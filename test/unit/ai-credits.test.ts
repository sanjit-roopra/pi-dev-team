import assert from "node:assert/strict";
import { test } from "node:test";
import { aiCreditsStatus, formatAiCredits, isCopilotModel, runsAiCredits, sessionAiCredits } from "../../extensions/dev-team/lib/ai-credits.ts";
import { SUBAGENT_USAGE_ENTRY, type NestedUsage, type UsageTotals } from "../../extensions/dev-team/lib/subagent-types.ts";

// GitHub bills 1 AI credit per $0.01 of token cost (docs.github.com/en/copilot/reference/copilot-billing/models-and-pricing).
const CREDITS_PER_USD = 100;
const close = (actual: number, expected: number) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} != ${expected}`);

const usage = (cost: number): UsageTotals => ({ input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost, turns: 1 });
const turn = (provider: string, total: number) => ({ type: "message", message: { role: "assistant", provider, model: "m", usage: { cost: { total } } } });
function subagentEntry(model: string, cost: number, nested: NestedUsage[] = []) {
	return { type: "custom", customType: SUBAGENT_USAGE_ENTRY, data: { agent: "a", model, ok: true, durationMs: 0, usage: usage(cost), nested } };
}

test("isCopilotModel: only the github-copilot provider", () => {
	assert.equal(isCopilotModel("github-copilot/claude-opus-5.5"), true);
	assert.equal(isCopilotModel("anthropic/claude-opus-5-5"), false);
	assert.equal(isCopilotModel("github-copilot-enterprise/x"), false);
	assert.equal(isCopilotModel(undefined), false);
});

test("runsAiCredits: Copilot runs at 100 credits per USD, other providers 0", () => {
	close(runsAiCredits([{ model: "github-copilot/m", usage: usage(0.25) }]), 0.25 * CREDITS_PER_USD);
	close(runsAiCredits([{ model: "anthropic/m", usage: usage(3) }, { usage: usage(1) }]), 0);
});

test("formatAiCredits: fewer decimals as the number grows", () => {
	assert.equal(formatAiCredits(0), "0.00 AI credits");
	assert.equal(formatAiCredits(0.1234), "0.12 AI credits");
	assert.equal(formatAiCredits(10), "10.0 AI credits");
	assert.equal(formatAiCredits(12.345), "12.3 AI credits");
	assert.equal(formatAiCredits(1000), "1,000 AI credits");
	assert.equal(formatAiCredits(1234.5), "1,235 AI credits");
});

test("formatAiCredits: the number of decimals follows the rounded value at the tier edges", () => {
	assert.equal(formatAiCredits(9.994), "9.99 AI credits");
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

test("sessionAiCredits: pi's Copilot usage entries (cache warming) count", () => {
	const warm = (provider: string) => ({ type: "usage", kind: "cache_warm", provider, model: "m", usage: { cost: { total: 0.03 } } });
	close(sessionAiCredits([warm("github-copilot"), warm("anthropic")]), 0.03 * CREDITS_PER_USD);
});

test("aiCreditsStatus: labelled credits, hidden while they round to 0.00", () => {
	assert.equal(aiCreditsStatus([turn("github-copilot", 0.5)]), "GitHub Copilot: 50.0 AI credits");
	assert.equal(aiCreditsStatus([turn("github-copilot", 0.00004)]), undefined);
	assert.equal(aiCreditsStatus([turn("anthropic", 1)]), undefined);
});
