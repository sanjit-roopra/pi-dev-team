/**
 * Where a session's GitHub Copilot AI credits went: the same runs the status line totals
 * (session-spend.ts), grouped by model, by dispatched agent and by thread. Runs served by other
 * providers, and runs that cost nothing, are left out, so "no Copilot spend" is simply an empty
 * breakdown. Credits stay floats here; only the display rounds them (formatCredits).
 */
import { runAiCredits } from "./ai-credits.ts";
import type { SpendRun } from "./session-spend.ts";
import type { SpendHistory } from "./usage-history.ts";

export interface CreditsRow<L extends string = string> {
	label: L;
	credits: number;
	/** Fraction (0 to 1) of the credits of the grouping this row belongs to. */
	share: number;
}

/** How a thread is named on screen; the split bar draws the same closed set. */
export type ThreadLabel = "main" | "subagents" | "overhead";

export interface ThreadRow extends CreditsRow<ThreadLabel> {
	/** The SpendRun thread behind the label ("subagents" is "subagent"). */
	thread: SpendRun["thread"];
}

export interface UsageBreakdown {
	/** Every Copilot credit; the sum of the `byModel` rows. */
	total: number;
	byModel: CreditsRow[];
	/** Dispatched agents only (main-thread turns and overhead are not agents); shares are of their own total. */
	byAgent: CreditsRow[];
	/** "main", "subagents" and "overhead", whichever spent credits, ranked like the other groupings. */
	byThread: ThreadRow[];
}

export const THREAD_LABEL: Record<SpendRun["thread"], ThreadLabel> = { main: "main", subagent: "subagents", overhead: "overhead" };
/** Below this share a row displays as "<1%". */
const TINY_SHARE = 0.01;

/** Rows largest first, ties by name, each with its share of the map's total. */
function rank<L extends string>(credits: ReadonlyMap<L, number>): CreditsRow<L>[] {
	const total = Array.from(credits.values()).reduce((sum, c) => sum + c, 0);
	return Array.from(credits, ([label, c]) => ({ label, credits: c, share: c / total })).sort(
		(a, b) => b.credits - a.credits || a.label.localeCompare(b.label, "en"),
	);
}

function addTo<K>(map: Map<K, number>, label: K, credits: number): void {
	map.set(label, (map.get(label) ?? 0) + credits);
}

export function usageBreakdown(runs: Iterable<SpendRun>): UsageBreakdown {
	const models = new Map<string, number>();
	const agents = new Map<string, number>();
	const threads = new Map<SpendRun["thread"], number>();
	for (const run of runs) {
		const credits = runAiCredits(run);
		if (!(credits > 0)) continue;
		addTo(models, run.model, credits);
		addTo(threads, run.thread, credits);
		if (run.thread === "subagent") addTo(agents, run.agent, credits);
	}
	const byModel = rank(models);
	const byThread = rank(threads).map(({ label: thread, ...row }) => ({ ...row, thread, label: THREAD_LABEL[thread] }));
	return { total: byModel.reduce((sum, row) => sum + row.credits, 0), byModel, byAgent: rank(agents), byThread };
}

/** What this month's load produced. */
export interface MonthSnapshot {
	breakdown: UsageBreakdown;
	/** Session files that could not be read. */
	unreadable: number;
	/** When the load finished; the header says "as of" this time. */
	loadedAt: Date;
}

/** The snapshot of a finished load: the breakdown of its runs, the files it could not read, and when it finished. */
export function monthSnapshot(history: SpendHistory, loadedAt: Date): MonthSnapshot {
	return { breakdown: usageBreakdown(history.records.map((r) => r.run)), unreadable: history.unreadable, loadedAt };
}

/** "83.3%", or "<1%" for a share under 1% so a small row never reads as 0.0%. */
export function formatShare(share: number): string {
	return share < TINY_SHARE ? "<1%" : `${(share * 100).toFixed(1)}%`;
}
