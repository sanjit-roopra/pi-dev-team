import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { type TestContext, test } from "node:test";
import { AUTOCOMPACT_KEY, autocompactDue, autocompactSetting, describeAutocompact } from "../../extensions/dev-team/lib/autocompact.ts";

/** A throwaway project dir and HOME, removed after the test. */
function sandbox(t: TestContext) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dt-ac-"));
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	const project = path.join(dir, "project");
	const home = path.join(dir, "home");
	fs.mkdirSync(project);
	const writeEnvBlock = (file: string, env: Record<string, unknown>) => {
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, JSON.stringify({ env }));
	};
	return {
		dir,
		project,
		env: { HOME: home } as NodeJS.ProcessEnv,
		writeUserSetting: (v: unknown) => writeEnvBlock(path.join(home, ".claude", "settings.json"), { [AUTOCOMPACT_KEY]: v }),
		writeSharedSetting: (v: unknown) => writeEnvBlock(path.join(project, ".claude", "settings.json"), { [AUTOCOMPACT_KEY]: v }),
		writeLocalSetting: (v: unknown) => writeEnvBlock(path.join(project, ".claude", "settings.local.json"), { [AUTOCOMPACT_KEY]: v }),
	};
}

test("autocompact threshold accepts only plain integers 1-100 (as upstream validate_pct)", (t) => {
	const cases: [unknown, number | undefined][] = [
		["1", 1],
		["40", 40],
		["100", 100],
		["0", undefined],
		["101", undefined],
		["040", undefined], // leading zero
		[" 40", undefined],
		["40.0", undefined],
		["+40", undefined],
		["abc", undefined],
		[40, undefined], // JSON number, not a string
	];
	const box = sandbox(t);
	for (const [raw, expected] of cases) {
		box.writeUserSetting(raw);
		const got = autocompactSetting(box.project, { env: box.env, projectTrusted: true });
		assert.equal(got.thresholdPct, expected, `raw ${JSON.stringify(raw)}`);
		assert.equal(got.origin, "user settings.json");
	}
});

test("autocompact precedence: env, settings.local.json, settings.json, user settings", (t) => {
	const box = sandbox(t);
	assert.deepEqual(autocompactSetting(box.project, { env: box.env, projectTrusted: true }), {});
	box.writeUserSetting("70");
	assert.equal(autocompactSetting(box.project, { env: box.env, projectTrusted: true }).thresholdPct, 70);
	box.writeSharedSetting("40");
	assert.equal(autocompactSetting(box.project, { env: box.env, projectTrusted: true }).origin, "settings.json");
	box.writeLocalSetting("30");
	assert.equal(autocompactSetting(box.project, { env: box.env, projectTrusted: true }).thresholdPct, 30);
	assert.equal(autocompactSetting(box.project, { env: { ...box.env, [AUTOCOMPACT_KEY]: "55" }, projectTrusted: true }).thresholdPct, 55);
});

test("autocompact: an invalid value in a higher source decides, it does not fall through", (t) => {
	const box = sandbox(t);
	box.writeSharedSetting("40");
	const got = autocompactSetting(box.project, { env: { ...box.env, [AUTOCOMPACT_KEY]: "lots" }, projectTrusted: true });
	assert.equal(got.thresholdPct, undefined);
	assert.equal(got.origin, "process env");
});

test("autocompact: CLAUDE_CONFIG_DIR replaces ~/.claude for user settings", (t) => {
	const box = sandbox(t);
	box.writeUserSetting("70");
	const configDir = path.join(box.dir, "config");
	fs.mkdirSync(configDir);
	fs.writeFileSync(path.join(configDir, "settings.json"), JSON.stringify({ env: { [AUTOCOMPACT_KEY]: "25" } }));
	assert.equal(autocompactSetting(box.project, { env: { ...box.env, CLAUDE_CONFIG_DIR: configDir }, projectTrusted: true }).thresholdPct, 25);
});

test("autocompact: a project file whose env lacks the key, or has a non-object env, falls through", (t) => {
	const box = sandbox(t);
	box.writeUserSetting("70");
	fs.mkdirSync(path.join(box.project, ".claude"), { recursive: true });
	fs.writeFileSync(path.join(box.project, ".claude", "settings.local.json"), JSON.stringify({ env: { OTHER: "1" } }));
	fs.writeFileSync(path.join(box.project, ".claude", "settings.json"), JSON.stringify({ env: ["40"] }));
	assert.equal(autocompactSetting(box.project, { env: box.env, projectTrusted: true }).thresholdPct, 70);
});

test("autocompact: settings files over 1 MB are not read", (t) => {
	const box = sandbox(t);
	box.writeUserSetting("70");
	fs.mkdirSync(path.join(box.project, ".claude"), { recursive: true });
	const padded = JSON.stringify({ env: { [AUTOCOMPACT_KEY]: "10" }, pad: "x".repeat(1024 * 1024) });
	fs.writeFileSync(path.join(box.project, ".claude", "settings.json"), padded);
	assert.equal(autocompactSetting(box.project, { env: box.env, projectTrusted: true }).thresholdPct, 70);
});

test("autocompact: malformed or non-file settings are skipped, not fatal", (t) => {
	const box = sandbox(t);
	box.writeUserSetting("70");
	fs.mkdirSync(path.join(box.project, ".claude"), { recursive: true });
	fs.writeFileSync(path.join(box.project, ".claude", "settings.local.json"), "{not json");
	fs.mkdirSync(path.join(box.project, ".claude", "settings.json")); // a directory, not a file
	assert.equal(autocompactSetting(box.project, { env: box.env, projectTrusted: true }).thresholdPct, 70);
});

test("autocompact: project settings are ignored when the project is not trusted", (t) => {
	const box = sandbox(t);
	box.writeUserSetting("70");
	box.writeSharedSetting("1");
	assert.equal(autocompactSetting(box.project, { env: box.env, projectTrusted: true }).thresholdPct, 1);
	assert.equal(autocompactSetting(box.project, { env: box.env, projectTrusted: false }).thresholdPct, 70);
});

test("autocompactDue compares current usage with the threshold, inclusive", (t) => {
	const box = sandbox(t);
	box.writeUserSetting("40");
	const ctx = (percent: number | null | undefined) => ({
		cwd: box.project,
		isProjectTrusted: () => true,
		getContextUsage: () => (percent === undefined ? undefined : { tokens: percent === null ? null : 1, contextWindow: 100, percent }),
	});
	assert.equal(autocompactDue(ctx(39.9), { env: box.env }), undefined);
	assert.deepEqual(autocompactDue(ctx(40), { env: box.env }), { thresholdPct: 40, usedPct: 40 });
	assert.deepEqual(autocompactDue(ctx(40.1), { env: box.env }), { thresholdPct: 40, usedPct: 40.1 });
	assert.equal(autocompactDue(ctx(null), { env: box.env }), undefined, "unknown usage right after a compaction");
	assert.equal(autocompactDue(ctx(undefined), { env: box.env }), undefined, "no model");
});

test("autocompactDue ignores a project's own threshold when the project is not trusted", (t) => {
	const box = sandbox(t);
	box.writeUserSetting("90");
	box.writeSharedSetting("1");
	const ctx = (trusted: boolean, percent: number) => ({ cwd: box.project, isProjectTrusted: () => trusted, getContextUsage: () => ({ tokens: percent, contextWindow: 100, percent }) });
	assert.deepEqual(autocompactDue(ctx(true, 50), { env: box.env }), { thresholdPct: 1, usedPct: 50 });
	assert.equal(autocompactDue(ctx(false, 50), { env: box.env }), undefined);
	assert.deepEqual(autocompactDue(ctx(false, 95), { env: box.env }), { thresholdPct: 90, usedPct: 95 }, "the user's threshold applies");
});

test("autocompactDue is off when nothing configures a threshold", (t) => {
	const box = sandbox(t);
	const ctx = { cwd: box.project, isProjectTrusted: () => true, getContextUsage: () => ({ tokens: 99, contextWindow: 100, percent: 99 }) };
	assert.equal(autocompactDue(ctx, { env: box.env }), undefined);
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
	const due = (tokens: number | null) => autocompactDue(usageCtx(box.project, tokens), { env: box.env, maxContextTokens: 200_000 });
	assert.equal(due(199_999), undefined, "one token below");
	assert.deepEqual(due(200_000), { usedPct: 20, tokens: { max: 200_000, used: 200_000 } }, "at the ceiling");
	assert.equal(due(null), undefined, "unknown usage right after a compaction");
	const noModel = { cwd: box.project, isProjectTrusted: () => true, getContextUsage: () => undefined };
	assert.equal(autocompactDue(noModel, { env: box.env, maxContextTokens: 200_000 }), undefined, "no model");
});

test("autocompactDue: a ceiling of 0, a negative or a non-number is off", (t) => {
	const box = sandbox(t);
	for (const max of [0, -1, Number.NaN, "200000" as unknown as number]) {
		assert.equal(autocompactDue(usageCtx(box.project, 900_000), { env: box.env, maxContextTokens: max }), undefined, `ceiling ${String(max)}`);
	}
});

test("autocompactDue: percentage and ceiling, whichever is reached first, and both", (t) => {
	const box = sandbox(t);
	box.writeUserSetting("40");
	const due = (tokens: number, window?: number) => autocompactDue(usageCtx(box.project, tokens, window), { env: box.env, maxContextTokens: 200_000 });
	assert.deepEqual(due(80_000, 200_000), { usedPct: 40, thresholdPct: 40 }, "percentage first on a 200k window");
	assert.deepEqual(due(250_000), { usedPct: 25, tokens: { max: 200_000, used: 250_000 } }, "ceiling first on a 1M window");
	assert.deepEqual(due(450_000), { usedPct: 45, thresholdPct: 40, tokens: { max: 200_000, used: 450_000 } }, "both reached");
});

test("autocompactDue: unknown tokens with a known percentage leave only the percentage", (t) => {
	const box = sandbox(t);
	box.writeUserSetting("40");
	const ctx = { cwd: box.project, isProjectTrusted: () => true, getContextUsage: () => ({ tokens: null, contextWindow: 1_000_000, percent: 45 }) };
	assert.deepEqual(autocompactDue(ctx, { env: box.env, maxContextTokens: 200_000 }), { usedPct: 45, thresholdPct: 40 });
});

test("describeAutocompact names every reason that fired", () => {
	assert.equal(describeAutocompact({ usedPct: 40, thresholdPct: 40 }), "dev-team: context at 40% (autocompact threshold 40%), compacting.");
	assert.equal(describeAutocompact({ usedPct: 25, tokens: { max: 200_000, used: 250_400 } }), "dev-team: context at 25% (250k tokens, autocompactMaxTokens 200k), compacting.");
	assert.equal(
		describeAutocompact({ usedPct: 45, thresholdPct: 40, tokens: { max: 200_000, used: 450_000 } }),
		"dev-team: context at 45% (autocompact threshold 40%; 450k tokens, autocompactMaxTokens 200k), compacting.",
	);
});
