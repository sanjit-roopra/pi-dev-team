import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, test } from "node:test";
import { AGENT_PROMPT_FLAG, AGENT_PROMPT_FLAG_VALUE } from "../../extensions/dev-team/lib/subagent.ts";

// Runs in its own process (node --test isolates files), so the Python probe cache starts empty.
type ToolDef = { name: string; exposure?: string; annotations?: Record<string, boolean> };
type Handler = (event: unknown, ctx: unknown) => Promise<unknown>;
type CommandDef = { description?: string; getArgumentCompletions?: (prefix: string) => { value: string }[]; handler: (args: string, ctx: unknown) => Promise<void> | void };

async function loadExtension(opts: { flags?: Record<string, unknown> } = {}) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dt-load-"));
	const marker = path.join(dir, "probed");
	const fakePython = path.join(dir, "python");
	fs.writeFileSync(fakePython, `#!/bin/sh\ntouch "${marker}"\nexit 1\n`, { mode: 0o755 });
	const savedEnv = { DEV_TEAM_PYTHON: process.env.DEV_TEAM_PYTHON, PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR, DEV_TEAM_SUBAGENT: process.env.DEV_TEAM_SUBAGENT };
	process.env.DEV_TEAM_PYTHON = fakePython;
	// The user's own ~/.pi/agent/dev-team.json must not change what the extension does here.
	process.env.PI_CODING_AGENT_DIR = dir;
	// A run of this suite from inside a dispatched agent must still load the extension as a main session.
	delete process.env.DEV_TEAM_SUBAGENT;
	fs.writeFileSync(path.join(dir, "dev-team.json"), JSON.stringify({ githubStyle: "block" }));
	const tools: Record<string, ToolDef> = {};
	const handlers: Record<string, Handler[]> = {};
	const commands: Record<string, CommandDef> = {};
	// Every API the factory may call is a no-op, except registerTool, registerCommand and on, which are recorded.
	const recorders: Record<string, unknown> = {
		registerTool: (def: ToolDef) => (tools[def.name] = def),
		registerCommand: (name: string, def: CommandDef) => (commands[name] = def),
		on: (event: string, handler: Handler) => (handlers[event] ??= []).push(handler),
		getFlag: (name: string) => opts.flags?.[name],
	};
	const fakePi = new Proxy({}, { get: (_t, key) => recorders[String(key)] ?? (() => undefined) });
	const { default: devTeam } = await import("../../extensions/dev-team/index.ts");
	await devTeam(fakePi as never);
	const cleanup = () => {
		fs.rmSync(dir, { recursive: true, force: true });
		for (const [key, value] of Object.entries(savedEnv)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	};
	return { tools, commands, handlers, probedAtLoad: fs.existsSync(marker), probed: () => fs.existsSync(marker), cleanup };
}

const loaded = loadExtension();
after(async () => (await loaded).cleanup());

test("loading the extension starts no process (the Python probe waits for first use)", async () => {
	const { probedAtLoad } = await loaded;
	assert.equal(probedAtLoad, false);
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

test("the system prompt carries the GitHub style guide in block mode", async () => {
	const { handlers } = await loaded;
	const opts: { sections?: Record<string, string> } = {};
	await handlers.before_agent_start[0]({ systemPromptOptions: opts }, { cwd: os.tmpdir(), isProjectTrusted: () => false });
	assert.match(opts.sections?.dev_team ?? "", /GitHub text style/);
});

test("the main session's guide lists every dev-team skill", async () => {
	const { handlers } = await loaded;
	const opts: { sections?: Record<string, string> } = {};
	await handlers.before_agent_start[0]({ systemPromptOptions: opts }, { cwd: os.tmpdir(), isProjectTrusted: () => false });
	assert.match(opts.sections?.dev_team ?? "", /Dev-team skills \(load with the skill tool/);
	assert.match(opts.sections?.dev_team ?? "", /^- autoship/m);
});

test("a dispatched agent's guide leaves the full skill index out (its own prompt lists its skills)", async () => {
	const child = await loadExtension({ flags: { [AGENT_PROMPT_FLAG]: AGENT_PROMPT_FLAG_VALUE } });
	try {
		const opts: { sections?: Record<string, string> } = {};
		await child.handlers.before_agent_start[0]({ systemPromptOptions: opts }, { cwd: os.tmpdir(), isProjectTrusted: () => false });
		assert.match(opts.sections?.dev_team ?? "", /GitHub text style/, "the rest of the guide stays");
		assert.doesNotMatch(opts.sections?.dev_team ?? "", /^- autoship/m);
	} finally {
		child.cleanup();
	}
});

test("agent_settled compacts the main session once context reaches autocompactMaxTokens", async () => {
	const { handlers } = await loaded;
	const saved = process.env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE;
	process.env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE = "100"; // the user's own setting must not decide this test
	try {
		const settle = async (tokens: number) => {
			let compacted = 0;
			const ctx = {
				cwd: os.tmpdir(),
				mode: "tui",
				hasUI: false,
				isProjectTrusted: () => false,
				getContextUsage: () => ({ tokens, contextWindow: 1_000_000, percent: tokens / 10_000 }),
				compact: () => void compacted++,
			};
			await handlers.agent_settled[0]({}, ctx);
			return compacted;
		};
		assert.equal(await settle(199_999), 0, "below the ceiling");
		assert.equal(await settle(200_000), 1, "the default ceiling is 200k tokens");
	} finally {
		if (saved === undefined) delete process.env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE;
		else process.env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE = saved;
	}
});

test("tool_call blocks a breaking gh command before the guard hooks run; the same command sent again reaches them", async () => {
	const { handlers, probed } = await loaded;
	assert.equal(handlers.tool_call?.length, 1);
	const ctx = { cwd: os.tmpdir(), hasUI: false, sessionManager: { getSessionId: () => "s", getSessionFile: () => undefined } };
	const call = (id: string) =>
		handlers.tool_call[0]({ toolName: "bash", toolCallId: id, input: { command: `gh issue create --title "Crash" --body "It simply crashes — always."` } }, ctx) as Promise<
			{ block?: boolean; reason?: string } | undefined
		>;
	const first = await call("1");
	assert.equal(first?.block, true);
	assert.match(first?.reason ?? "", /GitHub style/);
	assert.equal(probed(), false, "no hook ran for the blocked call");
	const resend = await call("2");
	assert.doesNotMatch(resend?.reason ?? "", /GitHub style/);
	assert.equal(probed(), true, "the resend went on to the hooks");
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
