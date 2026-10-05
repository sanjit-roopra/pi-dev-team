/**
 * Where a session's spend went, for every provider: the same runs the status line totals
 * (session-spend.ts), grouped by model, by provider, by dispatched agent and provider, and by thread.
 * Each group sums USD (pi's own cost, which every provider reports), the GitHub Copilot AI credits of
 * the runs Copilot served (ai-credits.ts), and tokens. Shares are of USD. A run counts when it cost
 * something or used tokens, so a free local model still shows; a run with neither is left out, and an
 * empty breakdown means no usage at all. Amounts stay floats here; only the display rounds them.
 */
import { CREDITS_PER_USD, isCopilotModel } from "./ai-credits.ts";
import { costUsd, type PiUsage, providerOf, type SpendRun } from "./session-spend.ts";
import type { SpendHistory } from "./usage-history.ts";

/** What a group of runs spent. */
export interface SpendAmounts {
	usd: number;
	/** AI credits of the runs GitHub Copilot served; 0 when it served none. */
	credits: number;
	tokens: number;
}

export interface UsageRow<L extends string = string> extends SpendAmounts {
	label: L;
	/** Fraction (0 to 1) of the USD of the grouping this row belongs to; 0 when that grouping cost nothing. */
	share: number;
}

/** How a thread is named on screen; the overlay's thread split draws the same closed set (THREAD_ORDER). */
export type ThreadLabel = "main" | "subagents" | "overhead";

export interface ThreadRow extends UsageRow<ThreadLabel> {
	/** The SpendRun thread behind the label ("subagents" is "subagent"). */
	thread: SpendRun["thread"];
}

/** One dispatched agent's spend on one provider; `label` is the agent's name. */
export interface AgentRow extends UsageRow {
	/** The provider that served this part of the agent's spend. */
	provider: string;
}

export interface UsageBreakdown {
	/** Every run's spend; the sum of the `byModel` rows. */
	total: SpendAmounts;
	/** "provider/model" rows. */
	byModel: UsageRow[];
	byProvider: UsageRow[];
	/** One row per dispatched agent and provider (main-thread turns and overhead are not agents); shares are of the agents' own USD. */
	byAgent: AgentRow[];
	/** "main", "subagents" and "overhead", whichever spent, ranked like the other groupings. */
	byThread: ThreadRow[];
}

export const THREAD_LABEL: Record<SpendRun["thread"], ThreadLabel> = { main: "main", subagent: "subagents", overhead: "overhead" };
/** The threads in the order the overlay's thread split draws them, so a glyph always means the same thread. */
export const THREAD_ORDER: readonly ThreadLabel[] = Object.values(THREAD_LABEL);
/** Below this share a non-zero row displays as "<1%". */
const TINY_SHARE = 0.01;
/** The finest USD amount the display shows; below it a cost reads as "<$0.01". */
const USD_CENT = 0.01;

/** Session files are untyped JSON: a cost or count that is not a positive finite number counts as none. */
const positiveFiniteOrZero = (n: unknown): number => (typeof n === "number" && Number.isFinite(n) && n > 0 ? n : 0);

/** A run's tokens: input, output and both cache directions. */
export function runTokens(usage: PiUsage): number {
	return positiveFiniteOrZero(usage.input) + positiveFiniteOrZero(usage.output) + positiveFiniteOrZero(usage.cacheRead) + positiveFiniteOrZero(usage.cacheWrite);
}

/** A run's USD, AI credits (from that same USD, when Copilot served it) and tokens. */
function runAmounts(run: SpendRun): SpendAmounts {
	const usd = positiveFiniteOrZero(costUsd(run.usage));
	return { usd, credits: isCopilotModel(run.model) ? usd * CREDITS_PER_USD : 0, tokens: runTokens(run.usage) };
}

const ZERO: SpendAmounts = { usd: 0, credits: 0, tokens: 0 };
const plus = (a: SpendAmounts, b: SpendAmounts): SpendAmounts => ({ usd: a.usd + b.usd, credits: a.credits + b.credits, tokens: a.tokens + b.tokens });

/** A group's label and what it spent, before ranking. */
interface Group<E> {
	label: string;
	/** Breaks ties between groups with the same label (an agent on two providers). */
	tieBreak: string;
	amounts: SpendAmounts;
	extra: E;
}

/** Rows by USD, largest first, then by tokens, then by name; each with its share of the groups' USD. */
function rank<E>(groups: Iterable<Group<E>>): (UsageRow & E)[] {
	const list = [...groups];
	const totalUsd = list.reduce((sum, g) => sum + g.amounts.usd, 0);
	return list
		.sort((a, b) => b.amounts.usd - a.amounts.usd || b.amounts.tokens - a.amounts.tokens || a.label.localeCompare(b.label, "en") || a.tieBreak.localeCompare(b.tieBreak, "en"))
		.map((g) => ({ ...g.extra, label: g.label, ...g.amounts, share: totalUsd > 0 ? g.amounts.usd / totalUsd : 0 }));
}

/** Sums runs into groups by key, keeping each group's label and extra fields from its first run. */
class Grouper<E> {
	private readonly groups = new Map<string, Group<E>>();
	add(key: string, label: string, amounts: SpendAmounts, extra: E, tieBreak = ""): void {
		const group = this.groups.get(key);
		if (group) group.amounts = plus(group.amounts, amounts);
		else this.groups.set(key, { label, tieBreak, amounts, extra });
	}
	ranked(): (UsageRow & E)[] {
		return rank(this.groups.values());
	}
}

/** False when nothing was spent: no USD and no tokens. */
export function hasUsage(amounts: SpendAmounts): boolean {
	return amounts.usd > 0 || amounts.tokens > 0;
}

export function usageBreakdown(runs: Iterable<SpendRun>): UsageBreakdown {
	const models = new Grouper<object>();
	const providers = new Grouper<object>();
	const agents = new Grouper<{ provider: string }>();
	const threads = new Grouper<{ thread: SpendRun["thread"] }>();
	for (const run of runs) {
		const amounts = runAmounts(run);
		if (!hasUsage(amounts)) continue;
		const provider = providerOf(run.model);
		models.add(run.model, run.model, amounts, {});
		providers.add(provider, provider, amounts, {});
		threads.add(run.thread, THREAD_LABEL[run.thread], amounts, { thread: run.thread });
		// Keyed on the pair, so no agent name can collide with another agent and provider.
		if (run.thread === "subagent") agents.add(JSON.stringify([run.agent, provider]), run.agent, amounts, { provider }, provider);
	}
	const byModel = models.ranked();
	return {
		total: byModel.reduce<SpendAmounts>((sum, row) => plus(sum, row), ZERO),
		byModel,
		byProvider: providers.ranked(),
		byAgent: agents.ranked(),
		byThread: threads.ranked() as ThreadRow[],
	};
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

/** "83.3%", "<1%" for a non-zero share under 1% so a small row never reads as 0.0%, and "0%" for none. */
export function formatShare(share: number): string {
	if (!(share > 0)) return "0%";
	return share < TINY_SHARE ? "<1%" : `${(share * 100).toFixed(1)}%`;
}

/** "$4.20", "$1,234.50", "<$0.01" for a cost under a cent, "$0.00" for none. */
export function formatUsd(usd: number): string {
	if (!(usd > 0)) return "$0.00";
	if (Number(usd.toFixed(2)) < USD_CENT) return "<$0.01";
	return `$${usd.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

const TOKEN_UNITS: readonly (readonly [number, string])[] = [
	[1e9, "B"],
	[1e6, "M"],
	[1e3, "k"],
];

/** "320 tok", "85.3k tok", "1.2M tok". */
export function formatTokens(tokens: number): string {
	for (const [size, unit] of TOKEN_UNITS) {
		const scaled = tokens / size;
		if (Number(scaled.toFixed(1)) >= 1) return `${Number(scaled.toFixed(1)).toLocaleString("en-US")}${unit} tok`;
	}
	return `${Math.round(tokens)} tok`;
}
