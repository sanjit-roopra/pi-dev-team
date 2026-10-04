import assert from "node:assert/strict";
import { test } from "node:test";
import { sessionSpend } from "../../extensions/dev-team/lib/session-spend.ts";
import { SUBAGENT_USAGE_ENTRY } from "../../extensions/dev-team/lib/subagent-types.ts";

const spend = (entries: Record<string, unknown>[]) => [...sessionSpend(entries)];

test("sessionSpend: a main turn without provider or model is booked to model 'unknown'", () => {
	const [run] = spend([{ type: "message", message: { role: "assistant", usage: { cost: { total: 1 } } } }]);
	assert.deepEqual({ thread: run.thread, model: run.model }, { thread: "main", model: "unknown" });
});

test("sessionSpend: a usage entry is overhead named by its kind, or 'usage' without one", () => {
	const runs = spend([
		{ type: "usage", kind: "cache_warm", provider: "p", model: "m", usage: { cost: { total: 1 } } },
		{ type: "usage", provider: "p", model: "m", usage: { cost: { total: 1 } } },
	]);
	assert.deepEqual(runs.map((r) => [r.thread, r.agent, r.model]), [["overhead", "cache_warm", "p/m"], ["overhead", "usage", "p/m"]]);
});

test("sessionSpend: entries without usage yield nothing", () => {
	assert.deepEqual(spend([{ type: "usage", kind: "cache_warm", provider: "p", model: "m" }, { type: "message", message: { role: "assistant" } }]), []);
});

test("sessionSpend: a main turn counts one message; a model without provider keeps its bare id", () => {
	const [run] = spend([{ type: "message", message: { role: "assistant", model: "m", usage: { cost: { total: 1 } } } }]);
	assert.deepEqual([run.model, run.messages], ["m", 1]);
});

test("sessionSpend: a dispatch yields the agent's own run, then each nested run, with their turns", () => {
	const totals = (turns: number) => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns });
	const data = { agent: "orchestrator", model: "p/opus", ok: true, durationMs: 0, usage: totals(3), nested: [{ agent: "Explore", usage: totals(2) }] };
	const runs = spend([{ type: "custom", customType: SUBAGENT_USAGE_ENTRY, data }]);
	assert.deepEqual(runs.map((r) => [r.thread, r.agent, r.model, r.messages]), [
		["subagent", "orchestrator", "p/opus", 3],
		["subagent", "Explore", "unknown", 2],
	]);
});
