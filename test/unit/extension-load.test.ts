import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

// Runs in its own process (node --test isolates files), so the Python probe cache starts empty.
type ToolDef = { name: string; exposure?: string; annotations?: Record<string, boolean> };
type Handler = (event: unknown, ctx: unknown) => Promise<unknown>;

async function loadExtension() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dt-load-"));
	const marker = path.join(dir, "probed");
	const fakePython = path.join(dir, "python");
	fs.writeFileSync(fakePython, `#!/bin/sh\ntouch "${marker}"\nexit 1\n`, { mode: 0o755 });
	process.env.DEV_TEAM_PYTHON = fakePython;
	// The user's own ~/.pi/agent/dev-team.json must not change what the extension does here.
	process.env.PI_CODING_AGENT_DIR = dir;
	fs.writeFileSync(path.join(dir, "dev-team.json"), JSON.stringify({ githubStyle: "block" }));
	const tools: Record<string, ToolDef> = {};
	const handlers: Record<string, Handler[]> = {};
	// Every API the factory may call is a no-op, except registerTool and on, which are recorded.
	const recorders: Record<string, unknown> = {
		registerTool: (def: ToolDef) => (tools[def.name] = def),
		on: (event: string, handler: Handler) => (handlers[event] ??= []).push(handler),
	};
	const fakePi = new Proxy({}, { get: (_t, key) => recorders[key as string] ?? (() => undefined) });
	const { default: devTeam } = await import("../../extensions/dev-team/index.ts");
	await devTeam(fakePi as never);
	return { tools, handlers, probed: fs.existsSync(marker), cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

const loaded = loadExtension();

test("loading the extension starts no process (the Python probe waits for first use)", async (t) => {
	const { probed, cleanup } = await loaded;
	t.after(cleanup);
	assert.equal(probed, false);
});

test("every dev-team tool declares pi's safety hints", async () => {
	const { tools } = await loaded;
	assert.deepEqual(Object.keys(tools).sort(), ["ask_user", "dev_team_subagent", "skill", "web_fetch"]);
	for (const tool of Object.values(tools)) assert.ok(tool.annotations, `${tool.name} has annotations`);
});

test("dev_team_subagent is marked destructive and open-world", async () => {
	const { tools } = await loaded;
	assert.equal(tools.dev_team_subagent.annotations?.readOnlyHint, false);
	assert.equal(tools.dev_team_subagent.annotations?.destructiveHint, true);
	assert.equal(tools.dev_team_subagent.annotations?.openWorldHint, true);
});

test("skill and ask_user are read-only; web_fetch is read-only but open-world", async () => {
	const { tools } = await loaded;
	assert.equal(tools.skill.annotations?.readOnlyHint, true);
	assert.equal(tools.ask_user.annotations?.readOnlyHint, true);
	assert.equal(tools.web_fetch.annotations?.readOnlyHint, true);
	assert.equal(tools.web_fetch.annotations?.openWorldHint, true);
});

test("ask_user is for the model only", async () => {
	const { tools } = await loaded;
	assert.equal(tools.ask_user.exposure, "model-only");
});

test("tool_call runs the GitHub style gate before the guard hooks", async () => {
	const { handlers } = await loaded;
	assert.equal(handlers.tool_call?.length, 1);
	const ctx = { cwd: os.tmpdir(), hasUI: false, sessionManager: { getSessionId: () => "s", getSessionFile: () => undefined } };
	const command = `gh issue create --title "Crash" --body "It simply crashes — always."`;
	const out = (await handlers.tool_call[0]({ toolName: "bash", toolCallId: "1", input: { command } }, ctx)) as { block?: boolean; reason?: string };
	assert.equal(out.block, true);
	assert.match(out.reason ?? "", /GitHub style/);
});
