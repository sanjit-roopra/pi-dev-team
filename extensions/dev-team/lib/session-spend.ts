/**
 * What a session spent, one run at a time: the single walk over session entries that both the cost
 * meter (metrics.ts) and the GitHub Copilot AI credits status line (ai-credits.ts) read, so the two
 * classify entries the same way. Each reader chooses which threads it counts: the cost meter leaves
 * out "overhead" runs (cache warming, compaction, branch summaries), the AI credits count them.
 */
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { creditedRuns, SUBAGENT_USAGE_ENTRY, type SubagentUsageEntry } from "./subagent-types.ts";

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
	/** "provider/model", or "unknown" when the entry does not name one. */
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

const modelId = (provider: unknown, model: unknown): string => (provider ? `${provider}/${model}` : String(model ?? "unknown"));

/** The overhead name of each entry type that records summary usage. */
const SUMMARY_AGENT: Record<string, string> = { compaction: "compaction", branch_summary: "branch summary" };

/**
 * Every run the entries record spend for. Compaction and branch-summary entries carry usage but not
 * the provider that served it; pi summarizes with the session's current model, so they are booked
 * to the model in effect when they were written: the last model switch or assistant turn before
 * them, "unknown" when there is none.
 */
export function* sessionSpend(entries: readonly Record<string, unknown>[]): Generator<SpendRun> {
	let modelInEffect = "unknown";
	for (const entry of entries) {
		if (entry.type === "model_change") {
			modelInEffect = modelId(entry.provider, entry.modelId);
		} else if (entry.type === "message") {
			const msg = entry.message as { role?: string; usage?: PiUsage; model?: string; provider?: string } | undefined;
			if (msg?.role !== "assistant") continue;
			if (msg.model) modelInEffect = modelId(msg.provider, msg.model);
			if (!msg.usage) continue;
			yield { thread: "main", agent: "main", model: modelId(msg.provider, msg.model), usage: msg.usage, messages: 1 };
		} else if (entry.type === "custom" && entry.customType === SUBAGENT_USAGE_ENTRY) {
			const d = entry.data as SubagentUsageEntry | undefined;
			if (!d?.usage) continue;
			// The child's own turns, then each agent it dispatched itself, credited to that agent and model.
			for (const run of creditedRuns(d)) {
				yield { thread: "subagent", agent: run.agent, model: run.model ?? "unknown", usage: run.usage, messages: run.usage.turns ?? 0 };
			}
		} else if (entry.type === "usage" && entry.usage) {
			yield { thread: "overhead", agent: String(entry.kind ?? "usage"), model: modelId(entry.provider, entry.model), usage: entry.usage as PiUsage, messages: 0 };
		} else if (SUMMARY_AGENT[String(entry.type)] && entry.usage) {
			yield { thread: "overhead", agent: SUMMARY_AGENT[String(entry.type)], model: modelInEffect, usage: entry.usage as PiUsage, messages: 0 };
		}
	}
}
