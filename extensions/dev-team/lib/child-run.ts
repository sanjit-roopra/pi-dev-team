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
	type LiveSubagentView,
	type ProgressPatch,
	type SubagentDetails,
	type SubagentTaskView,
	type ToolCallSummary,
	toUsageTotals,
} from "./subagent-types.ts";
import type { PiMessageLike } from "./transcript.ts";

const RECENT_CALLS_KEPT = 8;
/** Levels of live subagents kept below a child; deeper ones are dropped. Above maxSubagentDepth. */
const MAX_LIVE_SUBAGENT_LEVELS = 4;
const SUBAGENT_STATUSES: ReadonlySet<string> = new Set(["running", "ok", "failed"]);
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
	/** Set on tool_execution_* events. */
	toolCallId?: string;
	toolName?: string;
	/** Set on tool_execution_start. */
	args?: unknown;
	partialResult?: { details?: unknown };
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
	/** The tool call id of each entry in recentCalls, same order. */
	recentCallIds: (string | undefined)[];
	/** Calls executing right now: tool call id → when they started (epoch ms). */
	runningCalls: Map<string, number>;
	/** Live views of the agents each open dev-team call of the child is running, by tool call id. */
	openDevTeamCalls: Map<string, LiveSubagentView[]>;
	model?: string;
	stopReason?: string;
	errorMessage?: string;
}

export function newChildRunState(model?: string): ChildRunState {
	return {
		messages: [],
		own: emptyPiUsage(),
		total: emptyPiUsage(),
		nested: [],
		turns: 0,
		recentCalls: [],
		recentCallIds: [],
		runningCalls: new Map(),
		openDevTeamCalls: new Map(),
		model,
	};
}

/** Usage of the agents a nested dev_team_subagent result ran, each with its own nested runs. */
function nestedUsageOf(details: unknown): NestedUsage[] {
	const results = (details as SubagentDetails | undefined)?.results;
	if (!Array.isArray(results)) return [];
	return results.flatMap((v: SubagentTaskView) => creditedRuns({ ...v, nested: Array.isArray(v.nested) ? v.nested : undefined }));
}

function isRecord(v: unknown): v is Record<string, unknown> {
	return !!v && typeof v === "object" && !Array.isArray(v);
}

/**
 * The live views in a child's dispatch progress, built field by field from the child's output: an
 * entry without a string agent name and a known status is dropped, turns must be a number, and only
 * the latest call is kept, re-summarized so only its shown string arguments remain. Child output is
 * not trusted, so a malformed entry can neither throw here nor reach the terminal unchecked.
 */
function liveViews(entries: unknown, level = 1): LiveSubagentView[] {
	if (!Array.isArray(entries)) return [];
	return entries.flatMap((v): LiveSubagentView[] => {
		if (!isRecord(v) || typeof v.agent !== "string" || typeof v.status !== "string" || !SUBAGENT_STATUSES.has(v.status)) return [];
		const latest = Array.isArray(v.recentCalls) ? v.recentCalls.at(-1) : undefined;
		const subagents = level < MAX_LIVE_SUBAGENT_LEVELS ? liveViews(v.subagents, level + 1) : [];
		return [
			{
				agent: v.agent,
				status: v.status as LiveSubagentView["status"],
				turns: typeof v.turns === "number" && Number.isFinite(v.turns) ? v.turns : 0,
				recentCalls: isRecord(latest) && typeof latest.name === "string" ? [summarizeToolCall(latest.name, latest.args)] : [],
				...(subagents.length ? { subagents } : {}),
			},
		];
	});
}

/** The patch showing every agent the child's open dev-team calls are running, in call order. */
function openSubagentsPatch(state: ChildRunState): ProgressPatch {
	const subagents = [...state.openDevTeamCalls.values()].flat();
	return { subagents: subagents.length ? subagents : undefined };
}

/**
 * Follow the child's own dev-team calls while they run: pi streams the dispatch tool's progress as
 * `tool_execution_update`, and `tool_execution_end` closes the call. Both carry toolCallId and toolName.
 */
function applyDispatchProgress(state: ChildRunState, ev: ChildEvent): ProgressPatch | undefined {
	if (ev.toolName !== DEV_TEAM_SUBAGENT_TOOL || !ev.toolCallId) return undefined;
	if (ev.type === "tool_execution_end") {
		if (!state.openDevTeamCalls.delete(ev.toolCallId)) return undefined;
		return openSubagentsPatch(state);
	}
	const results = (ev.partialResult?.details as SubagentDetails | undefined)?.results;
	if (!Array.isArray(results)) return undefined;
	state.openDevTeamCalls.set(ev.toolCallId, liveViews(results));
	return openSubagentsPatch(state);
}

/** recentCalls with each executing call marked by its start time, the others unmarked. */
function markRunning(state: ChildRunState): ToolCallSummary[] {
	return state.recentCalls.map((call, i) => {
		const since = state.recentCallIds[i] === undefined ? undefined : state.runningCalls.get(state.recentCallIds[i] as string);
		const { startedAt: _, ...rest } = call;
		return since === undefined ? rest : { ...rest, startedAt: since };
	});
}

/**
 * A tool of the child starts or ends executing. The call itself is already in recentCalls (from the
 * assistant message) or arrives with it, so a start is kept by id until then. When the last running
 * call ends, the agent is back to the model: `activeSince` marks when that step began.
 */
function applyExecution(state: ChildRunState, ev: ChildEvent, now: number): ProgressPatch | undefined {
	if (!ev.toolCallId) return undefined;
	if (ev.type === "tool_execution_start") {
		state.runningCalls.set(ev.toolCallId, now);
	} else if (!state.runningCalls.delete(ev.toolCallId)) {
		return undefined;
	}
	state.recentCalls = markRunning(state);
	return { recentCalls: state.recentCalls, ...(state.runningCalls.size ? {} : { activeSince: now }) };
}

/**
 * Apply one event. Returns the progress patch to show when the event changed it. pi's json mode
 * reports every finished message, tool results included, as `message_end`, a tool's run as
 * `tool_execution_start` / `_update` / `_end`; other events carry nothing this needs. `now` is when
 * the event arrived (epoch ms).
 */
export function applyChildEvent(state: ChildRunState, ev: ChildEvent, now = Date.now()): ProgressPatch | undefined {
	if (ev.type === "tool_execution_start") return applyExecution(state, ev, now);
	if (ev.type === "tool_execution_update") return applyDispatchProgress(state, ev);
	if (ev.type === "tool_execution_end") {
		const execution = applyExecution(state, ev, now);
		const dispatch = applyDispatchProgress(state, ev);
		return execution || dispatch ? { ...execution, ...dispatch } : undefined;
	}
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
			? (m.content as { type: string; id?: string; name?: string; arguments?: unknown }[]).filter((c) => c.type === "toolCall" && !!c.name)
			: [];
		state.recentCalls = [...state.recentCalls, ...calls.map((c) => summarizeToolCall(c.name as string, c.arguments))].slice(-RECENT_CALLS_KEPT);
		state.recentCallIds = [...state.recentCallIds, ...calls.map((c) => (typeof c.id === "string" ? c.id : undefined))].slice(-RECENT_CALLS_KEPT);
		state.recentCalls = markRunning(state);
		return {
			turns: state.turns,
			recentCalls: state.recentCalls,
			model: state.model,
			usage: toUsageTotals(state.own, state.turns),
			...(state.runningCalls.size ? {} : { activeSince: now }),
		};
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
