import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { type TestContext, test } from "node:test";
import { filterProjectConfig, isProjectEnvKeyAllowed, loadConfig } from "../../extensions/dev-team/lib/config.ts";

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
		JSON.stringify({ env: { DEV_TEAM_MAX_PARALLEL_BUILDS: "2", PATH: "/evil/bin", NODE_OPTIONS: "--require x", DEV_TEAM_PYTHON: "/evil/py" }, maxParallelAgents: 4 }),
	);
	fs.writeFileSync(path.join(project, ".pi", "dev-team.local.json"), JSON.stringify({ hooks: { disabled: ["repo_review_nudge"] } }));
	return { project, userConfigFile };
}

test("loadConfig: a trusted project's config is merged over the user config", (t) => {
	const { project, userConfigFile } = fixture(t);
	const { config, sources } = loadConfig(project, { includeProject: true, userConfigFile });
	assert.equal(config.maxParallelAgents, 4);
	assert.equal(config.env.DEV_TEAM_MAX_PARALLEL_BUILDS, "2");
	assert.deepEqual(config.hooks.disabled, ["repo_review_nudge"]);
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

test("loadConfig: project env cannot set PATH, NODE_OPTIONS or the programs the port runs", (t) => {
	const { project, userConfigFile } = fixture(t);
	const { config, droppedEnv } = loadConfig(project, { includeProject: true, userConfigFile });
	assert.equal(config.env.PATH, "/user/bin", "the user's own value stays");
	assert.equal(config.env.NODE_OPTIONS, undefined);
	assert.equal(config.env.DEV_TEAM_PYTHON, undefined);
	assert.equal(config.env.FROM_USER, "1", "user config env is not filtered");
	assert.deepEqual(droppedEnv.sort(), ["DEV_TEAM_PYTHON", "NODE_OPTIONS", "PATH"]);
});

test("project env keys: dev-team settings only", () => {
	for (const ok of ["DEV_TEAM_AUTO_APPROVE", "DEV_TEAM_COST_METER", "DEV_TEAM_AUTOCOMPACT_NUDGE"]) assert.ok(isProjectEnvKeyAllowed(ok), ok);
	for (const denied of ["PATH", "PYTHONPATH", "NODE_OPTIONS", "LD_PRELOAD", "GIT_SSH_COMMAND", "CLAUDE_CONFIG_DIR", "PR_GATE_BYPASS_REASON", "DEV_TEAM_PI_BIN", "DEV_TEAM_REAL_CLAUDE", "DEV_TEAM_PI_ARGS", "DEV_TEAM_TRUSTED_ROOT", "DEV_TEAM_PYTHON", "dev_team_x"]) {
		assert.ok(!isProjectEnvKeyAllowed(denied), denied);
	}
});

test("filterProjectConfig leaves configs without env untouched", () => {
	const data = { maxParallelAgents: 2 };
	assert.deepEqual(filterProjectConfig(data), { data, dropped: [] });
});
