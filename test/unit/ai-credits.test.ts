import assert from "node:assert/strict";
import { test } from "node:test";
import { aiCreditsStatus, formatAiCredits, formatCredits, isCopilotModel, runAiCredits, runsAiCredits, sessionAiCredits } from "../../extensions/dev-team/lib/ai-credits.ts";
import { SUBAGENT_USAGE_ENTRY, type NestedUsage, type UsageTotals } from "../../extensions/dev-team/lib/subagent-types.ts";

// GitHub bills 1 AI credit per $0.01 of token cost (docs.github.com/en/copilot/reference/copilot-billing/models-and-pricing).
const CREDITS_PER_USD = 100;
const close = (actual: number, expected: number) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} != ${expected}`);

const usage = (cost: number): UsageTotals => ({ input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost, turns: 1 });
const turn = (provider: string, total: number) => ({ type: "message", message: { role: "assistant", provider, model: "m", usage: { cost: { total } } } });
const compaction = (total: number) => ({ type: "compaction", summary: "s", usage: { cost: { total } } });
function subagentEntry(model: string, cost: number, nested: NestedUsage[] = []) {
	return { type: "custom", customType: SUBAGENT_USAGE_ENTRY, data: { agent: "a", model, ok: true, durationMs: 0, usage: usage(cost), nested } };
}

test("isCopilotModel: only the github-copilot provider", () => {
	assert.equal(isCopilotModel("github-copilot/claude-opus-5.5"), true);
	assert.equal(isCopilotModel("anthropic/claude-opus-5-5"), false);
	assert.equal(isCopilotModel("github-copilot-enterprise/x"), false);
	assert.equal(isCopilotModel(undefined), false);
});

test("runAiCredits: a Copilot run at 100 credits per USD, any other run 0", () => {
	close(runAiCredits({ model: "github-copilot/m", usage: usage(0.25) }), 0.25 * CREDITS_PER_USD);
	close(runAiCredits({ model: "anthropic/m", usage: usage(3) }), 0);
	close(runAiCredits({ usage: usage(1) }), 0);
});

test("runsAiCredits: sums the Copilot runs of a mixed list", () => {
	close(runsAiCredits([{ model: "github-copilot/m", usage: usage(0.25) }, { model: "anthropic/m", usage: usage(3) }, { model: "github-copilot/n", usage: usage(0.05) }]), 0.3 * CREDITS_PER_USD);
});

test("formatAiCredits: fewer decimals as the number grows", () => {
	assert.equal(formatAiCredits(0), "0.00 AI credits");
	assert.equal(formatAiCredits(0.1234), "0.12 AI credits");
	assert.equal(formatAiCredits(10), "10.0 AI credits");
	assert.equal(formatAiCredits(12.345), "12.3 AI credits");
	assert.equal(formatAiCredits(1000), "1,000 AI credits");
	assert.equal(formatAiCredits(1234.5), "1,235 AI credits");
});

test("formatCredits: the bare number, with the same digit tiers", () => {
	assert.equal(formatCredits(1234.5), "1,235");
	assert.equal(formatCredits(12.345), "12.3");
	assert.equal(formatCredits(0.1234), "0.12");
	assert.equal(formatAiCredits(1234.5), `${formatCredits(1234.5)} AI credits`);
});

test("formatAiCredits: the number of decimals follows the rounded value at the tier edges", () => {
	assert.equal(formatAiCredits(9.994), "9.99 AI credits");
	assert.equal(formatAiCredits(9.995), "9.99 AI credits", "the double below 9.995 must not print as 10.00");
	assert.equal(formatAiCredits(9.996), "10.0 AI credits");
	assert.equal(formatAiCredits(999.94), "999.9 AI credits");
	assert.equal(formatAiCredits(999.96), "1,000 AI credits");
});

test("sessionAiCredits: the main thread's Copilot turns", () => {
	close(sessionAiCredits([turn("github-copilot", 0.5)]), 0.5 * CREDITS_PER_USD);
});

test("sessionAiCredits: other providers' turns and tool results do not count", () => {
	const toolResult = { type: "message", message: { role: "toolResult", usage: { cost: { total: 7 } } } };
	close(sessionAiCredits([turn("anthropic", 9), toolResult]), 0);
});

test("sessionAiCredits: a Copilot subagent and its Copilot nested runs count, other nested runs do not", () => {
	const entry = subagentEntry("github-copilot/claude-sonnet-5.5", 0.25, [
		{ agent: "Explore", model: "github-copilot/gpt-5-mini", usage: usage(0.01) },
		{ agent: "other", model: "anthropic/claude-haiku-4-5", usage: usage(3) },
	]);
	close(sessionAiCredits([entry]), (0.25 + 0.01) * CREDITS_PER_USD);
});

// The shape pi's SessionManager.appendUsage writes (UsageEntry in pi-coding-agent's session-manager.d.ts).
test("sessionAiCredits: pi's Copilot usage entries (cache warming) count", () => {
	const warm = (provider: string) => ({ type: "usage", kind: "cache_warm", provider, model: "m", usage: { cost: { total: 0.03 } } });
	close(sessionAiCredits([warm("github-copilot"), warm("anthropic")]), 0.03 * CREDITS_PER_USD);
});

test("aiCreditsStatus: labels the session's credits", () => {
	assert.equal(aiCreditsStatus([turn("github-copilot", 0.5)]), "GitHub Copilot: 50.0 AI credits");
});

// The status line appears once the credits round to 0.01: from 0.005 credits ($0.00005).
test("aiCreditsStatus: hidden just below 0.005 credits", () => {
	assert.equal(aiCreditsStatus([turn("github-copilot", 0.000049)]), undefined);
});

test("aiCreditsStatus: shown from 0.005 credits, as 0.01", () => {
	assert.equal(aiCreditsStatus([turn("github-copilot", 0.00005)]), "GitHub Copilot: 0.01 AI credits");
});

test("aiCreditsStatus: hidden when no Copilot model ran", () => {
	assert.equal(aiCreditsStatus([turn("anthropic", 1)]), undefined);
});

test("aiCreditsStatus: compaction usage reaches the status line", () => {
	assert.equal(aiCreditsStatus([turn("github-copilot", 0.5), compaction(0.05)]), "GitHub Copilot: 55.0 AI credits");
});

test("aiCreditsStatus: a compaction on an unknown model counts no AI credits", () => {
	assert.equal(aiCreditsStatus([compaction(5)]), undefined);
});
