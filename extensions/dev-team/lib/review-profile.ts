/**
 * DEV_TEAM_REVIEW=full|lean: how much review ceremony /plan, /build, /code-review and /ship run.
 *
 * `lean` (the default) cuts the review layers that measured runs showed cost the most and changed the
 * least (extra fix rounds, the second review panel, complex-tier plan critics, per-step implementer
 * dispatches). `full` is upstream's flow, and its prompt text stays byte for byte what it was: nothing
 * here adds text unless the profile is `lean`. Only the user's own process environment chooses the
 * profile: the value is read once, when the extension loads, before any config file's `env` is applied,
 * and a project's config may not set it either (it is not in PROJECT_ENV_SETTINGS). The lean instructions live in extensions/dev-team/lean/<skill>.md
 * and are inserted into the skill text only while lean is active.
 */
import * as fs from "node:fs";
import * as path from "node:path";

export type ReviewProfile = "full" | "lean";

export const REVIEW_PROFILE_ENV = "DEV_TEAM_REVIEW";

/** Skills with a lean section in extensions/dev-team/lean/. */
export const LEAN_SKILLS: ReadonlySet<string> = new Set(["plan", "build", "code-review", "ship"]);

/** Unset, empty or `lean` is lean; `full` is full; anything else is lean with a warning. Case and spaces are ignored. */
export function parseReviewProfile(value: string | undefined): { profile: ReviewProfile; warning?: string } {
	const v = (value ?? "").trim().toLowerCase();
	if (v === "" || v === "lean") return { profile: "lean" };
	if (v === "full") return { profile: "full" };
	return { profile: "lean", warning: `dev-team: ${REVIEW_PROFILE_ENV}=${JSON.stringify(value)} is not full or lean; using lean.` };
}

/** The profile from a process environment. Pass the environment as it was before any config `env` is applied. */
export function reviewProfileFromEnv(env: NodeJS.ProcessEnv): { profile: ReviewProfile; warning?: string } {
	return parseReviewProfile(env[REVIEW_PROFILE_ENV]);
}

/**
 * Sets DEV_TEAM_REVIEW in an environment that tools, hooks and child agents inherit, after config `env`
 * entries were merged into it: always the profile itself, never removed, because an unset value means lean.
 * So a config file's value never reaches a child, and a child reads the same profile as its parent.
 */
export function applyReviewProfileEnv(env: NodeJS.ProcessEnv, profile: ReviewProfile): void {
	env[REVIEW_PROFILE_ENV] = profile;
}

/**
 * DEV_TEAM_FARLEY=on|off: whether lean /build runs the step 7 Farley Score (a `qa-engineer` dispatch). Off by
 * default: the score is informational, never gates /pr, and in measured runs changed no file while adding
 * minutes per build. Only `on` (case and spaces ignored) turns it on. The full profile always runs it.
 */
export const FARLEY_ENV = "DEV_TEAM_FARLEY";

export function farleyEnabled(env: NodeJS.ProcessEnv): boolean {
	return (env[FARLEY_ENV] ?? "").trim().toLowerCase() === "on";
}

const FARLEY_BLOCK = /<!-- farley:(on|off) -->\n([\s\S]*?)<!-- \/farley:\1 -->\n?/g;

/** Keeps the `<!-- farley:on|off -->` block that matches `farley` (without its markers) and drops the other. */
export function selectFarleyBlock(text: string, farley: boolean): string {
	return text.replace(FARLEY_BLOCK, (_, state: string, body: string) => ((state === "on") === farley ? body : ""));
}

/** The lean section for a package skill, or undefined (full profile, another skill, or no file). */
export function reviewProfileNote(packageRoot: string, profile: ReviewProfile, skillName: string, farley = false): string | undefined {
	if (profile !== "lean" || !LEAN_SKILLS.has(skillName)) return undefined;
	try {
		const text = fs.readFileSync(path.join(packageRoot, "extensions", "dev-team", "lean", `${skillName}.md`), "utf-8");
		return selectFarleyBlock(text, farley).trim();
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

/**
 * The code-quality bar lean puts in the guide, so it binds the session itself (plain requests, /fix, fix rounds)
 * as well as /build's implementer. In SlopCodeBench runs this bar alone, given to plain pi, matched the lean
 * profile's code-shape metrics (erosion 0, max cyclomatic complexity 10): the review layers added none.
 */
export const QUALITY_BAR =
	"- Code quality bar (lean): every function you or an agent writes has a cyclomatic complexity of at most 10, at most 60 lines and at most 5 parameters, and the project's linter (`ruff check` for Python) reports nothing on changed files. Before you report code work done, run the linter and `lizard -w -C 10 -L 60 -a 5 <changed source files>` (install `lizard` into the project's environment if it is missing), fix every finding and re-run until both are clean. Write the least code that works: use what the codebase, the standard library or an installed dependency already has; no speculative options, no wrapper, factory or layer used once, no duplicated logic; fewer lines, never denser lines. Never cut input validation or error handling at a real boundary to save lines.";

/** The dev-team guide lines for the lean profile; empty for full, so the full guide is unchanged. */
export function reviewProfileGuideLine(profile: ReviewProfile): string {
	if (profile !== "lean") return "";
	return `- Review profile: lean (the default; ${REVIEW_PROFILE_ENV}=full in the user's environment selects the full profile). /plan, /build, /code-review and /ship carry a "Review profile: lean" section that overrides their steps: no plan critics, one implementer dispatch and one review panel per slice (spec-compliance and correctness at every slice; the simplify lens, and security when selected, at the last slice), only \`error\` findings fixed in one round. The static-analysis pre-pass (lint, type-check, and lizard complexity at every /build checkpoint) still runs, and its errors are fixed. /build runs with --backstop-review=skip. An implementer works a step at a time, runs only that step's tests while it works, and runs lint, type-check and the full suite once at the end of its task. Tests stay within a budget of one per Gherkin scenario plus one per request rule no scenario covers. /build skips the Farley Score (the qa-engineer dispatch) unless ${FARLEY_ENV}=on.
${QUALITY_BAR}`;
}

const BACKSTOP_SKIP_FLAG = "--backstop-review=skip";

/**
 * The arguments a skill expands with. Under lean, `/build` gets upstream's `--backstop-review=skip`, so the
 * skill's own flag logic (Parse Arguments, step 6) engages: the lean profile is the enclosing caller's
 * assertion that flag requires, the lean slice checkpoints being the enclosing review. Full: args unchanged.
 */
export function reviewProfileArgs(profile: ReviewProfile, skillName: string, args: string): string {
	if (profile !== "lean" || skillName !== "build") return args;
	if (args.split(/\s+/).includes(BACKSTOP_SKIP_FLAG)) return args;
	return args.trim() ? `${args.trim()} ${BACKSTOP_SKIP_FLAG}` : BACKSTOP_SKIP_FLAG;
}

const TEST_BUDGET =
	"Test budget: one test per Gherkin scenario, plus one per rule the request states that no scenario covers; add a case to an existing test's table rather than a new test where you can. Do not write tests for internal helpers, resource or memory bounds (tracemalloc, RSS, open-file counts), signals or KeyboardInterrupt, injected filesystem failures (fsync, rename, inode, permission) or exhaustive permutation matrices, unless the request asks for that behavior.";

/**
 * Skills lean inlines into a dispatched agent's system prompt, by agent. A dispatch starts with an empty context,
 * so software-engineer otherwise spends a turn per dispatch reading the skills its instructions say to invoke
 * before delivery and on a failing test; upstream Claude Code preloads frontmatter skills the same way.
 */
const LEAN_PRELOADED_SKILLS: Readonly<Record<string, readonly string[]>> = {
	"software-engineer": ["quality-gate-pipeline", "systematic-debugging"],
};

/** The skill names to inline into `agentName`'s system prompt; empty for the full profile or another agent. */
export function reviewProfilePreloadedSkills(profile: ReviewProfile, agentName: string): readonly string[] {
	if (profile !== "lean") return [];
	return LEAN_PRELOADED_SKILLS[agentName] ?? [];
}

const LIZARD_COMMAND = "lizard --csv <files> | python3 ${CLAUDE_PLUGIN_ROOT}/skills/static-analysis-integration/adapters/lizard-adapter.py";

/**
 * A lean override appended to a dispatched agent's system prompt, or "" (full profile, or an agent lean leaves alone).
 * software-engineer's per-step self-verification and the per-behavior cycle's full-suite gate run the full suite
 * per step; lean runs it once per task, tests once per step and lint (with lizard, so the checkpoint's complexity
 * pre-pass finds nothing to send back) once per task, commits once per task, and caps the tests it writes.
 * test-review and test-smell-review get the same test budget, so their findings do not grow the tests back.
 */
export function reviewProfileAgentNote(profile: ReviewProfile, agentName: string): string {
	if (profile !== "lean") return "";
	if (agentName === "software-engineer") {
		return `## Review profile: lean (the default; ${REVIEW_PROFILE_ENV}=full turns it off)

This overrides the self-verification constraint above and the /build per-behavior cycle's "Run the full test suite" gate and one-behavior batches. Work one step at a time: implement the whole step, write its tests, then run only that step's tests and paste the output. Refactor once per step, after that green run: when the refactor changes nothing, say so in one line, write no refactor phase marker and do not re-run the tests; when it changes code, re-run the step's tests once. Run the project's full test suite once, after the last step or fix of your task, in the same bash call as lint, type-check and the complexity check on the files you changed (run those only there), and paste that run in your report. The complexity check is \`${LIZARD_COMMAND}\` when \`lizard\` is installed; fix every threshold it reports before you report, because the review checkpoint treats each one as an error.

Fewer turns: never spend a turn on a \`build_phase.py\` marker alone; chain it with \`&&\` onto the bash call before or after it, such as the previous step's test run or this step's test run. Commit once, after the final full-suite run, not after each step. Do not write a report file; your final message is your report, at most 300 words. The quality-gate-pipeline and systematic-debugging skills are inlined below; do not load or read them again.

${TEST_BUDGET} Everything else in your instructions still applies.`;
	}
	if (agentName === "test-review" || agentName === "test-smell-review") {
		return `## Review profile: lean (the default; ${REVIEW_PROFILE_ENV}=full turns it off)

The implementer works to this test budget. ${TEST_BUDGET} A missing test is an \`error\` only when a Gherkin scenario or a rule the request states has no test. A request for more cases, permutations or any of the excluded kinds of test is at most a \`suggestion\`, unless the request asks for that behavior. Everything else in your instructions still applies.`;
	}
	return "";
}

