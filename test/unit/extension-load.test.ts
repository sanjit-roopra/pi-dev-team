import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, test } from "node:test";

// Runs in its own process (node --test isolates files), so the Python probe cache starts empty.
type ToolDef = { name: string; exposure?: string; annotations?: Record<string, boolean> };
type CommandDef = { description?: string; getArgumentCompletions?: (prefix: string) => { value: string }[]; handler: (args: string, ctx: unknown) => Promise<void> | void };

async function loadExtension() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dt-load-"));
	const marker = path.join(dir, "probed");
	const fakePython = path.join(dir, "python");
	fs.writeFileSync(fakePython, `#!/bin/sh\ntouch "${marker}"\nexit 1\n`, { mode: 0o755 });
	const previousPython = process.env.DEV_TEAM_PYTHON;
	process.env.DEV_TEAM_PYTHON = fakePython;
	const tools: Record<string, ToolDef> = {};
	const commands: Record<string, CommandDef> = {};
	// Every API the factory may call is a no-op, except registerTool and registerCommand, which are recorded.
	const recorders: Record<string, unknown> = {
		registerTool: (def: ToolDef) => (tools[def.name] = def),
		registerCommand: (name: string, def: CommandDef) => (commands[name] = def),
	};
	const fakePi = new Proxy({}, { get: (_t, key) => recorders[String(key)] ?? (() => undefined) });
	const { default: devTeam } = await import("../../extensions/dev-team/index.ts");
	await devTeam(fakePi as never);
	const cleanup = () => {
		fs.rmSync(dir, { recursive: true, force: true });
		if (previousPython === undefined) delete process.env.DEV_TEAM_PYTHON;
		else process.env.DEV_TEAM_PYTHON = previousPython;
	};
	return { tools, commands, probed: fs.existsSync(marker), cleanup };
}

const loaded = loadExtension();

after(async () => (await loaded).cleanup());

test("loading the extension starts no process (the Python probe waits for first use)", async () => {
	const { probed } = await loaded;
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

test("/dev-team offers usage in its completions and description", async () => {
	const { commands } = await loaded;
	const devTeam = commands["dev-team"];
	assert.deepEqual(devTeam.getArgumentCompletions?.("u"), [{ value: "usage", label: "usage" }]);
	assert.ok(devTeam.getArgumentCompletions?.("").some((c) => c.value === "usage"));
	assert.ok(devTeam.description?.includes("usage"));
});

test("/dev-team usage <unknown> reports the usage line instead of opening anything", async (t) => {
	const { commands } = await loaded;
	const printed: unknown[] = [];
	t.mock.method(console, "log", (...args: unknown[]) => void printed.push(args.join(" ")));
	await commands["dev-team"].handler("usage histroy", { hasUI: false });
	assert.deepEqual(printed, ["Usage: /dev-team usage [session|month]"]);
});
