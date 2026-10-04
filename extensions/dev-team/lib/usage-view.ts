/**
 * The /dev-team usage overlay. renderUsage() turns the view's state plus the credits breakdown into
 * the lines of the panel (header, split bar, ranked chart, footer), fitted to the terminal's width
 * and height; it is pure (colour comes from the injected style), so tests drive it without pi.
 * UsageView is the thin component around it: it holds the state and reacts to keys.
 */
import { type Component, visibleWidth } from "@earendil-works/pi-tui";
import { COPILOT_PROVIDER, formatAiCredits, formatCredits } from "./ai-credits.ts";
import type { SpendRun } from "./session-spend.ts";
import { type CreditsRow, formatShare, type UsageBreakdown, usageBreakdown } from "./usage-breakdown.ts";
import { barChartLines, type ChartStyle, cutToWidth, type SplitLabel, type SplitStyle, splitBarLines } from "./usage-chart.ts";
import { reduce, type Scope, type Transition, type UsageEffect, type UsageState, usageKeyFor, type View } from "./usage-state.ts";

export interface UsageStyle extends ChartStyle, SplitStyle {
	/** The header line. */
	title(text: string): string;
	/** The load failure message. */
	error(text: string): string;
}

/** What this month's load produced. */
export interface MonthSnapshot {
	breakdown: UsageBreakdown;
	/** Session files that could not be read. */
	skipped: number;
	/** When the load finished; the header says "as of" this time. */
	loadedAt: Date;
}

export interface UsageModel {
	state: UsageState;
	/** This session's breakdown. */
	session: UsageBreakdown;
	/** This month's, once loaded. */
	month?: MonthSnapshot;
	now: Date;
}

export interface RenderOptions {
	width: number;
	/** Most lines the panel may take. */
	height: number;
	style: UsageStyle;
}

const SEPARATOR = " · ";
const SCOPE_TITLE: Record<Scope, string> = { session: "This session", month: "This month" };
const SCOPE_NOUN: Record<Scope, string> = { session: "this session", month: "this month" };
const VIEW_TITLE: Record<View, string> = { model: "By model", agent: "By agent" };

/** Every row is GitHub Copilot, so the provider prefix is noise. */
const modelLabel = (model: string) => (model.startsWith(`${COPILOT_PROVIDER}/`) ? model.slice(COPILOT_PROVIDER.length + 1) : model);

const monthDay = (date: Date) => date.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
const clock = (date: Date) => `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;

/** The credits breakdown the state is showing, or undefined while it is not known (loading, failed). */
function shownBreakdown(model: UsageModel): UsageBreakdown | undefined {
	if (model.state.scope === "session") return model.session;
	return model.state.load.kind === "ready" ? model.month?.breakdown : undefined;
}

/**
 * The header from most to least detailed: the snapshot time goes first, then the dates, so a narrow
 * terminal keeps the scope, the view and the total.
 */
function headerCandidates(model: UsageModel): string[] {
	const { scope, view } = model.state;
	const breakdown = shownBreakdown(model);
	const windowStart = new Date(Date.UTC(model.now.getUTCFullYear(), model.now.getUTCMonth(), 1));
	const dates = scope === "month" ? ` (${monthDay(windowStart)} – ${monthDay(model.now)})` : "";
	const tail = [VIEW_TITLE[view], ...(breakdown ? [formatAiCredits(breakdown.total)] : [])];
	const asOf = scope === "month" && breakdown && model.month ? [`as of ${clock(model.month.loadedAt)}`] : [];
	const join = (scopeText: string, ...more: string[]) => [scopeText, ...tail, ...more].join(SEPARATOR);
	return [join(`${SCOPE_TITLE[scope]}${dates}`, ...asOf), join(`${SCOPE_TITLE[scope]}${dates}`), join(SCOPE_TITLE[scope])];
}

/** The key hints from most to least detailed: hints drop from the left, so "Esc close" is the last to go. */
function footerCandidates(state: UsageState): string[] {
	const other = SCOPE_NOUN[state.scope === "session" ? "month" : "session"];
	let hints = ["Tab view", `s ${other}`, "Esc close"];
	if (state.load.kind === "error") hints = ["s back", "Esc close"];
	else if (state.load.kind === "loading") hints = ["Tab view", "s cancel", "Esc close"];
	return hints.map((_, i) => hints.slice(i).join(SEPARATOR));
}

/** The first candidate that fits `width`, else the last one cut to it. */
function fitLine(candidates: readonly string[], width: number): string {
	return candidates.find((c) => visibleWidth(c) <= width) ?? cutToWidth(candidates.at(-1) ?? "", width);
}

const PINNED_LINES = 2;
const CONTROL_RUNS = /[\u0000-\u001f\u007f-\u009f]+/g;

const usageIn = (scope: Scope) => (scope === "session" ? "in this session" : "this month");

/** Text that fills the chart area in place of a chart. */
interface Message {
	text: string;
	tone: "plain" | "error";
}

function loadingMessage(load: UsageState["load"]): string {
	return load.kind === "loading" && load.progress ? `Reading sessions… ${load.progress.done}/${load.progress.total} files` : "Reading sessions…";
}

/** What replaces the chart when there is none to draw; undefined when the view has rows. */
function bodyMessage(model: UsageModel, breakdown: UsageBreakdown | undefined): Message | undefined {
	const { state } = model;
	if (state.load.kind === "loading") return { text: loadingMessage(state.load), tone: "plain" };
	if (state.load.kind === "error") return { text: `Could not load history: ${state.load.reason.replace(CONTROL_RUNS, " ")}`, tone: "error" };
	if (!breakdown || breakdown.total === 0) {
		const hint = state.scope === "session" ? " — press s for this month" : "";
		return { text: `No GitHub Copilot usage ${usageIn(state.scope)}${hint}`, tone: "plain" };
	}
	if (state.view === "agent" && breakdown.byAgent.length === 0) return { text: `No subagent usage ${usageIn(state.scope)}`, tone: "plain" };
	return undefined;
}

function footnoteText(model: UsageModel): string | undefined {
	const skipped = model.state.scope === "month" && model.state.load.kind === "ready" ? (model.month?.skipped ?? 0) : 0;
	return skipped > 0 ? `${skipped} session ${skipped === 1 ? "file" : "files"} could not be read` : undefined;
}

/** What the panel would like to show, in lines. */
interface Wanted {
	split: number;
	footnote: boolean;
	chart: number;
}

interface Layout {
	/** Blank lines between header, split bar, chart and footer. */
	gaps: boolean;
	/** Split bar lines kept (the bar first, then its legend). */
	split: number;
	footnote: boolean;
	chartRows: number;
}

/** Chart rows worth keeping over the extras before the extras start to go. */
const MIN_CHART_ROWS = 3;

/**
 * Decides which lines are pinned and which flex for `height`. The header and footer always stay; the
 * rest give way in order (blank gaps, footnote, split legend, split bar) until the chart gets
 * MIN_CHART_ROWS rows or what it asked for, whichever is fewer. What is left goes to the chart.
 */
function layout(height: number, want: Wanted): Layout {
	const free = Math.max(0, height - PINNED_LINES);
	const gapLines = 2 + (want.split ? 1 : 0);
	const options: Layout[] = [
		{ gaps: true, split: want.split, footnote: want.footnote, chartRows: 0 },
		{ gaps: false, split: want.split, footnote: want.footnote, chartRows: 0 },
		{ gaps: false, split: want.split, footnote: false, chartRows: 0 },
		{ gaps: false, split: Math.min(1, want.split), footnote: false, chartRows: 0 },
		{ gaps: false, split: 0, footnote: false, chartRows: 0 },
	];
	const withChartRows = (o: Layout): Layout => ({ ...o, chartRows: Math.max(0, free - (o.gaps ? gapLines : 0) - o.split - (o.footnote ? 1 : 0)) });
	const sized = options.map(withChartRows);
	return sized.find((o) => o.chartRows >= Math.min(want.chart, MIN_CHART_ROWS)) ?? sized[sized.length - 1];
}

export function renderUsage(model: UsageModel, { width, height, style }: RenderOptions): string[] {
	const breakdown = shownBreakdown(model);
	const message = bodyMessage(model, breakdown);
	// A split bar shows whenever there is spend to split, even when the view's own chart is empty.
	const showSplit = !!breakdown && breakdown.total > 0 && model.state.load.kind !== "loading";
	const splitLines = showSplit
		? splitBarLines(
				breakdown.byThread.map((r) => ({ label: r.label as SplitLabel, credits: r.credits })),
				{ width, formatValue: formatCredits, style },
			)
		: [];
	const footnote = footnoteText(model);
	const rows: CreditsRow[] = !breakdown ? [] : model.state.view === "model" ? breakdown.byModel.map((r) => ({ ...r, label: modelLabel(r.label) })) : breakdown.byAgent;
	const plan = layout(height, { split: splitLines.length, footnote: !!footnote, chart: message ? 1 : rows.length });

	const split = splitLines.slice(0, plan.split);
	const paint = message?.tone === "error" ? style.error : (text: string) => text;
	const body = message
		? plan.chartRows > 0 ? [paint(cutToWidth(message.text, width))] : []
		: barChartLines(rows, { width, maxRows: plan.chartRows, formatValue: formatCredits, formatShare, style });
	const gap = plan.gaps ? [""] : [];
	return [
		style.title(fitLine(headerCandidates(model), width)),
		...gap,
		...(split.length ? [...split, ...gap] : []),
		...body,
		...(footnote && plan.footnote ? [style.muted(cutToWidth(footnote, width))] : []),
		...gap,
		style.muted(fitLine(footerCandidates(model.state), width)),
	];
}

/** The overlay may take this share of the terminal's height; the command passes the same to pi as `maxHeight`. */
export const OVERLAY_HEIGHT_PERCENT = 90;

export interface UsageViewDeps {
	/** This session's runs; read again after `invalidate()`. */
	sessionRuns(): readonly SpendRun[];
	now(): Date;
	/** The terminal's height in rows. */
	rows(): number;
	style: UsageStyle;
	requestRender(): void;
	/** Closes the overlay. */
	close(): void;
}

/** The overlay component: owns the state, turns keys into transitions and renders the model. */
export class UsageView implements Component {
	private readonly deps: UsageViewDeps;
	private state: UsageState;
	private session: UsageBreakdown | undefined;

	constructor(deps: UsageViewDeps, initial: Transition) {
		this.deps = deps;
		this.state = initial.state;
		this.run(initial.effects);
	}

	render(width: number): string[] {
		this.session ??= usageBreakdown(this.deps.sessionRuns());
		const height = Math.max(1, Math.floor((this.deps.rows() * OVERLAY_HEIGHT_PERCENT) / 100));
		return renderUsage({ state: this.state, session: this.session, now: this.deps.now() }, { width, height, style: this.deps.style });
	}

	handleInput(data: string): void {
		const key = usageKeyFor(data);
		if (!key) return;
		const { state, effects } = reduce(this.state, { type: "key", key });
		this.state = state;
		this.run(effects);
		this.deps.requestRender();
	}

	invalidate(): void {
		this.session = undefined;
	}

	private run(effects: readonly UsageEffect[]): void {
		for (const effect of effects) if (effect === "close") this.deps.close();
	}
}
