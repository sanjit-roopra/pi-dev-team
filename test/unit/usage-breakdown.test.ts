import assert from "node:assert/strict";
import { test } from "node:test";
import { formatCredits } from "../../extensions/dev-team/lib/ai-credits.ts";
import type { SpendRun } from "../../extensions/dev-team/lib/session-spend.ts";
import { formatShare, monthSnapshot, usageBreakdown } from "../../extensions/dev-team/lib/usage-breakdown.ts";

const run = (model: string, usd: number, thread: SpendRun["thread"] = "main", agent = "main"): SpendRun => ({
	thread,
	agent,
	model,
	usage: { cost: { total: usd } },
	messages: 1,
});
const copilot = (model: string) => `github-copilot/${model}`;
const close = (actual: number, expected: number) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} != ${expected}`);
/** Rows as "label credits share" strings, so floats compare by what the overlay shows. */
const shown = (rows: { label: string; credits: number; share: number }[]) => rows.map((r) => `${r.label} ${formatCredits(r.credits)} ${formatShare(r.share)}`);

test("usageBreakdown: models ranked by credits, largest first, with total and shares", () => {
	const b = usageBreakdown([run(copilot("b"), 0.1), run(copilot("a"), 0.3), run(copilot("a"), 0.2)]);
	assert.deepEqual(shown(b.byModel), [`${copilot("a")} 50.0 83.3%`, `${copilot("b")} 10.0 16.7%`]);
	close(b.total, 60);
});

test("usageBreakdown: agents are the dispatched ones, main turns are not listed", () => {
	const b = usageBreakdown([
		run(copilot("m"), 0.3),
		run(copilot("m"), 0.2, "subagent", "orchestrator"),
		run(copilot("m"), 0.1, "subagent", "Explore"),
		run(copilot("m"), 0.1, "subagent", "Explore"),
	]);
	assert.deepEqual(shown(b.byAgent), ["Explore 20.0 50.0%", "orchestrator 20.0 50.0%"], "shares are of the subagent total, ties by name");
});

test("usageBreakdown: one agent on two Copilot models is one agent row and two model rows", () => {
	const b = usageBreakdown([run(copilot("a"), 0.3, "subagent", "Explore"), run(copilot("b"), 0.1, "subagent", "Explore")]);
	assert.deepEqual(shown(b.byAgent), ["Explore 40.0 100.0%"]);
	assert.deepEqual(shown(b.byModel), [`${copilot("a")} 30.0 75.0%`, `${copilot("b")} 10.0 25.0%`]);
});

test("usageBreakdown: the thread split covers main, subagents and overhead and sums to the total", () => {
	const b = usageBreakdown([run(copilot("m"), 0.5), run(copilot("m"), 0.3, "subagent", "a"), run(copilot("m"), 0.2, "overhead", "cache_warm")]);
	assert.deepEqual(shown(b.byThread), ["main 50.0 50.0%", "subagents 30.0 30.0%", "overhead 20.0 20.0%"]);
	close(b.byThread.reduce((sum, row) => sum + row.credits, 0), b.total);
});

test("usageBreakdown: thread rows carry the SpendRun thread next to their label", () => {
	const b = usageBreakdown([run(copilot("m"), 0.5), run(copilot("m"), 0.3, "subagent", "a"), run(copilot("m"), 0.2, "overhead", "cache_warm")]);
	assert.deepEqual(b.byThread.map((r) => [r.label, r.thread]), [["main", "main"], ["subagents", "subagent"], ["overhead", "overhead"]]);
});

test("usageBreakdown: non-Copilot runs appear in no ranking or total", () => {
	const b = usageBreakdown([run(copilot("m"), 0.1), run("anthropic/m", 5), run("anthropic/m", 5, "subagent", "a"), run("unknown", 5, "overhead", "compaction")]);
	assert.deepEqual(shown(b.byModel), [`${copilot("m")} 10.0 100.0%`]);
	assert.deepEqual(b.byAgent, []);
	assert.deepEqual(shown(b.byThread), ["main 10.0 100.0%"]);
	close(b.total, 10);
});

test("usageBreakdown: equal credits are ordered alphabetically", () => {
	const b = usageBreakdown([run(copilot("zeta"), 0.1), run(copilot("alpha"), 0.1)]);
	assert.deepEqual(b.byModel.map((r) => r.label), [copilot("alpha"), copilot("zeta")]);
});

test("usageBreakdown: a NaN cost is dropped and the total stays finite", () => {
	const nan: SpendRun = { thread: "main", agent: "main", model: copilot("m"), usage: { cost: Number.NaN }, messages: 1 };
	const b = usageBreakdown([nan, run(copilot("m"), 0.1)]);
	assert.deepEqual(shown(b.byModel), [`${copilot("m")} 10.0 100.0%`]);
	assert.ok(Number.isFinite(b.total));
	close(b.total, 10);
});

test("usageBreakdown: no runs, only non-Copilot runs, or only free runs give an empty breakdown", () => {
	const empty = { total: 0, byModel: [], byAgent: [], byThread: [] };
	assert.deepEqual(usageBreakdown([]), empty);
	assert.deepEqual(usageBreakdown([run("anthropic/m", 1)]), empty);
	assert.deepEqual(usageBreakdown([run(copilot("m"), 0)]), empty);
});

test("formatShare: one decimal, '<1%' under one percent", () => {
	assert.equal(formatShare(5 / 6), "83.3%");
	assert.equal(formatShare(0.5), "50.0%");
	assert.equal(formatShare(1), "100.0%");
	assert.equal(formatShare(0.01), "1.0%");
	assert.equal(formatShare(0.0099), "<1%");
	assert.equal(formatShare(0.0004), "<1%");
});

test("usageBreakdown: a row under 1% displays as '<1%'", () => {
	const b = usageBreakdown([run(copilot("big"), 10), run(copilot("tiny"), 0.01)]);
	assert.deepEqual(b.byModel.map((r) => r.label), [copilot("big"), copilot("tiny")]);
	assert.equal(formatShare(b.byModel[1].share), "<1%");
});

test("monthSnapshot: breakdown of the records' runs, with the skipped count and when the load finished", () => {
	const loadedAt = new Date(Date.UTC(2026, 9, 4, 14, 9));
	const records = [run(copilot("a"), 0.3), run(copilot("b"), 0.1)].map((r) => ({ timestamp: "2026-10-02T10:00:00.000Z", run: r }));
	const snapshot = monthSnapshot({ records, skipped: 2, aborted: false }, loadedAt);
	assert.deepEqual(shown(snapshot.breakdown.byModel), [`${copilot("a")} 30.0 75.0%`, `${copilot("b")} 10.0 25.0%`]);
	assert.equal(snapshot.skipped, 2);
	assert.equal(snapshot.loadedAt, loadedAt);
});
