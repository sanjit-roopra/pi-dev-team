import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { type TestContext, test } from "node:test";
import { AUTOCOMPACT_KEY, autocompactDue, autocompactSetting } from "../../extensions/dev-team/lib/autocompact.ts";

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
		user: (v: unknown) => writeEnvBlock(path.join(home, ".claude", "settings.json"), { [AUTOCOMPACT_KEY]: v }),
		shared: (v: unknown) => writeEnvBlock(path.join(project, ".claude", "settings.json"), { [AUTOCOMPACT_KEY]: v }),
		local: (v: unknown) => writeEnvBlock(path.join(project, ".claude", "settings.local.json"), { [AUTOCOMPACT_KEY]: v }),
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
	const sb = sandbox(t);
	for (const [raw, expected] of cases) {
		sb.user(raw);
		const got = autocompactSetting(sb.project, { env: sb.env });
		assert.equal(got.thresholdPct, expected, `raw ${JSON.stringify(raw)}`);
		assert.equal(got.origin, "user settings.json");
	}
});

test("autocompact precedence: env, settings.local.json, settings.json, user settings", (t) => {
	const sb = sandbox(t);
	assert.deepEqual(autocompactSetting(sb.project, { env: sb.env }), {});
	sb.user("70");
	assert.equal(autocompactSetting(sb.project, { env: sb.env }).thresholdPct, 70);
	sb.shared("40");
	assert.equal(autocompactSetting(sb.project, { env: sb.env }).origin, "settings.json");
	sb.local("30");
	assert.equal(autocompactSetting(sb.project, { env: sb.env }).thresholdPct, 30);
	assert.equal(autocompactSetting(sb.project, { env: { ...sb.env, [AUTOCOMPACT_KEY]: "55" } }).thresholdPct, 55);
});

test("autocompact: an invalid value in a higher source decides, it does not fall through", (t) => {
	const sb = sandbox(t);
	sb.shared("40");
	const got = autocompactSetting(sb.project, { env: { ...sb.env, [AUTOCOMPACT_KEY]: "lots" } });
	assert.equal(got.thresholdPct, undefined);
	assert.equal(got.origin, "process env");
});

test("autocompact: CLAUDE_CONFIG_DIR replaces ~/.claude for user settings", (t) => {
	const sb = sandbox(t);
	sb.user("70");
	const configDir = path.join(sb.dir, "config");
	fs.mkdirSync(configDir);
	fs.writeFileSync(path.join(configDir, "settings.json"), JSON.stringify({ env: { [AUTOCOMPACT_KEY]: "25" } }));
	assert.equal(autocompactSetting(sb.project, { env: { ...sb.env, CLAUDE_CONFIG_DIR: configDir } }).thresholdPct, 25);
});

test("autocompact: malformed or non-file settings are skipped, not fatal", (t) => {
	const sb = sandbox(t);
	sb.user("70");
	fs.mkdirSync(path.join(sb.project, ".claude"), { recursive: true });
	fs.writeFileSync(path.join(sb.project, ".claude", "settings.local.json"), "{not json");
	fs.mkdirSync(path.join(sb.project, ".claude", "settings.json")); // a directory, not a file
	assert.equal(autocompactSetting(sb.project, { env: sb.env }).thresholdPct, 70);
});

test("autocompact: project settings are ignored when the project is not trusted", (t) => {
	const sb = sandbox(t);
	sb.user("70");
	sb.shared("1");
	assert.equal(autocompactSetting(sb.project, { env: sb.env, projectTrusted: true }).thresholdPct, 1);
	assert.equal(autocompactSetting(sb.project, { env: sb.env, projectTrusted: false }).thresholdPct, 70);
});

test("autocompactDue compares current usage with the threshold, inclusive", (t) => {
	const sb = sandbox(t);
	sb.user("40");
	const ctx = (percent: number | null | undefined, trusted = true) => ({
		cwd: sb.project,
		isProjectTrusted: () => trusted,
		getContextUsage: () => (percent === undefined ? undefined : { tokens: percent === null ? null : 1, contextWindow: 100, percent }),
	});
	assert.equal(autocompactDue(ctx(39.9), sb.env), undefined);
	assert.deepEqual(autocompactDue(ctx(40), sb.env), { thresholdPct: 40, usedPct: 40 });
	assert.deepEqual(autocompactDue(ctx(40.1), sb.env), { thresholdPct: 40, usedPct: 40.1 });
	assert.equal(autocompactDue(ctx(null), sb.env), undefined, "unknown usage right after a compaction");
	assert.equal(autocompactDue(ctx(undefined), sb.env), undefined, "no model");
});

test("autocompactDue is off when nothing configures a threshold", (t) => {
	const sb = sandbox(t);
	const ctx = { cwd: sb.project, isProjectTrusted: () => true, getContextUsage: () => ({ tokens: 99, contextWindow: 100, percent: 99 }) };
	assert.equal(autocompactDue(ctx, sb.env), undefined);
});
