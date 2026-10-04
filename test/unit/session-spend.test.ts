import assert from "node:assert/strict";
import { test } from "node:test";
import { sessionSpend } from "../../extensions/dev-team/lib/session-spend.ts";

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
