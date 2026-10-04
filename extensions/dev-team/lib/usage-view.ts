/**
 * The /dev-team usage overlay. renderUsage() turns the view's state plus the credits breakdown into
 * the lines of the panel (header, split bar, ranked chart, footer), fitted to the terminal's width
 * and height; it is pure (colour comes from the injected style), so tests drive it without pi.
 * UsageView is the thin component around it: it holds the state and reacts to keys.
 */
import { type Component, visibleWidth } from "@earendil-works/pi-tui";
import { copilotBillingPeriodStart, formatAiCredits, formatCredits } from "./ai-credits.ts";
import type { SpendRun } from "./session-spend.ts";
import { type CreditsRow, formatShare, type UsageBreakdown, usageBreakdown } from "./usage-breakdown.ts";
import { barChartLines, type ChartStyle, cutToWidth, type SplitLabel, type SplitStyle, splitBarLines } from "./usage-chart.ts";
import type { SpendHistory } from "./usage-history.ts";
import { reduce, type Transition, type UsageAction, type UsageEffect, type UsageState, usageKeyFor, type View } from "./usage-state.ts";
import { asOfLabel, emptyUsageMessage, loadFailedMessage, modelLabel, noSubagentUsageMessage, SCOPE_NOUN, SCOPE_TITLE, SEPARATOR, scopeHeading, skippedFilesNote } from "./usage-text.ts";

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

const VIEW_TITLE: Record<View, string> = { model: "By model", agent: "By agent" };

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
	const tail = [VIEW_TITLE[view], ...(breakdown ? [formatAiCredits(breakdown.total)] : [])];
	const asOf = scope === "month" && breakdown && model.month ? [asOfLabel(model.month.loadedAt)] : [];
	const join = (scopeText: string, ...more: string[]) => [scopeText, ...tail, ...more].join(SEPARATOR);
	const heading = scopeHeading(scope, model.now);
	return [join(heading, ...asOf), join(heading), join(SCOPE_TITLE[scope])];
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
	if (state.load.kind === "error") return { text: loadFailedMessage(state.load.reason.replace(CONTROL_RUNS, " ")), tone: "error" };
	if (!breakdown || breakdown.total === 0) {
		const hint = state.scope === "session" ? " — press s for this month" : "";
		return { text: `${emptyUsageMessage(state.scope)}${hint}`, tone: "plain" };
	}
	if (state.view === "agent" && breakdown.byAgent.length === 0) return { text: noSubagentUsageMessage(state.scope), tone: "plain" };
	return undefined;
}

function footnoteText(model: UsageModel): string | undefined {
	const skipped = model.state.scope === "month" && model.state.load.kind === "ready" ? (model.month?.skipped ?? 0) : 0;
	return skippedFilesNote(skipped);
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
	/** Reads this month's spend from the saved sessions; the view cancels it through `signal`. */
	loadHistory(options: { since: Date; signal: AbortSignal; onProgress(done: number, total: number): void }): Promise<SpendHistory>;
}

/** The overlay component: owns the state, turns keys into transitions, runs the month's load and renders the model. */
export class UsageView implements Component {
	private readonly deps: UsageViewDeps;
	private state: UsageState;
	private session: UsageBreakdown | undefined;
	private month: MonthSnapshot | undefined;
	/** The load in flight. Whatever else holds a different controller (or none) is a stale load whose news is dropped. */
	private loading: AbortController | undefined;

	constructor(deps: UsageViewDeps, initial: Transition) {
		this.deps = deps;
		this.state = initial.state;
		this.run(initial.effects);
	}

	render(width: number): string[] {
		this.session ??= usageBreakdown(this.deps.sessionRuns());
		const height = Math.max(1, Math.floor((this.deps.rows() * OVERLAY_HEIGHT_PERCENT) / 100));
		return renderUsage({ state: this.state, session: this.session, month: this.month, now: this.deps.now() }, { width, height, style: this.deps.style });
	}

	handleInput(data: string): void {
		const key = usageKeyFor(data);
		if (key) this.dispatch({ type: "key", key });
	}

	invalidate(): void {
		this.session = undefined;
	}

	/** Called by pi when the overlay goes away; a load still running is of no use any more. */
	dispose(): void {
		this.cancelLoad();
	}

	private dispatch(action: UsageAction): void {
		const { state, effects } = reduce(this.state, action);
		this.state = state;
		this.run(effects);
		this.deps.requestRender();
	}

	private run(effects: readonly UsageEffect[]): void {
		for (const effect of effects) {
			if (effect === "start-load") this.startLoad();
			else if (effect === "cancel-load") this.cancelLoad();
			else this.deps.close();
		}
	}

	private startLoad(): void {
		const controller = new AbortController();
		this.loading = controller;
		const current = () => this.loading === controller;
		const since = copilotBillingPeriodStart(this.deps.now());
		const onProgress = (done: number, total: number) => {
			if (current()) this.dispatch({ type: "progress", done, total });
		};
		(async () => this.deps.loadHistory({ since, signal: controller.signal, onProgress }))().then(
			(history) => {
				if (!current()) return;
				this.loading = undefined;
				this.month = { breakdown: usageBreakdown(history.records.map((r) => r.run)), skipped: history.skipped, loadedAt: this.deps.now() };
				this.dispatch({ type: "loaded" });
			},
			(err: unknown) => {
				if (!current()) return;
				this.loading = undefined;
				this.dispatch({ type: "failed", reason: err instanceof Error ? err.message : String(err) });
			},
		);
	}

	private cancelLoad(): void {
		this.loading?.abort();
		this.loading = undefined;
	}
}
