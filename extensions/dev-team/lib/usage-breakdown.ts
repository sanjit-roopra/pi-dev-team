/**
 * Where a session's spend went, for every provider: the same runs the status line totals
 * (session-spend.ts), grouped by model, by provider, by dispatched agent and provider, and by thread.
 * Each group sums USD (pi's own cost, which every provider reports), the GitHub Copilot AI credits of
 * the runs Copilot served (ai-credits.ts), and tokens. Shares are of USD. A run counts when it cost
 * something or used tokens, so a free local model still shows; a run with neither is left out, and an
 * empty breakdown means no usage at all. Amounts stay floats here; only the display rounds them.
 */
import { hasVisibleCredits, runAiCredits } from "./ai-credits.ts";
import { costUsd, type PiUsage, type SpendRun, UNKNOWN_MODEL } from "./session-spend.ts";
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

/** How a thread is named on screen; the split bar draws the same closed set. */
export type ThreadLabel = "main" | "subagents" | "overhead";

export interface ThreadRow extends UsageRow<ThreadLabel> {
	/** The SpendRun thread behind the label ("subagents" is "subagent"). */
	thread: SpendRun["thread"];
}

export interface AgentRow extends UsageRow {
	/** The dispatched agent's name. */
	agent: string;
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
/** Joins an agent and its provider in an agent row's label. */
export const AGENT_PROVIDER_SEPARATOR = " · ";
/** Below this share a non-zero row displays as "<1%". */
const TINY_SHARE = 0.01;
/** The finest USD amount the display shows; below it a cost reads as "<$0.01". */
const USD_CENT = 0.01;

/** Session files are untyped JSON: a cost or count that is not a positive finite number counts as none. */
const amount = (n: unknown): number => (typeof n === "number" && Number.isFinite(n) && n > 0 ? n : 0);

/** A run's tokens: input, output and both cache directions. */
export function runTokens(usage: PiUsage): number {
	return amount(usage.input) + amount(usage.output) + amount(usage.cacheRead) + amount(usage.cacheWrite);
}

/** The provider part of a "provider/model" id; UNKNOWN_MODEL when the id names no provider. */
export function providerOf(model: string): string {
	const slash = model.indexOf("/");
	return slash > 0 ? model.slice(0, slash) : UNKNOWN_MODEL;
}

const ZERO: SpendAmounts = { usd: 0, credits: 0, tokens: 0 };
const plus = (a: SpendAmounts, b: SpendAmounts): SpendAmounts => ({ usd: a.usd + b.usd, credits: a.credits + b.credits, tokens: a.tokens + b.tokens });

function addTo<K>(map: Map<K, SpendAmounts>, key: K, amounts: SpendAmounts): void {
	map.set(key, plus(map.get(key) ?? ZERO, amounts));
}

/** Rows by USD, largest first, then by tokens, then by name; each with its share of the map's USD. */
function rank<K>(groups: ReadonlyMap<K, SpendAmounts>, labelOf: (key: K) => string): (UsageRow & { key: K })[] {
	const totalUsd = Array.from(groups.values()).reduce((sum, a) => sum + a.usd, 0);
	return Array.from(groups, ([key, amounts]) => ({ key, label: labelOf(key), ...amounts, share: totalUsd > 0 ? amounts.usd / totalUsd : 0 })).sort(
		(a, b) => b.usd - a.usd || b.tokens - a.tokens || a.label.localeCompare(b.label, "en"),
	);
}

const withoutKey = <R extends { key: unknown }>({ key: _key, ...row }: R): Omit<R, "key"> => row;

export function usageBreakdown(runs: Iterable<SpendRun>): UsageBreakdown {
	const models = new Map<string, SpendAmounts>();
	const providers = new Map<string, SpendAmounts>();
	const agents = new Map<string, { agent: string; provider: string; amounts: SpendAmounts }>();
	const threads = new Map<SpendRun["thread"], SpendAmounts>();
	for (const run of runs) {
		const amounts: SpendAmounts = { usd: amount(costUsd(run.usage)), credits: amount(runAiCredits(run)), tokens: amount(runTokens(run.usage)) };
		if (amounts.usd === 0 && amounts.tokens === 0) continue;
		const provider = providerOf(run.model);
		addTo(models, run.model, amounts);
		addTo(providers, provider, amounts);
		addTo(threads, run.thread, amounts);
		if (run.thread === "subagent") {
			const key = `${run.agent}${AGENT_PROVIDER_SEPARATOR}${provider}`;
			const prev = agents.get(key);
			agents.set(key, { agent: run.agent, provider, amounts: plus(prev?.amounts ?? ZERO, amounts) });
		}
	}
	const byModel = rank(models, (model) => model).map(withoutKey);
	const agentAmounts = new Map(Array.from(agents, ([key, a]) => [key, a.amounts]));
	const byAgent = rank(agentAmounts, (key) => key).map(({ key, ...row }) => ({ ...row, agent: agents.get(key)?.agent ?? key, provider: agents.get(key)?.provider ?? UNKNOWN_MODEL }));
	const byThread = rank(threads, (thread) => THREAD_LABEL[thread]).map(({ key: thread, ...row }) => ({ ...row, thread, label: THREAD_LABEL[thread] }));
	return {
		total: byModel.reduce<SpendAmounts>((sum, row) => plus(sum, row), ZERO),
		byModel,
		byProvider: rank(providers, (provider) => provider).map(withoutKey),
		byAgent,
		byThread,
	};
}

/** False when nothing was spent: no USD and no tokens. */
export function hasUsage(total: SpendAmounts): boolean {
	return total.usd > 0 || total.tokens > 0;
}

/** True when some of the spend was GitHub Copilot's, as much as the credits display shows. */
export const hasCopilotSpend = (amounts: SpendAmounts): boolean => hasVisibleCredits(amounts.credits);

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

/** "320 tok", "85.3k tok", "1.2M tok". */
export function formatTokens(tokens: number): string {
	const units: [number, string][] = [
		[1e9, "B"],
		[1e6, "M"],
		[1e3, "k"],
	];
	for (const [size, unit] of units) {
		const scaled = tokens / size;
		if (Number(scaled.toFixed(1)) >= 1) return `${Number(scaled.toFixed(1)).toLocaleString("en-US")}${unit} tok`;
	}
	return `${Math.round(tokens)} tok`;
}
