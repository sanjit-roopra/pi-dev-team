import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { SUBAGENT_USAGE_ENTRY } from "../../extensions/spend/lib/subagent-usage.ts";

type Handler = (event: unknown, ctx: unknown) => Promise<unknown>;
type CommandDef = { description?: string; getArgumentCompletions?: (prefix: string) => { value: string }[]; handler: (args: string, ctx: unknown) => Promise<void> | void };

/** The spend extension against a fake pi that records commands, tools and event handlers. */
async function loadSpend() {
	const tools: string[] = [];
	const handlers: Record<string, Handler[]> = {};
	const commands: Record<string, CommandDef> = {};
	const recorders: Record<string, unknown> = {
		registerTool: (def: { name: string }) => tools.push(def.name),
		registerCommand: (name: string, def: CommandDef) => (commands[name] = def),
		on: (event: string, handler: Handler) => (handlers[event] ??= []).push(handler),
	};
	const fakePi = new Proxy({}, { get: (_t, key) => recorders[String(key)] ?? (() => undefined) });
	const { default: spend } = await import("../../extensions/spend/index.ts");
	spend(fakePi as never);
	const fire = async (event: string, payload: unknown, ctx: unknown) => {
		for (const h of handlers[event] ?? []) await h(payload, ctx);
	};
	return { tools, handlers, commands, fire };
}

const copilotTurn = (total: number) => ({ type: "message", message: { role: "assistant", provider: "github-copilot", model: "m", usage: { cost: { total } } } });

/** A UI context over `entries`, recording each status line set (key and text). */
function uiCtx(entries: unknown[]) {
	const statuses: [string, string | undefined][] = [];
	const ctx = { hasUI: true, ui: { setStatus: (key: string, text?: string) => void statuses.push([key, text]), notify: () => {} }, sessionManager: { getEntries: () => entries } };
	return { ctx, statuses };
}

let savedSubagent: string | undefined;
beforeEach(() => {
	savedSubagent = process.env.DEV_TEAM_SUBAGENT;
	delete process.env.DEV_TEAM_SUBAGENT;
});
afterEach(() => {
	if (savedSubagent === undefined) delete process.env.DEV_TEAM_SUBAGENT;
	else process.env.DEV_TEAM_SUBAGENT = savedSubagent;
});

test("spend registers /spend and no tools", async () => {
	const { tools, commands } = await loadSpend();
	assert.deepEqual(Object.keys(commands), ["spend"]);
	assert.deepEqual(tools, []);
});

test("/spend completes its scopes", async () => {
	const { commands } = await loadSpend();
	assert.deepEqual(commands.spend.getArgumentCompletions?.("m"), [{ value: "month", label: "month" }]);
	assert.deepEqual(commands.spend.getArgumentCompletions?.("").map((c) => c.value), ["session", "month"]);
});

test("/spend <unknown> prints its syntax without a UI", async (t) => {
	const { commands } = await loadSpend();
	const printed: unknown[] = [];
	t.mock.method(console, "log", (...args: unknown[]) => void printed.push(args.join(" ")));
	await commands.spend.handler("histroy", { hasUI: false });
	assert.deepEqual(printed, ["Usage: /spend [session|month]"]);
});

test("/spend prints the session summary without a UI", async (t) => {
	const { commands } = await loadSpend();
	const printed: string[] = [];
	t.mock.method(console, "log", (...args: unknown[]) => void printed.push(args.join(" ")));
	await commands.spend.handler("", { hasUI: false, sessionManager: { getEntries: () => [] } });
	assert.equal(printed.length, 1);
	assert.match(printed[0], /No usage in this session/);
});

test("the AI credits status line is set at session start and turn end", async () => {
	const { fire } = await loadSpend();
	for (const event of ["session_start", "turn_end"]) {
		const { ctx, statuses } = uiCtx([copilotTurn(0.5)]);
		await fire(event, {}, ctx);
		assert.deepEqual(statuses, [["spend-ai-credits", "GitHub Copilot: 50.0 AI credits"]], event);
	}
});

test("a dev-team dispatch result refreshes the status line with the agents' spend", async () => {
	const { fire } = await loadSpend();
	const agent = { type: "custom", customType: SUBAGENT_USAGE_ENTRY, data: { agent: "Explore", model: "github-copilot/m", ok: true, durationMs: 1, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0.25, turns: 1 } } };
	const { ctx, statuses } = uiCtx([copilotTurn(0.5), agent]);
	await fire("tool_result", { toolName: "dev_team_subagent" }, ctx);
	assert.deepEqual(statuses, [["spend-ai-credits", "GitHub Copilot: 75.0 AI credits"]]);
});

test("other tool results leave the status line alone", async () => {
	const { fire } = await loadSpend();
	const { ctx, statuses } = uiCtx([copilotTurn(0.5)]);
	await fire("tool_result", { toolName: "bash" }, ctx);
	assert.deepEqual(statuses, []);
});

test("a dev-team agent's child process sets no status line: its parent shows the spend", async () => {
	process.env.DEV_TEAM_SUBAGENT = "1";
	const { fire } = await loadSpend();
	const { ctx, statuses } = uiCtx([copilotTurn(0.5)]);
	await fire("turn_end", {}, ctx);
	assert.deepEqual(statuses, []);
});

test("without a UI the status line is not touched", async () => {
	const { fire } = await loadSpend();
	let touched = false;
	await fire("turn_end", {}, { hasUI: false, ui: { setStatus: () => (touched = true) }, sessionManager: { getEntries: () => [copilotTurn(0.5)] } });
	assert.equal(touched, false);
});

// A project can switch the dev-team extension off; spend must still load then.
test("no spend module imports from the dev-team extension", () => {
	const root = path.join(import.meta.dirname, "../../extensions/spend");
	const files = fs.readdirSync(root, { recursive: true, encoding: "utf-8" }).filter((f) => f.endsWith(".ts"));
	assert.ok(files.length > 10);
	for (const file of files) assert.doesNotMatch(fs.readFileSync(path.join(root, file), "utf-8"), /from "[^"]*dev-team\//, file);
});
