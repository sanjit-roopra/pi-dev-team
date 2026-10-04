/**
 * What a session spent, one run at a time: the single walk over session entries that both the cost
 * meter (metrics.ts) and the GitHub Copilot AI credits status line (ai-credits.ts) read, so the two
 * classify entries the same way. Each reader chooses which threads it counts: the cost meter leaves
 * out "overhead" runs (cache warming, compaction, branch summaries), the AI credits count them.
 */
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { creditedRuns, SUBAGENT_USAGE_ENTRY, type SubagentUsageEntry } from "./subagent-types.ts";

/** The model of a run whose entry does not name one. */
export const UNKNOWN_MODEL = "unknown";

/** Token usage as session entries carry it: pi's Usage (cost.total) or our UsageTotals (cost as a number). */
export interface PiUsage {
	input?: number;
	output?: number;
	cacheRead?: number;
	cacheWrite?: number;
	cost?: { total?: number } | number;
}

export interface SpendRun {
	/**
	 * "main": one of the session's own assistant turns. "subagent": a dispatched agent's own turns, or
	 * an agent it dispatched itself. "overhead": spend pi records outside any turn, such as cache
	 * warming, compaction and branch summaries.
	 */
	thread: "main" | "subagent" | "overhead";
	/** "main", the dispatched agent's name, the usage entry's kind (e.g. "cache_warm"), "compaction" or "branch summary". */
	agent: string;
	/** "provider/model", or UNKNOWN_MODEL when the entry does not name one. */
	model: string;
	usage: PiUsage;
	/** Model messages the run covers. */
	messages: number;
}

export function costUsd(u: PiUsage): number {
	return typeof u.cost === "number" ? u.cost : (u.cost?.total ?? 0);
}

/** The session's entries, every branch, as the plain records this module reads. */
export function sessionEntries(ctx: ExtensionContext): readonly Record<string, unknown>[] {
	return ctx.sessionManager.getEntries() as unknown as Record<string, unknown>[];
}

/** "provider/model", the bare model when no provider is named, UNKNOWN_MODEL when no model is. */
const qualifiedModelId = (provider: unknown, model: unknown): string => {
	if (!model) return UNKNOWN_MODEL;
	return provider ? `${provider}/${model}` : String(model);
};

/** The overhead name of each entry type that records summary usage. */
const SUMMARY_AGENT: ReadonlyMap<string, string> = new Map([
	["compaction", "compaction"],
	["branch_summary", "branch summary"],
]);

/** The model a compaction or branch summary is booked to: updated as the walk passes switches and turns. */
interface ModelInEffect {
	model: string;
}

/** The runs one entry records spend for, updating `effect` when the entry puts another model in effect. */
function entryRuns(entry: Record<string, unknown>, effect: ModelInEffect): SpendRun[] {
	const type = String(entry.type);
	const summaryAgent = SUMMARY_AGENT.get(type);
	if (type === "model_change") {
		effect.model = qualifiedModelId(entry.provider, entry.modelId);
	} else if (type === "message") {
		const msg = entry.message as { role?: string; usage?: PiUsage; model?: string; provider?: string } | undefined;
		if (msg?.role !== "assistant") return [];
		const model = qualifiedModelId(msg.provider, msg.model);
		if (msg.model) effect.model = model;
		if (msg.usage) return [{ thread: "main", agent: "main", model, usage: msg.usage, messages: 1 }];
	} else if (type === "custom" && entry.customType === SUBAGENT_USAGE_ENTRY) {
		const d = entry.data as SubagentUsageEntry | undefined;
		if (!d?.usage) return [];
		// The child's own turns, then each agent it dispatched itself, credited to that agent and model.
		return creditedRuns(d).map((run) => ({ thread: "subagent", agent: run.agent, model: run.model ?? UNKNOWN_MODEL, usage: run.usage, messages: run.usage.turns ?? 0 }));
	} else if (type === "usage" && entry.usage) {
		return [{ thread: "overhead", agent: String(entry.kind ?? "usage"), model: qualifiedModelId(entry.provider, entry.model), usage: entry.usage as PiUsage, messages: 0 }];
	} else if (summaryAgent && entry.usage) {
		return [{ thread: "overhead", agent: summaryAgent, model: effect.model, usage: entry.usage as PiUsage, messages: 0 }];
	}
	return [];
}

/**
 * Every entry with the runs it records spend for (none for most entries), in one walk. Compaction and
 * branch-summary entries carry usage but not the provider that served it; pi summarizes with the
 * session's current model, so they are booked to the model in effect when they were written: the last
 * model switch or assistant turn before them, UNKNOWN_MODEL when there is none.
 */
export function* sessionSpendByEntry<E extends Record<string, unknown>>(entries: Iterable<E>): Generator<{ entry: E; runs: SpendRun[] }> {
	const effect: ModelInEffect = { model: UNKNOWN_MODEL };
	for (const entry of entries) yield { entry, runs: entryRuns(entry, effect) };
}

/** Every run the entries record spend for: sessionSpendByEntry() without the entries. */
export function* sessionSpend(entries: Iterable<Record<string, unknown>>): Generator<SpendRun> {
	for (const { runs } of sessionSpendByEntry(entries)) yield* runs;
}
