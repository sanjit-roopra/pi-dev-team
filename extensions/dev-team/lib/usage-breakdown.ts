/**
 * Where a session's GitHub Copilot AI credits went: the same runs the status line totals
 * (session-spend.ts), grouped by model, by dispatched agent and by thread. Runs served by other
 * providers, and runs that cost nothing, are left out, so "no Copilot spend" is simply an empty
 * breakdown. Credits stay floats here; only the display rounds them (formatCredits).
 */
import { runCredits } from "./ai-credits.ts";
import type { SpendRun } from "./session-spend.ts";

export interface CreditsRow {
	label: string;
	credits: number;
	/** Fraction (0 to 1) of the credits of the grouping this row belongs to. */
	share: number;
}

export interface UsageBreakdown {
	/** Every Copilot credit; the sum of the `byModel` rows. */
	total: number;
	byModel: CreditsRow[];
	/** Dispatched agents only (main-thread turns and overhead are not agents); shares are of their own total. */
	byAgent: CreditsRow[];
	/** "main", "subagents" and "overhead", whichever spent credits, ranked like the other groupings. */
	byThread: CreditsRow[];
}

const THREAD_LABEL: Record<SpendRun["thread"], string> = { main: "main", subagent: "subagents", overhead: "overhead" };
/** Below this share a row displays as "<1%". */
const TINY_SHARE = 0.01;

/** Rows largest first, ties by name, each with its share of the map's total. */
function rank(credits: ReadonlyMap<string, number>): CreditsRow[] {
	const total = Array.from(credits.values()).reduce((sum, c) => sum + c, 0);
	return Array.from(credits, ([label, c]) => ({ label, credits: c, share: c / total })).sort(
		(a, b) => b.credits - a.credits || a.label.localeCompare(b.label, "en"),
	);
}

function addTo(map: Map<string, number>, label: string, credits: number): void {
	map.set(label, (map.get(label) ?? 0) + credits);
}

export function usageBreakdown(runs: Iterable<SpendRun>): UsageBreakdown {
	const models = new Map<string, number>();
	const agents = new Map<string, number>();
	const threads = new Map<string, number>();
	for (const run of runs) {
		const credits = runCredits(run);
		if (credits <= 0) continue;
		addTo(models, run.model, credits);
		addTo(threads, THREAD_LABEL[run.thread], credits);
		if (run.thread === "subagent") addTo(agents, run.agent, credits);
	}
	const byModel = rank(models);
	return { total: byModel.reduce((sum, row) => sum + row.credits, 0), byModel, byAgent: rank(agents), byThread: rank(threads) };
}

/** "83.3%", or "<1%" for a share under 1% so a small row never reads as 0.0%. */
export function formatShare(share: number): string {
	return share < TINY_SHARE ? "<1%" : `${(share * 100).toFixed(1)}%`;
}
