/**
 * Folds a child pi's `--mode json` event stream into what the dispatch tool reports: messages for the
 * synthetic transcript, the child's own usage, the spend of agents it dispatched itself (credited to
 * those agents), and the progress fields the TUI shows. Pure apart from mutating the state it is given.
 */
import type { Usage } from "@earendil-works/pi-ai";
import { DEV_TEAM_SUBAGENT_TOOL } from "./agents.ts";
import {
	addPiUsage,
	creditedRuns,
	emptyPiUsage,
	type NestedUsage,
	type ProgressPatch,
	type SubagentDetails,
	type SubagentTaskView,
	type ToolCallSummary,
	toUsageTotals,
} from "./subagent-types.ts";
import type { PiMessageLike } from "./transcript.ts";

const RECENT_CALLS_KEPT = 8;
/** Arguments the progress view shows, by name; anything else in a call is not kept. */
const SHOWN_ARGS = ["command", "pattern", "path", "file_path", "url", "name", "agent", "subagent_type"] as const;
const SHOWN_ARG_CHARS = 200;

/** The parts of a tool call the progress view needs, each argument one line and bounded. */
export function summarizeToolCall(name: string, args: unknown): ToolCallSummary {
	const record = (args && typeof args === "object" ? args : {}) as Record<string, unknown>;
	const shown: Record<string, string> = {};
	for (const key of SHOWN_ARGS) {
		const value = record[key];
		if (typeof value === "string" && value.trim()) shown[key] = value.replace(/\s+/g, " ").trim().slice(0, SHOWN_ARG_CHARS);
	}
	if (Array.isArray(record.tasks)) shown.tasks = String(record.tasks.length);
	return Object.keys(shown).length ? { name, args: shown } : { name };
}

export interface ChildEvent {
	type?: string;
	message?: PiMessageLike & { errorMessage?: string; provider?: string; toolName?: string; details?: unknown };
}

export interface ChildRunState {
	messages: PiMessageLike[];
	/** Usage of the child's own assistant turns (and of tool results other than dev-team dispatch). */
	own: Usage;
	/** Everything, including nested dev-team dispatches: what pi should add to session totals. */
	total: Usage;
	nested: NestedUsage[];
	turns: number;
	recentCalls: ToolCallSummary[];
	model?: string;
	stopReason?: string;
	errorMessage?: string;
}

export function newChildRunState(model?: string): ChildRunState {
	return { messages: [], own: emptyPiUsage(), total: emptyPiUsage(), nested: [], turns: 0, recentCalls: [], model };
}

/** Usage of the agents a nested dev_team_subagent result ran, each with its own nested runs. */
function nestedUsageOf(details: unknown): NestedUsage[] {
	const results = (details as SubagentDetails | undefined)?.results;
	if (!Array.isArray(results)) return [];
	return results.flatMap((v: SubagentTaskView) => creditedRuns({ ...v, nested: Array.isArray(v.nested) ? v.nested : undefined }));
}

/**
 * Apply one event. Returns the progress patch to show when the event changed it. pi's json mode
 * reports every finished message, tool results included, as `message_end`; other events carry nothing
 * this needs.
 */
export function applyChildEvent(state: ChildRunState, ev: ChildEvent): ProgressPatch | undefined {
	const m = ev.message;
	if (ev.type !== "message_end" || !m) return undefined;
	if (m.role === "assistant") {
		state.messages.push(m);
		state.turns++;
		addPiUsage(state.own, m.usage as Partial<Usage> | undefined);
		addPiUsage(state.total, m.usage as Partial<Usage> | undefined);
		if (m.model) state.model = m.provider ? `${m.provider}/${m.model}` : m.model;
		if (m.stopReason) state.stopReason = m.stopReason;
		if (m.errorMessage) state.errorMessage = m.errorMessage;
		const calls = Array.isArray(m.content)
			? (m.content as { type: string; name?: string; arguments?: unknown }[])
					.filter((c) => c.type === "toolCall" && !!c.name)
					.map((c) => summarizeToolCall(c.name as string, c.arguments))
			: [];
		state.recentCalls = [...state.recentCalls, ...calls].slice(-RECENT_CALLS_KEPT);
		return { turns: state.turns, recentCalls: state.recentCalls, model: state.model, usage: toUsageTotals(state.own, state.turns) };
	}
	if (m.role === "toolResult") {
		state.messages.push(m);
		const usage = m.usage as Partial<Usage> | undefined;
		addPiUsage(state.total, usage);
		// A nested dev-team dispatch reports its agents' spend; credit those agents, not this child.
		const runs = m.toolName === DEV_TEAM_SUBAGENT_TOOL ? nestedUsageOf(m.details) : [];
		if (runs.length) state.nested = [...state.nested, ...runs];
		else addPiUsage(state.own, usage);
	}
	return undefined;
}
