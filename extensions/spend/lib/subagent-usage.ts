/**
 * The session entry through which dev-team's `dev_team_subagent` tool reports what its agents spent,
 * and the cost meter reads it back. A leaf module owned by the spend extension so that it runs without
 * dev-team loaded; dev-team imports these shapes from here. The entry name stays as it was, so spend
 * recorded in older sessions still counts.
 */

export const SUBAGENT_USAGE_ENTRY = "dev-team-subagent-usage";

/** The dev-team tool that appends SUBAGENT_USAGE_ENTRY; its results are when an agent's spend lands. */
export const DEV_TEAM_SUBAGENT_TOOL = "dev_team_subagent";

/** One child's usage as the cost meter and the renderers read it (cost is the total in USD). */
export interface UsageTotals {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	turns: number;
}

/** Spend of an agent dispatched by a child (or deeper), credited to that agent and its model. */
export interface NestedUsage {
	agent: string;
	model?: string;
	usage: UsageTotals;
}

/** Payload of the SUBAGENT_USAGE_ENTRY session entry the cost meter reads. */
export interface SubagentUsageEntry {
	agent: string;
	model?: string;
	tier?: string;
	ok: boolean;
	durationMs: number;
	/** The child's own turns only. */
	usage: UsageTotals;
	/** Agents the child dispatched itself, at any depth. */
	nested?: NestedUsage[];
}

/**
 * The spend one dispatched agent accounts for: its own run (when it reported usage), then every run it
 * dispatched itself. The single rule the cost meter, the parent's crediting and the TUI total share.
 */
export function creditedRuns(run: { agent: string; model?: string; usage?: UsageTotals; nested?: NestedUsage[] }): NestedUsage[] {
	return [...(run.usage ? [{ agent: run.agent, model: run.model, usage: run.usage }] : []), ...(run.nested ?? [])];
}
