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
	isWaitingForSlot,
	type NestedUsage,
	type LiveSubagentView,
	type ProgressPatch,
	type SubagentDetails,
	type SubagentTaskView,
	type ToolCallSummary,
	toUsageTotals,
} from "./subagent-types.ts";
import type { PiMessageLike } from "./transcript.ts";

const TRACKED_CALLS_KEPT = 8;
/**
 * Calls followed by id at most (callStartTimes, latestMessageCalls, unendedCalls), so a child that
 * never ends its calls cannot grow them further: past it callStartTimes drops its oldest start (that
 * call is no longer marked), and the calls of one message past it are not followed. It also bounds
 * the calls trimTrackedCalls looks at.
 */
const CALLS_BY_ID_KEPT = 64;
/** Levels of live subagents kept below a child; deeper ones are dropped. Above maxSubagentDepth. */
const MAX_LIVE_SUBAGENT_LEVELS = 4;
const SUBAGENT_STATUSES: ReadonlySet<string> = new Set(["running", "ok", "failed"]);
/** Arguments the progress view shows, by name; anything else in a call is not kept. */
const SHOWN_ARGS = ["command", "pattern", "path", "file_path", "url", "name", "agent", "subagent_type"] as const;
const SHOWN_ARG_CHARS = 200;

/** Child text the view shows on one line: whitespace runs (newlines too) become one space, bounded. */
const oneLine = (text: string) => text.replace(/\s+/g, " ").trim().slice(0, SHOWN_ARG_CHARS);

/** The parts of a tool call the progress view needs, its name and each argument one line and bounded. */
export function summarizeToolCall(name: string, args: unknown): ToolCallSummary {
	const record = (args && typeof args === "object" ? args : {}) as Record<string, unknown>;
	const shown: Record<string, string> = {};
	for (const key of SHOWN_ARGS) {
		const value = record[key];
		if (typeof value === "string" && value.trim()) shown[key] = oneLine(value);
	}
	if (Array.isArray(record.tasks)) shown.tasks = String(record.tasks.length);
	const oneLineName = oneLine(name);
	return Object.keys(shown).length ? { name: oneLineName, args: shown } : { name: oneLineName };
}

export interface ChildEvent {
	type?: string;
	/** Set on tool_execution_* events. */
	toolCallId?: string;
	toolName?: string;
	partialResult?: { details?: unknown };
	message?: PiMessageLike & { errorMessage?: string; provider?: string; toolName?: string; details?: unknown };
}

/** A call the child made, with the id its tool execution events carry. */
export interface TrackedCall {
	id?: string;
	call: ToolCallSummary;
}

export interface ChildRunState {
	messages: PiMessageLike[];
	/** Usage of the child's own assistant turns (and of tool results other than dev-team dispatch). */
	own: Usage;
	/** Everything, including nested dev-team dispatches: what pi should add to session totals. */
	total: Usage;
	nested: NestedUsage[];
	turns: number;
	/** The last TRACKED_CALLS_KEPT tool calls with their ids, in call order; markedCalls turns them into the view's recentCalls. */
	trackedCalls: TrackedCall[];
	/** The calls of the latest assistant message by id, in message order, so one that starts out of view comes back in its place. */
	latestMessageCalls: Map<string, ToolCallSummary>;
	/** Calls of the latest assistant message that have not ended yet (not run yet, or executing), by id. */
	unendedCalls: Set<string>;
	/** When each executing call started (epoch ms), by tool call id. */
	callStartTimes: Map<string, number>;
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
		trackedCalls: [],
		latestMessageCalls: new Map(),
		unendedCalls: new Set(),
		callStartTimes: new Map(),
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
		if (!isRecord(v) || typeof v.agent !== "string" || !v.agent.trim() || typeof v.status !== "string" || !SUBAGENT_STATUSES.has(v.status)) return [];
		const latest = Array.isArray(v.recentCalls) ? v.recentCalls.at(-1) : undefined;
		const subagents = level < MAX_LIVE_SUBAGENT_LEVELS ? liveViews(v.subagents, level + 1) : [];
		const view: LiveSubagentView = {
			agent: oneLine(v.agent),
			status: v.status as LiveSubagentView["status"],
			turns: typeof v.turns === "number" && Number.isFinite(v.turns) ? v.turns : 0,
			recentCalls: isRecord(latest) && typeof latest.name === "string" ? [summarizeToolCall(latest.name, latest.args)] : [],
			...(typeof v.queuePosition === "number" ? { queuePosition: v.queuePosition } : {}),
			...(subagents.length ? { subagents } : {}),
		};
		// Only a real place in line is kept (isWaitingForSlot checks it again where it is drawn).
		return [isWaitingForSlot(view) || view.queuePosition === undefined ? view : { ...view, queuePosition: undefined }];
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

/**
 * The last TRACKED_CALLS_KEPT calls; when there are more, finished calls go first, so a call that
 * still executes stays in view.
 */
function trimTrackedCalls(state: ChildRunState, calls: TrackedCall[]): TrackedCall[] {
	const kept = calls.slice(-(TRACKED_CALLS_KEPT + CALLS_BY_ID_KEPT));
	while (kept.length > TRACKED_CALLS_KEPT) {
		const finishedIndex = kept.findIndex((t) => t.id === undefined || !state.callStartTimes.has(t.id));
		kept.splice(finishedIndex === -1 ? 0 : finishedIndex, 1);
	}
	return kept;
}

/**
 * Put a call of the latest message back into the tracked calls at its place in the message: before
 * the first tracked call of that message that comes after it.
 */
function withCallInPlace(state: ChildRunState, id: string, call: ToolCallSummary): TrackedCall[] {
	const order = [...state.latestMessageCalls.keys()];
	const place = order.indexOf(id);
	const before = state.trackedCalls.findIndex((t) => t.id !== undefined && order.indexOf(t.id) > place);
	const at = before === -1 ? state.trackedCalls.length : before;
	return [...state.trackedCalls.slice(0, at), { id, call }, ...state.trackedCalls.slice(at)];
}

/** The calls the progress view shows: each a copy, an executing one marked with when it started. */
function markedCalls(state: ChildRunState): ToolCallSummary[] {
	return state.trackedCalls.map(({ id, call }) => {
		const since = id === undefined ? undefined : state.callStartTimes.get(id);
		return since === undefined ? { ...call } : { ...call, runningSince: since };
	});
}

/**
 * A tool of the child starts or ends executing. A start is kept by id, also before its message
 * arrives; a call the view dropped comes back when it starts. The model's step starts again (at
 * `now`) only once every call of the latest message has ended, so no thinking clock shows while a
 * call of the message has not run yet.
 */
function applyToolExecution(state: ChildRunState, ev: ChildEvent, now: number): ProgressPatch | undefined {
	const id = ev.toolCallId;
	if (typeof id !== "string") return undefined;
	if (ev.type === "tool_execution_start") {
		state.callStartTimes.set(id, now);
		if (state.callStartTimes.size > CALLS_BY_ID_KEPT) state.callStartTimes.delete(state.callStartTimes.keys().next().value as string);
		const latestMessageCall = state.latestMessageCalls.get(id);
		const isTracked = state.trackedCalls.some((t) => t.id === id);
		if (latestMessageCall && !isTracked) state.trackedCalls = trimTrackedCalls(state, withCallInPlace(state, id, latestMessageCall));
		return { recentCalls: markedCalls(state) };
	}
	const wasUnended = state.unendedCalls.delete(id);
	if (!state.callStartTimes.delete(id) && !wasUnended) return undefined;
	const allCallsEnded = !state.unendedCalls.size && !state.callStartTimes.size;
	return { recentCalls: markedCalls(state), ...(allCallsEnded ? { stepStartedAt: now } : {}) };
}

/**
 * The child finished an assistant turn: usage, model, stop reason and the calls it made. Its model
 * step is over: the calls run next, or, without calls, the child is done.
 */
function applyAssistantMessage(state: ChildRunState, message: NonNullable<ChildEvent["message"]>): ProgressPatch {
	state.messages.push(message);
	state.turns++;
	addPiUsage(state.own, message.usage as Partial<Usage> | undefined);
	addPiUsage(state.total, message.usage as Partial<Usage> | undefined);
	if (message.model) state.model = message.provider ? `${message.provider}/${message.model}` : message.model;
	if (message.stopReason) state.stopReason = message.stopReason;
	if (message.errorMessage) state.errorMessage = message.errorMessage;
	const calls = (Array.isArray(message.content) ? (message.content as { type: string; id?: unknown; name?: unknown; arguments?: unknown }[]) : [])
		.filter((c): c is { type: string; id?: unknown; name: string; arguments?: unknown } => c.type === "toolCall" && typeof c.name === "string" && !!c.name.trim())
		.map((c): TrackedCall => ({ id: typeof c.id === "string" ? c.id : undefined, call: summarizeToolCall(c.name, c.arguments) }));
	const withIds = calls.filter((t): t is TrackedCall & { id: string } => t.id !== undefined).slice(0, CALLS_BY_ID_KEPT);
	state.latestMessageCalls = new Map(withIds.map((t) => [t.id, t.call]));
	state.unendedCalls = new Set(withIds.map((t) => t.id));
	state.trackedCalls = trimTrackedCalls(state, [...state.trackedCalls, ...calls]);
	return {
		turns: state.turns,
		recentCalls: markedCalls(state),
		model: state.model,
		usage: toUsageTotals(state.own, state.turns),
		stepStartedAt: undefined,
	};
}

/**
 * A tool result: its usage, credited to the agents a nested dev-team dispatch ran, else to the child.
 * Returns the nested runs once there are new ones, so the view's spend so far includes them.
 */
function applyToolResult(state: ChildRunState, message: NonNullable<ChildEvent["message"]>): ProgressPatch | undefined {
	state.messages.push(message);
	const usage = message.usage as Partial<Usage> | undefined;
	addPiUsage(state.total, usage);
	const runs = message.toolName === DEV_TEAM_SUBAGENT_TOOL ? nestedUsageOf(message.details) : [];
	if (!runs.length) {
		addPiUsage(state.own, usage);
		return undefined;
	}
	state.nested = [...state.nested, ...runs];
	return { nested: state.nested };
}

/**
 * Apply one event. Returns the progress patch to show when the event changed it. pi's json mode
 * reports every finished message, tool results included, as `message_end`, a tool's run as
 * `tool_execution_start` / `_update` / `_end`; other events carry nothing this needs. `now` is when
 * the event arrived (epoch ms).
 */
export function applyChildEvent(state: ChildRunState, ev: ChildEvent, now = Date.now()): ProgressPatch | undefined {
	switch (ev.type) {
		case "tool_execution_start":
			return applyToolExecution(state, ev, now);
		case "tool_execution_update":
			return applyDispatchProgress(state, ev);
		case "tool_execution_end": {
			// Both may apply to a dev-team call; their patches share no key.
			const executionPatch = applyToolExecution(state, ev, now);
			const dispatchPatch = applyDispatchProgress(state, ev);
			return executionPatch || dispatchPatch ? { ...executionPatch, ...dispatchPatch } : undefined;
		}
		case "message_end":
			if (ev.message?.role === "assistant") return applyAssistantMessage(state, ev.message);
			if (ev.message?.role === "toolResult") return applyToolResult(state, ev.message);
			return undefined;
		default:
			return undefined;
	}
}
