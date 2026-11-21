/**
 * One-time move of dev-team's project state from the old `.claude/` folders to `.pi/dev-team/`
 * (STATE_DIR), and a copy of the user's telemetry consent and metrics from `~/.claude/` to
 * `<agentDir>/dev-team/`. The session_start handler runs it in the top session only (not in a
 * dispatched agent or a nested run, which share the folder and would race), before the SessionStart hooks
 * read the state.
 *
 * User: files are copied first, never moved (`~/.claude` may still be in use elsewhere), and only when
 * the target is absent and the source is a regular file. After a copy run without errors (and when
 * `~/.claude` exists), `<agentDir>/dev-team/.migrated-from-claude` is written and later runs copy nothing.
 *
 * Project: a base whose `.claude` is the user's `~/.claude` (pi run in the home folder) is skipped, and so
 * is a base that already has the `.pi/dev-team/.migrated-from-claude` marker. An entry moves only when the
 * old path exists with the expected kind (folder or file) and is not a symlink, no folder on either path
 * is a symlink, the new path does not exist, and git tracks nothing at the old path or above it (a cloned
 * repo cannot plant state). A folder on the old path with its own `.git`, or a `.claude` in another git
 * toplevel (nested repo, submodule), counts as tracked; any other git failure except "not a git
 * repository" leaves the state and adds a note, so the marker waits for a run that can check. A file moves
 * by link + unlink, so it never replaces a file that appeared at the new path. A folder moves through the
 * stage `<new>.migrating`, which is renamed into place only when complete; a folder that holds kept files
 * moves child by child into that stage, and a later run resumes an unfinished stage, merging it into the
 * new folder when that appeared since (never over a file; a clash is a note). An entry on another
 * filesystem (EXDEV) is skipped with a note, and what was staged goes back, so nothing is created. Each
 * entry and each copy has its own error handling, so one failure never stops the rest. After a run without
 * errors or notes, the base gets the marker (when something moved or `.pi/dev-team` already exists), and
 * later runs leave it alone.
 *
 * Kept in `.claude/`: the PR review gate file (`memory/.pr-review-passed`) and the ledgers
 * (`metrics/review-verdicts*`, `metrics/boundary-events.jsonl`, `metrics/gate-bypass-audit.jsonl`): moving
 * an untracked copy would let a planted file become a trusted one. Never touched: settings*.json,
 * CLAUDE.md, skills, commands, rules, plugins, projects, agents, worktrees (git links them by absolute
 * path) and Claude Code's own agent-memory folders.
 */
import { spawnSync } from "node:child_process";
import * as nodeFs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { STATE_DIR } from "./state-dir.ts";

export const LEGACY_DIR = ".claude";

/** Written to `.pi/dev-team/` of a base after a migration run without errors; such a base is skipped. */
export const MIGRATED_MARKER = ".migrated-from-claude";

/** Suffix of the stage a folder is moved into before it is renamed into place. */
export const STAGE_SUFFIX = ".migrating";

export interface MigratedEntry {
	/** Path under `.claude/`, moved to the same path under `.pi/dev-team/`. */
	entry: string;
	kind: "dir" | "file";
}

/** Project entries under `.claude/` that move to the same name under `.pi/dev-team/`. */
export const MIGRATED_ENTRIES: readonly MigratedEntry[] = [
	{ entry: "memory", kind: "dir" },
	{ entry: "metrics", kind: "dir" },
	{ entry: "plans", kind: "dir" },
	{ entry: "review-summaries", kind: "dir" },
	{ entry: "evals", kind: "dir" },
	{ entry: "init-state.json", kind: "file" },
	{ entry: "project-stack.json", kind: "file" },
	{ entry: "session-metrics.json", kind: "file" },
	{ entry: "telemetry.json", kind: "file" },
	{ entry: "code-intelligence-turn-state.json", kind: "file" },
	{ entry: "model-overrides.json", kind: "file" },
	{ entry: "session-model", kind: "file" },
	{ entry: path.join("hooks", "freeze-state.json"), kind: "file" },
	{ entry: path.join("hooks", "careful-state.json"), kind: "file" },
];

/** Files inside a migrated folder that stay in `.claude/`, with the name the notice gives them. */
const KEPT_CHILDREN: readonly { entry: string; keep: (name: string) => boolean; label: string }[] = [
	{ entry: "memory", keep: (name) => name === ".pr-review-passed", label: ".pr-review-passed" },
	{ entry: "metrics", keep: (name) => name.startsWith("review-verdicts"), label: "review-verdicts*" },
	{ entry: "metrics", keep: (name) => name === "boundary-events.jsonl", label: "boundary-events.jsonl" },
	{ entry: "metrics", keep: (name) => name === "gate-bypass-audit.jsonl", label: "gate-bypass-audit.jsonl" },
];

/** `.claude/` entries named in the notice when they exist: dev-team no longer reads them and leaves them. */
const LEFT_ENTRIES: readonly string[] = ["agents", "worktrees"];

/** User-level files copied from `~/.claude/` to `<agentDir>/dev-team/`. */
export const COPIED_USER_FILES: readonly string[] = ["telemetry.json", path.join("metrics", "telemetry.jsonl"), path.join("metrics", "artifact-usage.json")];

/** The file system calls the migration makes; tests inject failures through it. */
export type MigrateFs = Pick<
	typeof nodeFs,
	"lstatSync" | "statSync" | "readdirSync" | "mkdirSync" | "rmdirSync" | "renameSync" | "linkSync" | "unlinkSync" | "copyFileSync" | "writeFileSync" | "realpathSync"
>;

export interface MigrateOptions {
	home?: string;
	agentDir: string;
	fs?: MigrateFs;
	/** The git binary for the tracked-files check (default `git`). */
	git?: string;
}

export interface MigrationResult {
	/** Project entries moved, as `.claude/<entry>` relative to their base. */
	moved: string[];
	/** User files copied, as `~/.claude/<file>`. */
	copied: string[];
	/** Files kept in a migrated folder, as `.claude/<entry>/<name>` (gate file, ledgers). */
	kept: string[];
	/** `.claude/agents` / `.claude/worktrees` that exist and were left. */
	left: string[];
	/** Entries skipped for a reason the user can fix (another filesystem). */
	notes: string[];
	/** Every error, one per failed entry or copy; the rest still ran. */
	errors: string[];
	/** The first error, if any. */
	error?: string;
}

const codeOf = (e: unknown) => (e as NodeJS.ErrnoException | undefined)?.code;
const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e));
const coded = (message: string, code: string) => Object.assign(new Error(message), { code });

/** The git failure that made the tracked check fail closed, with a short reason. */
interface GitFailure {
	failed: string;
}

/** The reason a spawned git call failed, for the note. */
function gitReason(r: ReturnType<typeof spawnSync>): string {
	if (r.error) return codeOf(r.error) === "ETIMEDOUT" ? "timed out" : messageOf(r.error);
	const line = String(r.stderr ?? "").split("\n").map((l) => l.trim()).find(Boolean);
	return line ?? (r.signal ? `killed by ${r.signal}` : `exit ${r.status}`);
}

/** An EXDEV error that may have left part of a folder in its stage (`inStage`). */
const crossDevice = (e: unknown, inStage: boolean) => Object.assign(new Error(messageOf(e)), { code: "EXDEV", inStage });

class Migrator {
	readonly fs: MigrateFs;
	private readonly git: string;

	constructor(fs: MigrateFs, git: string) {
		this.fs = fs;
		this.git = git;
	}

	lstat(p: string): nodeFs.Stats | undefined {
		try {
			return this.fs.lstatSync(p);
		} catch {
			return undefined;
		}
	}

	realpath(p: string): string | undefined {
		try {
			return this.fs.realpathSync.native(p);
		} catch {
			return undefined;
		}
	}

	/** Whether any existing folder from `base` down to `rel`, or `rel` itself, is a symlink. */
	linkOnPath(base: string, rel: string): boolean {
		const parts = rel.split(path.sep).filter(Boolean);
		for (let i = 1; i <= parts.length; i++) {
			const st = this.lstat(path.join(base, ...parts.slice(0, i)));
			if (!st) return false;
			if (st.isSymbolicLink()) return true;
		}
		return false;
	}

	/**
	 * Whether a folder from `base/.claude` down to `rel` (a folder entry included, a file entry's own name not)
	 * holds its own `.git`: a nested repository or a submodule, whose files the project's index never lists.
	 */
	ownRepoOnPath(base: string, rel: string, kind: MigratedEntry["kind"]): boolean {
		const parts = rel.split(path.sep).filter(Boolean);
		const last = kind === "dir" ? parts.length : parts.length - 1;
		for (let i = 1; i <= last; i++) if (this.lstat(path.join(base, ...parts.slice(0, i), ".git"))) return true;
		return false;
	}

	/** Whether `p` is a real folder (not a symlink). */
	isDir(p: string): boolean {
		const st = this.lstat(p);
		return !!st && st.isDirectory() && !st.isSymbolicLink();
	}

	private runGit(cwd: string, args: string[]) {
		return spawnSync(this.git, ["-c", "core.fsmonitor=false", ...args], {
			cwd,
			encoding: "utf-8",
			timeout: 3000,
			maxBuffer: 64 * 1024 * 1024,
			env: { ...process.env, LC_ALL: "C", LANGUAGE: "" },
		});
	}

	/** The git toplevel of `dir`: a path, null outside a repository, or the failure. */
	private toplevel(dir: string): string | null | GitFailure {
		const r = this.runGit(dir, ["rev-parse", "--show-toplevel"]);
		if (r.status === 0) return String(r.stdout ?? "").trim();
		if (!r.error && /not a git repository/i.test(String(r.stderr ?? ""))) return null;
		return { failed: gitReason(r) };
	}

	/**
	 * Lowercased paths git tracks among the migrated entries of `base/.claude`, read once per base. A
	 * `.claude` with its own `.git`, or in another git toplevel than the base (nested repository,
	 * submodule), counts as tracked as a whole (`[".claude"]`). Fails closed on any other git failure
	 * except "not a git repository" (then nothing is tracked). No fsmonitor (a repo's config must not run a
	 * command here) and a 3 s timeout per call.
	 */
	trackedUnder(base: string): string[] | GitFailure {
		const legacy = path.join(base, LEGACY_DIR);
		const whole = [LEGACY_DIR.toLowerCase()];
		if (this.lstat(path.join(legacy, ".git"))) return whole;
		const mine = this.toplevel(base);
		if (mine !== null && typeof mine === "object") return mine;
		const theirs = this.toplevel(legacy);
		if (theirs !== null && typeof theirs === "object") return theirs;
		if (mine !== theirs) return whole;
		const specs = MIGRATED_ENTRIES.map((e) => path.join(LEGACY_DIR, e.entry).split(path.sep).join("/"));
		const r = this.runGit(base, ["ls-files", "-z", "--", ...specs.map((s) => `:(literal,icase)${s}`)]);
		if (r.status === 0) return String(r.stdout ?? "").split("\0").filter(Boolean).map((p) => p.toLowerCase());
		if (!r.error && /not a git repository/i.test(String(r.stderr ?? ""))) return [];
		return { failed: gitReason(r) };
	}

	/** Creates the missing folders down to `dir`, recording each one so a failure can remove them again. */
	mkdirs(dir: string, created: string[]) {
		const missing: string[] = [];
		for (let p = dir; !this.lstat(p) && path.dirname(p) !== p; p = path.dirname(p)) missing.unshift(p);
		for (const p of missing) {
			this.fs.mkdirSync(p);
			created.push(p);
		}
	}

	/** Removes folders `mkdirs` created, deepest first, while they are empty (one already gone is skipped). */
	undo(created: string[]) {
		for (const p of [...created].reverse()) {
			try {
				this.fs.rmdirSync(p);
			} catch (e) {
				if (codeOf(e) !== "ENOENT") return;
			}
		}
	}

	/** Throws EXDEV when `from` is on another filesystem than the nearest existing folder above `to`. */
	sameDevice(from: string, to: string) {
		let at = path.dirname(to);
		while (!this.lstat(at) && path.dirname(at) !== at) at = path.dirname(at);
		const a = this.lstat(from)?.dev;
		let b: number;
		try {
			b = this.fs.statSync(at).dev;
		} catch {
			return;
		}
		if (a !== undefined && a !== b) throw coded(`${from} is on another filesystem`, "EXDEV");
	}

	/** Moves a file by link + unlink (fails on an existing target), anything else by rename to an absent path. */
	moveOne(from: string, to: string) {
		if (!this.lstat(from)?.isFile()) {
			if (this.lstat(to)) throw coded(`${to} exists`, "EEXIST");
			this.fs.renameSync(from, to);
			return;
		}
		try {
			this.fs.linkSync(from, to);
		} catch (e) {
			// A filesystem without hard links: an exclusive copy keeps the no-overwrite rule.
			if (!["EPERM", "ENOTSUP", "EOPNOTSUPP", "ENOSYS"].includes(codeOf(e) ?? "")) throw e;
			this.fs.copyFileSync(from, to, nodeFs.constants.COPYFILE_EXCL);
		}
		this.fs.unlinkSync(from);
	}

	/** Moves `names` from folder `from` into folder `to`, never over an existing path; returns the names left. */
	moveChildren(from: string, to: string, names: string[]): string[] {
		const left: string[] = [];
		for (const name of names) {
			const target = path.join(to, name);
			if (this.lstat(target)) {
				left.push(name);
				continue;
			}
			try {
				this.moveOne(path.join(from, name), target);
			} catch (e) {
				if (codeOf(e) !== "EEXIST") throw e;
				left.push(name);
			}
		}
		return left;
	}

	/**
	 * After EXDEV: puts a folder's stage back into the old folder (renamed back whole when the old folder is
	 * gone, else child by child, never over an existing child) and removes the empty stage. Returns
	 * whether anything is still in the stage.
	 */
	restoreStage(stage: string, oldPath: string): boolean {
		try {
			if (!this.isDir(stage)) return false;
			if (!this.lstat(oldPath)) {
				this.fs.renameSync(stage, oldPath);
				return false;
			}
			if (this.moveChildren(stage, oldPath, this.fs.readdirSync(stage)).length) return true;
			this.fs.rmdirSync(stage);
			return false;
		} catch {
			return this.isDir(stage);
		}
	}

	/** Whether `base/.claude/<entry>` may move: exists with its kind, no symlink or own repository on the way, untracked. */
	movable(base: string, { entry, kind }: MigratedEntry, tracked: () => string[] | undefined): "absent" | "no" | "yes" {
		const oldRel = path.join(LEGACY_DIR, entry);
		const st = this.lstat(path.join(base, oldRel));
		if (!st) return "absent";
		if (st.isSymbolicLink() || this.linkOnPath(base, oldRel)) return "no";
		if (kind === "dir" ? !st.isDirectory() : !st.isFile()) return "no";
		if (this.ownRepoOnPath(base, oldRel, kind)) return "no";
		const files = tracked();
		const posix = oldRel.split(path.sep).join("/").toLowerCase();
		if (!files || files.some((f) => f === posix || f.startsWith(`${posix}/`) || posix.startsWith(`${f}/`))) return "no";
		return "yes";
	}

	/**
	 * Moves one entry of `base`. Returns whether it moved, the kept files it left and notes for the user.
	 * Throws on a failure (code EXDEV for another filesystem, with `inStage` when part of a folder could not
	 * go back from its stage), after removing the folders it created that are still empty.
	 */
	moveEntry(base: string, item: MigratedEntry, tracked: () => string[] | undefined): { moved: boolean; kept: string[]; notes: string[] } {
		const { entry, kind } = item;
		const none = { moved: false, kept: [], notes: [] };
		const oldRel = path.join(LEGACY_DIR, entry);
		const newRel = path.join(STATE_DIR, entry);
		const oldPath = path.join(base, oldRel);
		const newPath = path.join(base, newRel);
		const stage = newPath + STAGE_SUFFIX;
		const stageRel = newRel + STAGE_SUFFIX;
		if (this.linkOnPath(base, path.dirname(newRel))) return none;
		const staged = kind === "dir" && this.isDir(stage);
		if (kind === "dir" && !staged && this.lstat(stage)) return none;
		const target = this.lstat(newPath);
		if (target && !staged) return none;
		const source = this.movable(base, item, tracked);
		const rules = KEPT_CHILDREN.filter((k) => k.entry === entry);
		const split = () => {
			const children = this.fs.readdirSync(oldPath);
			return {
				kept: rules.filter((r) => children.some(r.keep)).map((r) => path.join(oldRel, r.label)),
				toMove: children.filter((name) => !rules.some((r) => r.keep(name))),
			};
		};
		if (target) {
			// An earlier run stopped with a stage, and the folder appeared since: merge the stage into it.
			if (!this.isDir(newPath)) return { ...none, notes: [`${stageRel} was left: ${newRel} exists and is not a folder`] };
			const notes: string[] = [];
			const staging = this.fs.readdirSync(stage);
			const stageLeft = this.moveChildren(stage, newPath, staging);
			let moved = stageLeft.length < staging.length;
			if (stageLeft.length) notes.push(`${stageRel} holds ${stageLeft.join(", ")}, which ${newRel} already has; merge them by hand`);
			else this.fs.rmdirSync(stage);
			if (source !== "yes") return { moved, kept: [], notes };
			const { kept, toMove } = split();
			for (const name of toMove) this.sameDevice(path.join(oldPath, name), path.join(newPath, name));
			const sourceLeft = this.moveChildren(oldPath, newPath, toMove);
			moved ||= sourceLeft.length < toMove.length;
			if (sourceLeft.length) notes.push(`${oldRel} holds ${sourceLeft.join(", ")}, which ${newRel} already has; merge them by hand`);
			return { moved, kept, notes };
		}
		if (source === "absent") {
			// The source is gone but its stage is there: an earlier run stopped before the last rename.
			if (!staged) return none;
			this.fs.renameSync(stage, newPath);
			return { moved: true, kept: [], notes: [] };
		}
		if (source === "no") return none;
		const created: string[] = [];
		try {
			if (kind === "file") {
				this.sameDevice(oldPath, newPath);
				this.mkdirs(path.dirname(newPath), created);
				this.moveOne(oldPath, newPath);
				return { moved: true, kept: [], notes: [] };
			}
			const { kept, toMove } = split();
			if (!kept.length && !staged) {
				this.sameDevice(oldPath, stage);
				this.mkdirs(path.dirname(stage), created);
				this.fs.renameSync(oldPath, stage);
				this.fs.renameSync(stage, newPath);
				return { moved: true, kept, notes: [] };
			}
			if (!toMove.length && !staged) return { moved: false, kept, notes: [] };
			for (const name of toMove) this.sameDevice(path.join(oldPath, name), path.join(stage, name));
			this.mkdirs(stage, created);
			const clashes: string[] = [];
			for (const name of toMove) {
				const to = path.join(stage, name);
				if (!this.lstat(to)) this.moveOne(path.join(oldPath, name), to);
				else clashes.push(name);
			}
			this.fs.renameSync(stage, newPath);
			const notes = clashes.length ? [`${oldRel} holds ${clashes.join(", ")}, which ${newRel} already has; merge them by hand`] : [];
			return { moved: true, kept, notes };
		} catch (e) {
			// Another filesystem: put what is staged back, so the note ("move it by hand") stays true.
			const exdev = codeOf(e) === "EXDEV";
			const inStage = exdev && kind === "dir" && this.restoreStage(stage, oldPath);
			this.undo(created);
			throw exdev ? crossDevice(e, inStage) : e;
		}
	}

	/** Copies one user file; returns whether it copied. */
	copyUserFile(home: string, agentDir: string, file: string): boolean {
		const from = path.join(home, LEGACY_DIR, file);
		const to = path.join(agentDir, "dev-team", file);
		if (!this.lstat(from)?.isFile() || this.lstat(to)) return false;
		this.fs.mkdirSync(path.dirname(to), { recursive: true });
		this.fs.copyFileSync(from, to, nodeFs.constants.COPYFILE_EXCL);
		return true;
	}

	/** Whether `base/.claude` is the user's `~/.claude`, by path or after resolving symlinks. */
	isHomeLegacy(base: string, home: string): boolean {
		const mine = path.resolve(base, LEGACY_DIR);
		const theirs = path.resolve(home, LEGACY_DIR);
		if (mine === theirs) return true;
		const a = this.realpath(mine);
		return a !== undefined && a === this.realpath(theirs);
	}
}

const pushNew = (list: string[], item: string) => {
	if (!list.includes(item)) list.push(item);
};

/** Copies the user files once: skipped when `<agentDir>/dev-team/` has the marker, which a run without errors writes. */
function copyUserFiles(m: Migrator, home: string, agentDir: string, result: MigrationResult) {
	const userState = path.join(agentDir, "dev-team");
	const marker = path.join(userState, MIGRATED_MARKER);
	if (m.lstat(marker)) return;
	const errors = result.errors.length;
	for (const file of COPIED_USER_FILES) {
		const shown = `~/${path.join(LEGACY_DIR, file)}`;
		try {
			if (m.copyUserFile(home, agentDir, file)) result.copied.push(shown);
		} catch (e) {
			result.errors.push(`copy ${shown}: ${messageOf(e)}`);
		}
	}
	// Nothing to copy from: no marker, so a fresh install creates nothing.
	if (result.errors.length !== errors || !m.isDir(path.join(home, LEGACY_DIR))) return;
	try {
		m.fs.mkdirSync(userState, { recursive: true });
		m.fs.writeFileSync(marker, `${new Date().toISOString()}\n`, { flag: "wx" });
	} catch (e) {
		if (codeOf(e) !== "EEXIST") result.errors.push(`write ${marker}: ${messageOf(e)}`);
	}
}

/**
 * Copies the user files, then migrates each distinct base (the session's cwd and its git toplevel).
 * Never throws: each failure is collected in `errors` (the first also in `error`) and the rest still runs.
 */
export function migrateLegacyState(bases: string[], opts: MigrateOptions): MigrationResult {
	const result: MigrationResult = { moved: [], copied: [], kept: [], left: [], notes: [], errors: [] };
	const m = new Migrator(opts.fs ?? nodeFs, opts.git ?? "git");
	const home = opts.home ?? os.homedir();
	copyUserFiles(m, home, opts.agentDir, result);
	for (const base of [...new Set(bases.map((b) => path.resolve(b)))]) {
		if (m.isHomeLegacy(base, home)) continue;
		const stateDir = path.join(base, STATE_DIR);
		if (m.lstat(path.join(stateDir, MIGRATED_MARKER))) continue;
		const problems = result.errors.length + result.notes.length;
		let tracked: string[] | GitFailure | null = null;
		const trackedOnce = () => {
			if (tracked === null) tracked = m.trackedUnder(base);
			return Array.isArray(tracked) ? tracked : undefined;
		};
		let movedHere = false;
		for (const item of MIGRATED_ENTRIES) {
			const oldRel = path.join(LEGACY_DIR, item.entry);
			const newRel = path.join(STATE_DIR, item.entry);
			try {
				const r = m.moveEntry(base, item, trackedOnce);
				for (const k of r.kept) pushNew(result.kept, k);
				for (const n of r.notes) result.notes.push(n);
				if (r.moved) {
					movedHere = true;
					pushNew(result.moved, oldRel);
				}
			} catch (e) {
				if (codeOf(e) !== "EXDEV") result.errors.push(`move ${oldRel}: ${messageOf(e)}`);
				else {
					const part = (e as { inStage?: boolean }).inStage ? ` (part of it is still in ${newRel + STAGE_SUFFIX})` : "";
					pushNew(result.notes, `${oldRel} is on another filesystem, move it by hand to ${newRel}${part}`);
				}
			}
		}
		// The tracked check failed closed: say so (one note per base), so the marker is not written.
		const failure = tracked as string[] | GitFailure | null;
		if (failure && !Array.isArray(failure)) result.notes.push(`git ls-files failed (${failure.failed}); ${path.join(base, LEGACY_DIR)} state left in place`);
		for (const entry of LEFT_ENTRIES) {
			const rel = path.join(LEGACY_DIR, entry);
			if (m.lstat(path.join(base, rel))) pushNew(result.left, rel);
		}
		const clean = result.errors.length + result.notes.length === problems;
		if (clean && (movedHere || m.isDir(stateDir)) && !m.linkOnPath(base, STATE_DIR)) {
			try {
				m.mkdirs(stateDir, []);
				m.fs.writeFileSync(path.join(stateDir, MIGRATED_MARKER), `${new Date().toISOString()}\n`, { flag: "wx" });
			} catch (e) {
				if (codeOf(e) !== "EEXIST") result.errors.push(`write ${path.join(STATE_DIR, MIGRATED_MARKER)}: ${messageOf(e)}`);
			}
		}
	}
	if (result.errors.length) result.error = result.errors[0];
	return result;
}

/** The one notice line for a migration that moved, copied or skipped something, else undefined. */
export function migrationNotice(result: MigrationResult, agentDir: string): string | undefined {
	if (!result.moved.length && !result.copied.length && !result.notes.length) return undefined;
	const parts = [
		...(result.moved.length ? [`moved ${result.moved.join(", ")} to ${STATE_DIR}/`] : []),
		...(result.copied.length ? [`copied ${result.copied.join(", ")} to ${path.join(agentDir, "dev-team")}/`] : []),
	];
	const head = parts.length ? `dev-team: one-time state move: ${parts.join("; ")}.` : "dev-team: one-time state move: nothing moved.";
	const kept = result.kept.length ? ` Kept the PR review gate file and the ledgers in .claude: ${result.kept.join(", ")}.` : "";
	const agentsLeft = result.left.includes(path.join(LEGACY_DIR, "agents")) ? " (project agents now load from .pi/agents)" : "";
	const left = result.left.length ? ` Left ${result.left.join(" and ")} where they are${agentsLeft}.` : "";
	const notes = result.notes.length ? ` Not moved: ${result.notes.join("; ")}.` : "";
	return `${head}${kept}${left}${notes}`;
}
