/**
 * TUI renderers for `dev_team_subagent`, after pi's examples/extensions/subagent.
 *
 * Rendering only: the tool's `content` stays the model-facing result, so print/json/rpc modes are
 * unaffected. Everything shown comes from `details` (SubagentDetails), which the tool streams through
 * onUpdate while children run and returns final in the result. Child-derived text is sanitized first,
 * as pi's own tool renderer does, so child output cannot drive the terminal.
 */
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { getMarkdownTheme, type Theme, type ToolRenderResultOptions } from "@earendil-works/pi-coding-agent";
import { type Component, Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import {
	type DispatchArgs,
	describeWorktree,
	dispatchAgent,
	dispatchTask,
	type SubagentDetails,
	type SubagentTaskView,
	type UsageTotals,
} from "./subagent-types.ts";

const COLLAPSED_TOOLS = 3;
const COLLAPSED_OUTPUT_LINES = 3;
const CALL_PREVIEW_TASKS = 4;
const SINGLE_CALL_PREVIEW_CHARS = 80;
const PARALLEL_CALL_PREVIEW_CHARS = 50;
const COLLAPSED_ERROR_CHARS = 300;

// ANSI CSI/OSC/other escape sequences, then remaining C0/C1 controls (keeping \t and \n) and the
// interlinear annotation characters pi's sanitizeBinaryOutput also removes. A bare \r would let a line
// overwrite itself, so CR and CRLF become \n first.
const ANSI_RE = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[@-Z\\-_])/g;
const CONTROL_RE = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f￹-￻]/g;

export function sanitizeTerminalText(text: string): string {
	return text.replace(/\r\n?/g, "\n").replace(ANSI_RE, "").replace(CONTROL_RE, "");
}

function preview(text: string | undefined, maxChars: number): string {
	const flat = sanitizeTerminalText(text ?? "").replace(/\s+/g, " ").trim();
	return flat.length > maxChars ? `${flat.slice(0, maxChars)}…` : flat || "…";
}

function formatTokens(n: number): string {
	if (n < 1000) return String(n);
	return `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k`;
}

export function formatUsage(u: UsageTotals | undefined, model?: string, durationMs?: number): string {
	if (!u) return "";
	const parts = [`${u.turns} turn${u.turns === 1 ? "" : "s"}`, `↑${formatTokens(u.input)}`, `↓${formatTokens(u.output)}`];
	if (u.cacheRead) parts.push(`R${formatTokens(u.cacheRead)}`);
	if (u.cacheWrite) parts.push(`W${formatTokens(u.cacheWrite)}`);
	if (u.cost) parts.push(`$${u.cost.toFixed(4)}`);
	if (durationMs !== undefined) parts.push(`${(durationMs / 1000).toFixed(1)}s`);
	if (model) parts.push(sanitizeTerminalText(model));
	return parts.join(" ");
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
	const usages = views.flatMap((v) => [...(v.usage ? [v.usage] : []), ...(v.nested ?? []).map((n) => n.usage)]);
	return usages.reduce(addTotals, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 });
}

function statusIcon(v: SubagentTaskView, theme: Theme): string {
	if (v.status === "running") return theme.fg("warning", "⏳");
	return v.status === "ok" ? theme.fg("success", "✓") : theme.fg("error", "✗");
}

function headerLine(v: SubagentTaskView, theme: Theme): string {
	let line = `${statusIcon(v, theme)} ${theme.fg("toolTitle", theme.bold(sanitizeTerminalText(v.agent)))}`;
	if (v.source === "project") line += theme.fg("muted", " (project)");
	if (v.tier && v.tier !== "inherit") line += theme.fg("muted", ` [${sanitizeTerminalText(v.tier)}]`);
	if (v.status === "failed" && v.stopReason && v.stopReason !== "stop") line += ` ${theme.fg("error", `[${sanitizeTerminalText(v.stopReason)}]`)}`;
	return line;
}

function worktreeLine(v: SubagentTaskView, theme: Theme): string {
	return v.worktree ? theme.fg("muted", `worktree ${sanitizeTerminalText(describeWorktree(v.worktree))}`) : "";
}

function toolLines(tools: string[], theme: Theme): string {
	return tools.map((t) => `${theme.fg("muted", "→ ")}${theme.fg("accent", sanitizeTerminalText(t))}`).join("\n");
}

/** Collapsed block for one agent: header, latest tool calls or the start of its output, usage. */
function renderCollapsed(v: SubagentTaskView, theme: Theme): string {
	const lines = [headerLine(v, theme)];
	if (v.status === "failed" && v.error) lines.push(theme.fg("error", `Error: ${preview(v.error, COLLAPSED_ERROR_CHARS)}`));
	else if (v.status === "running") lines.push(v.tools.length ? toolLines(v.tools.slice(-COLLAPSED_TOOLS), theme) : theme.fg("muted", "(starting…)"));
	else if (v.output) {
		lines.push(theme.fg("toolOutput", sanitizeTerminalText(v.output).trim().split("\n").slice(0, COLLAPSED_OUTPUT_LINES).join("\n")));
	} else lines.push(theme.fg("muted", "(no output)"));
	const wt = worktreeLine(v, theme);
	if (wt) lines.push(wt);
	const usage = formatUsage(v.usage, v.model, v.durationMs);
	if (usage) lines.push(theme.fg("dim", usage));
	return lines.join("\n");
}

/** Expanded block for one agent: header, task, recent tool calls, full output as markdown, usage. */
function renderExpandedInto(container: Container, v: SubagentTaskView, theme: Theme): void {
	container.addChild(new Text(headerLine(v, theme), 0, 0));
	container.addChild(new Text(`${theme.fg("muted", "Task: ")}${theme.fg("dim", sanitizeTerminalText(v.task))}`, 0, 0));
	if (v.tools.length) container.addChild(new Text(toolLines(v.tools, theme), 0, 0));
	if (v.status === "failed" && v.error) container.addChild(new Text(theme.fg("error", `Error: ${sanitizeTerminalText(v.error)}`), 0, 0));
	if (v.output) {
		container.addChild(new Spacer(1));
		container.addChild(new Markdown(sanitizeTerminalText(v.output).trim(), 0, 0, getMarkdownTheme()));
	}
	const wt = worktreeLine(v, theme);
	if (wt) container.addChild(new Text(wt, 0, 0));
	const usage = formatUsage(v.usage, v.model, v.durationMs);
	if (usage) container.addChild(new Text(theme.fg("dim", usage), 0, 0));
}

export function renderSubagentCall(args: DispatchArgs & { tasks?: DispatchArgs[] }, theme: Theme): Component {
	const title = theme.fg("toolTitle", theme.bold("dev-team "));
	if (args.tasks?.length) {
		let text = `${title}${theme.fg("accent", `parallel (${args.tasks.length} agents)`)}`;
		for (const t of args.tasks.slice(0, CALL_PREVIEW_TASKS)) {
			text += `\n  ${theme.fg("accent", preview(dispatchAgent(t), PARALLEL_CALL_PREVIEW_CHARS))}${theme.fg("dim", ` ${preview(dispatchTask(t), PARALLEL_CALL_PREVIEW_CHARS)}`)}`;
		}
		const more = args.tasks.length - CALL_PREVIEW_TASKS;
		if (more > 0) text += `\n  ${theme.fg("muted", `… +${more} more`)}`;
		return new Text(text, 0, 0);
	}
	let text = `${title}${theme.fg("accent", preview(dispatchAgent(args), SINGLE_CALL_PREVIEW_CHARS))}`;
	if (args.isolation === "worktree") text += theme.fg("muted", " [worktree]");
	text += `\n  ${theme.fg("dim", preview(dispatchTask(args), SINGLE_CALL_PREVIEW_CHARS))}`;
	return new Text(text, 0, 0);
}

export function renderSubagentResult(
	result: AgentToolResult<unknown>,
	{ expanded, isPartial }: ToolRenderResultOptions,
	theme: Theme,
): Component {
	const details = result.details as SubagentDetails | undefined;
	if (!details?.results?.length) {
		const first = result.content[0];
		return new Text(sanitizeTerminalText(first?.type === "text" ? first.text : "(no output)"), 0, 0);
	}
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
		let text = renderCollapsed(v, theme);
		if (skippedNote) text += `\n${skippedNote}`;
		if (!isPartial && v.output && v.output.trim().split("\n").length > COLLAPSED_OUTPUT_LINES) {
			text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
		}
		return new Text(text, 0, 0);
	}

	const running = views.filter((v) => v.status === "running").length;
	const failed = views.filter((v) => v.status === "failed").length;
	const summaryLine = running
		? `${theme.fg("warning", "⏳")} ${theme.fg("toolTitle", theme.bold("parallel "))}${theme.fg("accent", `${views.length - running}/${views.length} done, ${running} running`)}`
		: `${failed ? theme.fg("warning", "◐") : theme.fg("success", "✓")} ${theme.fg("toolTitle", theme.bold("parallel "))}${theme.fg("accent", `${views.length - failed}/${views.length} succeeded`)}`;
	const totalUsageText = running ? "" : formatUsage(sumUsageTotals(views));

	if (expanded && !running) {
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
	for (const v of views) text += `\n\n${renderCollapsed(v, theme)}`;
	if (skippedNote) text += `\n\n${skippedNote}`;
	if (totalUsageText) text += `\n\n${theme.fg("dim", `Total: ${totalUsageText}`)}`;
	if (!running) text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
	return new Text(text, 0, 0);
}
