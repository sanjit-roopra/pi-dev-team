import assert from "node:assert/strict";
import { test } from "node:test";
import { buildCostRow } from "../../extensions/dev-team/lib/metrics.ts";
import { sessionSpend, sessionSpendByEntry, UNKNOWN_AGENT, UNKNOWN_MODEL } from "../../extensions/dev-team/lib/session-spend.ts";
import { SUBAGENT_USAGE_ENTRY } from "../../extensions/dev-team/lib/subagent-types.ts";

const spend = (entries: Record<string, unknown>[]) => [...sessionSpend(entries)];

test("sessionSpend: a main turn without provider or model is booked to model 'unknown'", () => {
	const [run] = spend([{ type: "message", message: { role: "assistant", usage: { cost: { total: 1 } } } }]);
	assert.deepEqual({ thread: run.thread, model: run.model }, { thread: "main", model: UNKNOWN_MODEL });
});

test("sessionSpend: a subagent entry with a non-text agent or model is booked to 'unknown', not passed on", () => {
	const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 1, turns: 1 };
	const runs = spend([
		{ type: "custom", customType: SUBAGENT_USAGE_ENTRY, data: { agent: 5, model: 7, usage, nested: [{ agent: { x: 1 }, model: ["m"], usage }] } },
	]);
	assert.deepEqual(
		runs.map((r) => [r.agent, r.model]),
		[[UNKNOWN_AGENT, UNKNOWN_MODEL], [UNKNOWN_AGENT, UNKNOWN_MODEL]],
	);
});

test("sessionSpend: a subagent entry's empty agent or model counts as unnamed; named ones pass through", () => {
	const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 1, turns: 1 };
	const runs = spend([
		{ type: "custom", customType: SUBAGENT_USAGE_ENTRY, data: { agent: "", model: "", usage, nested: [{ agent: "Explore", model: "github-copilot/gpt-5", usage }] } },
	]);
	assert.deepEqual(
		runs.map((r) => [r.agent, r.model]),
		[[UNKNOWN_AGENT, UNKNOWN_MODEL], ["Explore", "github-copilot/gpt-5"]],
	);
});

test("sessionSpend: a main turn's model or provider that is not text is not printed as one", () => {
	const [noModel, noProvider] = spend([
		{ type: "message", message: { role: "assistant", provider: "github-copilot", model: { x: 1 }, usage: { cost: { total: 1 } } } },
		{ type: "message", message: { role: "assistant", provider: 7, model: "gpt-5", usage: { cost: { total: 1 } } } },
	]);
	assert.deepEqual([noModel.model, noProvider.model], [UNKNOWN_MODEL, "gpt-5"]);
});

test("sessionSpend: a provider without a model is 'unknown', not 'provider/undefined'", () => {
	const [run] = spend([{ type: "message", message: { role: "assistant", provider: "github-copilot", usage: { cost: { total: 1 } } } }]);
	assert.equal(run.model, UNKNOWN_MODEL);
});

test("sessionSpend: an entry type named like an Object.prototype key is not a summary entry", () => {
	assert.deepEqual(spend([{ type: "constructor", usage: { cost: { total: 1 } } }]), []);
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

test("sessionSpend: a compaction is overhead named 'compaction', attributed to the model in effect", () => {
	assert.deepEqual(overhead([assistant("github-copilot", "a"), compaction(0.05)]), [["compaction", "github-copilot/a", 0]]);
});

test("sessionSpend: a compaction's usage is passed through unchanged", () => {
	const [run] = spend([assistant("github-copilot", "a"), compaction(0.05)]).filter((r) => r.thread === "overhead");
	assert.deepEqual(run.usage, cost(0.05));
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

test("cost row: compaction usage leaves the cost meter row unchanged", () => {
	const ctxFrom = (entries: unknown[]) => ({ sessionManager: { getEntries: () => entries, getSessionId: () => "s1", getSessionFile: () => "/x/s1.jsonl" } }) as never;
	const turn = assistant("p", "a", 0.1);
	const omitTimestamp = (row: unknown) => Object.fromEntries(Object.entries(row as Record<string, unknown>).filter(([key]) => key !== "timestamp"));
	assert.deepEqual(omitTimestamp(buildCostRow(ctxFrom([turn, compaction(5)]))), omitTimestamp(buildCostRow(ctxFrom([turn]))));
});

test("sessionSpendByEntry: a dispatch entry's nested runs stay with that entry; a model_change has none", () => {
	const totals = (turns: number) => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns });
	const data = { agent: "orchestrator", model: "p/opus", ok: true, durationMs: 0, usage: totals(3), nested: [{ agent: "Explore", usage: totals(2) }] };
	const dispatch = { type: "custom", customType: SUBAGENT_USAGE_ENTRY, id: "d", data };
	const switched = modelChange("p", "next");
	const turn = assistant("p", "m", 1);
	const grouped = [...sessionSpendByEntry([switched, dispatch, turn])];
	assert.deepEqual(
		grouped.map(({ entry, runs }) => [entry, runs.map((r) => r.agent)]),
		[[switched, []], [dispatch, ["orchestrator", "Explore"]], [turn, ["main"]]],
	);
});

test("sessionSpendByEntry: model-in-effect tracking runs across entries, so a compaction is booked to an earlier switch", () => {
	const grouped = [...sessionSpendByEntry([modelChange("p", "switched"), compaction(1)])];
	assert.deepEqual(grouped.map(({ runs }) => runs.map((r) => r.model)), [[], ["p/switched"]]);
});
