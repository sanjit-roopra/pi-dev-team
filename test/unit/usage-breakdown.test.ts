import assert from "node:assert/strict";
import { test } from "node:test";
import type { PiUsage, SpendRun } from "../../extensions/dev-team/lib/session-spend.ts";
import {
	formatShare,
	formatTokens,
	formatUsd,
	hasCopilotSpend,
	hasUsage,
	monthSnapshot,
	providerOf,
	runTokens,
	type UsageRow,
	usageBreakdown,
} from "../../extensions/dev-team/lib/usage-breakdown.ts";

const run = (model: string, usd: number, thread: SpendRun["thread"] = "main", agent = "main", usage: PiUsage = {}): SpendRun => ({
	thread,
	agent,
	model,
	usage: { cost: { total: usd }, ...usage },
	messages: 1,
});
const copilot = (model: string) => `github-copilot/${model}`;
const close = (actual: number, expected: number) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} != ${expected}`);
/** Rows as "label usd credits share" strings, so floats compare by what the overlay shows. */
const shown = (rows: readonly UsageRow[]) => rows.map((r) => `${r.label} ${formatUsd(r.usd)} ${r.credits.toFixed(1)} ${formatShare(r.share)}`);

test("usageBreakdown: models ranked by USD, largest first, with the total and USD shares", () => {
	const b = usageBreakdown([run(copilot("b"), 0.1), run(copilot("a"), 0.3), run(copilot("a"), 0.2)]);
	assert.deepEqual(shown(b.byModel), [`${copilot("a")} $0.50 50.0 83.3%`, `${copilot("b")} $0.10 10.0 16.7%`]);
	close(b.total.usd, 0.6);
	close(b.total.credits, 60);
});

test("usageBreakdown: every provider counts; only Copilot runs carry credits", () => {
	const b = usageBreakdown([run(copilot("m"), 0.25), run("openai/gpt-5.5", 0.75)]);
	assert.deepEqual(shown(b.byModel), ["openai/gpt-5.5 $0.75 0.0 75.0%", `${copilot("m")} $0.25 25.0 25.0%`]);
	close(b.total.usd, 1);
	close(b.total.credits, 25);
});

test("usageBreakdown: providers are grouped from the model ids, with their USD share", () => {
	const b = usageBreakdown([run(copilot("a"), 0.3), run(copilot("b"), 0.1), run("openai/gpt-5.5", 0.6)]);
	assert.deepEqual(shown(b.byProvider), ["openai $0.60 0.0 60.0%", "github-copilot $0.40 40.0 40.0%"]);
});

test("usageBreakdown: an agent has one row per provider it ran on, shares of the agents' USD", () => {
	const b = usageBreakdown([
		run(copilot("m"), 0.3),
		run(copilot("m"), 0.2, "subagent", "orchestrator"),
		run("openai/gpt-5.5", 0.1, "subagent", "orchestrator"),
		run(copilot("m"), 0.1, "subagent", "Explore"),
		run(copilot("n"), 0.1, "subagent", "Explore"),
	]);
	assert.deepEqual(shown(b.byAgent), [
		"Explore · github-copilot $0.20 20.0 40.0%",
		"orchestrator · github-copilot $0.20 20.0 40.0%",
		"orchestrator · openai $0.10 0.0 20.0%",
	]);
	assert.deepEqual(
		b.byAgent.map((r) => [r.agent, r.provider]),
		[
			["Explore", "github-copilot"],
			["orchestrator", "github-copilot"],
			["orchestrator", "openai"],
		],
	);
});

test("usageBreakdown: the thread split covers main, subagents and overhead and sums to the total", () => {
	const b = usageBreakdown([run(copilot("m"), 0.5), run("openai/x", 0.3, "subagent", "a"), run("unknown", 0.2, "overhead", "compaction")]);
	assert.deepEqual(shown(b.byThread), ["main $0.50 50.0 50.0%", "subagents $0.30 0.0 30.0%", "overhead $0.20 0.0 20.0%"]);
	assert.deepEqual(b.byThread.map((r) => [r.label, r.thread]), [["main", "main"], ["subagents", "subagent"], ["overhead", "overhead"]]);
	close(b.byThread.reduce((sum, row) => sum + row.usd, 0), b.total.usd);
});

test("usageBreakdown: a free run with tokens shows, ranks after paid rows and has a 0% share", () => {
	const b = usageBreakdown([run("ollama/qwen3", 0, "main", "main", { input: 800, output: 50 }), run(copilot("m"), 0.1, "main", "main", { input: 10 })]);
	assert.deepEqual(shown(b.byModel), [`${copilot("m")} $0.10 10.0 100.0%`, "ollama/qwen3 $0.00 0.0 0%"]);
	assert.equal(b.byModel[1].tokens, 850);
	assert.equal(b.total.tokens, 860);
});

test("usageBreakdown: only free runs give rows with 0% shares, ranked by tokens", () => {
	const b = usageBreakdown([run("ollama/a", 0, "main", "main", { input: 10 }), run("ollama/b", 0, "main", "main", { input: 30 })]);
	assert.deepEqual(shown(b.byModel), ["ollama/b $0.00 0.0 0%", "ollama/a $0.00 0.0 0%"]);
	assert.ok(hasUsage(b.total));
});

test("usageBreakdown: equal USD and tokens are ordered alphabetically", () => {
	const b = usageBreakdown([run(copilot("zeta"), 0.1), run(copilot("alpha"), 0.1)]);
	assert.deepEqual(b.byModel.map((r) => r.label), [copilot("alpha"), copilot("zeta")]);
});

test("usageBreakdown: a NaN or negative cost or token count counts as none, and totals stay finite", () => {
	const bad: SpendRun = { thread: "main", agent: "main", model: copilot("m"), usage: { cost: Number.NaN, input: 5, output: -3 }, messages: 1 };
	const b = usageBreakdown([bad, run(copilot("m"), -1, "main", "main", { input: Number.NaN }), run(copilot("m"), 0.1)]);
	assert.ok(Object.values(b.total).every(Number.isFinite), JSON.stringify(b.total));
	close(b.total.usd, 0.1);
	assert.equal(b.total.tokens, 5);
});

test("usageBreakdown: a run without cost or tokens is left out; none at all is an empty breakdown", () => {
	const empty = { total: { usd: 0, credits: 0, tokens: 0 }, byModel: [], byProvider: [], byAgent: [], byThread: [] };
	assert.deepEqual(usageBreakdown([]), empty);
	assert.deepEqual(usageBreakdown([run(copilot("m"), 0)]), empty);
	assert.ok(!hasUsage(empty.total));
});

test("providerOf: the part before the first slash, unknown without one", () => {
	assert.equal(providerOf("github-copilot/claude-sonnet-5.5"), "github-copilot");
	assert.equal(providerOf("openrouter/anthropic/claude"), "openrouter");
	assert.equal(providerOf("gpt-5.5"), "unknown");
	assert.equal(providerOf("unknown"), "unknown");
	assert.equal(providerOf("/x"), "unknown");
});

test("runTokens: input, output and both cache directions", () => {
	assert.equal(runTokens({ input: 1, output: 2, cacheRead: 3, cacheWrite: 4 }), 10);
	assert.equal(runTokens({}), 0);
});

test("hasCopilotSpend: only credits the display shows count", () => {
	assert.ok(hasCopilotSpend({ usd: 1, credits: 0.01, tokens: 0 }));
	assert.ok(!hasCopilotSpend({ usd: 1, credits: 0.004, tokens: 0 }));
});

test("formatShare: one decimal, '<1%' for a small share, '0%' for none", () => {
	assert.equal(formatShare(5 / 6), "83.3%");
	assert.equal(formatShare(1), "100.0%");
	assert.equal(formatShare(0.01), "1.0%");
	assert.equal(formatShare(0.0099), "<1%");
	assert.equal(formatShare(0), "0%");
	assert.equal(formatShare(Number.NaN), "0%");
});

test("formatUsd: cents, thousands separators, '<$0.01' under a cent, '$0.00' for none", () => {
	assert.equal(formatUsd(4.2), "$4.20");
	assert.equal(formatUsd(1234.5), "$1,234.50");
	assert.equal(formatUsd(0.01), "$0.01");
	assert.equal(formatUsd(0.004), "<$0.01");
	assert.equal(formatUsd(0.005), "$0.01");
	assert.equal(formatUsd(0), "$0.00");
});

test("formatTokens: plain under a thousand, then k, M and B with one decimal", () => {
	assert.equal(formatTokens(320), "320 tok");
	assert.equal(formatTokens(85_300), "85.3k tok");
	assert.equal(formatTokens(999_960), "1M tok");
	assert.equal(formatTokens(1_200_000), "1.2M tok");
	assert.equal(formatTokens(3_000_000_000), "3B tok");
});

test("monthSnapshot: breakdown of the records' runs, with the unreadable count and when the load finished", () => {
	const loadedAt = new Date(Date.UTC(2026, 9, 4, 14, 9));
	const records = [run(copilot("a"), 0.3), run("openai/b", 0.1)].map((r) => ({ timestamp: "2026-10-02T10:00:00.000Z", run: r }));
	const snapshot = monthSnapshot({ records, unreadable: 2, aborted: false }, loadedAt);
	assert.deepEqual(shown(snapshot.breakdown.byModel), [`${copilot("a")} $0.30 30.0 75.0%`, "openai/b $0.10 0.0 25.0%"]);
	assert.equal(snapshot.unreadable, 2);
	assert.equal(snapshot.loadedAt, loadedAt);
});
