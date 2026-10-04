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
	const tools: Record<string, ToolDef> = {};
	const handlers: Record<string, Handler> = {};
	// Every API the factory may call is a no-op, except registerTool and on, which are recorded.
	const recorders: Record<string, unknown> = {
		registerTool: (def: ToolDef) => (tools[def.name] = def),
		on: (event: string, handler: Handler) => (handlers[event] = handler),
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

test("a gh pr create that breaks the GitHub style is stopped once; the same command sent again passes the style check", async () => {
	const { handlers } = await loaded;
	const ctx = { cwd: os.tmpdir(), hasUI: false, sessionManager: { getSessionId: () => "s", getSessionFile: () => undefined } };
	// Other guards (pre_pr_review) may still stop the call, so only the style reason is checked.
	const styleReason = async (command: string, id: string) => {
		const out = (await handlers.tool_call({ toolName: "bash", toolCallId: id, input: { command } }, ctx)) as { reason?: string } | undefined;
		return /GitHub style/.test(out?.reason ?? "") ? out?.reason : undefined;
	};
	const bad = `gh pr create --title "Fix" --body "This simply works — trust me."`;
	assert.match((await styleReason(bad, "1")) ?? "", /em-dashes/);
	assert.equal(await styleReason(bad, "2"), undefined);
	assert.equal(await styleReason(`gh pr create --title "Fix" --body "Fixes the crash."`, "3"), undefined);
});
