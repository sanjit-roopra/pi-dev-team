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
	toUsageTotals,
} from "./subagent-types.ts";
import type { PiMessageLike } from "./transcript.ts";

const RECENT_TOOLS_KEPT = 8;
const TOOL_CALL_CHARS = 80;

/**
 * A tool call as the progress view shows it, after pi's subagent example: `$ cmd`, `read path`,
 * `grep /pattern/ in path`, otherwise the tool name and its path or first argument.
 */
export function describeToolCall(name: string, args: unknown): string {
	const a = (args && typeof args === "object" ? args : {}) as Record<string, unknown>;
	const str = (v: unknown) => (typeof v === "string" ? v : undefined);
	const firstLine = (v: string) => v.split("\n")[0];
	let text: string;
	if (name === "bash" && str(a.command)) text = `$ ${firstLine(str(a.command) as string)}`;
	else if (name === "grep" && str(a.pattern)) text = `grep /${str(a.pattern)}/ in ${str(a.path) ?? "."}`;
	else if (name === "find" && str(a.pattern)) text = `find ${str(a.pattern)} in ${str(a.path) ?? "."}`;
	else if (name === "dev_team_subagent") text = `dev-team ${str(a.agent) ?? str(a.subagent_type) ?? (Array.isArray(a.tasks) ? `${a.tasks.length} agents` : "")}`.trim();
	else {
		const target = str(a.path) ?? str(a.file_path) ?? str(a.url) ?? str(a.name);
		text = target ? `${name} ${firstLine(target)}` : name;
	}
	return text.length > TOOL_CALL_CHARS ? `${text.slice(0, TOOL_CALL_CHARS - 1)}…` : text;
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
	recentTools: string[];
	model?: string;
	stopReason?: string;
	errorMessage?: string;
}

export function newChildRunState(model?: string): ChildRunState {
	return { messages: [], own: emptyPiUsage(), total: emptyPiUsage(), nested: [], turns: 0, recentTools: [], model };
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
					.map((c) => describeToolCall(c.name as string, c.arguments))
			: [];
		state.recentTools = [...state.recentTools, ...calls].slice(-RECENT_TOOLS_KEPT);
		return { turns: state.turns, tools: state.recentTools, model: state.model, usage: toUsageTotals(state.own, state.turns) };
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
