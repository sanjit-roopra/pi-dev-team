import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { type TestContext, test } from "node:test";
import { filterProjectConfig, isProjectEnvSettingAllowed, loadConfig } from "../../extensions/dev-team/lib/config.ts";

/** Guard hooks a project may not disable (in the extension: the enabled PreToolUse hooks). */
const guards = new Set(["destructive_guard", "pre_tool_guard"]);

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
	const { config, sources } = loadConfig(project, { includeProject: true, userConfigFile, guardHooks: guards });
	assert.equal(config.maxParallelAgents, 4);
	assert.equal(config.env.DEV_TEAM_MAX_PARALLEL_BUILDS, "2");
	assert.ok(config.hooks.disabled.includes("repo_review_nudge"), "an advisory hook may be turned off");
	assert.ok(config.hooks.disabled.includes("cost_meter"), "default-off hooks stay off");
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
	const { config, ignoredProjectSettings } = loadConfig(project, { includeProject: true, userConfigFile, guardHooks: guards });
	assert.equal(config.env.PATH, "/user/bin", "the user's own value stays");
	assert.equal(config.env.NODE_OPTIONS, undefined);
	assert.equal(config.env.DEV_TEAM_PYTHON, undefined);
	assert.equal(config.env.DEV_TEAM_PY_CACHE, undefined, "hooks/py.sh executes the command stored in this file");
	assert.equal(config.env.FROM_USER, "1", "user config env is not filtered");
	assert.deepEqual(ignoredProjectSettings.sort(), ["env.DEV_TEAM_PYTHON", "env.DEV_TEAM_PY_CACHE", "env.NODE_OPTIONS", "env.PATH"]);
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
	const { config, ignoredProjectSettings } = loadConfig(project, { includeProject: true, userConfigFile, guardHooks: guards });
	assert.equal(config.env.FROM_USER, "1");
	assert.equal(config.env["0"], undefined);
	assert.deepEqual(ignoredProjectSettings, ["env"]);
});

test("loadConfig: an oversized project config file is skipped", (t) => {
	const { project, userConfigFile } = fixture(t);
	fs.writeFileSync(path.join(project, ".pi", "dev-team.json"), JSON.stringify({ maxParallelAgents: 9, pad: "x".repeat(1024 * 1024) }));
	const userOnly = loadConfig(project, { includeProject: false, userConfigFile }).config.maxParallelAgents;
	assert.equal(loadConfig(project, { includeProject: true, userConfigFile, guardHooks: guards }).config.maxParallelAgents, userOnly);
});

test("project hooks: guards cannot be disabled, advisory hooks can", () => {
	const { data, ignored } = filterProjectConfig({ hooks: { disabled: ["destructive_guard", "repo_review_nudge"] } }, guards);
	const disabled = (data.hooks as { disabled: string[] }).disabled;
	assert.ok(disabled.includes("repo_review_nudge"));
	assert.ok(!disabled.includes("destructive_guard"));
	assert.deepEqual(ignored, ["hooks.disabled.destructive_guard"]);
});

test("project hooks: hooks cannot be switched off, nor the timeout shortened", () => {
	const { data, ignored } = filterProjectConfig({ hooks: { enabled: false, timeoutSec: 1, enable: ["version_check"] } }, guards);
	assert.deepEqual(data.hooks, { enable: ["version_check"] });
	assert.deepEqual(ignored.sort(), ["hooks.enabled", "hooks.timeoutSec"]);
	assert.deepEqual(filterProjectConfig({ hooks: { timeoutSec: 120 } }, guards).data.hooks, { timeoutSec: 120 }, "a longer timeout is fine");
});

test("project hooks: without the guard list nothing may be disabled", () => {
	const { ignored } = filterProjectConfig({ hooks: { disabled: ["repo_review_nudge"] } });
	assert.deepEqual(ignored, ["hooks.disabled.repo_review_nudge"]);
});

test("loadConfig: a project's hooks config is filtered, the user's is not", (t) => {
	const { project, userConfigFile } = fixture(t);
	fs.writeFileSync(userConfigFile, JSON.stringify({ hooks: { enabled: false } }));
	fs.writeFileSync(path.join(project, ".pi", "dev-team.local.json"), JSON.stringify({ hooks: { disabled: ["destructive_guard"] }, env: { NODE_OPTIONS: "x" } }));
	const { config, ignoredProjectSettings } = loadConfig(project, { includeProject: true, userConfigFile, guardHooks: guards });
	assert.equal(config.hooks.enabled, false, "the user may switch hooks off for themselves");
	assert.ok(!config.hooks.disabled.includes("destructive_guard"));
	assert.ok(ignoredProjectSettings.includes("hooks.disabled.destructive_guard"));
	assert.ok(ignoredProjectSettings.includes("env.NODE_OPTIONS"), "the local project file is filtered too");
});

test("project env settings: over-long values and booleans", () => {
	assert.ok(isProjectEnvSettingAllowed("DEV_TEAM_COST_METER", true));
	assert.ok(!isProjectEnvSettingAllowed("DEV_TEAM_COST_METER", "x".repeat(65)));
});
