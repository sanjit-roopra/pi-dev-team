import assert from "node:assert/strict";
import { test } from "node:test";
import { buildCostRow } from "../../extensions/dev-team/lib/metrics.ts";
import { SUBAGENT_USAGE_ENTRY, type SubagentUsageEntry, type UsageTotals } from "../../extensions/dev-team/lib/subagent-types.ts";

const usage = (input: number, cost: number): UsageTotals => ({ input, output: 1, cacheRead: 0, cacheWrite: 0, cost, turns: 1 });

const mainTurn = { type: "message", message: { role: "assistant", provider: "p", model: "main", usage: { input: 10, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0.1 } } } };

function ctxFrom(entries: unknown[]) {
	return { sessionManager: { getEntries: () => entries, getSessionId: () => "s1", getSessionFile: () => "/x/s1.jsonl" } } as never;
}

/** A session with one main-thread turn and one dev-team dispatch entry. */
function ctxWith(entry: SubagentUsageEntry) {
	return ctxFrom([mainTurn, { type: "custom", customType: SUBAGENT_USAGE_ENTRY, data: entry }]);
}

test("cost row: a nested dispatch is booked under the agent and model that ran it", () => {
	const row = buildCostRow(
		ctxWith({ agent: "orchestrator", model: "p/opus", ok: true, durationMs: 1, usage: usage(100, 1), nested: [{ agent: "Explore", model: "p/haiku", usage: usage(40, 0.2) }] }),
	) as { total: { input_tokens: number }; by_agent_type: Record<string, { input_tokens: number }>; by_model: Record<string, { input_tokens: number }>; by_thread: Record<string, { input_tokens: number }> };
	assert.equal(row.by_agent_type["dev-team:orchestrator"].input_tokens, 100, "the child's own turns only");
	assert.equal(row.by_agent_type["dev-team:Explore"].input_tokens, 40);
	assert.equal(row.by_model["p/opus"].input_tokens, 100);
	assert.equal(row.by_model["p/haiku"].input_tokens, 40);
	assert.equal(row.by_thread.subagent.input_tokens, 140);
	assert.equal(row.total.input_tokens, 10 + 100 + 40, "main + child + nested, each once");
});

test("cost row: entries written before nested crediting still count", () => {
	const row = buildCostRow(ctxWith({ agent: "a", model: "p/m", ok: true, durationMs: 1, usage: usage(5, 0) })) as { total: { input_tokens: number }; by_agent_type: Record<string, unknown> };
	assert.equal(row.total.input_tokens, 15);
	assert.ok(row.by_agent_type["dev-team:a"]);
});

test("cost row: pi's own usage entries (cache warming) stay out of the upstream row shape", () => {
	// The shape pi's SessionManager.appendUsage writes (UsageEntry in pi-coding-agent's session-manager.d.ts).
	const cacheWarm = { type: "usage", kind: "cache_warm", provider: "p", model: "main", usage: { input: 500, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 5 } } };
	const row = buildCostRow(ctxFrom([mainTurn, cacheWarm])) as { total: { input_tokens: number; cost_usd: number }; by_thread: Record<string, unknown> };
	assert.equal(row.total.input_tokens, 10);
	assert.equal(row.total.cost_usd, 0.1);
	assert.deepEqual(Object.keys(row.by_thread), ["main"]);
});
