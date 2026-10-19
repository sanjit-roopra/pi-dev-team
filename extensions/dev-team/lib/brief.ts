/**
 * Plain-text routing: before the first file change for a request the user typed, the session posts a
 * short "what I'm building" brief with dev_team_brief. The session model picks the size (no extra LLM
 * call); code makes sure a brief comes first (BriefGate in the tool_call handler).
 *
 *   question  no files change: answer, no brief
 *   tiny      one sentence, a few files: show 3 lines and go on
 *   feature   show "At a glance", ask ok (timed), then run /ship
 *   vague     run /specs, which asks the open decisions in rounds
 *   resume    the message answers or continues a /command or flow skill already running
 *
 * A /command the user types runs its own gates, so it opens the gate for its request.
 */
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { lintGhText } from "./github-style.ts";
import { type ShellSegment, scanShell, unquotedView } from "./shell-scan.ts";

export const BRIEF_KINDS = ["question", "tiny", "feature", "vague", "resume"] as const;
export type BriefKind = (typeof BRIEF_KINDS)[number];

export interface Brief {
	kind: BriefKind;
	building?: string;
	doneWhen?: string;
	assuming?: string[];
	slices?: string[];
}

/** Skills that run their own human gates; a request whose model loads one needs no brief. index.ts adds every user command. */
export const FLOW_SKILLS: ReadonlySet<string> = new Set(["specs", "plan", "build", "fix", "ship", "autoship", "continue"]);

/** Commands that start new work: an older request's brief.json must not reach their PR. */
export const NEW_WORK_SKILLS: ReadonlySet<string> = new Set(["specs", "ship", "autoship", "fix"]);

/** A skill name as the skill tool resolves it: no "/", no "<namespace>:", lower case. */
export function bareSkillName(name: string): string {
	return name.trim().replace(/^\//, "").replace(/^[\w-]+:/, "").toLowerCase();
}

export const BRIEF_FILE = path.join(".claude", "memory", "brief.json");
export const TINY_MAX_FILES = 3;
export const TINY_MAX_LINES = 150;
export const MAX_GLANCE_LINES = 15;
/** Lines of an untracked file are counted up to this size; a bigger one counts as TINY_MAX_LINES + 1. */
const MAX_COUNTED_BYTES = 1_000_000;

// ---------------------------------------------------------------- gate

const MUTATING_COMMANDS = new Set(["rm", "rmdir", "mv", "cp", "mkdir", "touch", "tee", "ln", "chmod", "chown", "truncate", "dd", "patch", "install", "rsync", "unzip"]);
const MUTATING_GIT = new Set(["add", "commit", "push", "checkout", "switch", "restore", "reset", "rm", "mv", "apply", "am", "merge", "rebase", "cherry-pick", "revert", "clean", "pull", "init", "clone"]);
/** Subcommands that change files or the project's dependencies, per tool. */
const MUTATING_SUBCOMMANDS: Record<string, ReadonlySet<string>> = {
	npm: new Set(["install", "i", "add", "remove", "rm", "uninstall", "un", "update", "up", "upgrade", "ci", "init", "version", "publish", "link"]),
	pip: new Set(["install", "uninstall"]),
	uv: new Set(["add", "remove", "sync", "lock", "pip", "init"]),
	cargo: new Set(["add", "remove", "install", "update", "init", "new", "publish", "fix"]),
	go: new Set(["get", "install", "mod", "generate", "work"]),
	gem: new Set(["install", "uninstall", "update"]),
	brew: new Set(["install", "uninstall", "upgrade", "reinstall"]),
};
for (const alias of ["pnpm", "yarn", "bun"]) MUTATING_SUBCOMMANDS[alias] = MUTATING_SUBCOMMANDS.npm;
MUTATING_SUBCOMMANDS.pip3 = MUTATING_SUBCOMMANDS.pip;
/** sed -i, sed -Ei, perl -pi, --in-place. */
const IN_PLACE = /^-[A-Za-z]*i|^--in-place/;
/** Words before the command itself. */
const PREFIXES = new Set(["sudo", "env", "command", "nohup", "time", "exec", "xargs"]);
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
/** `>`, `>>`, `2>` or `>|` starting a word, or glued to the end of a word (`hi>>f`), with its target. */
const REDIRECT = /^(?:\d)?>>?\|?(.*)$|^[^\s<>]+?>>?\|?(\S*)$/;
const DEVICE = /^\/dev\/(?:null|stdout|stderr|tty)$/;
const COPY_COMMANDS = new Set(["cp", "ln", "install", "rsync"]);

/** A path a command writes; `dynamic`: the shell computes part of it. */
interface Target {
	text: string;
	dynamic: boolean;
}

/**
 * The file a redirect in word i writes, or undefined. Only an unquoted `>` counts (`views`: words
 * with quoted characters masked); the target keeps its quotes' text. scanShell splits at `&` and `|`,
 * so `>&2` and `2>&1` leave a redirect with no target (no file); `>|` is found in isMutatingBash.
 */
function redirectTarget(segment: ShellSegment, views: string[], i: number): Target | undefined {
	const m = REDIRECT.exec(views[i]);
	if (!m) return undefined;
	const word = segment[i];
	const captured = m[1] ?? m[2] ?? "";
	if (captured) return { text: word.text.slice(word.text.length - captured.length), dynamic: word.dynamic };
	const next = m[1] !== undefined ? segment[i + 1] : undefined;
	return next && { text: next.text, dynamic: next.dynamic };
}

/**
 * Whether a path is outside the project (`/tmp/x`, `$TMPDIR/x`, `~/x`), so writing it changes nothing
 * here. A path the shell computes (`"$(pwd)/a"`) is taken as inside.
 */
function outsideProject({ text: target, dynamic }: Target, cwd: string | undefined): boolean {
	if (DEVICE.test(target) || /^\$\{?TMPDIR\b/.test(target)) return true;
	if (dynamic) return false;
	if (!cwd || !(path.isAbsolute(target) || target.startsWith("~"))) return false;
	const rel = path.relative(cwd, path.resolve(cwd, target.replace(/^~/, process.env.HOME ?? "~")));
	return rel.startsWith("..") || path.isAbsolute(rel);
}

/** Whether writing `target` changes the project: inside it and not the team's own state. */
function writesProject(target: Target, cwd: string | undefined): boolean {
	return !isStatePath(target.text, cwd ?? "") && !outsideProject(target, cwd);
}

/** A git subcommand that changes the repository; list forms of stash, tag and worktree do not. */
function gitChanges(sub: string, rest: string[]): boolean {
	if (MUTATING_GIT.has(sub)) return true;
	const first = rest.find((w) => !w.startsWith("-"));
	if (sub === "stash") return !["list", "show"].includes(rest[0] ?? "push");
	if (sub === "worktree") return ["add", "remove", "move", "prune", "repair"].includes(rest[0] ?? "");
	if (sub === "tag") return first !== undefined && !rest.some((w) => w === "-l" || w === "--list" || w.startsWith("--contains") || w.startsWith("--points-at"));
	if (sub === "branch") return rest.some((w) => /^-(?:[dDmMcC]|-delete|-move|-copy)$/.test(w)) || (first !== undefined && !rest.some((w) => /^-(?:l|a|r|v|vv|-list|-all|-remotes)$/.test(w)));
	return false;
}

/** The command line without its single-quoted text, where neither backticks nor `>|` act. */
const withoutSingleQuoted = (command: string) => command.replace(/'[^']*'/g, "''");

/**
 * Whether a bash command line visibly writes files or repository state in the project at `cwd`.
 * Read-only commands, tests, builds and writes outside the project (`/tmp`) pass.
 */
export function isMutatingBash(command: string, cwd?: string): boolean {
	const active = withoutSingleQuoted(command);
	// scanShell splits `>|` (write even with noclobber) at the pipe, and backtick commands at spaces.
	if (/>\|\s*[^\s&]/.test(active.replace(/"(?:\\.|[^"\\])*"/g, '""'))) return true;
	if ([...active.matchAll(/`([^`]+)`/g)].some((m) => isMutatingBash(m[1], cwd))) return true;
	return segmentsChange(scanShell(command), cwd);
}

function segmentsChange(segments: ShellSegment[], cwd: string | undefined): boolean {
	for (const segment of segments) {
		if (segment.some((w) => segmentsChange(w.substitutions ?? [], cwd))) return true;
		const words = segment.map((w) => w.text);
		const views = segment.map(unquotedView);
		for (let i = 0; i < words.length; i++) {
			if (segment[i].redirect) continue;
			const target = redirectTarget(segment, views, i);
			if (target && writesProject(target, cwd)) return true;
		}
		let at = 0;
		while (at < words.length && (ASSIGNMENT.test(words[at]) || PREFIXES.has(words[at]))) at++;
		const [name = "", sub = "", ...rest] = words.slice(at);
		const cmd = path.basename(name);
		if (MUTATING_COMMANDS.has(cmd)) {
			const paths = segment.slice(at + 1).filter((w) => w.text && !w.text.startsWith("-"));
			// cp, ln, install and rsync write only their last path; the others change every path.
			const written = COPY_COMMANDS.has(cmd) ? paths.slice(-1) : paths;
			if (!written.length || written.some((w) => writesProject(w, cwd))) return true;
		}
		if ((cmd === "sed" || cmd === "perl") && [sub, ...rest].some((w) => IN_PLACE.test(w))) return true;
		if (cmd === "git" && gitChanges(sub, rest)) return true;
		if (MUTATING_SUBCOMMANDS[cmd]?.has(sub)) return true;
		if (cmd === "gh" && (sub === "pr" || sub === "issue" || sub === "release" || sub === "repo") && /^(?:create|edit|comment|merge|close|delete|reopen|ready)$/.test(rest[0] ?? "")) return true;
	}
	return false;
}

/** Paths the team keeps its own state and reports in; writing them needs no brief. */
function isStatePath(file: unknown, cwd: string): boolean {
	if (typeof file !== "string" || !file) return false;
	const rel = path.relative(cwd, path.resolve(cwd, file));
	return /^(?:\.claude|\.dev-team-reports)(?:[\\/]|$)/.test(rel);
}

/**
 * Per-request state. The `input` handler calls newRequest() for each request the user types; a
 * brief, a /command the user typed, or a flow skill the model loads opens the gate until the next one.
 */
export class BriefGate {
	private briefed = false;
	private flowRan = false;
	private resumed = false;
	/** The /command or flow skill of the previous request, which a "resume" brief may continue. */
	lastFlow: string | undefined;
	kind: BriefKind | undefined;
	sizeWarned = false;
	/** The working tree when the tiny brief was posted; only changes after it count. */
	baseline: DiffSnapshot | undefined;

	private readonly flowSkills: ReadonlySet<string>;

	constructor(flowSkills: ReadonlySet<string> = FLOW_SKILLS) {
		this.flowSkills = flowSkills;
	}

	/**
	 * A new typed request. Returns whether it may continue the previous request's flow (that request
	 * ran or resumed one); otherwise the flow is over and "resume" no longer applies.
	 */
	newRequest(): boolean {
		const continues = this.flowRan || this.resumed;
		if (!continues) this.lastFlow = undefined;
		this.briefed = false;
		this.flowRan = false;
		this.resumed = false;
		this.resetSize();
		return continues;
	}

	/** The user typed a /command. It runs its own gates. */
	commandRan(name: string): void {
		this.flowRan = true;
		this.lastFlow = bareSkillName(name);
		this.resetSize();
	}

	/** The model loaded a skill; a flow skill or user command opens the gate. */
	noteSkill(name: string): void {
		const bare = bareSkillName(name);
		if (!this.flowSkills.has(bare)) return;
		this.flowRan = true;
		this.lastFlow = bare;
		this.resetSize();
	}

	/**
	 * Records a brief and returns whether the gate is open. "resume" opens it only after a flow; a
	 * question, vague or resume brief does not replace the kind of a brief already posted.
	 */
	briefPosted(kind: BriefKind): boolean {
		if (kind === "tiny" || kind === "feature") {
			this.kind = kind;
			this.briefed = true;
		} else if (kind === "resume") {
			if (this.lastFlow) this.resumed = true;
		} else if (!this.open) this.kind = kind;
		return this.open;
	}

	private resetSize(): void {
		this.kind = undefined;
		this.sizeWarned = false;
		this.baseline = undefined;
	}

	get open(): boolean {
		return this.briefed || this.flowRan || this.resumed;
	}

	/** Reason to block a call that changes files before a brief, or undefined. */
	check(toolName: string, input: Record<string, unknown>, cwd: string): string | undefined {
		if (this.open) return undefined;
		const changes =
			toolName === "write" || toolName === "edit"
				? !isStatePath(input.path ?? input.file_path, cwd)
				: toolName === "powershell" || (toolName === "bash" && typeof input.command === "string" && isMutatingBash(input.command, cwd));
		return changes ? this.blockReason() : undefined;
	}

	blockReason(): string {
		return [
			"dev-team routing: call dev_team_brief before the first file change of this request, so the user sees what you build.",
			"Pick kind: tiny (one sentence, at most 3 files), feature (bigger: the user approves, then /ship), vague (open decisions: /specs).",
			this.lastFlow ? `If the user's message answers or continues /${this.lastFlow} from the previous request, pick resume.` : "",
			"A question that changes no files needs no brief.",
		]
			.filter(Boolean)
			.join(" ");
	}
}

/** Changed lines per file in the working tree, the team's own state (.claude/) left out. */
export type DiffSnapshot = Map<string, number>;

/**
 * A snapshot from `git diff --numstat` output and the untracked files with their line counts. Paths
 * under .claude/ and .dev-team-reports/ are left out: the team writes them itself.
 */
export function parseDiff(numstat: string, untracked: Record<string, number> = {}): DiffSnapshot {
	const snapshot: DiffSnapshot = new Map();
	for (const row of numstat.split("\n")) {
		const [added, removed, file] = row.split("\t");
		if (file && !isStatePath(file, "")) snapshot.set(file, (Number(added) || 0) + (Number(removed) || 0));
	}
	for (const [file, lines] of Object.entries(untracked)) if (!snapshot.has(file) && !isStatePath(file, "")) snapshot.set(file, lines);
	return snapshot;
}

/** Advisory when a tiny change has grown past its size since the brief (`before`), or undefined. */
export function sizeAdvisory(before: DiffSnapshot, after: DiffSnapshot): string | undefined {
	let files = 0;
	let lines = 0;
	for (const [file, n] of after) {
		if (before.get(file) === n) continue;
		files++;
		lines += Math.abs(n - (before.get(file) ?? 0));
	}
	if (files <= TINY_MAX_FILES && lines <= TINY_MAX_LINES) return undefined;
	return `dev-team routing: this "tiny" change now touches ${files} files and ${lines} lines. Post an updated brief with dev_team_brief (kind feature), or stop and run /ship.`;
}

function countLines(file: string): number {
	try {
		const stat = fs.statSync(file);
		if (stat.size > MAX_COUNTED_BYTES) return TINY_MAX_LINES + 1;
		const text = fs.readFileSync(file, "utf-8");
		return text ? text.split("\n").length - (text.endsWith("\n") ? 1 : 0) : 0;
	} catch {
		return 0;
	}
}

/** The working tree's changes against HEAD (or the index in a repo with no commit), or undefined when git cannot tell. */
export function diffSnapshot(cwd: string): DiffSnapshot | undefined {
	const git = (args: string[]) => execFileSync("git", args, { cwd, encoding: "utf-8", timeout: 3000, stdio: ["ignore", "pipe", "ignore"] });
	try {
		let numstat: string;
		try {
			numstat = git(["diff", "--numstat", "HEAD"]);
		} catch {
			numstat = git(["diff", "--numstat"]);
		}
		const untracked = git(["ls-files", "--others", "--exclude-standard"]).split("\n").filter((f) => f.trim() && !isStatePath(f, ""));
		return parseDiff(numstat, Object.fromEntries(untracked.map((f) => [f, countLines(path.join(cwd, f))])));
	} catch {
		return undefined;
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

/** Breaks of the plain-language rules in a brief the user sees (tiny, feature). Empty when it passes. */
export function lintBrief(b: Brief): string[] {
	if (b.kind !== "tiny" && b.kind !== "feature") return [];
	const body = [b.building, b.doneWhen, "", ...bullets(b.assuming), "", ...bullets(b.slices)].join("\n");
	const problems = lintGhText({ kind: "comment", body });
	const listLines = (items: string[] | undefined) => (bullets(items).length ? bullets(items).length + 1 : 0);
	const lines = 3 + listLines(b.assuming) + listLines(b.slices);
	if (b.kind === "feature" && lines > MAX_GLANCE_LINES) problems.push(`The brief has ${lines} lines. Keep "At a glance" at ${MAX_GLANCE_LINES} or fewer.`);
	return problems;
}

/** brief.json, or undefined when it or a folder on its way is a link: a cloned repo could point it anywhere. */
function briefPath(cwd: string): string | undefined {
	const file = path.join(cwd, BRIEF_FILE);
	let at = cwd;
	for (const part of BRIEF_FILE.split(path.sep)) {
		at = path.join(at, part);
		try {
			if (fs.lstatSync(at).isSymbolicLink()) return undefined;
		} catch {
			break; // does not exist yet
		}
	}
	return file;
}

/**
 * Saves the brief for /pr, which puts it at the top of the pull request of the same session. Never
 * throws. The file is written beside its target and renamed, so a link put there meanwhile is replaced.
 */
export function saveBrief(cwd: string, b: Brief, extra: Record<string, unknown>): void {
	const file = briefPath(cwd);
	if (!file) return;
	const tmp = `${file}.${randomUUID()}.tmp`;
	try {
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(tmp, `${JSON.stringify({ ...b, ...extra, text: renderBrief(b) }, null, 2)}\n`, { encoding: "utf-8", flag: "wx" });
		fs.renameSync(tmp, file);
	} catch {
		// The brief still reached the user and the model.
		try {
			fs.rmSync(tmp, { force: true });
		} catch {
			/* nothing was written */
		}
	}
}

/** Removes an older request's brief, so /pr cannot put it on unrelated work. Never throws. */
export function clearBrief(cwd: string): void {
	const file = briefPath(cwd);
	try {
		if (file) fs.rmSync(file, { force: true });
	} catch {
		/* nothing to clear */
	}
}

// ---------------------------------------------------------------- tool

export const DEV_TEAM_BRIEF_TOOL = "dev_team_brief";

const BriefParams = Type.Object({
	kind: Type.Union(
		[Type.Literal("question"), Type.Literal("tiny"), Type.Literal("feature"), Type.Literal("vague"), Type.Literal("resume")],
		{
			description:
				"question: no file changes. tiny: one sentence, at most 3 files. feature: bigger. vague: open decisions the user must make first. resume: the message answers or continues a /command already running",
		},
	),
	building: Type.Optional(Type.String({ description: "tiny and feature: one plain sentence, what you will build or change" })),
	doneWhen: Type.Optional(Type.String({ description: "tiny and feature: one plain sentence, what the user can see or run when it is done" })),
	assuming: Type.Optional(Type.Array(Type.String(), { description: "Decisions you made without asking, at most 5" })),
	slices: Type.Optional(Type.Array(Type.String(), { description: "feature only: the steps, at most 5" })),
});

export type FeatureAnswer = "go" | "change" | "stop" | "away" | "noHuman";

export interface BriefToolDeps {
	gate: BriefGate;
	/** The session id /pr compares with $CLAUDE_SESSION_ID. */
	sessionId: (ctx: ExtensionContext) => string;
	/** Asks the human to approve a feature brief. "away": nobody answered in time. "noHuman": nobody to ask. */
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
			"Before the first file change for a request the user typed, show them in plain words what you will build. Pick kind: question (no file changes; answer, no brief), tiny (one sentence, at most 3 files: shows 3 lines, then go on), feature (bigger: the user approves, then run /ship), vague (decisions only the user can make: run /specs), resume (the message answers or continues a /command already running).",
		promptSnippet: "Show the user what you will build before changing files",
		parameters: BriefParams,
		executionMode: "sequential",
		exposure: "model-only",
		// It writes .claude/memory/brief.json.
		annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
		async execute(_id, params, signal, _onUpdate, ctx) {
			const b = params as Brief;
			if (b.kind === "resume") {
				const flow = deps.gate.lastFlow;
				const open = deps.gate.briefPosted("resume");
				const reply = flow
					? `Go on with /${flow}.`
					: open
						? "Go on: this request already has a brief."
						: "No /command or dev-team flow ran in the previous request, so there is nothing to resume. Call dev_team_brief with kind tiny, feature or vague.";
				return { ...text(reply), details: { kind: b.kind, open } };
			}
			// Inside a running flow, its brief stays for its PR; otherwise an older brief must not reach a later one.
			const keepBrief = deps.gate.open || deps.gate.lastFlow !== undefined;
			if (b.kind === "question") {
				deps.gate.briefPosted("question");
				if (!keepBrief) clearBrief(ctx.cwd);
				return { ...text("No brief needed. Answer without changing files. If the answer needs file changes, call dev_team_brief again with kind tiny or feature."), details: { kind: b.kind } };
			}
			if (b.kind === "vague") {
				deps.gate.briefPosted("vague");
				if (!keepBrief) clearBrief(ctx.cwd);
				return { ...text("Run /specs now (skill tool, name specs) with the user's request as args. It asks the open decisions in rounds before anything is built."), details: { kind: b.kind } };
			}
			if (!b.building?.trim() || !b.doneWhen?.trim()) {
				return { ...text(`A ${b.kind} brief needs "building" and "doneWhen": one plain sentence each. Call dev_team_brief again.`), details: { kind: b.kind } };
			}
			const brief = renderBrief(b);
			const saved = { sessionId: deps.sessionId(ctx) };
			if (b.kind === "tiny") {
				deps.gate.briefPosted("tiny");
				deps.gate.baseline = diffSnapshot(ctx.cwd);
				saveBrief(ctx.cwd, b, { ...saved, approved: "tiny" });
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
			saveBrief(ctx.cwd, b, { ...saved, approved: answer === "go" ? "user" : "no answer" });
			if (answer === "away") deps.onAway("dev-team goes on without you", brief);
			const alone = answer === "go" ? "" : " Nobody answered, so you go on alone: keep the brief's assumptions; /pr lists them under \"Decide these\".";
			return { ...text(`Approved.${alone} Run /ship now (skill tool, name ship) with the brief's "Building" sentence as args.`), details: { kind: b.kind, answer, brief } };
		},
	});
}
