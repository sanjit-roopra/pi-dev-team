/**
 * TUI renderers for `dev_team_subagent`, after pi's examples/extensions/subagent.
 *
 * Rendering only: the tool's `content` stays the model-facing result, so print/json/rpc modes are
 * unaffected. Everything shown comes from `details` (SubagentDetails), which the tool streams through
 * onUpdate while children run and returns final in the result. Child-derived text is sanitized first,
 * as pi's own tool renderer does, so child output cannot drive the terminal.
 */
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { getMarkdownTheme, type Theme, type ToolRenderContext, type ToolRenderResultOptions } from "@earendil-works/pi-coding-agent";
import { type Component, Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import { formatAiCredits, runsAiCredits } from "./ai-credits.ts";
import {
	creditedRuns,
	type DispatchArgs,
	describeWorktree,
	dispatchAgent,
	type LiveSubagentView,
	dispatchTask,
	type SubagentDetails,
	type SubagentTaskView,
	type ToolCallSummary,
	type UsageTotals,
} from "./subagent-types.ts";
import { sanitizeTerminalText } from "./terminal-text.ts";

const COLLAPSED_TOOLS = 3;
const COLLAPSED_OUTPUT_LINES = 3;
const CALL_PREVIEW_TASKS = 4;
const SINGLE_CALL_PREVIEW_CHARS = 80;
const PARALLEL_CALL_PREVIEW_CHARS = 50;
const COLLAPSED_ERROR_CHARS = 300;
/** Subagents listed under a running agent before the rest are counted. */
const SHOWN_SUBAGENTS = 12;
const SUBAGENT_INDENT = "  ";
/** How often a running dispatch redraws, so its clocks move between updates. */
const CLOCK_TICK_MS = 1000;
/** With no update for this long the clock stops (its run is gone); the next update starts it again. */
const CLOCK_IDLE_LIMIT_MS = 2 * 60 * 60 * 1000;

function preview(text: string | undefined, maxChars: number): string {
	const flat = sanitizeTerminalText(text ?? "").replace(/\s+/g, " ").trim();
	return flat.length > maxChars ? `${flat.slice(0, maxChars)}…` : flat || "…";
}

function formatTokens(n: number): string {
	if (n < 1000) return String(n);
	return `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k`;
}

export interface UsageLineOptions {
	model?: string;
	durationMs?: number;
	/** The GitHub Copilot AI credits within `u.cost`, shown after it when not 0. */
	aiCredits?: number;
}

/** Elapsed time for the progress view: "12s", "1m 05s", "1h 02m". */
export function formatElapsed(ms: number): string {
	const s = Math.max(0, Math.floor(ms / 1000));
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60);
	if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
	return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}

/** 1st, 2nd, 3rd, 4th, ... 11th, 12th, 13th, ... 21st. */
function ordinal(n: number): string {
	const tens = n % 100;
	const suffix = tens >= 11 && tens <= 13 ? "th" : ({ 1: "st", 2: "nd", 3: "rd" } as Record<number, string>)[n % 10] ?? "th";
	return `${n}${suffix}`;
}

/** One usage line: turns, tokens, cost (with its AI credits), duration and model. */
export function formatUsage(u: UsageTotals | undefined, { model, durationMs, aiCredits = 0 }: UsageLineOptions = {}): string {
	if (!u) return "";
	const parts = [`${u.turns} turn${u.turns === 1 ? "" : "s"}`, `↑${formatTokens(u.input)}`, `↓${formatTokens(u.output)}`];
	if (u.cacheRead) parts.push(`R${formatTokens(u.cacheRead)}`);
	if (u.cacheWrite) parts.push(`W${formatTokens(u.cacheWrite)}`);
	if (u.cost) parts.push(`$${u.cost.toFixed(4)}`);
	if (aiCredits) parts.push(`(${formatAiCredits(aiCredits)})`);
	if (durationMs !== undefined) parts.push(`${(durationMs / 1000).toFixed(1)}s`);
	if (model) parts.push(sanitizeTerminalText(model));
	return parts.join(" ");
}

/** One agent's own usage line (what it dispatched itself is in the parallel total). */
function agentUsageLine(v: SubagentTaskView): string {
	const aiCredits = v.usage ? runsAiCredits([{ model: v.model, usage: v.usage }]) : 0;
	return formatUsage(v.usage, { model: v.model, durationMs: v.durationMs, aiCredits });
}

function addTotals(t: UsageTotals, u: UsageTotals): UsageTotals {
	return {
		input: t.input + u.input,
		output: t.output + u.output,
		cacheRead: t.cacheRead + u.cacheRead,
		cacheWrite: t.cacheWrite + u.cacheWrite,
		cost: t.cost + u.cost,
		turns: t.turns + u.turns,
	};
}

/** Everything the agents cost, including what they dispatched themselves (what pi books for the call). */
function sumUsageTotals(views: SubagentTaskView[]): UsageTotals {
	const usages = views.flatMap((v) => creditedRuns(v).map((run) => run.usage));
	return usages.reduce(addTotals, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 });
}

function statusIcon(v: Pick<SubagentTaskView, "status" | "queuePosition">, theme: Theme): string {
	if (v.status === "running" && v.queuePosition) return theme.fg("muted", "◌");
	if (v.status === "running") return theme.fg("warning", "⏳");
	return v.status === "ok" ? theme.fg("success", "✓") : theme.fg("error", "✗");
}

/**
 * `now` is set only while the dispatch runs (a partial result): the live clocks are drawn against it.
 * A stored or final result has no `now`, so it never shows a clock that keeps counting.
 */
function headerLine(v: SubagentTaskView, theme: Theme, now?: number): string {
	let line = `${statusIcon(v, theme)} ${theme.fg("toolTitle", theme.bold(sanitizeTerminalText(v.agent)))}`;
	if (v.source === "project") line += theme.fg("muted", " (project)");
	if (v.tier && v.tier !== "inherit") line += theme.fg("muted", ` [${sanitizeTerminalText(v.tier)}]`);
	if (v.status === "failed" && v.stopReason && v.stopReason !== "stop") line += ` ${theme.fg("error", `[${sanitizeTerminalText(v.stopReason)}]`)}`;
	if (v.status === "running" && now !== undefined && v.startedAt !== undefined && !v.queuePosition) {
		line += theme.fg("dim", ` · ${formatElapsed(now - v.startedAt)}`);
	}
	return line;
}

function worktreeLine(v: SubagentTaskView, theme: Theme): string {
	return v.worktree ? theme.fg("muted", `worktree ${sanitizeTerminalText(describeWorktree(v.worktree))}`) : "";
}

const TOOL_CALL_CHARS = 80;

/**
 * A tool call as the progress view shows it, after pi's subagent example: `$ cmd`, `read path`,
 * `grep /pattern/ in path`, otherwise the tool name and its path, file_path, url or name argument.
 */
export function formatToolCall(call: ToolCallSummary): string {
	const a = call.args ?? {};
	let text: string;
	if (call.name === "bash" && a.command) text = `$ ${a.command}`;
	else if (call.name === "grep" && a.pattern) text = `grep /${a.pattern}/ in ${a.path ?? "."}`;
	else if (call.name === "find" && a.pattern) text = `find ${a.pattern} in ${a.path ?? "."}`;
	else if (call.name === "dev_team_subagent") {
		const who = a.agent ?? a.subagent_type ?? (a.tasks ? `${a.tasks} agents` : undefined);
		text = who ? `dev-team ${who}` : "dev-team";
	} else {
		const target = a.path ?? a.file_path ?? a.url ?? a.name;
		text = target ? `${call.name} ${target}` : call.name;
	}
	return text.length > TOOL_CALL_CHARS ? `${text.slice(0, TOOL_CALL_CHARS - 1)}…` : text;
}

/** A view's recent calls as display lines; stored sessions may still carry plain tool names. */
export function recentCallLines(v: Pick<SubagentTaskView, "recentCalls" | "tools">): string[] {
	return v.recentCalls ? v.recentCalls.map(formatToolCall) : (v.tools ?? []);
}

function toolLines(tools: string[], theme: Theme): string {
	return tools.map((t) => `${theme.fg("muted", "→ ")}${theme.fg("accent", sanitizeTerminalText(t))}`).join("\n");
}

/** A running agent's latest calls; one still executing is marked ▶ with how long it has run. */
function liveCallLines(v: SubagentTaskView, theme: Theme, now: number | undefined): string[] {
	if (!v.recentCalls) return v.tools?.length ? [toolLines(v.tools.slice(-COLLAPSED_TOOLS), theme)] : [];
	return v.recentCalls.slice(-COLLAPSED_TOOLS).map((call) => {
		const text = theme.fg("accent", sanitizeTerminalText(formatToolCall(call)));
		if (now === undefined || call.startedAt === undefined) return `${theme.fg("muted", "→ ")}${text}`;
		return `${theme.fg("warning", "▶ ")}${text}${theme.fg("dim", ` running ${formatElapsed(now - call.startedAt)}`)}`;
	});
}

/**
 * The body of a running agent: its place in line while it waits for a slot, otherwise its latest
 * calls and, when no call is executing, how long the model has worked on its current step.
 */
function runningLines(v: SubagentTaskView, theme: Theme, now: number | undefined): string[] {
	if (v.queuePosition) return [theme.fg("muted", `waiting for a free agent slot (${ordinal(v.queuePosition)} in line)`)];
	const lines = liveCallLines(v, theme, now);
	const executing = now !== undefined && v.recentCalls?.some((c) => c.startedAt !== undefined);
	const since = v.activeSince ?? v.startedAt;
	if (now !== undefined && !executing && since !== undefined) lines.push(theme.fg("dim", `  thinking… ${formatElapsed(now - since)}`));
	return lines.length ? lines : [theme.fg("muted", "(starting…)")];
}

/** One subagent: status, name, turn and its latest call, then the agents it runs in turn. */
function subagentLines(v: LiveSubagentView, indent: string, theme: Theme): string[] {
	let line = `${indent}${statusIcon(v, theme)} ${theme.fg("accent", sanitizeTerminalText(v.agent))}`;
	if (v.status === "running") {
		const latest = recentCallLines(v).at(-1);
		line += theme.fg("dim", ` turn ${v.turns}`);
		if (latest) line += `${theme.fg("muted", " → ")}${theme.fg("dim", sanitizeTerminalText(latest))}`;
	}
	return [line, ...(v.status === "running" ? subagentBlock(v.subagents, indent + SUBAGENT_INDENT, theme) : [])];
}

/**
 * The agents a running agent runs itself (through its own dev-team calls): a done count, then one
 * line each, still-running ones first, the rest counted.
 */
function subagentBlock(subagents: LiveSubagentView[] | undefined, indent: string, theme: Theme): string[] {
	if (!subagents?.length) return [];
	const running = subagents.filter((s) => s.status === "running");
	const finished = subagents.filter((s) => s.status !== "running");
	const lines = [theme.fg("muted", `${indent}subagents ${finished.length}/${subagents.length} done`)];
	for (const s of [...running, ...finished].slice(0, SHOWN_SUBAGENTS)) lines.push(...subagentLines(s, indent + SUBAGENT_INDENT, theme));
	const hiddenCount = subagents.length - SHOWN_SUBAGENTS;
	if (hiddenCount > 0) lines.push(theme.fg("muted", `${indent}${SUBAGENT_INDENT}… +${hiddenCount} more`));
	return lines;
}

/** Collapsed block for one agent: header, latest tool calls or the start of its output, usage. */
function renderCollapsed(v: SubagentTaskView, theme: Theme, now?: number): string {
	const lines = [headerLine(v, theme, now)];
	if (v.status === "failed" && v.error) lines.push(theme.fg("error", `Error: ${preview(v.error, COLLAPSED_ERROR_CHARS)}`));
	else if (v.status === "running") {
		lines.push(...runningLines(v, theme, now));
		lines.push(...subagentBlock(v.subagents, SUBAGENT_INDENT, theme));
	}
	else if (v.output) {
		lines.push(theme.fg("toolOutput", sanitizeTerminalText(v.output).trim().split("\n").slice(0, COLLAPSED_OUTPUT_LINES).join("\n")));
	} else lines.push(theme.fg("muted", "(no output)"));
	const wt = worktreeLine(v, theme);
	if (wt) lines.push(wt);
	const usage = agentUsageLine(v);
	if (usage) lines.push(theme.fg("dim", usage));
	return lines.join("\n");
}

/** Expanded block for one agent: header, task, recent tool calls, full output as markdown, usage. */
function renderExpandedInto(container: Container, v: SubagentTaskView, theme: Theme): void {
	container.addChild(new Text(headerLine(v, theme), 0, 0));
	container.addChild(new Text(`${theme.fg("muted", "Task: ")}${theme.fg("dim", sanitizeTerminalText(v.task))}`, 0, 0));
	const calls = recentCallLines(v);
	if (calls.length) container.addChild(new Text(toolLines(calls, theme), 0, 0));
	if (v.status === "failed" && v.error) container.addChild(new Text(theme.fg("error", `Error: ${sanitizeTerminalText(v.error)}`), 0, 0));
	if (v.output) {
		container.addChild(new Spacer(1));
		container.addChild(new Markdown(sanitizeTerminalText(v.output).trim(), 0, 0, getMarkdownTheme()));
	}
	const wt = worktreeLine(v, theme);
	if (wt) container.addChild(new Text(wt, 0, 0));
	const usage = agentUsageLine(v);
	if (usage) container.addChild(new Text(theme.fg("dim", usage), 0, 0));
}

export function renderSubagentCall(args: DispatchArgs & { tasks?: DispatchArgs[] }, theme: Theme): Component {
	const title = theme.fg("toolTitle", theme.bold("dev-team "));
	if (args.tasks?.length) {
		let text = `${title}${theme.fg("accent", `parallel (${args.tasks.length} agents)`)}`;
		for (const t of args.tasks.slice(0, CALL_PREVIEW_TASKS)) {
			text += `\n  ${theme.fg("accent", preview(dispatchAgent(t), PARALLEL_CALL_PREVIEW_CHARS))}${theme.fg("dim", ` ${preview(dispatchTask(t), PARALLEL_CALL_PREVIEW_CHARS)}`)}`;
		}
		const hiddenTaskCount = args.tasks.length - CALL_PREVIEW_TASKS;
		if (hiddenTaskCount > 0) text += `\n  ${theme.fg("muted", `… +${hiddenTaskCount} more`)}`;
		return new Text(text, 0, 0);
	}
	let text = `${title}${theme.fg("accent", preview(dispatchAgent(args), SINGLE_CALL_PREVIEW_CHARS))}`;
	if (args.isolation === "worktree") text += theme.fg("muted", " [worktree]");
	text += `\n  ${theme.fg("dim", preview(dispatchTask(args), SINGLE_CALL_PREVIEW_CHARS))}`;
	return new Text(text, 0, 0);
}

/** The renderer state the live clock keeps in pi's per-row `context.state`. */
interface ClockState {
	devTeamClock?: ReturnType<typeof setInterval>;
	devTeamLastDetails?: unknown;
	devTeamLastUpdateAt?: number;
}

/**
 * Keep a running dispatch redrawing once a second, so its clocks move while no agent reports
 * anything; stop when it finishes. pi gives each tool row its own `state` and `invalidate`. A row
 * whose run went away without a final result stops after CLOCK_IDLE_LIMIT_MS without updates.
 */
function keepClockRunning(context: Pick<ToolRenderContext, "invalidate" | "state"> | undefined, details: unknown, running: boolean, now: number): void {
	const state = context?.state as ClockState | undefined;
	if (!context || !state || typeof state !== "object") return;
	if (state.devTeamLastDetails !== details) {
		state.devTeamLastDetails = details;
		state.devTeamLastUpdateAt = now;
	}
	const stop = () => {
		clearInterval(state.devTeamClock);
		state.devTeamClock = undefined;
	};
	if (!running) return stop();
	if (state.devTeamClock) return;
	state.devTeamClock = setInterval(() => {
		if (Date.now() - (state.devTeamLastUpdateAt ?? 0) > CLOCK_IDLE_LIMIT_MS) return stop();
		context.invalidate();
	}, CLOCK_TICK_MS);
	state.devTeamClock.unref?.();
}

/** The parallel header while agents run: done, running and waiting counts, the clock and the spend so far. */
function runningSummaryLine(details: SubagentDetails, theme: Theme, now: number | undefined): string {
	const views = details.results;
	const running = views.filter((v) => v.status === "running");
	const waiting = running.filter((v) => v.queuePosition).length;
	let counts = `${views.length - running.length}/${views.length} done, ${running.length - waiting} running`;
	if (waiting) counts += `, ${waiting} waiting`;
	const label = details.label ? `${sanitizeTerminalText(details.label)} · ` : "";
	let line = `${theme.fg("warning", "⏳")} ${theme.fg("toolTitle", theme.bold("parallel "))}${theme.fg("accent", `${label}${counts}`)}`;
	if (now !== undefined && details.startedAt !== undefined) line += theme.fg("dim", ` · ${formatElapsed(now - details.startedAt)}`);
	const spent = sumUsageTotals(views);
	if (spent.cost) {
		const aiCredits = runsAiCredits(views.flatMap((v) => creditedRuns(v)));
		line += theme.fg("dim", ` · $${spent.cost.toFixed(4)}${aiCredits ? ` (${formatAiCredits(aiCredits)})` : ""} so far`);
	}
	return line;
}

export function renderSubagentResult(
	result: AgentToolResult<unknown>,
	{ expanded, isPartial }: ToolRenderResultOptions,
	theme: Theme,
	context?: Pick<ToolRenderContext, "invalidate" | "state">,
	now = Date.now(),
): Component {
	const details = result.details as SubagentDetails | undefined;
	const anyRunning = !!details?.results?.some((v) => v.status === "running");
	keepClockRunning(context, result.details, isPartial && anyRunning, now);
	if (!details?.results?.length) {
		const first = result.content[0];
		return new Text(sanitizeTerminalText(first?.type === "text" ? first.text : "(no output)"), 0, 0);
	}
	const liveNow = isPartial ? now : undefined;
	const views = details.results;
	const skipped = details.skippedProjectAgents ?? details.untrustedProjectAgents ?? [];
	const skippedNote = skipped.length
		? theme.fg("warning", `project agents skipped (project not trusted): ${sanitizeTerminalText(skipped.join(", "))}`)
		: "";

	if (views.length === 1) {
		const v = views[0];
		if (expanded && !isPartial) {
			const c = new Container();
			renderExpandedInto(c, v, theme);
			if (skippedNote) c.addChild(new Text(skippedNote, 0, 0));
			return c;
		}
		let text = renderCollapsed(v, theme, liveNow);
		if (skippedNote) text += `\n${skippedNote}`;
		if (!isPartial && v.output && v.output.trim().split("\n").length > COLLAPSED_OUTPUT_LINES) {
			text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
		}
		return new Text(text, 0, 0);
	}

	const runningCount = views.filter((v) => v.status === "running").length;
	const failedCount = views.filter((v) => v.status === "failed").length;
	const summaryLine = runningCount
		? runningSummaryLine(details, theme, liveNow)
		: `${failedCount ? theme.fg("warning", "◐") : theme.fg("success", "✓")} ${theme.fg("toolTitle", theme.bold("parallel "))}${theme.fg("accent", `${views.length - failedCount}/${views.length} succeeded`)}`;
	const totalUsageText = runningCount ? "" : formatUsage(sumUsageTotals(views), { aiCredits: runsAiCredits(views.flatMap((v) => creditedRuns(v))) });

	if (expanded && !runningCount) {
		const c = new Container();
		c.addChild(new Text(summaryLine, 0, 0));
		for (const v of views) {
			c.addChild(new Spacer(1));
			renderExpandedInto(c, v, theme);
		}
		if (skippedNote) c.addChild(new Text(skippedNote, 0, 0));
		if (totalUsageText) {
			c.addChild(new Spacer(1));
			c.addChild(new Text(theme.fg("dim", `Total: ${totalUsageText}`), 0, 0));
		}
		return c;
	}
	let text = summaryLine;
	for (const v of views) text += `\n\n${renderCollapsed(v, theme, liveNow)}`;
	if (skippedNote) text += `\n\n${skippedNote}`;
	if (totalUsageText) text += `\n\n${theme.fg("dim", `Total: ${totalUsageText}`)}`;
	if (!runningCount) text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
	return new Text(text, 0, 0);
}
