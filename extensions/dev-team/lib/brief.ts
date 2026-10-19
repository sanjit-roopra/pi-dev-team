/**
 * Plain-text routing: before the first file change for a request the user typed, the session posts a
 * short "what I'm building" brief with dev_team_brief. The session model picks the size (no extra LLM
 * call); code makes sure a brief comes first (BriefGate in the tool_call handler).
 *
 *   question  no files change: answer, no brief
 *   tiny      one sentence, a few files: show 3 lines and go on
 *   feature   show "At a glance", ask ok (timed), then run /ship
 *   vague     run /specs, which asks the open decisions in rounds
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { lintGhText } from "./github-style.ts";
import { scanShell } from "./shell-scan.ts";

export const BRIEF_KINDS = ["question", "tiny", "feature", "vague"] as const;
export type BriefKind = (typeof BRIEF_KINDS)[number];

export interface Brief {
	kind: BriefKind;
	building: string;
	doneWhen: string;
	assuming?: string[];
	slices?: string[];
}

/** Skills that run their own human gates; a turn that ran one needs no brief. */
export const FLOW_SKILLS: ReadonlySet<string> = new Set(["specs", "plan", "build", "fix", "ship", "autoship", "continue"]);

export const BRIEF_FILE = path.join(".claude", "memory", "brief.json");
export const TINY_MAX_FILES = 3;
export const TINY_MAX_LINES = 150;
export const MAX_GLANCE_LINES = 15;

// ---------------------------------------------------------------- gate

const MUTATING_COMMANDS = new Set(["rm", "rmdir", "mv", "cp", "mkdir", "touch", "tee", "ln", "chmod", "chown", "truncate", "dd", "patch", "install", "rsync", "unzip"]);
const MUTATING_GIT = new Set(["add", "commit", "push", "checkout", "switch", "restore", "reset", "rm", "mv", "apply", "am", "merge", "rebase", "cherry-pick", "revert", "stash", "tag", "clean", "pull", "init", "clone", "worktree"]);
const MUTATING_PACKAGE = new Set(["install", "i", "add", "remove", "rm", "uninstall", "un", "update", "up", "upgrade", "ci", "init", "version", "publish", "link"]);
const PACKAGE_MANAGERS = new Set(["npm", "pnpm", "yarn", "bun", "pip", "pip3", "uv", "cargo", "go", "gem", "brew"]);
/** sed -i, sed -Ei, perl -pi, --in-place. */
const IN_PLACE = /^-[A-Za-z]*i|^--in-place/;
/** Words before the command itself. */
const PREFIXES = new Set(["sudo", "env", "command", "nohup", "time", "exec", "xargs"]);
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
/** `>`, `>>`, `2>` or `>|` starting a word, or glued to a word without spaces (`hi>>f`), with its target. */
const REDIRECT = /^(?:\d)?>>?\|?(.*)$|^[^\s<>=-]+?>>?(\S*)$/;

/**
 * The file a redirect in word i writes, or undefined. scanShell splits at `&`, so `>&2` and `2>&1`
 * leave a redirect with no target: they write no file. A quoted "a > b" has spaces and is not one.
 */
function redirectTarget(words: string[], i: number): string | undefined {
	const m = REDIRECT.exec(words[i]);
	if (!m) return undefined;
	const target = m[1] ?? m[2] ?? "";
	return target || (m[1] !== undefined ? words[i + 1] : undefined);
}

/** Whether a bash command line visibly writes files or repository state. Read-only commands, tests and builds pass. */
export function isMutatingBash(command: string): boolean {
	// scanShell splits `>|` (write even with noclobber) at the pipe.
	if (/>\|\s*[^\s&]/.test(command)) return true;
	for (const segment of scanShell(command)) {
		const words = segment.map((w) => w.text);
		for (let i = 0; i < words.length; i++) {
			if (segment[i].redirect) continue;
			const target = redirectTarget(words, i);
			if (target && !/^\/dev\/(?:null|stdout|stderr|tty)$/.test(target)) return true;
		}
		let at = 0;
		while (at < words.length && (ASSIGNMENT.test(words[at]) || PREFIXES.has(words[at]))) at++;
		const [name = "", sub = "", ...rest] = words.slice(at);
		const cmd = path.basename(name);
		if (MUTATING_COMMANDS.has(cmd)) return true;
		if ((cmd === "sed" || cmd === "perl") && [sub, ...rest].some((w) => IN_PLACE.test(w))) return true;
		if (cmd === "git" && MUTATING_GIT.has(sub)) return true;
		if (PACKAGE_MANAGERS.has(cmd) && MUTATING_PACKAGE.has(sub)) return true;
		if (cmd === "gh" && (sub === "pr" || sub === "issue" || sub === "release" || sub === "repo") && /^(?:create|edit|comment|merge|close|delete|reopen|ready)$/.test(rest[0] ?? "")) return true;
	}
	return false;
}

/** Paths the team keeps its own state in; writing them needs no brief. */
function isStatePath(file: unknown, cwd: string): boolean {
	if (typeof file !== "string") return false;
	const rel = path.relative(cwd, path.resolve(cwd, file));
	return rel === ".claude" || rel.startsWith(`.claude${path.sep}`);
}

/**
 * Per-request state. The `input` handler calls newRequest() for each request the user types; a
 * dev_team_brief call or a flow skill opens the gate until the next one.
 */
export class BriefGate {
	private briefed = false;
	private flowSkill = false;
	kind: BriefKind | undefined;
	sizeWarned = false;

	newRequest(): void {
		this.briefed = false;
		this.flowSkill = false;
		this.kind = undefined;
		this.sizeWarned = false;
	}

	noteSkill(name: string): void {
		if (FLOW_SKILLS.has(name.replace(/^\/|^dev-team:/g, ""))) this.flowSkill = true;
	}

	briefPosted(kind: BriefKind): void {
		this.kind = kind;
		if (kind === "tiny" || kind === "feature") this.briefed = true;
	}

	get open(): boolean {
		return this.briefed || this.flowSkill;
	}

	/** Reason to block a tool call that changes files before a brief, or undefined. */
	check(toolName: string, input: Record<string, unknown>, cwd: string): string | undefined {
		if (this.open) return undefined;
		const changes =
			toolName === "write" || toolName === "edit"
				? !isStatePath(input.path ?? input.file_path, cwd)
				: toolName === "bash" && typeof input.command === "string" && isMutatingBash(input.command);
		if (!changes) return undefined;
		return [
			"dev-team routing: call dev_team_brief before the first file change of this request, so the user sees what you build.",
			"Pick kind: tiny (one sentence, at most 3 files), feature (bigger: the user approves, then /ship), vague (open decisions: /specs). A question that changes no files needs no brief.",
		].join(" ");
	}
}

/** Advisory when a tiny brief has outgrown its size, from `git diff --numstat HEAD` output. */
export function sizeAdvisory(numstat: string): string | undefined {
	const rows = numstat.split("\n").filter((l) => l.trim());
	const lines = rows.reduce((sum, row) => {
		const [added, removed] = row.split("\t");
		return sum + (Number(added) || 0) + (Number(removed) || 0);
	}, 0);
	if (rows.length <= TINY_MAX_FILES && lines <= TINY_MAX_LINES) return undefined;
	return `dev-team routing: this "tiny" change now touches ${rows.length} files and ${lines} lines. Post an updated brief with dev_team_brief (kind feature), or stop and run /ship.`;
}

/** The working tree's diff size, or "" when git cannot tell. */
export function diffNumstat(cwd: string): string {
	try {
		return execFileSync("git", ["diff", "--numstat", "HEAD"], { cwd, encoding: "utf-8", timeout: 3000, stdio: ["ignore", "pipe", "ignore"] });
	} catch {
		return "";
	}
}

// ---------------------------------------------------------------- text

const bullets = (items: string[] | undefined) => (items ?? []).filter((s) => s.trim()).map((s) => `- ${s.trim()}`);

/** What the user sees. tiny: 3 lines. feature: "At a glance", at most MAX_GLANCE_LINES lines. */
export function renderBrief(b: Brief): string {
	const assuming = (b.assuming ?? []).filter((s) => s.trim());
	if (b.kind !== "feature") {
		return [`Building: ${b.building}`, `Done when: ${b.doneWhen}`, `Assuming: ${assuming.length ? assuming.join("; ") : "nothing"}`].join("\n");
	}
	const lines = [
		"At a glance",
		`Building: ${b.building}`,
		`Done when: ${b.doneWhen}`,
		...(assuming.length ? ["Assuming:", ...bullets(assuming)] : []),
		...(b.slices?.length ? ["Steps:", ...bullets(b.slices)] : []),
	];
	return lines.length > MAX_GLANCE_LINES ? [...lines.slice(0, MAX_GLANCE_LINES - 1), "…"].join("\n") : lines.join("\n");
}

/** Breaks of the plain-language rules in a brief. Empty when it passes. */
export function lintBrief(b: Brief): string[] {
	const body = [b.building, b.doneWhen, "", ...bullets(b.assuming), "", ...bullets(b.slices)].join("\n");
	const problems = lintGhText({ kind: "comment", body });
	const listLines = (items: string[] | undefined) => (bullets(items).length ? bullets(items).length + 1 : 0);
	const lines = 3 + listLines(b.assuming) + listLines(b.slices);
	if (b.kind === "feature" && lines > MAX_GLANCE_LINES) problems.push(`The brief has ${lines} lines. Keep "At a glance" at ${MAX_GLANCE_LINES} or fewer.`);
	return problems;
}

/** Saves the brief for /pr, which puts it at the top of the pull request. Never throws. */
export function saveBrief(cwd: string, b: Brief, extra: Record<string, unknown>): void {
	try {
		const file = path.join(cwd, BRIEF_FILE);
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, `${JSON.stringify({ ...b, ...extra, text: renderBrief(b) }, null, 2)}\n`, "utf-8");
	} catch {
		/* the brief still reached the user and the model */
	}
}

// ---------------------------------------------------------------- tool

export const DEV_TEAM_BRIEF_TOOL = "dev_team_brief";

const BriefParams = Type.Object({
	kind: Type.Union(
		[Type.Literal("question"), Type.Literal("tiny"), Type.Literal("feature"), Type.Literal("vague")],
		{ description: "question: no file changes. tiny: one sentence, at most 3 files. feature: bigger. vague: open decisions the user must make first" },
	),
	building: Type.String({ description: "One plain sentence: what you will build or change" }),
	doneWhen: Type.String({ description: "One plain sentence: what the user can see or run when it is done" }),
	assuming: Type.Optional(Type.Array(Type.String(), { description: "Decisions you made without asking, at most 5" })),
	slices: Type.Optional(Type.Array(Type.String(), { description: "feature only: the steps, at most 5" })),
});

export type FeatureAnswer = "go" | "change" | "stop" | "away";

export interface BriefToolDeps {
	gate: BriefGate;
	/** Asks the human to approve a feature brief. "away": no answer, the run goes on alone. */
	approveFeature: (ctx: ExtensionContext, glance: string, signal: AbortSignal | undefined) => Promise<{ answer: FeatureAnswer; change?: string }>;
	/** Tells an absent human that the run went on alone. */
	onAway: (title: string, text: string) => void;
}

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });

export function registerBriefTool(pi: ExtensionAPI, deps: BriefToolDeps): void {
	pi.registerTool({
		name: DEV_TEAM_BRIEF_TOOL,
		label: "Brief",
		description:
			"Before the first file change for a request the user typed, show them in plain words what you will build. Pick kind: question (no file changes; answer, no brief), tiny (one sentence, at most 3 files: shows 3 lines, then go on), feature (bigger: the user approves, then run /ship), vague (decisions only the user can make: run /specs).",
		promptSnippet: "Show the user what you will build before changing files",
		parameters: BriefParams,
		executionMode: "sequential",
		exposure: "model-only",
		annotations: { readOnlyHint: true, openWorldHint: false },
		async execute(_id, params, signal, _onUpdate, ctx) {
			const b = params as Brief;
			if (b.kind === "question") {
				deps.gate.briefPosted("question");
				return { ...text("No brief needed. Answer without changing files. If the answer needs file changes, call dev_team_brief again with kind tiny or feature."), details: { kind: b.kind } };
			}
			if (b.kind === "vague") {
				deps.gate.briefPosted("vague");
				return { ...text("Run /specs now (skill tool, name specs) with the user's request as args. It asks the open decisions in rounds before anything is built."), details: { kind: b.kind } };
			}
			const brief = renderBrief(b);
			if (b.kind === "tiny") {
				deps.gate.briefPosted("tiny");
				saveBrief(ctx.cwd, b, { approved: "tiny" });
				if (ctx.hasUI) ctx.ui.notify(brief, "info");
				return { ...text(`The user sees this brief:\n${brief}\n\nGo on. If the change grows past ${TINY_MAX_FILES} files, post an updated brief.`), details: { kind: b.kind, brief } };
			}
			const { answer, change } = await deps.approveFeature(ctx, brief, signal);
			if (answer === "change") {
				return { ...text(`The user wants changes to the brief: ${change ?? "(no details)"}\nCall dev_team_brief again with an updated brief. Change no files yet.`), details: { kind: b.kind, answer } };
			}
			if (answer === "stop") {
				return { ...text("The user stopped this. Change no files. Ask what they want instead."), details: { kind: b.kind, answer } };
			}
			deps.gate.briefPosted("feature");
			saveBrief(ctx.cwd, b, { approved: answer === "go" ? "user" : "no answer" });
			if (answer === "away") deps.onAway("dev-team goes on without you", brief);
			const alone = answer === "away" ? " Nobody answered, so you go on alone: keep the brief's assumptions, list them under \"Decide these\" at the top of the PR." : "";
			return { ...text(`Approved.${alone} Run /ship now (skill tool, name ship) with the brief's "Building" sentence as args.`), details: { kind: b.kind, answer, brief } };
		},
	});
}
