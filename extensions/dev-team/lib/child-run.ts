/**
 * Folds a child pi's `--mode json` event stream into what the dispatch tool reports: messages for the
 * synthetic transcript, the child's own usage, the spend of agents it dispatched itself (credited to
 * those agents), and the progress fields the TUI shows. Pure apart from mutating the state it is given.
 */
import type { Usage } from "@earendil-works/pi-ai";
import { DEV_TEAM_SUBAGENT_TOOL } from "./agents.ts";
import {
	addPiUsage,
	emptyPiUsage,
	type NestedUsage,
	type SubagentDetails,
	type SubagentTaskView,
	toUsageTotals,
} from "./subagent-types.ts";
import type { PiMessageLike } from "./transcript.ts";

const RECENT_TOOLS_KEPT = 8;

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
	recentTools: string[];
	model?: string;
	stopReason?: string;
	errorMessage?: string;
}

export function newChildRunState(model?: string): ChildRunState {
	return { messages: [], own: emptyPiUsage(), total: emptyPiUsage(), nested: [], turns: 0, recentTools: [], model };
}

/** The agents a nested dev_team_subagent result ran, each with its own usage and its own nested runs. */
function nestedRunsOf(details: unknown): NestedUsage[] {
	const results = (details as SubagentDetails | undefined)?.results;
	if (!Array.isArray(results)) return [];
	return results.flatMap((v: SubagentTaskView) => [
		...(v.usage ? [{ agent: v.agent, model: v.model, usage: v.usage }] : []),
		...(Array.isArray(v.nested) ? v.nested : []),
	]);
}

/** Apply one event. Returns the progress patch to show when the event changed it. */
export function applyChildEvent(state: ChildRunState, ev: ChildEvent): Partial<SubagentTaskView> | undefined {
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
			? (m.content as { type: string; name?: string }[]).filter((c) => c.type === "toolCall" && !!c.name).map((c) => c.name as string)
			: [];
		state.recentTools = [...state.recentTools, ...calls].slice(-RECENT_TOOLS_KEPT);
		return { turns: state.turns, tools: state.recentTools, model: state.model, usage: toUsageTotals(state.own, state.turns) };
	}
	if (m.role === "toolResult") {
		state.messages.push(m);
		const usage = m.usage as Partial<Usage> | undefined;
		addPiUsage(state.total, usage);
		// A nested dev-team dispatch reports its agents' spend; credit those agents, not this child.
		const runs = m.toolName === DEV_TEAM_SUBAGENT_TOOL ? nestedRunsOf(m.details) : [];
		if (runs.length) state.nested = [...state.nested, ...runs];
		else addPiUsage(state.own, usage);
	}
	return undefined;
}
