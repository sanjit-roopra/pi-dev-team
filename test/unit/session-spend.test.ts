import assert from "node:assert/strict";
import { test } from "node:test";
import { aiCreditsStatus } from "../../extensions/dev-team/lib/ai-credits.ts";
import { buildCostRow } from "../../extensions/dev-team/lib/metrics.ts";
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

const cost = (total: number) => ({ cost: { total } });
const assistant = (provider: string, model: string, total = 0) => ({ type: "message", message: { role: "assistant", provider, model, usage: cost(total) } });
const modelChange = (provider: string, modelId: string) => ({ type: "model_change", provider, modelId });
const compaction = (total: number) => ({ type: "compaction", summary: "s", usage: cost(total) });
const overhead = (entries: Record<string, unknown>[]) => spend(entries).filter((r) => r.thread === "overhead").map((r) => [r.agent, r.model, r.messages]);

test("sessionSpend: a compaction is overhead named 'compaction', booked to the model of the last assistant turn", () => {
	assert.deepEqual(overhead([assistant("github-copilot", "a"), compaction(0.05)]), [["compaction", "github-copilot/a", 0]]);
	assert.deepEqual(spend([assistant("github-copilot", "a"), compaction(0.05)])[1].usage, cost(0.05));
});

test("sessionSpend: a model switch before a compaction moves it to the new model", () => {
	assert.deepEqual(overhead([assistant("github-copilot", "a"), modelChange("github-copilot", "b"), compaction(0.05)]), [["compaction", "github-copilot/b", 0]]);
});

test("sessionSpend: a later assistant turn on another model also moves the model in effect", () => {
	assert.deepEqual(overhead([modelChange("p", "a"), assistant("p", "b"), compaction(0.05)]), [["compaction", "p/b", 0]]);
});

test("sessionSpend: a compaction before any model is known is booked to 'unknown'", () => {
	assert.deepEqual(overhead([compaction(0.05)]), [["compaction", "unknown", 0]]);
});

test("sessionSpend: a compaction without usage yields nothing", () => {
	assert.deepEqual(spend([assistant("p", "a"), { type: "compaction", summary: "s" }]).filter((r) => r.thread === "overhead"), []);
});

test("sessionSpend: an assistant turn without usage still sets the model in effect", () => {
	assert.deepEqual(overhead([{ type: "message", message: { role: "assistant", provider: "p", model: "a" } }, compaction(0.05)]), [["compaction", "p/a", 0]]);
});

test("sessionSpend: a branch summary is overhead named 'branch summary', booked to the model in effect", () => {
	const summary = { type: "branch_summary", fromId: "x", summary: "s", usage: cost(0.02) };
	assert.deepEqual(overhead([assistant("github-copilot", "a"), summary]), [["branch summary", "github-copilot/a", 0]]);
});

test("sessionSpend: compaction usage reaches the AI credits status line", () => {
	assert.equal(aiCreditsStatus([assistant("github-copilot", "a", 0.5), compaction(0.05)]), "GitHub Copilot: 55.0 AI credits");
});

test("sessionSpend: a compaction on an unknown model counts no AI credits", () => {
	assert.equal(aiCreditsStatus([compaction(5)]), undefined);
});

test("cost row: compaction usage leaves the cost meter row unchanged", () => {
	const ctxFrom = (entries: unknown[]) => ({ sessionManager: { getEntries: () => entries, getSessionId: () => "s1", getSessionFile: () => "/x/s1.jsonl" } }) as never;
	const turn = assistant("p", "a", 0.1);
	const { timestamp: _t1, ...without } = buildCostRow(ctxFrom([turn])) as Record<string, unknown>;
	const { timestamp: _t2, ...withCompaction } = buildCostRow(ctxFrom([turn, compaction(5)])) as Record<string, unknown>;
	assert.deepEqual(withCompaction, without);
});
