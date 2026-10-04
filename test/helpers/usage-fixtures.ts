import { COPILOT_PROVIDER, CREDITS_PER_USD } from "../../extensions/dev-team/lib/ai-credits.ts";
import type { SpendRun } from "../../extensions/dev-team/lib/session-spend.ts";
import { usageBreakdown } from "../../extensions/dev-team/lib/usage-breakdown.ts";

/** A Copilot run costing `credits` AI credits (1 credit = $0.01). */
export const run = (model: string, credits: number, thread: SpendRun["thread"] = "main", agent = "main"): SpendRun => ({
	thread,
	agent: thread === "main" ? "main" : agent,
	model: `${COPILOT_PROVIDER}/${model}`,
	usage: { cost: { total: credits / CREDITS_PER_USD } },
	messages: 1,
});

/** 14:05 UTC on 2026-10-04; tests that print the clock pin TZ to UTC. */
export const NOW = new Date(Date.UTC(2026, 9, 4, 14, 5));

/** 105 credits: two models, two agents, a main thread and overhead. */
export const mixed = usageBreakdown([
	run("claude-sonnet-4.5", 60),
	run("gpt-5", 30, "subagent", "Explore"),
	run("claude-sonnet-4.5", 10, "subagent", "orchestrator"),
	run("gpt-5", 5, "overhead", "compaction"),
]);
