import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { type TestContext, test } from "node:test";
import {
	FREEZE_FILE,
	type FreezeFile,
	freezeCases,
	freezeCopyPath,
	parseRedOutput,
	passesFirstMessage,
	pythonRedRunner,
	type RedReport,
	type RedRun,
	readFreezeFile,
	registerFreezeCases,
} from "../../extensions/dev-team/lib/freeze-cases.ts";
import { REQUEST_DIR } from "../../extensions/dev-team/lib/skills.ts";

type Result = { content: { text: string }[]; details: Record<string, unknown> };
type Execute = (id: string, params: unknown, signal: AbortSignal | undefined, onUpdate: unknown, ctx: unknown) => Promise<Result>;

const NOW = new Date("2026-11-09T12:00:00.000Z");
/** Copies of freeze files go here, never to the user's pi folder. */
const COPIES = fs.mkdtempSync(path.join(os.tmpdir(), "dt-freeze-copies-"));
process.env.DEV_TEAM_FREEZE_DIR = COPIES;
const copyOf = (cwd: string) => freezeCopyPath(cwd, { DEV_TEAM_FREEZE_DIR: COPIES });
const H = (c: string) => c.repeat(64);

function project(t: TestContext): string {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "dt-freeze-"));
	t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
	return cwd;
}

/** The tool with a stubbed red run that returns `runs` in order. */
function tool(runs: RedRun[]) {
	let execute: Execute | undefined;
	const calls: string[] = [];
	registerFreezeCases({ registerTool: (def: { execute: Execute }) => (execute = def.execute) } as never, {
		packageRoot: "/pkg",
		now: () => NOW,
		copyPath: copyOf,
		runRed: async (cwd) => {
			calls.push(cwd);
			return runs.shift() ?? { error: "no more runs" };
		},
	});
	const run = (cwd: string, params: unknown = {}) => (execute as Execute)("1", params, undefined, undefined, { cwd });
	return { run, calls };
}

const report = (cases: RedReport["cases"], static_problems: string[] = []): RedRun => ({ report: { static_problems, cases } });
const frozen = (cwd: string) => JSON.parse(fs.readFileSync(path.join(cwd, FREEZE_FILE), "utf-8")) as FreezeFile;

test("freeze: red cases and already_passing cases are frozen; a green case without a reason is refused", async (t) => {
	const cwd = project(t);
	const { run, calls } = tool([
		report({
			a: { hash: H("a"), passed: false, derived: false, already_passing: false },
			b: { hash: H("b"), passed: false, derived: true, already_passing: false },
			c: { hash: H("c"), passed: true, derived: false, already_passing: true },
			d: { hash: H("d"), passed: true, derived: true, already_passing: false },
		}),
	]);
	const r = await run(cwd);
	assert.deepEqual(calls, [cwd]);
	assert.deepEqual(frozen(cwd), {
		version: 1,
		cases: {
			a: { hash: H("a"), red: true, frozen_at: NOW.toISOString() },
			b: { hash: H("b"), red: true, frozen_at: NOW.toISOString() },
			c: { hash: H("c"), red: false, frozen_at: NOW.toISOString() },
		},
	});
	assert.deepEqual(r.details.frozen, ["a", "b", "c"]);
	assert.match(r.content[0].text, /^dev_team_freeze_cases: frozen 3 \(2 red, 1 already passing\), unchanged 0, refused 1, violations 0\./);
	assert.ok(r.content[0].text.includes(passesFirstMessage("d")));
	assert.match(passesFirstMessage("d"), /^d passes before implementation: a case must fail first\. Write cases before code; if the behaviour exists from an earlier request, set already_passing with a reason\. If it is an error case that the current program already rejects for another reason .*add a first step that uses the new behaviour successfully/);
});

test("freeze: static problems freeze nothing and are returned", async (t) => {
	const cwd = project(t);
	const { run } = tool([report({}, ['rule not covered: "Each order has a price" (request-1.md)'])]);
	const r = await run(cwd);
	assert.equal(fs.existsSync(path.join(cwd, FREEZE_FILE)), false);
	assert.equal(r.details.ok, false);
	assert.match(r.content[0].text, /1 static problem\(s\); nothing was frozen/);
	assert.match(r.content[0].text, /- rule not covered: "Each order has a price"/);
	assert.match(r.content[0].text, /scenario-author/);
});

test("freeze: a frozen case keeps its hash; a changed one is a violation and is not re-frozen, even when it now fails", async (t) => {
	const cwd = project(t);
	fs.mkdirSync(path.join(cwd, REQUEST_DIR), { recursive: true });
	const before: FreezeFile = { version: 1, cases: { a: { hash: H("a"), red: true, frozen_at: "2026-11-01T00:00:00.000Z" }, b: { hash: H("b"), red: true, frozen_at: "2026-11-01T00:00:00.000Z" }, gone: { hash: H("9"), red: true, frozen_at: "2026-11-01T00:00:00.000Z" } } };
	fs.writeFileSync(path.join(cwd, FREEZE_FILE), JSON.stringify(before));
	const { run } = tool([report({ a: { hash: H("a"), passed: true }, b: { hash: H("e"), passed: false }, n: { hash: H("f"), passed: false } })]);
	const r = await run(cwd);
	assert.deepEqual(frozen(cwd).cases.a, before.cases.a, "an implemented case stays frozen");
	assert.deepEqual(frozen(cwd).cases.b, before.cases.b, "the old hash is kept");
	assert.deepEqual(frozen(cwd).cases.gone, before.cases.gone, "a superseded or removed case stays in the file");
	assert.equal(frozen(cwd).cases.n.hash, H("f"));
	assert.match(r.content[0].text, /unchanged 1, refused 0, violations 1/);
	assert.match(r.content[0].text, /case b changed after it was frozen: restore it; a changed spec needs superseded_by and a new case/);
	assert.match(r.content[0].text, /Frozen but not run .*: gone/);
});

test("freeze: nothing new leaves the file untouched; ids limits what is frozen", async (t) => {
	const cwd = project(t);
	const { run } = tool([report({ a: { hash: H("a"), passed: false }, b: { hash: H("b"), passed: false } }), report({ a: { hash: H("a"), passed: false }, b: { hash: H("b"), passed: false } })]);
	const r = await run(cwd, { ids: ["a", "zz"] });
	assert.deepEqual(Object.keys(frozen(cwd).cases), ["a"]);
	assert.match(r.content[0].text, /Not in the case file or superseded: zz/);
	const mtime = fs.statSync(path.join(cwd, FREEZE_FILE)).mtimeMs;
	const again = await run(cwd, { ids: ["a"] });
	assert.match(again.content[0].text, /frozen 0 .* unchanged 1/);
	assert.equal(fs.statSync(path.join(cwd, FREEZE_FILE)).mtimeMs, mtime);
});

test("freeze: a runner error, a corrupt freeze file or a symlinked folder freezes nothing", async (t) => {
	const cwd = project(t);
	assert.match((await tool([{ error: "python >= 3.10 not found" }]).run(cwd)).content[0].text, /python >= 3\.10 not found/);
	fs.mkdirSync(path.join(cwd, REQUEST_DIR), { recursive: true });
	fs.writeFileSync(path.join(cwd, FREEZE_FILE), "{not json");
	const stub = tool([report({ a: { hash: H("a"), passed: false } })]);
	assert.match((await stub.run(cwd)).content[0].text, /is not a valid freeze file; nothing was frozen/);
	assert.deepEqual(stub.calls, [], "no red run on a corrupt freeze file");
	assert.equal(readFreezeFile(cwd), undefined);

	const other = project(t);
	const real = project(t);
	fs.symlinkSync(real, path.join(other, ".dev-team"));
	const r = await tool([report({ a: { hash: H("a"), passed: false } })]).run(other);
	assert.match(r.content[0].text, /is a symlink; the freeze file was not written/);
	assert.equal(fs.existsSync(path.join(real, "requests", ".frozen.json")), false);
});

test("freezeCases is pure: the existing file object is not changed", () => {
	const existing: FreezeFile = { version: 1, cases: {} };
	const r = freezeCases({ static_problems: [], cases: { a: { hash: H("a"), passed: false } } }, existing, NOW);
	assert.deepEqual(existing.cases, {});
	assert.deepEqual(r.frozen, ["a"]);
});

test("parseRedOutput accepts the contract's JSON whatever the exit code and rejects anything else", () => {
	const ok = parseRedOutput(JSON.stringify({ static_problems: [], cases: { a: { hash: H("a"), passed: false, derived: true, already_passing: false } } }));
	assert.ok("report" in ok && ok.report.cases.a.derived);
	const bad = parseRedOutput("Traceback ...", "SyntaxError");
	assert.ok("error" in bad && /printed no report:\nTraceback \.\.\.\nSyntaxError/.test(bad.error));
	assert.ok("error" in parseRedOutput(JSON.stringify({ static_problems: [], cases: { a: { passed: false } } })));
});

test("pythonRedRunner: no python is a clear error; a real interpreter runs the script with --red --json --mode spec in cwd", async (t) => {
	const cwd = project(t);
	const none = await pythonRedRunner("/pkg", () => null)(cwd, undefined);
	assert.ok("error" in none && /python >= 3\.10 not found/.test(none.error));
	const missing = await pythonRedRunner("/pkg", () => path.join(cwd, "no-such-python"))(cwd, undefined);
	assert.ok("error" in missing && /could not be started/.test(missing.error));
	// A stand-in script that echoes its argv and cwd as the report's static problems.
	const pkg = project(t);
	fs.mkdirSync(path.join(pkg, "scripts"));
	fs.writeFileSync(
		path.join(pkg, "scripts", "example_replay.py"),
		"import json, os, sys\nprint(json.dumps({'static_problems': [' '.join(sys.argv[1:]), os.getcwd()], 'cases': {}}))\nsys.exit(1)\n",
	);
	const python = ["python3", "python"].find((p) => {
		try {
			return spawnSync(p, ["-c", "pass"]).status === 0;
		} catch {
			return false;
		}
	});
	if (!python) return t.skip("no python on PATH");
	const r = await pythonRedRunner(pkg, () => python)(cwd, undefined);
	assert.ok("report" in r, JSON.stringify(r));
	assert.equal(r.report.static_problems[0], "--red --json --mode spec");
	assert.equal(fs.realpathSync(r.report.static_problems[1]), fs.realpathSync(cwd));
});

test("freeze: deleting the freeze file does not let edited cases re-freeze: the copy outside the project restores it", async (t) => {
	const cwd = project(t);
	const { run } = tool([
		report({ a: { hash: H("a"), passed: false }, b: { hash: H("b"), passed: false } }),
		// After `find .dev-team -name .frozen.json -delete`, b edited to fit the program and marked already_passing.
		report({ a: { hash: H("a"), passed: true }, b: { hash: H("e"), passed: true, already_passing: true } }),
	]);
	await run(cwd);
	assert.deepEqual(JSON.parse(fs.readFileSync(copyOf(cwd), "utf-8")), frozen(cwd), "the copy matches the file");
	fs.rmSync(path.join(cwd, FREEZE_FILE));
	const r = await run(cwd);
	assert.equal(frozen(cwd).cases.b.hash, H("b"), "the old hash comes back, the edited case is not frozen");
	assert.equal(frozen(cwd).cases.b.red, true);
	assert.deepEqual(r.details.frozen, []);
	assert.match(r.content[0].text, /violations 3/);
	assert.match(r.content[0].text, /frozen case a was missing from \.dev-team\/requests\/\.frozen\.json: restored from the copy outside the project/);
	assert.match(r.content[0].text, /case b changed after it was frozen/);
});

test("freeze: a forged entry in the freeze file is dropped when a copy exists", async (t) => {
	const cwd = project(t);
	const { run } = tool([report({ a: { hash: H("a"), passed: false } }), report({ a: { hash: H("a"), passed: false }, x: { hash: H("f"), passed: true } })]);
	await run(cwd);
	const file = frozen(cwd);
	file.cases.x = { hash: H("f"), red: true, frozen_at: NOW.toISOString() };
	fs.writeFileSync(path.join(cwd, FREEZE_FILE), JSON.stringify(file));
	const r = await run(cwd);
	assert.deepEqual(Object.keys(frozen(cwd).cases), ["a"]);
	assert.match(r.content[0].text, /named case x, which this tool never froze: dropped/);
	assert.ok(r.content[0].text.includes(passesFirstMessage("x")));
});

test("freezeCopyPath agrees with example_replay.py freeze_copy_path", (t) => {
	const cwd = project(t);
	const python = ["python3", "python"].find((p) => spawnSync(p, ["-c", "pass"]).status === 0);
	if (!python) return t.skip("no python on PATH");
	const script = path.join(import.meta.dirname, "..", "..", "scripts");
	const env = { ...process.env, DEV_TEAM_FREEZE_DIR: "", PI_CODING_AGENT_DIR: path.join(cwd, "agent") };
	const out = spawnSync(python, ["-c", `import sys; sys.path.insert(0, ${JSON.stringify(script)}); import example_replay as r; from pathlib import Path; print(r.freeze_copy_path(Path(sys.argv[1])))`, cwd], { env, encoding: "utf-8" });
	assert.equal(out.status, 0, out.stderr);
	assert.equal(out.stdout.trim(), freezeCopyPath(cwd, { PI_CODING_AGENT_DIR: path.join(cwd, "agent") }));
	assert.match(freezeCopyPath(cwd, { PI_CODING_AGENT_DIR: "/a" }), /^\/a\/dev-team-frozen\/[0-9a-f]{16}\.frozen\.json$/);
});
