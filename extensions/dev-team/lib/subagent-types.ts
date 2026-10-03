/**
 * Shapes and small pure helpers shared by the `dev_team_subagent` tool, its TUI renderers and the
 * cost meter. A leaf module: it imports nothing from the tool or the renderers, so both depend on it
 * rather than on each other.
 */
import type { Usage } from "@earendil-works/pi-ai";

export const SUBAGENT_USAGE_ENTRY = "dev-team-subagent-usage";

export type AgentSource = "project" | "package";

/** One child's usage as the cost meter and the renderers read it (cost is the total in USD). */
export interface UsageTotals {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	turns: number;
}

export interface WorktreeInfo {
	path: string;
	branch: string;
	kept: boolean;
	dirty: boolean;
	commits: number;
}

/** One dispatch as the renderers see it. Streamed through onUpdate while running, final in the result. */
export interface SubagentTaskView {
	agent: string;
	source?: AgentSource;
	task: string;
	status: "running" | "ok" | "failed";
	/** Same as status === "ok"; kept from the earlier details shape. */
	ok: boolean;
	model?: string;
	tier?: string;
	turns: number;
	/** Most recent tool calls, newest last (bounded). */
	tools: string[];
	usage?: UsageTotals;
	durationMs?: number;
	stopReason?: string;
	error?: string;
	output?: string;
	worktree?: WorktreeInfo;
}

export interface SubagentDetails {
	results: SubagentTaskView[];
	/** Project agents that were requested but not run because the project is not trusted. */
	untrustedProjectAgents?: string[];
}

/** Tool arguments, with the Claude Agent/Task aliases (subagent_type, prompt) still possible. */
export interface DispatchArgs {
	agent?: string;
	subagent_type?: string;
	task?: string;
	prompt?: string;
	description?: string;
	model?: string;
	thinking?: string;
	cwd?: string;
	isolation?: string;
}

export function dispatchAgent(args: DispatchArgs): string {
	return (args.agent ?? args.subagent_type ?? "").trim();
}

export function dispatchTask(args: DispatchArgs): string {
	return (args.task ?? args.prompt ?? "").trim();
}

/** "kept: <path> on branch <b>, N commit(s)[, uncommitted changes]" or "removed: no changes". */
export function describeWorktree(wt: WorktreeInfo): string {
	if (!wt.kept) return "removed: no changes";
	return `kept: ${wt.path} on branch ${wt.branch}, ${wt.commits} commit(s)${wt.dirty ? ", uncommitted changes" : ""}`;
}

export function emptyPiUsage(): Usage {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
}

/** Add one message's usage (pi-ai `Usage`, possibly partial) into `into`. `into` is a local accumulator. */
export function addPiUsage(into: Usage, u: Partial<Usage> | undefined): void {
	if (!u) return;
	into.input += u.input ?? 0;
	into.output += u.output ?? 0;
	into.cacheRead += u.cacheRead ?? 0;
	into.cacheWrite += u.cacheWrite ?? 0;
	into.totalTokens += u.totalTokens ?? (u.input ?? 0) + (u.output ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0);
	if (u.cacheWrite1h !== undefined) into.cacheWrite1h = (into.cacheWrite1h ?? 0) + u.cacheWrite1h;
	if (u.reasoning !== undefined) into.reasoning = (into.reasoning ?? 0) + u.reasoning;
	into.cost.input += u.cost?.input ?? 0;
	into.cost.output += u.cost?.output ?? 0;
	into.cost.cacheRead += u.cost?.cacheRead ?? 0;
	into.cost.cacheWrite += u.cost?.cacheWrite ?? 0;
	into.cost.total += u.cost?.total ?? 0;
}

/** Combined usage of all children, for the tool result: pi adds tool-result usage to session totals. */
export function sumPiUsage(usages: (Usage | undefined)[]): Usage | undefined {
	const present = usages.filter((u): u is Usage => u !== undefined);
	if (!present.length) return undefined;
	const total = emptyPiUsage();
	for (const u of present) addPiUsage(total, u);
	return total;
}

export function toUsageTotals(u: Usage, turns: number): UsageTotals {
	return { input: u.input, output: u.output, cacheRead: u.cacheRead, cacheWrite: u.cacheWrite, cost: u.cost.total, turns };
}
