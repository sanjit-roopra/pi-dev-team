import { COPILOT_PROVIDER, CREDITS_PER_USD } from "../../extensions/dev-team/lib/ai-credits.ts";
import type { SpendRun } from "../../extensions/dev-team/lib/session-spend.ts";
import { usageBreakdown } from "../../extensions/dev-team/lib/usage-breakdown.ts";

/** A Copilot run costing `credits` AI credits (1 credit = $0.01); for other providers, or a cost in USD, use providerRun. */
export const copilotRun = (model: string, credits: number, thread: SpendRun["thread"] = "main", agent = "main"): SpendRun => ({
	thread,
	agent: thread === "main" ? "main" : agent,
	model: `${COPILOT_PROVIDER}/${model}`,
	usage: { cost: { total: credits / CREDITS_PER_USD } },
	messages: 1,
});

/** 14:05 UTC on 2026-10-04; tests that print the clock pin TZ to UTC. */
export const NOW = new Date(Date.UTC(2026, 9, 4, 14, 5));

/**
 * Copilot only, 105 AI credits ($1.05). Models: claude-sonnet-4.5 $0.70, gpt-5 $0.35. Agents: Explore
 * $0.30, orchestrator $0.10. Threads: main $0.60, subagents $0.40, overhead $0.05.
 */
export const mixed = usageBreakdown([
	copilotRun("claude-sonnet-4.5", 60),
	copilotRun("gpt-5", 30, "subagent", "Explore"),
	copilotRun("claude-sonnet-4.5", 10, "subagent", "orchestrator"),
	copilotRun("gpt-5", 5, "overhead", "compaction"),
]);

/** A run on any provider: `model` is "provider/model", `usd` its cost, `tokens` its input tokens. */
export const providerRun = (model: string, usd: number, thread: SpendRun["thread"] = "main", agent = "main", tokens = 0): SpendRun => ({
	thread,
	agent: thread === "main" ? "main" : agent,
	model,
	usage: { cost: { total: usd }, input: tokens },
	messages: 1,
});

/**
 * The main session on OpenAI, agents on Copilot and OpenAI, and a free local model. Totals: $2.00 and
 * 90 AI credits. Providers: openai $1.10 (55%), github-copilot $0.90 (45%), ollama $0.00 with 850k
 * tokens. Threads: main $0.80, subagents $1.20. Agents: software-engineer on github-copilot $0.90,
 * arch-review on openai $0.30, Explore on ollama $0.00.
 */
export const multiProvider = usageBreakdown([
	providerRun("openai/gpt-5.5", 0.8),
	providerRun("github-copilot/claude-sonnet-5.5", 0.9, "subagent", "software-engineer"),
	providerRun("openai/gpt-5.5", 0.3, "subagent", "arch-review"),
	providerRun("ollama/qwen3", 0, "subagent", "Explore", 850_000),
]);
