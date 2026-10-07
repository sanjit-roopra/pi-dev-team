import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { type TestContext, test } from "node:test";
import { MAX_REPO_FILE_BYTES } from "../../extensions/dev-team/lib/safe-read.ts";
import {
	DEFAULT_CONFIG,
	filterProjectConfig,
	isProjectEnvSettingAllowed,
	loadConfig,
	MODEL_PRESETS,
	type ModelStatus,
	presetAdvice,
} from "../../extensions/dev-team/lib/config.ts";

/** A project with .pi/dev-team.json and .pi/dev-team.local.json, and a user config file. */
function fixture(t: TestContext) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dt-config-"));
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	const project = path.join(dir, "project");
	fs.mkdirSync(path.join(project, ".pi"), { recursive: true });
	const userConfigFile = path.join(dir, "user.json");
	fs.writeFileSync(userConfigFile, JSON.stringify({ env: { FROM_USER: "1", PATH: "/user/bin" }, maxParallelAgents: 3 }));
	fs.writeFileSync(
		path.join(project, ".pi", "dev-team.json"),
		JSON.stringify({ env: { DEV_TEAM_MAX_PARALLEL_BUILDS: "2", PATH: "/evil/bin", NODE_OPTIONS: "--require x", DEV_TEAM_PYTHON: "/evil/py", DEV_TEAM_PY_CACHE: "docs/py" }, maxParallelAgents: 4 }),
	);
	fs.writeFileSync(path.join(project, ".pi", "dev-team.local.json"), JSON.stringify({ hooks: { disabled: ["repo_review_nudge"] } }));
	return { project, userConfigFile };
}

test("loadConfig: a trusted project's config is merged over the user config", (t) => {
	const { project, userConfigFile } = fixture(t);
	const { config, sources } = loadConfig(project, { includeProject: true, userConfigFile });
	assert.equal(config.maxParallelAgents, 4);
	assert.equal(config.env.DEV_TEAM_MAX_PARALLEL_BUILDS, "2");
	assert.deepEqual(config.hooks, DEFAULT_CONFIG.hooks, "a project cannot change hooks");
	assert.equal(sources.length, 3);
});

test("loadConfig: an untrusted project's config is not read at all", (t) => {
	const { project, userConfigFile } = fixture(t);
	const { config, sources } = loadConfig(project, { includeProject: false, userConfigFile });
	assert.equal(config.maxParallelAgents, 3);
	assert.equal(config.env.DEV_TEAM_MAX_PARALLEL_BUILDS, undefined);
	assert.ok(config.hooks.disabled.includes("cost_meter"), "defaults, not the project's list");
	assert.deepEqual(sources, [userConfigFile]);
});

test("loadConfig: project env cannot set PATH, NODE_OPTIONS, file paths or the programs the port runs", (t) => {
	const { project, userConfigFile } = fixture(t);
	const { config, ignoredProjectSettings } = loadConfig(project, { includeProject: true, userConfigFile });
	assert.equal(config.env.PATH, "/user/bin", "the user's own value stays");
	assert.equal(config.env.NODE_OPTIONS, undefined);
	assert.equal(config.env.DEV_TEAM_PYTHON, undefined);
	assert.equal(config.env.DEV_TEAM_PY_CACHE, undefined, "hooks/py.sh executes the command stored in this file");
	assert.equal(config.env.FROM_USER, "1", "user config env is not filtered");
	assert.deepEqual(ignoredProjectSettings.sort(), ["env.DEV_TEAM_PYTHON", "env.DEV_TEAM_PY_CACHE", "env.NODE_OPTIONS", "env.PATH", "hooks"]);
});

test("project env settings: tuning keys allowed", () => {
	for (const key of ["DEV_TEAM_MAX_PARALLEL_BUILDS", "DEV_TEAM_COST_METER", "DEV_TEAM_AUTOCOMPACT_NUDGE", "DEV_TEAM_REPO_REVIEW_MIN_ADDED_LINES"]) {
		assert.ok(isProjectEnvSettingAllowed(key, "2"), key);
	}
});

test("project env settings: paths, programs, gate bypasses and other env refused", () => {
	const refused = [
		"PATH", "PYTHONPATH", "NODE_OPTIONS", "LD_PRELOAD", "GIT_SSH_COMMAND", "CLAUDE_CONFIG_DIR", "PR_GATE_BYPASS_REASON",
		"DEV_TEAM_PY_CACHE", "DEV_TEAM_PYTHON", "DEV_TEAM_PI_BIN", "DEV_TEAM_REAL_CLAUDE", "DEV_TEAM_PI_ARGS", "DEV_TEAM_TRUSTED_DIR",
		"DEV_TEAM_AUTO_APPROVE", "DEV_TEAM_GUARD_OVERRIDE", "DEV_TEAM_STRYKER_XUNIT3_GATE_SKIP", "DEV_TEAM_XUNIT3_SHIM_DECISION_FILE",
		"DEV_TEAM_VERIFY_THRESHOLD", "DEV_TEAM_BASH_RETRY_THRESHOLD",
	];
	for (const key of refused) assert.ok(!isProjectEnvSettingAllowed(key, "1"), key);
});

test("project env settings: values must be plain numbers, words or flags", () => {
	assert.ok(isProjectEnvSettingAllowed("DEV_TEAM_MAX_PARALLEL_BUILDS", 2));
	assert.ok(isProjectEnvSettingAllowed("DEV_TEAM_COST_METER", "off"));
	assert.ok(!isProjectEnvSettingAllowed("DEV_TEAM_COST_METER", "off; rm -rf ~"));
	assert.ok(!isProjectEnvSettingAllowed("DEV_TEAM_COST_METER", "../x"));
	assert.ok(!isProjectEnvSettingAllowed("DEV_TEAM_COST_METER", { x: 1 }));
});

test("filterProjectConfig: configs without env are untouched", () => {
	const data = { maxParallelAgents: 2 };
	assert.deepEqual(filterProjectConfig(data), { data, ignored: [] });
});

test("filterProjectConfig: an env that is not an object is dropped whole", () => {
	for (const env of [["x"], "abc", null, 1]) {
		assert.deepEqual(filterProjectConfig({ env, maxParallelAgents: 2 }), { data: { maxParallelAgents: 2 }, ignored: ["env"] }, JSON.stringify(env));
	}
});

test("loadConfig: a malformed project env does not replace the user's env", (t) => {
	const { project, userConfigFile } = fixture(t);
	fs.writeFileSync(path.join(project, ".pi", "dev-team.json"), JSON.stringify({ env: ["x"] }));
	const { config, ignoredProjectSettings } = loadConfig(project, { includeProject: true, userConfigFile });
	assert.equal(config.env.FROM_USER, "1");
	assert.equal(config.env["0"], undefined);
	assert.deepEqual(ignoredProjectSettings.sort(), ["env", "hooks"], "the fixture's local file also carries hooks");
});

test("loadConfig: an oversized project config file is skipped", (t) => {
	const { project, userConfigFile } = fixture(t);
	fs.writeFileSync(path.join(project, ".pi", "dev-team.json"), JSON.stringify({ maxParallelAgents: 9, pad: "x".repeat(MAX_REPO_FILE_BYTES) }));
	const userOnly = loadConfig(project, { includeProject: false, userConfigFile }).config.maxParallelAgents;
	assert.equal(loadConfig(project, { includeProject: true, userConfigFile }).config.maxParallelAgents, userOnly);
});

test("project hooks: ignored whatever their shape; the user's own hooks config stands", (t) => {
	for (const hooks of [{ enabled: false }, { disabled: ["destructive_guard"] }, { enable: 5 }, { timeoutSec: 1 }, [], "x", null]) {
		assert.deepEqual(filterProjectConfig({ hooks, maxParallelAgents: 2 }), { data: { maxParallelAgents: 2 }, ignored: ["hooks"] }, JSON.stringify(hooks));
	}
	const { project, userConfigFile } = fixture(t);
	fs.writeFileSync(userConfigFile, JSON.stringify({ hooks: { disabled: ["repo_review_nudge"] } }));
	fs.writeFileSync(path.join(project, ".pi", "dev-team.local.json"), JSON.stringify({ hooks: { disabled: ["destructive_guard"], enable: [] }, env: { NODE_OPTIONS: "x" } }));
	const { config, ignoredProjectSettings } = loadConfig(project, { includeProject: true, userConfigFile });
	assert.deepEqual(config.hooks.disabled, ["repo_review_nudge"], "the user's list, untouched by the project");
	assert.ok(ignoredProjectSettings.includes("hooks"));
	assert.ok(ignoredProjectSettings.includes("env.NODE_OPTIONS"), "the local project file is filtered too");
});

test("project env settings: over-long values and booleans", () => {
	assert.ok(isProjectEnvSettingAllowed("DEV_TEAM_COST_METER", true));
	assert.ok(isProjectEnvSettingAllowed("DEV_TEAM_COST_METER", "x".repeat(64)));
	assert.ok(!isProjectEnvSettingAllowed("DEV_TEAM_COST_METER", "x".repeat(65)));
});

test("loadConfig: githubStyle keeps a valid mode and falls back to the default for anything else", (t) => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dt-style-cfg-"));
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	const userConfigFile = path.join(dir, "user.json");
	const load = (githubStyle: unknown) => {
		fs.writeFileSync(userConfigFile, JSON.stringify({ githubStyle }));
		return loadConfig(dir, { includeProject: false, userConfigFile }).config.githubStyle;
	};
	assert.equal(DEFAULT_CONFIG.githubStyle, "block");
	assert.equal(load("warn"), "warn");
	assert.equal(load("off"), "off");
	const OSC_CLIPBOARD_ESCAPE = "\u001b]52;c;x\u0007";
	for (const invalid of ["Block", false, 1, null, OSC_CLIPBOARD_ESCAPE]) assert.equal(load(invalid), "block", JSON.stringify(invalid));
});

test("loadConfig: an invalid project githubStyle does not override a valid user value", (t) => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dt-style-prec-"));
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	const userConfigFile = path.join(dir, "user.json");
	fs.writeFileSync(userConfigFile, JSON.stringify({ githubStyle: "warn" }));
	fs.mkdirSync(path.join(dir, ".pi"));
	fs.writeFileSync(path.join(dir, ".pi", "dev-team.json"), JSON.stringify({ githubStyle: "loud" }));
	assert.equal(loadConfig(dir, { includeProject: true, userConfigFile }).config.githubStyle, "warn");
	fs.writeFileSync(path.join(dir, ".pi", "dev-team.json"), JSON.stringify({ githubStyle: "off" }));
	assert.equal(loadConfig(dir, { includeProject: true, userConfigFile }).config.githubStyle, "off", "a valid project value wins");
});

test("loadConfig: a project may turn the autocompact ceiling off or keep it at 50k tokens or more, never lower", (t) => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dt-config-"));
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	const project = path.join(dir, "project");
	fs.mkdirSync(path.join(project, ".pi"), { recursive: true });
	const userConfigFile = path.join(dir, "user.json");
	const load = (projectValue: unknown, userValue?: number) => {
		fs.writeFileSync(userConfigFile, JSON.stringify(userValue === undefined ? {} : { autocompactMaxTokens: userValue }));
		fs.writeFileSync(path.join(project, ".pi", "dev-team.json"), JSON.stringify({ autocompactMaxTokens: projectValue }));
		return loadConfig(project, { includeProject: true, userConfigFile });
	};
	assert.equal(load(0).config.autocompactMaxTokens, 0, "off");
	assert.equal(load(300_000).config.autocompactMaxTokens, 300_000, "higher");
	assert.equal(load(50_000).config.autocompactMaxTokens, 50_000, "at the floor");
	for (const bad of [1, 49_999, -1, "200000", 100_000.5]) {
		const { config, ignoredProjectSettings } = load(bad);
		assert.equal(config.autocompactMaxTokens, DEFAULT_CONFIG.autocompactMaxTokens, `project value ${JSON.stringify(bad)} ignored`);
		assert.deepEqual(ignoredProjectSettings, ["autocompactMaxTokens"]);
	}
	assert.equal(load(1, 10_000).config.autocompactMaxTokens, 10_000, "the user's own low value still applies");
});

const COPILOT = MODEL_PRESETS["github-copilot"];
const ANTHROPIC = MODEL_PRESETS.anthropic;
/** Every tier left to inherit the session model, fresh for each test. */
const allInherit = (): Record<string, string> => ({ opus: "inherit", sonnet: "inherit", haiku: "inherit", fable: "inherit" });
const allOk = (): ModelStatus => "ok";
/** A status stub keyed by exact model id; any other model is usable. */
const statusOf = (statuses: Record<string, ModelStatus>) => (model: string): ModelStatus => statuses[model] ?? "ok";
const changesOf = (preset: Record<string, string>, tiers: string[]) => tiers.map((tier) => ({ tier, model: preset[tier] }));

test("presetAdvice: a Copilot session on its preset's opus, every tier inheriting: the preset, for haiku and sonnet", () => {
	assert.deepEqual(presetAdvice(allInherit(), COPILOT.opus, allOk), {
		preset: "github-copilot",
		tiersOnSessionModel: ["haiku", "sonnet"],
		action: "preset",
		changes: changesOf(COPILOT, ["opus", "sonnet", "haiku", "fable"]),
		unusable: [],
	});
});

test("presetAdvice: an Anthropic session on a model in no tier names all three default tiers", () => {
	assert.deepEqual(presetAdvice(allInherit(), "anthropic/claude-sonnet-4-5", allOk)?.tiersOnSessionModel, ["haiku", "sonnet", "opus"]);
});

test("presetAdvice: a session on the preset's haiku leaves haiku out", () => {
	assert.deepEqual(presetAdvice(allInherit(), ANTHROPIC.haiku, allOk)?.tiersOnSessionModel, ["sonnet", "opus"]);
});

test("presetAdvice: one default tier on the session model is enough", () => {
	const models = { ...allInherit(), haiku: COPILOT.haiku };
	assert.deepEqual(presetAdvice(models, COPILOT.opus, allOk)?.tiersOnSessionModel, ["sonnet"]);
});

test("presetAdvice: with a tier mapped to another model, custom steps for the inheriting tiers instead of the preset", () => {
	const models = { ...allInherit(), haiku: "github-copilot/gpt-5-mini" };
	assert.deepEqual(presetAdvice(models, COPILOT.opus, allOk), {
		preset: "github-copilot",
		tiersOnSessionModel: ["sonnet"],
		action: "custom",
		changes: changesOf(COPILOT, ["sonnet"]),
		unusable: [],
	});
});

test("presetAdvice: a tier already on its preset model does not count as mapped elsewhere", () => {
	const models = { ...allInherit(), haiku: COPILOT.haiku };
	assert.equal(presetAdvice(models, COPILOT.opus, allOk)?.action, "preset");
});

test("presetAdvice: an empty tier inherits, as resolveModel reads it", () => {
	assert.deepEqual(presetAdvice({ ...allInherit(), haiku: "" }, COPILOT.opus, allOk)?.tiersOnSessionModel, ["haiku", "sonnet"]);
	assert.deepEqual(presetAdvice({}, COPILOT.opus, allOk)?.tiersOnSessionModel, ["haiku", "sonnet"], "no tiers set at all");
});

test("presetAdvice: no advice once the preset is applied", () => {
	assert.equal(presetAdvice({ ...COPILOT }, COPILOT.opus, allOk), undefined);
});

test("presetAdvice: no advice when every default tier is mapped; fable is not one of them", () => {
	const models = { opus: "github-copilot/a", sonnet: "github-copilot/b", haiku: "github-copilot/c", fable: "inherit" };
	assert.equal(presetAdvice(models, COPILOT.opus, allOk), undefined);
});

test("presetAdvice: no advice for a provider without a preset", () => {
	assert.equal(presetAdvice(allInherit(), "openai/gpt-5.5", allOk), undefined);
});

test("presetAdvice: a provider named inherit does not get the inherit reset option as its preset", () => {
	assert.equal(presetAdvice(allInherit(), "inherit/x", allOk), undefined);
});

test("presetAdvice: a provider named like an object key gets no preset", () => {
	for (const provider of ["__proto__", "constructor", "toString"]) assert.equal(presetAdvice(allInherit(), `${provider}/x`, allOk), undefined, provider);
});

test("presetAdvice: no advice without a session model", () => {
	assert.equal(presetAdvice(allInherit(), undefined, allOk), undefined);
});

test("presetAdvice: every model the preset writes is checked, fable included, and only unusable ones are listed", () => {
	const status = statusOf({ [COPILOT.sonnet]: "unknown", [COPILOT.fable]: "no-auth" });
	assert.deepEqual(presetAdvice(allInherit(), COPILOT.opus, status)?.unusable, [
		{ model: COPILOT.sonnet, status: "unknown" },
		{ model: COPILOT.fable, status: "no-auth" },
	]);
});

test("presetAdvice: custom steps check only the models they set", () => {
	const status = statusOf({ [COPILOT.fable]: "no-auth", [COPILOT.sonnet]: "unknown" });
	const models = { ...allInherit(), haiku: "github-copilot/gpt-5-mini" };
	assert.deepEqual(presetAdvice(models, COPILOT.opus, status)?.unusable, [{ model: COPILOT.sonnet, status: "unknown" }]);
});
