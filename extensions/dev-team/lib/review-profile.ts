/**
 * DEV_TEAM_REVIEW=full|lean: how much review ceremony /plan, /build, /code-review and /ship run.
 *
 * `full` (the default) is upstream's flow, and its prompt text stays byte for byte what it was: nothing
 * here adds text unless the profile is `lean`. `lean` cuts the review layers that measured runs showed
 * cost the most and changed the least (the Farley Score, extra fix rounds, the second review panel,
 * complex-tier plan critics, per-step implementer dispatches). It weakens a review gate, so only the
 * user's own process environment can turn it on: the value is read once, when the extension loads,
 * before any config file's `env` is applied, and a project's config may not set it either
 * (it is not in PROJECT_ENV_SETTINGS). The lean instructions live in extensions/dev-team/lean/<skill>.md
 * and are inserted into the skill text only while lean is active.
 */
import * as fs from "node:fs";
import * as path from "node:path";

export type ReviewProfile = "full" | "lean";

export const REVIEW_PROFILE_ENV = "DEV_TEAM_REVIEW";

/** Skills with a lean section in extensions/dev-team/lean/. */
export const LEAN_SKILLS: ReadonlySet<string> = new Set(["plan", "build", "code-review", "ship"]);

/** Unset, empty or `full` is full; `lean` is lean; anything else is full with a warning. Case and spaces are ignored. */
export function parseReviewProfile(value: string | undefined): { profile: ReviewProfile; warning?: string } {
	const v = (value ?? "").trim().toLowerCase();
	if (v === "" || v === "full") return { profile: "full" };
	if (v === "lean") return { profile: "lean" };
	return { profile: "full", warning: `dev-team: ${REVIEW_PROFILE_ENV}=${JSON.stringify(value)} is not full or lean; using full.` };
}

/** The profile from a process environment. Pass the environment as it was before any config `env` is applied. */
export function reviewProfileFromEnv(env: NodeJS.ProcessEnv): { profile: ReviewProfile; warning?: string } {
	return parseReviewProfile(env[REVIEW_PROFILE_ENV]);
}

/**
 * Sets DEV_TEAM_REVIEW in an environment that tools, hooks and child agents inherit, after config `env`
 * entries were merged into it: `lean` when the profile is lean, removed otherwise, so a config file's
 * value never reaches a child, and a child reads the same profile as its parent.
 */
export function applyReviewProfileEnv(env: NodeJS.ProcessEnv, profile: ReviewProfile): void {
	if (profile === "lean") env[REVIEW_PROFILE_ENV] = "lean";
	else delete env[REVIEW_PROFILE_ENV];
}

/** The lean section for a package skill, or undefined (full profile, another skill, or no file). */
export function reviewProfileNote(packageRoot: string, profile: ReviewProfile, skillName: string): string | undefined {
	if (profile !== "lean" || !LEAN_SKILLS.has(skillName)) return undefined;
	try {
		return fs.readFileSync(path.join(packageRoot, "extensions", "dev-team", "lean", `${skillName}.md`), "utf-8").trim();
	} catch {
		return undefined;
	}
}

const PORT_NOTES_MARKER = "<!-- pi-port-notes -->";

/**
 * Inserts the profile section after the skill's pi port notes (the second marker), so it is read after them
 * and overrides them; without markers, after the first `# ` heading; else at the top. No note: body unchanged.
 */
export function insertReviewProfileNote(body: string, note: string | undefined): string {
	if (!note) return body;
	const marker = body.lastIndexOf(PORT_NOTES_MARKER);
	if (marker >= 0) {
		const at = marker + PORT_NOTES_MARKER.length;
		return `${body.slice(0, at)}\n${note}\n${body.slice(at)}`;
	}
	const heading = body.match(/^# .*$/m);
	if (heading?.index !== undefined) {
		const at = heading.index + heading[0].length;
		return `${body.slice(0, at)}\n\n${note}\n${body.slice(at)}`;
	}
	return `${note}\n\n${body}`;
}

/** The dev-team guide line for the lean profile; empty for full, so the full guide is unchanged. */
export function reviewProfileGuideLine(profile: ReviewProfile): string {
	if (profile !== "lean") return "";
	return `- Review profile: lean (${REVIEW_PROFILE_ENV}=lean in the user's environment). /plan, /build, /code-review and /ship carry a "Review profile: lean" section that overrides their steps: one review panel per slice, only \`error\` findings fixed in one round, no Farley Score, plan critics at most the standard tier. Spec-compliance review, structure-review and the static-analysis pre-pass (lint, type-check, and lizard complexity at every /build checkpoint) still run, and lint and complexity errors are still fixed. /build runs with --backstop-review=skip and the skill tool skips farley-score. An implementer runs only the tests for the behavior it changes while it works, and the full suite once at the end of its task.`;
}

const BACKSTOP_SKIP_FLAG = "--backstop-review=skip";

/**
 * The arguments a skill expands with. Under lean, `/build` gets upstream's `--backstop-review=skip`, so the
 * skill's own flag logic (Parse Arguments, step 6) engages: DEV_TEAM_REVIEW=lean is the enclosing caller's
 * assertion that flag requires, the lean slice checkpoints being the enclosing review. Full: args unchanged.
 */
export function reviewProfileArgs(profile: ReviewProfile, skillName: string, args: string): string {
	if (profile !== "lean" || skillName !== "build") return args;
	if (args.split(/\s+/).includes(BACKSTOP_SKIP_FLAG)) return args;
	return args.trim() ? `${args.trim()} ${BACKSTOP_SKIP_FLAG}` : BACKSTOP_SKIP_FLAG;
}

/** Skills the lean profile skips when a model loads them with the skill tool (a typed command still runs them). */
const LEAN_SKIPPED_SKILLS: ReadonlySet<string> = new Set(["farley-score"]);

/** The skill tool's result for a skill lean skips, or undefined (run it). */
export function reviewProfileSkippedSkill(profile: ReviewProfile, skillName: string): string | undefined {
	if (profile !== "lean" || !LEAN_SKIPPED_SKILLS.has(skillName)) return undefined;
	return `${skillName} skipped (${REVIEW_PROFILE_ENV}=lean): the lean review profile does not score tests. Do not score them another way; print \`Farley Score skipped (${REVIEW_PROFILE_ENV}=lean).\` where the score would go and continue. The user can still run /${skillName} directly.`;
}

/**
 * A lean override appended to a dispatched agent's system prompt, or "" (full profile, or an agent lean leaves alone).
 * software-engineer's per-step self-verification and the per-behavior cycle's full-suite gate run the full suite
 * per step; lean runs it once per task.
 */
export function reviewProfileAgentNote(profile: ReviewProfile, agentName: string): string {
	if (profile !== "lean" || agentName !== "software-engineer") return "";
	return `## Review profile: lean (${REVIEW_PROFILE_ENV}=lean)

This overrides the self-verification constraint above and the /build per-behavior cycle's "Run the full test suite" gate. While you work, after each behavior and each step, run only the tests for the behavior you are changing, plus lint and type-check on the files you changed, and paste that output. Run the project's full test suite once, after the last step or fix of your task, and paste that run in your report. Everything else in your instructions still applies.`;
}
