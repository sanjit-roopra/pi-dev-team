/**
 * TUI renderers for `dev_team_subagent`, after pi's examples/extensions/subagent.
 *
 * Rendering only: the tool's `content` stays the model-facing result, so print/json/rpc modes are
 * unaffected. Everything shown comes from `details` (SubagentDetails), which the tool streams through
 * onUpdate while children run and returns final in the result.
 */
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { getMarkdownTheme, type Theme, type ToolRenderResultOptions } from "@earendil-works/pi-coding-agent";
import { type Component, Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import type { SubagentDetails, SubagentTaskView, UsageTotals } from "./subagent.ts";

const COLLAPSED_TOOLS = 3;
const COLLAPSED_OUTPUT_LINES = 3;

interface CallArgs {
	agent?: string;
	subagent_type?: string;
	task?: string;
	prompt?: string;
	isolation?: string;
	tasks?: CallArgs[];
}

function preview(text: string | undefined, max: number): string {
	const flat = (text ?? "").replace(/\s+/g, " ").trim();
	return flat.length > max ? `${flat.slice(0, max)}…` : flat || "…";
}

function tokens(n: number): string {
	return n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : String(n);
}

export function formatUsage(u: UsageTotals | undefined, model?: string, durationMs?: number): string {
	if (!u) return "";
	const parts = [`${u.turns} turn${u.turns === 1 ? "" : "s"}`, `↑${tokens(u.input)}`, `↓${tokens(u.output)}`];
	if (u.cacheRead) parts.push(`R${tokens(u.cacheRead)}`);
	if (u.cacheWrite) parts.push(`W${tokens(u.cacheWrite)}`);
	if (u.cost) parts.push(`$${u.cost.toFixed(4)}`);
	if (durationMs !== undefined) parts.push(`${(durationMs / 1000).toFixed(1)}s`);
	if (model) parts.push(model);
	return parts.join(" ");
}

function totalUsage(views: SubagentTaskView[]): UsageTotals {
	const t: UsageTotals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
	for (const v of views) {
		if (!v.usage) continue;
		t.input += v.usage.input;
		t.output += v.usage.output;
		t.cacheRead += v.usage.cacheRead;
		t.cacheWrite += v.usage.cacheWrite;
		t.cost += v.usage.cost;
		t.turns += v.usage.turns;
	}
	return t;
}

function icon(v: SubagentTaskView, theme: Theme): string {
	if (v.status === "running") return theme.fg("warning", "⏳");
	return v.status === "ok" ? theme.fg("success", "✓") : theme.fg("error", "✗");
}

function header(v: SubagentTaskView, theme: Theme): string {
	let line = `${icon(v, theme)} ${theme.fg("toolTitle", theme.bold(v.agent))}`;
	if (v.source === "project") line += theme.fg("muted", " (project)");
	if (v.tier && v.tier !== "inherit") line += theme.fg("muted", ` [${v.tier}]`);
	if (v.status === "failed" && v.stopReason && v.stopReason !== "stop") line += ` ${theme.fg("error", `[${v.stopReason}]`)}`;
	return line;
}

function worktreeLine(v: SubagentTaskView, theme: Theme): string {
	const wt = v.worktree;
	if (!wt) return "";
	return theme.fg(
		"muted",
		wt.kept
			? `worktree kept: ${wt.path} on ${wt.branch} (${wt.commits} commit(s)${wt.dirty ? ", uncommitted changes" : ""})`
			: "worktree removed: no changes",
	);
}

/** Collapsed block for one agent: header, latest tool calls or the start of its output, usage. */
function collapsed(v: SubagentTaskView, theme: Theme): string {
	const lines = [header(v, theme)];
	if (v.status === "failed" && v.error) lines.push(theme.fg("error", `Error: ${preview(v.error, 300)}`));
	else if (v.status === "running") {
		lines.push(
			v.tools.length
				? v.tools.slice(-COLLAPSED_TOOLS).map((t) => `${theme.fg("muted", "→ ")}${theme.fg("accent", t)}`).join("\n")
				: theme.fg("muted", "(starting…)"),
		);
	} else if (v.output) {
		lines.push(theme.fg("toolOutput", v.output.trim().split("\n").slice(0, COLLAPSED_OUTPUT_LINES).join("\n")));
	} else lines.push(theme.fg("muted", "(no output)"));
	const wt = worktreeLine(v, theme);
	if (wt) lines.push(wt);
	const usage = formatUsage(v.usage, v.model, v.durationMs);
	if (usage) lines.push(theme.fg("dim", usage));
	return lines.join("\n");
}

/** Expanded block for one agent: header, task, recent tool calls, full output as markdown, usage. */
function expandedInto(container: Container, v: SubagentTaskView, theme: Theme): void {
	container.addChild(new Text(header(v, theme), 0, 0));
	container.addChild(new Text(`${theme.fg("muted", "Task: ")}${theme.fg("dim", v.task)}`, 0, 0));
	if (v.tools.length) {
		container.addChild(new Text(v.tools.map((t) => `${theme.fg("muted", "→ ")}${theme.fg("accent", t)}`).join("\n"), 0, 0));
	}
	if (v.status === "failed" && v.error) container.addChild(new Text(theme.fg("error", `Error: ${v.error}`), 0, 0));
	if (v.output) {
		container.addChild(new Spacer(1));
		container.addChild(new Markdown(v.output.trim(), 0, 0, getMarkdownTheme()));
	}
	const wt = worktreeLine(v, theme);
	if (wt) container.addChild(new Text(wt, 0, 0));
	const usage = formatUsage(v.usage, v.model, v.durationMs);
	if (usage) container.addChild(new Text(theme.fg("dim", usage), 0, 0));
}

export function renderSubagentCall(args: CallArgs, theme: Theme): Component {
	const title = theme.fg("toolTitle", theme.bold("dev-team "));
	if (args.tasks?.length) {
		let text = `${title}${theme.fg("accent", `parallel (${args.tasks.length} agents)`)}`;
		for (const t of args.tasks.slice(0, 4)) {
			text += `\n  ${theme.fg("accent", t.agent ?? t.subagent_type ?? "…")}${theme.fg("dim", ` ${preview(t.task ?? t.prompt, 50)}`)}`;
		}
		if (args.tasks.length > 4) text += `\n  ${theme.fg("muted", `… +${args.tasks.length - 4} more`)}`;
		return new Text(text, 0, 0);
	}
	let text = `${title}${theme.fg("accent", args.agent ?? args.subagent_type ?? "…")}`;
	if (args.isolation === "worktree") text += theme.fg("muted", " [worktree]");
	text += `\n  ${theme.fg("dim", preview(args.task ?? args.prompt, 80))}`;
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
		return new Text(first?.type === "text" ? first.text : "(no output)", 0, 0);
	}
	const views = details.results;
	const trust = details.untrustedProjectAgents?.length
		? theme.fg("warning", `project agents skipped (project not trusted): ${details.untrustedProjectAgents.join(", ")}`)
		: "";

	if (views.length === 1) {
		const v = views[0];
		if (expanded && !isPartial) {
			const c = new Container();
			expandedInto(c, v, theme);
			if (trust) c.addChild(new Text(trust, 0, 0));
			return c;
		}
		let text = collapsed(v, theme);
		if (trust) text += `\n${trust}`;
		if (!isPartial && v.output && v.output.trim().split("\n").length > COLLAPSED_OUTPUT_LINES) {
			text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
		}
		return new Text(text, 0, 0);
	}

	const running = views.filter((v) => v.status === "running").length;
	const failed = views.filter((v) => v.status === "failed").length;
	const done = views.length - running;
	const top = running
		? `${theme.fg("warning", "⏳")} ${theme.fg("toolTitle", theme.bold("parallel "))}${theme.fg("accent", `${done}/${views.length} done, ${running} running`)}`
		: `${failed ? theme.fg("warning", "◐") : theme.fg("success", "✓")} ${theme.fg("toolTitle", theme.bold("parallel "))}${theme.fg("accent", `${views.length - failed}/${views.length} succeeded`)}`;
	const total = running ? "" : formatUsage(totalUsage(views));

	if (expanded && !running) {
		const c = new Container();
		c.addChild(new Text(top, 0, 0));
		for (const v of views) {
			c.addChild(new Spacer(1));
			expandedInto(c, v, theme);
		}
		if (trust) c.addChild(new Text(trust, 0, 0));
		if (total) {
			c.addChild(new Spacer(1));
			c.addChild(new Text(theme.fg("dim", `Total: ${total}`), 0, 0));
		}
		return c;
	}
	let text = top;
	for (const v of views) text += `\n\n${collapsed(v, theme)}`;
	if (trust) text += `\n\n${trust}`;
	if (total) text += `\n\n${theme.fg("dim", `Total: ${total}`)}`;
	if (!running) text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
	return new Text(text, 0, 0);
}
