import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { type TestContext, test } from "node:test";
import { AUTOCOMPACT_CONFIG_KEY, AUTOCOMPACT_KEY, autocompactDue, autocompactSetting, describeAutocompact } from "../../extensions/dev-team/lib/autocompact.ts";

/** A throwaway project dir and user config file, removed after the test. */
function sandbox(t: TestContext) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dt-ac-"));
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	const project = path.join(dir, "project");
	const userConfigFile = path.join(dir, "agent", "dev-team.json");
	fs.mkdirSync(project);
	const writeSetting = (file: string, v: unknown) => {
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, JSON.stringify({ models: { opus: "inherit" }, [AUTOCOMPACT_CONFIG_KEY]: v }));
	};
	return {
		dir,
		project,
		userConfigFile,
		env: {} as NodeJS.ProcessEnv,
		opts: (extra: { env?: NodeJS.ProcessEnv; projectTrusted?: boolean } = {}) => ({ env: {}, projectTrusted: true, userConfigFile, ...extra }),
		writeUserSetting: (v: unknown) => writeSetting(userConfigFile, v),
		writeSharedSetting: (v: unknown) => writeSetting(path.join(project, ".pi", "dev-team.json"), v),
		writeLocalSetting: (v: unknown) => writeSetting(path.join(project, ".pi", "dev-team.local.json"), v),
	};
}

test("autocompact threshold accepts whole numbers 1-100, as a number or a plain string", (t) => {
	const cases: [unknown, number | undefined][] = [
		["1", 1],
		["40", 40],
		["100", 100],
		[40, 40],
		[100, 100],
		["0", undefined],
		["101", undefined],
		["040", undefined], // leading zero
		[" 40", undefined],
		["40.0", undefined],
		["+40", undefined],
		["abc", undefined],
		[0, undefined],
		[40.5, undefined],
	];
	const box = sandbox(t);
	for (const [raw, expected] of cases) {
		box.writeUserSetting(raw);
		const got = autocompactSetting(box.project, box.opts());
		assert.equal(got.thresholdPct, expected, `raw ${JSON.stringify(raw)}`);
		assert.equal(got.origin, "user dev-team.json");
	}
});

test("autocompact precedence: env, dev-team.local.json, dev-team.json, user dev-team.json", (t) => {
	const box = sandbox(t);
	assert.deepEqual(autocompactSetting(box.project, box.opts()), {});
	box.writeUserSetting("70");
	assert.equal(autocompactSetting(box.project, box.opts()).thresholdPct, 70);
	box.writeSharedSetting(40);
	assert.deepEqual(autocompactSetting(box.project, box.opts()), { thresholdPct: 40, origin: "dev-team.json" });
	box.writeLocalSetting("30");
	assert.deepEqual(autocompactSetting(box.project, box.opts()), { thresholdPct: 30, origin: "dev-team.local.json" });
	assert.deepEqual(autocompactSetting(box.project, box.opts({ env: { [AUTOCOMPACT_KEY]: "55" } })), { thresholdPct: 55, origin: "process env" });
});

test("autocompact: an invalid value in a higher source decides, it does not fall through", (t) => {
	const box = sandbox(t);
	box.writeSharedSetting("40");
	const got = autocompactSetting(box.project, box.opts({ env: { [AUTOCOMPACT_KEY]: "lots" } }));
	assert.equal(got.thresholdPct, undefined);
	assert.equal(got.origin, "process env");
	box.writeLocalSetting(0);
	assert.deepEqual(autocompactSetting(box.project, box.opts()), { thresholdPct: undefined, origin: "dev-team.local.json" });
});

test("autocompact: the user file defaults to <agentDir>/dev-team.json", (t) => {
	const box = sandbox(t);
	const saved = process.env.PI_CODING_AGENT_DIR;
	t.after(() => {
		if (saved === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = saved;
	});
	process.env.PI_CODING_AGENT_DIR = path.dirname(box.userConfigFile);
	box.writeUserSetting(25);
	assert.deepEqual(autocompactSetting(box.project, { env: {}, projectTrusted: true }), { thresholdPct: 25, origin: "user dev-team.json" });
});

test("autocompact: an env block in dev-team.json is not a source (the key is top-level only)", (t) => {
	const box = sandbox(t);
	box.writeUserSetting("70");
	fs.mkdirSync(path.join(box.project, ".pi"), { recursive: true });
	fs.writeFileSync(path.join(box.project, ".pi", "dev-team.json"), JSON.stringify({ env: { [AUTOCOMPACT_KEY]: "10" } }));
	assert.equal(autocompactSetting(box.project, box.opts()).thresholdPct, 70);
});

test("autocompact: a project file without the key, or one that is not an object, falls through", (t) => {
	const box = sandbox(t);
	box.writeUserSetting("70");
	fs.mkdirSync(path.join(box.project, ".pi"), { recursive: true });
	fs.writeFileSync(path.join(box.project, ".pi", "dev-team.local.json"), JSON.stringify({ maxParallelAgents: 2 }));
	fs.writeFileSync(path.join(box.project, ".pi", "dev-team.json"), JSON.stringify(["40"]));
	assert.equal(autocompactSetting(box.project, box.opts()).thresholdPct, 70);
});

test("autocompact: config files over 1 MB are not read", (t) => {
	const box = sandbox(t);
	box.writeUserSetting("70");
	fs.mkdirSync(path.join(box.project, ".pi"), { recursive: true });
	const padded = JSON.stringify({ [AUTOCOMPACT_CONFIG_KEY]: "10", pad: "x".repeat(1024 * 1024) });
	fs.writeFileSync(path.join(box.project, ".pi", "dev-team.json"), padded);
	assert.equal(autocompactSetting(box.project, box.opts()).thresholdPct, 70);
});

test("autocompact: malformed or non-file config is skipped, not fatal", (t) => {
	const box = sandbox(t);
	box.writeUserSetting("70");
	fs.mkdirSync(path.join(box.project, ".pi"), { recursive: true });
	fs.writeFileSync(path.join(box.project, ".pi", "dev-team.local.json"), "{not json");
	fs.mkdirSync(path.join(box.project, ".pi", "dev-team.json")); // a directory, not a file
	assert.equal(autocompactSetting(box.project, box.opts()).thresholdPct, 70);
});

test("autocompact: project config is ignored when the project is not trusted", (t) => {
	const box = sandbox(t);
	box.writeUserSetting("70");
	box.writeSharedSetting("1");
	assert.equal(autocompactSetting(box.project, box.opts()).thresholdPct, 1);
	assert.equal(autocompactSetting(box.project, box.opts({ projectTrusted: false })).thresholdPct, 70);
});

test("autocompactDue compares current usage with the threshold, inclusive", (t) => {
	const box = sandbox(t);
	box.writeUserSetting("40");
	const ctx = (percent: number | null | undefined) => ({
		cwd: box.project,
		isProjectTrusted: () => true,
		getContextUsage: () => (percent === undefined ? undefined : { tokens: percent === null ? null : 1, contextWindow: 100, percent }),
	});
	assert.equal(autocompactDue(ctx(39.9), { env: box.env, userConfigFile: box.userConfigFile }), undefined);
	assert.deepEqual(autocompactDue(ctx(40), { env: box.env, userConfigFile: box.userConfigFile }), { thresholdPct: 40, usedPct: 40 });
	assert.deepEqual(autocompactDue(ctx(40.1), { env: box.env, userConfigFile: box.userConfigFile }), { thresholdPct: 40, usedPct: 40.1 });
	assert.equal(autocompactDue(ctx(null), { env: box.env, userConfigFile: box.userConfigFile }), undefined, "unknown usage right after a compaction");
	assert.equal(autocompactDue(ctx(undefined), { env: box.env, userConfigFile: box.userConfigFile }), undefined, "no model");
});

test("autocompactDue ignores a project's own threshold when the project is not trusted", (t) => {
	const box = sandbox(t);
	box.writeUserSetting("90");
	box.writeSharedSetting("1");
	const ctx = (trusted: boolean, percent: number) => ({ cwd: box.project, isProjectTrusted: () => trusted, getContextUsage: () => ({ tokens: percent, contextWindow: 100, percent }) });
	assert.deepEqual(autocompactDue(ctx(true, 50), { env: box.env, userConfigFile: box.userConfigFile }), { thresholdPct: 1, usedPct: 50 });
	assert.equal(autocompactDue(ctx(false, 50), { env: box.env, userConfigFile: box.userConfigFile }), undefined);
	assert.deepEqual(autocompactDue(ctx(false, 95), { env: box.env, userConfigFile: box.userConfigFile }), { thresholdPct: 90, usedPct: 95 }, "the user's threshold applies");
});

test("autocompactDue is off when nothing configures a threshold", (t) => {
	const box = sandbox(t);
	const ctx = { cwd: box.project, isProjectTrusted: () => true, getContextUsage: () => ({ tokens: 99, contextWindow: 100, percent: 99 }) };
	assert.equal(autocompactDue(ctx, { env: box.env, userConfigFile: box.userConfigFile }), undefined);
});

/** A context of `tokens` used out of `window`; null tokens is pi's "unknown right after a compaction". */
function usageCtx(project: string, tokens: number | null, window = 1_000_000) {
	return {
		cwd: project,
		isProjectTrusted: () => true,
		getContextUsage: () => ({ tokens, contextWindow: window, percent: tokens === null ? null : (tokens / window) * 100 }),
	};
}

test("autocompactDue: the token ceiling alone compacts at the ceiling, inclusive", (t) => {
	const box = sandbox(t);
	const due = (tokens: number | null) => autocompactDue(usageCtx(box.project, tokens), { env: box.env, userConfigFile: box.userConfigFile, maxContextTokens: 200_000 });
	assert.equal(due(199_999), undefined, "one token below");
	assert.deepEqual(due(200_000), { usedPct: 20, tokens: { max: 200_000, used: 200_000 } }, "at the ceiling");
	assert.equal(due(null), undefined, "unknown usage right after a compaction");
	const noModel = { cwd: box.project, isProjectTrusted: () => true, getContextUsage: () => undefined };
	assert.equal(autocompactDue(noModel, { env: box.env, userConfigFile: box.userConfigFile, maxContextTokens: 200_000 }), undefined, "no model");
});

test("autocompactDue: a ceiling of 0, a negative or a non-number is off", (t) => {
	const box = sandbox(t);
	for (const max of [0, -1, Number.NaN, "200000" as unknown as number]) {
		assert.equal(autocompactDue(usageCtx(box.project, 900_000), { env: box.env, userConfigFile: box.userConfigFile, maxContextTokens: max }), undefined, `ceiling ${String(max)}`);
	}
});

test("autocompactDue: percentage and ceiling, whichever is reached first, and both", (t) => {
	const box = sandbox(t);
	box.writeUserSetting("40");
	const due = (tokens: number, window?: number) => autocompactDue(usageCtx(box.project, tokens, window), { env: box.env, userConfigFile: box.userConfigFile, maxContextTokens: 200_000 });
	assert.deepEqual(due(80_000, 200_000), { usedPct: 40, thresholdPct: 40 }, "percentage first on a 200k window");
	assert.deepEqual(due(250_000), { usedPct: 25, tokens: { max: 200_000, used: 250_000 } }, "ceiling first on a 1M window");
	assert.deepEqual(due(450_000), { usedPct: 45, thresholdPct: 40, tokens: { max: 200_000, used: 450_000 } }, "both reached");
});

test("autocompactDue: unknown tokens with a known percentage leave only the percentage", (t) => {
	const box = sandbox(t);
	box.writeUserSetting("40");
	const ctx = { cwd: box.project, isProjectTrusted: () => true, getContextUsage: () => ({ tokens: null, contextWindow: 1_000_000, percent: 45 }) };
	assert.deepEqual(autocompactDue(ctx, { env: box.env, userConfigFile: box.userConfigFile, maxContextTokens: 200_000 }), { usedPct: 45, thresholdPct: 40 });
});

test("describeAutocompact names every reason that fired", () => {
	assert.equal(describeAutocompact({ usedPct: 40, thresholdPct: 40 }), "dev-team: context at 40% (autocompact threshold 40%), compacting.");
	assert.equal(describeAutocompact({ usedPct: 25, tokens: { max: 200_000, used: 250_400 } }), "dev-team: context at 25% (250k tokens, autocompactMaxTokens 200k), compacting.");
	assert.equal(
		describeAutocompact({ usedPct: 45, thresholdPct: 40, tokens: { max: 200_000, used: 450_000 } }),
		"dev-team: context at 45% (autocompact threshold 40%; 450k tokens, autocompactMaxTokens 200k), compacting.",
	);
});
