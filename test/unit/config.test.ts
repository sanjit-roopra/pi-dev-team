import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { type TestContext, test } from "node:test";
import { MAX_REPO_FILE_BYTES } from "../../extensions/dev-team/lib/safe-read.ts";
import {
	autocompactPctValue,
	DEFAULT_CONFIG,
	filterProjectConfig,
	isProjectEnvSettingAllowed,
	loadConfig,
	MAX_PROJECT_PARALLEL_AGENTS,
	MODEL_PRESETS,
	PARALLEL_AGENTS_ENV,
	type ModelStatus,
	presetAdvice,
	fileTierModels,
	projectFileSettingTiers,
	updateConfigFile,
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

test("loadConfig: project env cannot set PATH, NODE_OPTIONS, file paths or the programs dev-team runs", (t) => {
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
		"PATH", "PYTHONPATH", "NODE_OPTIONS", "LD_PRELOAD", "GIT_SSH_COMMAND", "PI_CODING_AGENT_DIR", "PR_GATE_BYPASS_REASON",
		"DEV_TEAM_PY_CACHE", "DEV_TEAM_PYTHON", "DEV_TEAM_PI_BIN", "DEV_TEAM_RUN_BIN", "DEV_TEAM_PI_ARGS", "DEV_TEAM_TRUSTED_DIR",
		"DEV_TEAM_AUTO_APPROVE", "DEV_TEAM_GUARD_OVERRIDE", "DEV_TEAM_STRYKER_XUNIT3_GATE_SKIP", "DEV_TEAM_XUNIT3_SHIM_DECISION_FILE",
		"DEV_TEAM_VERIFY_THRESHOLD", "DEV_TEAM_BASH_RETRY_THRESHOLD", "DEV_TEAM_AUTOCOMPACT_PCT",
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

test("loadConfig: DEV_TEAM_MAX_PARALLEL_AGENTS overrides every config file; invalid values are ignored", (t) => {
	const { project, userConfigFile } = fixture(t);
	const load = (value: string) =>
		loadConfig(project, { includeProject: true, userConfigFile, env: { [PARALLEL_AGENTS_ENV]: value } });
	const fromFiles = loadConfig(project, { includeProject: true, userConfigFile, env: {} }).config.maxParallelAgents;
	assert.equal(load("12").config.maxParallelAgents, 12);
	assert.ok(load("12").sources.includes(`env ${PARALLEL_AGENTS_ENV}`));
	for (const bad of ["", "0", "-3", "2.5", "many"]) assert.equal(load(bad).config.maxParallelAgents, fromFiles, bad);
});

test("allowPiSubagents: only the user's own file lifts the pi-subagents block", (t) => {
	assert.deepEqual(filterProjectConfig({ allowPiSubagents: true }), { data: {}, ignored: ["allowPiSubagents"] });
	const { project, userConfigFile } = fixture(t);
	fs.writeFileSync(path.join(project, ".pi", "dev-team.json"), JSON.stringify({ allowPiSubagents: true }));
	assert.equal(loadConfig(project, { includeProject: true, userConfigFile }).config.allowPiSubagents, false);
	fs.writeFileSync(userConfigFile, JSON.stringify({ allowPiSubagents: true }));
	assert.equal(loadConfig(project, { includeProject: true, userConfigFile }).config.allowPiSubagents, true);
});

test("askTimeoutSec: only the user's own file sets it, and only to a whole number of seconds", (t) => {
	assert.deepEqual(filterProjectConfig({ askTimeoutSec: 0 }), { data: {}, ignored: ["askTimeoutSec"] });
	const { project, userConfigFile } = fixture(t);
	fs.writeFileSync(path.join(project, ".pi", "dev-team.json"), JSON.stringify({ askTimeoutSec: 0 }));
	const load = () => loadConfig(project, { includeProject: true, userConfigFile }).config.askTimeoutSec;
	assert.equal(load(), DEFAULT_CONFIG.askTimeoutSec, "a project cannot turn the human gates off");
	for (const [value, want] of [[0, 0], [30, 30], [-5, 120], [1.5, 120], ["abc", 120], [null, 120]] as const) {
		fs.writeFileSync(userConfigFile, JSON.stringify({ askTimeoutSec: value }));
		assert.equal(load(), want, JSON.stringify(value));
	}
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

test("loadConfig: a project may run 1 to 16 agents at once, never more; the user's own file may set more", (t) => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dt-config-"));
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	const project = path.join(dir, "project");
	fs.mkdirSync(path.join(project, ".pi"), { recursive: true });
	const userConfigFile = path.join(dir, "user.json");
	const load = (projectValue: unknown, userValue?: number) => {
		fs.writeFileSync(userConfigFile, JSON.stringify(userValue === undefined ? {} : { maxParallelAgents: userValue }));
		fs.writeFileSync(path.join(project, ".pi", "dev-team.json"), JSON.stringify({ maxParallelAgents: projectValue }));
		return loadConfig(project, { includeProject: true, userConfigFile });
	};
	assert.equal(load(1).config.maxParallelAgents, 1, "the lowest");
	assert.equal(load(MAX_PROJECT_PARALLEL_AGENTS).config.maxParallelAgents, MAX_PROJECT_PARALLEL_AGENTS, "at the ceiling");
	for (const bad of [MAX_PROJECT_PARALLEL_AGENTS + 1, 100_000, Number.MAX_SAFE_INTEGER, 0, 2.5, "8"]) {
		const { config, ignoredProjectSettings } = load(bad);
		assert.equal(config.maxParallelAgents, DEFAULT_CONFIG.maxParallelAgents, `project value ${JSON.stringify(bad)} ignored`);
		assert.deepEqual(ignoredProjectSettings, ["maxParallelAgents"]);
	}
	assert.equal(load(100, 40).config.maxParallelAgents, 40, "the user's own high value still applies");
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
const allInherit = (): Record<string, string> => ({ small: "inherit", standard: "inherit", strong: "inherit", max: "inherit" });
const allOk = (): ModelStatus => "ok";
/** A status stub keyed by exact model id; any other model is usable. */
const statusOf = (statuses: Record<string, ModelStatus>) => (model: string): ModelStatus => statuses[model] ?? "ok";
const changesOf = (preset: Record<string, string>, tiers: string[]) => tiers.map((tier) => ({ tier, model: preset[tier] }));

test("presetAdvice: a Copilot session on its preset's strong, every tier inheriting: the preset, for small and standard", () => {
	assert.deepEqual(presetAdvice(allInherit(), COPILOT.strong, allOk), {
		presetName: "github-copilot",
		tiersOnSessionModel: ["small", "standard"],
		action: "preset",
		changes: changesOf(COPILOT, Object.keys(COPILOT)),
		unusable: [],
	});
});

test("presetAdvice: an Anthropic session on a model in no tier names all three default tiers", () => {
	assert.deepEqual(presetAdvice(allInherit(), "anthropic/claude-sonnet-4-5", allOk)?.tiersOnSessionModel, ["small", "standard", "strong"]);
});

test("presetAdvice: a session on the preset's small leaves small out", () => {
	assert.deepEqual(presetAdvice(allInherit(), ANTHROPIC.small, allOk)?.tiersOnSessionModel, ["standard", "strong"]);
});

test("presetAdvice: one default tier on the session model is enough", () => {
	const models = { ...allInherit(), small: COPILOT.small };
	assert.deepEqual(presetAdvice(models, COPILOT.strong, allOk)?.tiersOnSessionModel, ["standard"]);
});

test("presetAdvice: with a tier mapped to another model, custom steps for the inheriting tiers instead of the preset", () => {
	const models = { ...allInherit(), small: "github-copilot/gpt-5-mini" };
	assert.deepEqual(presetAdvice(models, COPILOT.strong, allOk), {
		presetName: "github-copilot",
		tiersOnSessionModel: ["standard"],
		action: "custom",
		changes: changesOf(COPILOT, ["standard"]),
		unusable: [],
	});
});

for (const tier of Object.keys(allInherit())) {
	test(`presetAdvice: ${tier} mapped to another model makes it custom steps`, () => {
		const models = { ...allInherit(), [tier]: "github-copilot/elsewhere" };
		assert.equal(presetAdvice(models, COPILOT.strong, allOk)?.action, "custom");
	});
}

test("presetAdvice: a tier already on its preset model does not count as mapped elsewhere, and the preset leaves it out of what it sets", () => {
	const models = { ...allInherit(), small: COPILOT.small };
	const advice = presetAdvice(models, COPILOT.strong, statusOf({ [COPILOT.small]: "no-auth" }));
	assert.equal(advice?.action, "preset");
	assert.deepEqual(advice?.changes, changesOf(COPILOT, ["standard", "strong", "max"]));
	assert.deepEqual(advice?.unusable, [], "a model the preset does not write is not checked");
});

test("presetAdvice: a tier set to the session model itself counts as the user's choice", () => {
	const advice = presetAdvice({ ...allInherit(), small: COPILOT.strong }, COPILOT.strong, allOk);
	assert.deepEqual(advice?.tiersOnSessionModel, ["standard"], "only inheriting tiers are named");
	assert.equal(advice?.action, "custom");
});

test("presetAdvice: an empty tier inherits, as resolveModel reads it", () => {
	assert.deepEqual(presetAdvice({ ...allInherit(), small: "" }, COPILOT.strong, allOk)?.tiersOnSessionModel, ["small", "standard"]);
	assert.deepEqual(presetAdvice({}, COPILOT.strong, allOk)?.tiersOnSessionModel, ["small", "standard"], "no tiers set at all");
});

test("presetAdvice: no advice once the preset is applied", () => {
	assert.equal(presetAdvice({ ...COPILOT }, COPILOT.strong, allOk), undefined);
});

test("presetAdvice: no advice when every default tier is mapped; max is not one of them", () => {
	const models = { strong: "github-copilot/a", standard: "github-copilot/b", small: "github-copilot/c", max: "inherit" };
	assert.equal(presetAdvice(models, COPILOT.strong, allOk), undefined);
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

test("presetAdvice: every model the preset writes is checked, max included, and only unusable ones are listed", () => {
	const status = statusOf({ [COPILOT.standard]: "unknown", [COPILOT.max]: "no-auth" });
	assert.deepEqual(presetAdvice(allInherit(), COPILOT.strong, status)?.unusable, [
		{ model: COPILOT.standard, status: "unknown" },
		{ model: COPILOT.max, status: "no-auth" },
	]);
});

test("presetAdvice: custom steps check only the models they set", () => {
	const status = statusOf({ [COPILOT.max]: "no-auth", [COPILOT.standard]: "unknown" });
	const models = { ...allInherit(), small: "github-copilot/gpt-5-mini" };
	assert.deepEqual(presetAdvice(models, COPILOT.strong, status)?.unusable, [{ model: COPILOT.standard, status: "unknown" }]);
});

function projectWith(t: TestContext, files: { shared?: unknown; local?: unknown }) {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "dt-models-"));
	t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
	fs.mkdirSync(path.join(cwd, ".pi"));
	const shared = path.join(cwd, ".pi", "dev-team.json");
	const local = path.join(cwd, ".pi", "dev-team.local.json");
	if (files.shared !== undefined) fs.writeFileSync(shared, JSON.stringify(files.shared));
	if (files.local !== undefined) fs.writeFileSync(local, JSON.stringify(files.local));
	return { cwd, shared, local };
}
const trusted = { includeProject: true };

test("projectFileSettingTiers: the project file that sets one of the tiers", (t) => {
	const p = projectWith(t, { shared: { models: { standard: "x/y" } }, local: { autoFormat: true } });
	assert.equal(projectFileSettingTiers(p.cwd, trusted, ["small", "standard"]), p.shared);
});

test("projectFileSettingTiers: the local file wins when both set the tiers, as loadConfig merges it last", (t) => {
	const p = projectWith(t, { shared: { models: { standard: "x/y" } }, local: { models: { small: "inherit" } } });
	assert.equal(projectFileSettingTiers(p.cwd, trusted, ["small", "standard"]), p.local);
});

test("projectFileSettingTiers: a project file that sets only other tiers does not count", (t) => {
	const p = projectWith(t, { shared: { models: { strong: "x/y" } } });
	assert.equal(projectFileSettingTiers(p.cwd, trusted, ["small", "standard"]), undefined);
});

test("projectFileSettingTiers: an untrusted project's config is not read", (t) => {
	const p = projectWith(t, { shared: { models: { standard: "x/y" } } });
	assert.equal(projectFileSettingTiers(p.cwd, { includeProject: false }, ["standard"]), undefined);
});

test("fileTierModels: the text tier values one file sets itself", (t) => {
	const p = projectWith(t, { shared: { models: { small: "x/y", standard: 5, strong: { toString: 1 } } } });
	assert.deepEqual(fileTierModels(p.shared), { small: "x/y" });
	assert.deepEqual(fileTierModels(p.local), {}, "a missing file sets nothing");
	fs.writeFileSync(p.local, JSON.stringify({ models: ["x/y"] }));
	assert.deepEqual(fileTierModels(p.local), {}, "a list is not a tier mapping");
	assert.equal(projectFileSettingTiers(p.cwd, trusted, ["0"]), undefined, "nor does it set a tier named 0");
});

test("fileTierModels: only known tiers", (t) => {
	const p = projectWith(t, { shared: { models: { small: "x/y", "x\u001b]52;c;x\u0007": "y", toString: "z" } } });
	assert.deepEqual(fileTierModels(p.shared), { small: "x/y" });
});

test("loadConfig: a models value that is not a table sets nothing", (t) => {
	for (const models of [null, ["a/b"], "a/b"]) {
		const p = projectWith(t, { shared: { models } });
		assert.deepEqual(loadConfig(p.cwd, { includeProject: true, userConfigFile: path.join(p.cwd, "none.json") }).config.models, DEFAULT_CONFIG.models, JSON.stringify(models));
	}
});

test("updateConfigFile: merges into the file, and refuses to overwrite one it cannot parse", (t) => {
	const p = projectWith(t, { shared: { models: { small: "x/y" } } });
	updateConfigFile(p.shared, { models: { strong: "a/b" } });
	assert.deepEqual(JSON.parse(fs.readFileSync(p.shared, "utf-8")).models, { small: "x/y", strong: "a/b" });
	fs.writeFileSync(p.local, "{ broken");
	assert.throws(() => updateConfigFile(p.local, { models: { strong: "a/b" } }), /not valid JSON/);
	assert.equal(fs.readFileSync(p.local, "utf-8"), "{ broken");
	assert.deepEqual(fs.readdirSync(path.dirname(p.local)).sort(), ["dev-team.json", "dev-team.local.json"], "no temp file left behind");
});

test("updateConfigFile: writes through a symlinked config and keeps the link", (t) => {
	const p = projectWith(t, { shared: { models: { small: "x/y" } } });
	fs.symlinkSync(p.shared, p.local);
	updateConfigFile(p.local, { models: { strong: "a/b" } });
	assert.ok(fs.lstatSync(p.local).isSymbolicLink(), "link replaced by a file");
	assert.deepEqual(JSON.parse(fs.readFileSync(p.shared, "utf-8")).models, { small: "x/y", strong: "a/b" });
});

test("loadConfig: earlier tier names still set their tier and are reported; a file's new name wins over its earlier one", (t) => {
	const p = projectWith(t, { shared: { models: { sonnet: "p/project" } } });
	const userConfigFile = path.join(p.cwd, "user.json");
	fs.writeFileSync(userConfigFile, JSON.stringify({ models: { opus: "p/old", strong: "p/new", haiku: "p/small" } }));
	const { config, oldTierNames } = loadConfig(p.cwd, { includeProject: true, userConfigFile });
	assert.deepEqual(config.models, { small: "p/small", standard: "p/project", strong: "p/new", max: "inherit" });
	assert.deepEqual(oldTierNames, [
		{ file: userConfigFile, names: ["opus", "haiku"] },
		{ file: p.shared, names: ["sonnet"] },
	]);
	assert.deepEqual(loadConfig(p.cwd, { includeProject: false, userConfigFile: path.join(p.cwd, "none.json") }).oldTierNames, []);
});

test("loadConfig: a later file's earlier tier name still overrides an earlier file's new name", (t) => {
	const p = projectWith(t, { shared: { models: { opus: "p/proj" } } });
	const userConfigFile = path.join(p.cwd, "user.json");
	fs.writeFileSync(userConfigFile, JSON.stringify({ models: { strong: "p/user" } }));
	assert.equal(loadConfig(p.cwd, { includeProject: true, userConfigFile }).config.models.strong, "p/proj");
});

test("fileTierModels and projectFileSettingTiers read earlier tier names as their tier", (t) => {
	const p = projectWith(t, { shared: { models: { haiku: "x/y", fable: "x/z", max: "x/new" } } });
	assert.deepEqual(fileTierModels(p.shared), { small: "x/y", max: "x/new" });
	assert.equal(projectFileSettingTiers(p.cwd, trusted, ["small"]), p.shared);
});

test("updateConfigFile: a tier patch renames the file's earlier tier names", (t) => {
	const p = projectWith(t, { shared: { models: { haiku: "x/y", opus: "x/old" }, autoFormat: true } });
	updateConfigFile(p.shared, { models: { strong: "a/b" } });
	assert.deepEqual(JSON.parse(fs.readFileSync(p.shared, "utf-8")), { models: { small: "x/y", strong: "a/b" }, autoFormat: true });
});

test("answerMode, routing and notify default to timeout, brief and nowhere", () => {
	assert.equal(DEFAULT_CONFIG.answerMode, "timeout");
	assert.equal(DEFAULT_CONFIG.routing, "brief");
	assert.equal(DEFAULT_CONFIG.notify, "");
});

test("loadConfig: answerMode, routing and notify keep valid values and drop anything else", (t) => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dt-answer-cfg-"));
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	const userConfigFile = path.join(dir, "user.json");
	const load = (data: Record<string, unknown>) => {
		fs.writeFileSync(userConfigFile, JSON.stringify(data));
		return loadConfig(dir, { includeProject: false, userConfigFile }).config;
	};
	const valid = load({ answerMode: "wait", routing: "off", notify: "ntfy:my-topic" });
	assert.equal(valid.answerMode, "wait");
	assert.equal(valid.routing, "off");
	assert.equal(valid.notify, "ntfy:my-topic");
	const invalid = load({ answerMode: "forever", routing: 1, notify: 42 });
	assert.equal(invalid.answerMode, "timeout");
	assert.equal(invalid.routing, "brief");
	assert.equal(invalid.notify, "");
});

test("a project file may set routing but not answerMode or notify", (t) => {
	assert.deepEqual(filterProjectConfig({ answerMode: "wait", routing: "off", notify: "ntfy:x" }), {
		data: { routing: "off" },
		ignored: ["answerMode", "notify"],
	});
	const { project, userConfigFile } = fixture(t);
	fs.writeFileSync(path.join(project, ".pi", "dev-team.json"), JSON.stringify({ answerMode: "wait", routing: "off", notify: "ntfy:evil" }));
	const { config, ignoredProjectSettings } = loadConfig(project, { includeProject: true, userConfigFile });
	assert.equal(config.answerMode, "timeout", "a project cannot make questions wait forever");
	assert.equal(config.routing, "off");
	assert.equal(config.notify, "", "a project cannot choose where briefs are sent");
	assert.ok(ignoredProjectSettings.includes("answerMode"));
	assert.ok(ignoredProjectSettings.includes("notify"));
});

test("the user file keeps answerMode even when a project file sets it too", (t) => {
	const { project, userConfigFile } = fixture(t);
	fs.writeFileSync(userConfigFile, JSON.stringify({ answerMode: "wait" }));
	fs.writeFileSync(path.join(project, ".pi", "dev-team.json"), JSON.stringify({ answerMode: "timeout" }));
	const { config, ignoredProjectSettings } = loadConfig(project, { includeProject: true, userConfigFile });
	assert.equal(config.answerMode, "wait");
	assert.ok(ignoredProjectSettings.includes("answerMode"));
});

test("loadConfig: the CLI helper's old key claudeShim still works, cliShim wins when both are set", (t) => {
	const { project, userConfigFile } = fixture(t);
	fs.writeFileSync(userConfigFile, JSON.stringify({ claudeShim: false }));
	let { config } = loadConfig(project, { includeProject: false, userConfigFile });
	assert.equal(config.cliShim, false);
	assert.equal("claudeShim" in config, false, "the old key is not kept beside the new one");
	fs.writeFileSync(path.join(project, ".pi", "dev-team.local.json"), JSON.stringify({ claudeShim: true, cliShim: false }));
	fs.writeFileSync(userConfigFile, JSON.stringify({}));
	({ config } = loadConfig(project, { includeProject: true, userConfigFile }));
	assert.equal(config.cliShim, false);
	assert.equal(DEFAULT_CONFIG.cliShim, true);
});

test("loadConfig: a project's autocompactPct applies as a setting, not as env", (t) => {
	const { project, userConfigFile } = fixture(t);
	fs.writeFileSync(path.join(project, ".pi", "dev-team.local.json"), JSON.stringify({ autocompactPct: 40 }));
	const { config, ignoredProjectSettings } = loadConfig(project, { includeProject: true, userConfigFile });
	assert.equal(config.autocompactPct, 40);
	assert.equal(ignoredProjectSettings.includes("autocompactPct"), false);
	assert.equal(config.env.DEV_TEAM_AUTOCOMPACT_PCT, undefined);
});

test("autocompactPctValue: whole numbers 1-100, as a number or a plain string", () => {
	const cases: [unknown, number | undefined][] = [
		[1, 1], [40, 40], [100, 100], ["1", 1], ["40", 40], ["100", 100],
		[0, undefined], [101, undefined], [40.5, undefined], [-1, undefined], [Number.NaN, undefined],
		["0", undefined], ["101", undefined], ["040", undefined], [" 40", undefined], ["40.0", undefined], ["+40", undefined], ["abc", undefined],
		[null, undefined], [true, undefined], [[40], undefined],
	];
	for (const [raw, expected] of cases) assert.equal(autocompactPctValue(raw), expected, JSON.stringify(raw));
});
