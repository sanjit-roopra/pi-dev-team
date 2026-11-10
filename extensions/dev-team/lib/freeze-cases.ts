/**
 * dev_team_freeze_cases: the freeze step of the executable spec (`DEV_TEAM_EXAMPLES=spec`, gate profile).
 *
 * `scenario-author` writes `.dev-team/examples.json` from the saved requests alone, before the program changes.
 * This tool runs `example_replay.py --red --json --mode spec` against the unchanged program and records, per
 * case, the sha256 of its text in `.dev-team/requests/.frozen.json`: a case that fails now (red) is frozen; a
 * case that passes is frozen only when it says why (`already_passing`), since a case that passes before the code
 * exists tests nothing new. example_replay.py then fails on a case that is not frozen, changed after it was
 * frozen, or removed, so the implementing session cannot edit a case to fit its code. The freeze file sits in
 * the saved-request folder, which request-guard.ts keeps the model out of; this tool writes it with fs, not
 * through a tool call, so the guard does not apply to it. A frozen case is never re-frozen: a changed case is
 * reported and its old hash kept.
 *
 * The guard is a static scan, so the tool also keeps a copy of the freeze file outside the project
 * (freezeCopyPath, in pi's agent folder, which persists across the sessions of one project). The copy is the
 * record: a case deleted from or changed in the project's file is restored from it and reported, so deleting
 * `.frozen.json` and calling the tool again does not re-freeze edited cases, and example_replay.py reads the
 * same copy and fails on any difference.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { resolvePython } from "./hooks.ts";
import { REQUEST_DIR } from "./skills.ts";

export const DEV_TEAM_FREEZE_CASES_TOOL = "dev_team_freeze_cases";
export const FREEZE_FILE = path.join(REQUEST_DIR, ".frozen.json");
const RED_TIMEOUT_MS = 600_000;

/** One case of `example_replay.py --red --json`. */
export interface RedCase {
	hash: string;
	passed: boolean;
	derived?: boolean;
	already_passing?: boolean;
}

export interface RedReport {
	static_problems: string[];
	cases: Record<string, RedCase>;
}

export interface FrozenCase {
	hash: string;
	red: boolean;
	frozen_at: string;
}

export interface FreezeFile {
	version: 1;
	cases: Record<string, FrozenCase>;
}

/** The red run's report, or why there is none. */
export type RedRun = { report: RedReport } | { error: string };
export type RunRed = (cwd: string, signal: AbortSignal | undefined) => Promise<RedRun>;

export interface FreezeResult {
	file: FreezeFile;
	frozen: string[];
	unchanged: string[];
	refused: string[];
	violations: string[];
	notRun: string[];
	unknown: string[];
}

export const passesFirstMessage = (id: string) =>
	`${id} passes before implementation: a case must fail first. Write cases before code; if the behaviour exists from an earlier request, set already_passing with a reason. If it is an error case that the current program already rejects for another reason (an unknown option or command), add a first step that uses the new behaviour successfully, or check the error text the request states, so it fails until the feature exists.`;

/**
 * The copy of the freeze file outside the project (example_replay.py freeze_copy_path): `$DEV_TEAM_FREEZE_DIR`,
 * else `$PI_CODING_AGENT_DIR/dev-team-frozen` (`~/.pi/agent` by default), named by the project's real path.
 */
export function freezeCopyPath(cwd: string, env: NodeJS.ProcessEnv = process.env): string {
	const agent = env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
	const base = env.DEV_TEAM_FREEZE_DIR || path.join(agent, "dev-team-frozen");
	let real = path.resolve(cwd);
	try {
		real = fs.realpathSync.native(real);
	} catch {
		// a project folder that does not exist yet keeps its resolved path
	}
	return path.join(base, `${createHash("sha256").update(real, "utf-8").digest("hex").slice(0, 16)}.frozen.json`);
}

/** The copy, merged over the project's file: entries the project's file lost or changed come back, each a violation. */
export function restoreFromCopy(disk: FreezeFile, copy: FreezeFile | undefined): { file: FreezeFile; violations: string[] } {
	if (!copy) return { file: disk, violations: [] };
	const violations: string[] = [];
	for (const [id, entry] of Object.entries(copy.cases)) {
		const now = disk.cases[id];
		if (!now) violations.push(`frozen case ${id} was missing from ${FREEZE_FILE}: restored from the copy outside the project`);
		else if (now.hash !== entry.hash) violations.push(`frozen case ${id} had another hash in ${FREEZE_FILE}: restored from the copy outside the project`);
	}
	for (const id of Object.keys(disk.cases)) {
		if (!(id in copy.cases)) violations.push(`${FREEZE_FILE} named case ${id}, which this tool never froze: dropped`);
	}
	return { file: { version: 1, cases: { ...copy.cases } }, violations };
}

/** Applies a red run to the freeze file: freezes new red (or already_passing) cases, keeps frozen ones, reports the rest. `ids` limits what may be frozen. */
export function freezeCases(report: RedReport, existing: FreezeFile, now: Date, ids?: readonly string[]): FreezeResult {
	const file: FreezeFile = { version: 1, cases: { ...existing.cases } };
	const result: FreezeResult = { file, frozen: [], unchanged: [], refused: [], violations: [], notRun: [], unknown: [] };
	const wanted = ids?.length ? new Set(ids) : undefined;
	for (const [id, red] of Object.entries(report.cases)) {
		const frozen = existing.cases[id];
		if (frozen) {
			if (frozen.hash === red.hash) result.unchanged.push(id);
			else result.violations.push(`case ${id} changed after it was frozen: restore it; a changed spec needs superseded_by and a new case`);
			continue;
		}
		if (wanted && !wanted.has(id)) continue;
		if (red.passed && !red.already_passing) {
			result.refused.push(passesFirstMessage(id));
			continue;
		}
		file.cases[id] = { hash: red.hash, red: !red.passed, frozen_at: now.toISOString() };
		result.frozen.push(id);
	}
	// The red run reports active cases only, so a frozen case missing from it may be superseded; the replay check judges removals.
	result.notRun = Object.keys(existing.cases).filter((id) => !(id in report.cases));
	result.unknown = wanted ? [...wanted].filter((id) => !(id in report.cases)) : [];
	return result;
}

/** The text the model reads. */
export function freezeSummary(r: FreezeResult): string {
	const red = r.frozen.filter((id) => r.file.cases[id].red).length;
	const lines = [
		`dev_team_freeze_cases: frozen ${r.frozen.length} (${red} red, ${r.frozen.length - red} already passing), unchanged ${r.unchanged.length}, refused ${r.refused.length}, violations ${r.violations.length}.`,
	];
	if (r.frozen.length) lines.push(`Frozen: ${r.frozen.join(", ")}`);
	if (r.refused.length) lines.push("Refused (not frozen):", ...r.refused.map((x) => `- ${x}`));
	if (r.violations.length) lines.push("Violations (frozen hash kept):", ...r.violations.map((x) => `- ${x}`));
	if (r.unknown.length) lines.push(`Not in the case file or superseded: ${r.unknown.join(", ")}`);
	if (r.notRun.length) lines.push(`Frozen but not run (superseded, or removed, which example_replay.py reports): ${r.notRun.join(", ")}`);
	if (r.refused.length) lines.push("Dispatch scenario-author with the refusals, then call dev_team_freeze_cases again.");
	return lines.join("\n");
}

function isRedReport(value: unknown): value is RedReport {
	const v = value as RedReport;
	if (!v || typeof v !== "object" || !Array.isArray(v.static_problems) || !v.cases || typeof v.cases !== "object") return false;
	return Object.values(v.cases).every((c) => c && typeof c.hash === "string" && typeof c.passed === "boolean");
}

/** Parses the script's stdout; any exit code (static problems exit 1). */
export function parseRedOutput(stdout: string, stderr = ""): RedRun {
	try {
		const parsed: unknown = JSON.parse(stdout);
		if (isRedReport(parsed)) return { report: parsed };
	} catch {
		// reported below
	}
	const tail = `${stdout}\n${stderr}`.trim().slice(-2000);
	return { error: `example_replay.py --red --json printed no report${tail ? `:\n${tail}` : "."}` };
}

/** Runs `python3 <packageRoot>/scripts/example_replay.py --red --json --mode spec` in cwd. */
export function pythonRedRunner(packageRoot: string, python: () => string | null = resolvePython): RunRed {
	const script = path.join(packageRoot, "scripts", "example_replay.py");
	return (cwd, signal) =>
		new Promise((resolve) => {
			const interpreter = python();
			if (!interpreter) {
				resolve({ error: "python >= 3.10 not found (tried DEV_TEAM_PYTHON, python3, python): dev_team_freeze_cases needs it to run example_replay.py. Install python3 and call the tool again." });
				return;
			}
			execFile(
				interpreter,
				[script, "--red", "--json", "--mode", "spec"],
				{ cwd, env: process.env, timeout: RED_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024, signal },
				(err, stdout, stderr) => {
					const e = err as (NodeJS.ErrnoException & { killed?: boolean }) | null;
					if (e?.code === "ENOENT") resolve({ error: `${interpreter} could not be started: dev_team_freeze_cases needs python >= 3.10.` });
					else if (e?.killed || e?.name === "AbortError") resolve({ error: `example_replay.py --red did not finish (timeout ${RED_TIMEOUT_MS / 1000} s or aborted); nothing was frozen.` });
					else resolve(parseRedOutput(String(stdout), String(stderr)));
				},
			);
		});
}

/** The freeze file, empty when missing; undefined when it exists but is not a freeze file. `file` overrides its path. */
export function readFreezeFile(cwd: string, file = path.join(cwd, FREEZE_FILE)): FreezeFile | undefined {
	let text: string;
	try {
		text = fs.readFileSync(file, "utf-8");
	} catch {
		return { version: 1, cases: {} };
	}
	try {
		const data = JSON.parse(text) as FreezeFile;
		if (data?.version === 1 && data.cases && typeof data.cases === "object" && !Array.isArray(data.cases)) return data;
	} catch {
		// reported by the caller
	}
	return undefined;
}

/** Writes the freeze file (temp file, then rename), never through a symlinked `.dev-team` or requests folder. */
export function writeFreezeFile(cwd: string, file: FreezeFile): string | undefined {
	let at = cwd;
	for (const part of REQUEST_DIR.split(path.sep)) {
		at = path.join(at, part);
		try {
			if (fs.lstatSync(at).isSymbolicLink()) return `${path.relative(cwd, at)} is a symlink; the freeze file was not written.`;
		} catch {
			break; // does not exist yet
		}
	}
	try {
		fs.mkdirSync(path.join(cwd, REQUEST_DIR), { recursive: true });
		const tmp = path.join(cwd, `${FREEZE_FILE}.${process.pid}.tmp`);
		fs.writeFileSync(tmp, `${JSON.stringify(file, null, 2)}\n`, "utf-8");
		fs.renameSync(tmp, path.join(cwd, FREEZE_FILE));
		return undefined;
	} catch (err) {
		return `the freeze file could not be written: ${(err as Error).message}`;
	}
}

/** Writes the copy outside the project (temp file, then rename). */
export function writeFreezeCopy(copyPath: string, file: FreezeFile): string | undefined {
	try {
		fs.mkdirSync(path.dirname(copyPath), { recursive: true });
		const tmp = `${copyPath}.${process.pid}.tmp`;
		fs.writeFileSync(tmp, `${JSON.stringify(file, null, 2)}\n`, "utf-8");
		fs.renameSync(tmp, copyPath);
		return undefined;
	} catch (err) {
		return `the copy of the freeze file (${copyPath}) could not be written: ${(err as Error).message}`;
	}
}

const Params = Type.Object({
	ids: Type.Optional(Type.Array(Type.String(), { description: "Freeze only these case ids (default: every case not yet frozen)" })),
});

const reply = (text: string, details: Record<string, unknown>) => ({ content: [{ type: "text" as const, text }], details });

export interface FreezeCasesDeps {
	packageRoot: string;
	/** Replaces the python red run (tests). */
	runRed?: RunRed;
	now?: () => Date;
	/** Where the copy outside the project lives (default: freezeCopyPath). */
	copyPath?: (cwd: string) => string;
}

export function registerFreezeCases(pi: ExtensionAPI, deps: FreezeCasesDeps): void {
	const runRed = deps.runRed ?? pythonRedRunner(deps.packageRoot);
	pi.registerTool({
		name: DEV_TEAM_FREEZE_CASES_TOOL,
		label: "Freeze cases",
		description:
			"Run every case in .dev-team/examples.json against the program as it is now (example_replay.py --red) and freeze each new case that fails, or that passes and sets already_passing, by recording its hash in .dev-team/requests/.frozen.json. Call it after scenario-author writes the cases and before you change program code. A frozen case may not change; example_replay.py fails on an unfrozen, changed or removed case.",
		promptSnippet: "Freeze the acceptance cases after they fail against the unchanged program",
		parameters: Params,
		executionMode: "sequential",
		// It runs the program under test, so only the model may call it, never a codemode script.
		exposure: "model-only",
		// It writes .dev-team/requests/.frozen.json and runs the project's program.
		annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
		async execute(_id, params, signal, _onUpdate, ctx: ExtensionContext) {
			const copyPath = (deps.copyPath ?? freezeCopyPath)(ctx.cwd);
			const copy = fs.existsSync(copyPath) ? readFreezeFile(ctx.cwd, copyPath) : undefined;
			const disk = readFreezeFile(ctx.cwd) ?? (copy ? { version: 1 as const, cases: {} } : undefined);
			if (!disk) return reply(`${FREEZE_FILE} is not a valid freeze file; nothing was frozen. Only a human can fix or delete it.`, { ok: false });
			// The copy outside the project is the record: what the project's file lost or changed comes back.
			const { file: existing, violations: restored } = restoreFromCopy(disk, copy);
			const run = await runRed(ctx.cwd, signal);
			if ("error" in run) return reply(run.error, { ok: false });
			if (run.report.static_problems.length) {
				return reply(
					[`example_replay.py reports ${run.report.static_problems.length} static problem(s); nothing was frozen. Dispatch scenario-author with them, then call dev_team_freeze_cases again:`, ...run.report.static_problems.map((p) => `- ${p}`)].join("\n"),
					{ ok: false, staticProblems: run.report.static_problems },
				);
			}
			const result = freezeCases(run.report, existing, deps.now?.() ?? new Date(), params.ids);
			result.violations.unshift(...restored);
			// A freeze file from before the copy existed gets one.
			if (result.frozen.length || restored.length || (!copy && Object.keys(result.file.cases).length)) {
				const problem = writeFreezeFile(ctx.cwd, result.file) ?? writeFreezeCopy(copyPath, result.file);
				if (problem) return reply(`${problem} Nothing was frozen.`, { ok: false });
			}
			return reply(freezeSummary(result), { ok: true, frozen: result.frozen, unchanged: result.unchanged, refused: result.refused, violations: result.violations });
		},
	});
}
