import assert from "node:assert/strict";
import { test } from "node:test";
import { formatAiCredits, isCopilotModel, sessionAiCredits } from "../../extensions/dev-team/lib/ai-credits.ts";
import { SUBAGENT_USAGE_ENTRY, type UsageTotals } from "../../extensions/dev-team/lib/subagent-types.ts";

const usage = (cost: number): UsageTotals => ({ input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost, turns: 1 });
const turn = (provider: string, total: number) => ({ type: "message", message: { role: "assistant", provider, model: "m", usage: { cost: { total } } } });

test("isCopilotModel: only the github-copilot provider", () => {
	assert.equal(isCopilotModel("github-copilot/claude-opus-5.5"), true);
	assert.equal(isCopilotModel("anthropic/claude-opus-5-5"), false);
	assert.equal(isCopilotModel("github-copilot-enterprise/x"), false);
	assert.equal(isCopilotModel(undefined), false);
});

test("formatAiCredits: fewer decimals as the number grows", () => {
	assert.equal(formatAiCredits(0.1234), "0.12 AI credits");
	assert.equal(formatAiCredits(12.345), "12.3 AI credits");
	assert.equal(formatAiCredits(1234.5), "1,235 AI credits");
});

test("sessionAiCredits: Copilot main turns and Copilot subagent runs, nested included, at 1 credit per cent", () => {
	const entries = [
		turn("github-copilot", 0.5),
		turn("anthropic", 9),
		{ type: "message", message: { role: "toolResult", usage: { cost: { total: 7 } } } },
		{
			type: "custom",
			customType: SUBAGENT_USAGE_ENTRY,
			data: {
				agent: "orchestrator",
				model: "github-copilot/claude-sonnet-5.5",
				ok: true,
				durationMs: 1,
				usage: usage(0.25),
				nested: [
					{ agent: "Explore", model: "github-copilot/gpt-5-mini", usage: usage(0.01) },
					{ agent: "other", model: "anthropic/claude-haiku-4-5", usage: usage(3) },
				],
			},
		},
	];
	assert.ok(Math.abs(sessionAiCredits(entries) - 76) < 1e-9, "0.50 + 0.25 + 0.01 USD; tool results and other providers left out");
	assert.equal(sessionAiCredits([turn("anthropic", 1)]), 0);
});
