/**
 * Renders the /dev-team usage overlay. renderUsage() turns the view's state plus the usage breakdown
 * into the lines of the panel (header, split bars, ranked chart, footer), fitted to the terminal's width
 * and height; it is pure (colour comes from the injected style), so tests drive it without pi. The
 * component that holds the state and reacts to keys is UsageView (usage-view.ts).
 */
import { visibleWidth } from "@earendil-works/pi-tui";
import { formatShare, formatUsd, hasUsage, type MonthSnapshot, type UsageBreakdown, type UsageRow } from "./usage-breakdown.ts";
import { cutToWidth } from "./terminal-text.ts";
import { barChartLines, type ChartStyle } from "./usage-chart.ts";
import { type SplitBarOptions, type SplitStyle, splitBarLines } from "./usage-split-bar.ts";
import type { UsageState } from "./usage-state.ts";
import {
	asOfLabel,
	CHART_FORMAT,
	emptyUsageMessage,
	loadFailedMessage,
	noSubagentUsageMessage,
	pressSHint,
	READING_SESSIONS,
	SCOPE_NOUN,
	SCOPE_TITLE,
	SEPARATOR,
	scopeHeading,
	splitSections,
	totalHeaderParts,
	unreadableFilesNote,
	VIEW_TITLE,
	viewRows,
	wantedColumns,
} from "./usage-text.ts";

export interface UsageStyle extends ChartStyle, SplitStyle {
	/** The header line. */
	title(text: string): string;
	/** The load failure message. */
	error(text: string): string;
}

export interface UsageViewModel {
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

/** The breakdown the state is showing, or undefined while it is not known (loading, failed). */
function shownBreakdown(viewModel: UsageViewModel): UsageBreakdown | undefined {
	if (viewModel.state.scope === "session") return viewModel.session;
	return viewModel.state.load.kind === "ready" ? viewModel.month?.breakdown : undefined;
}

/**
 * The header from most to least detailed: the snapshot time goes first, then the dates, then the
 * AI credits, so a narrow terminal keeps the scope, the view and the USD total.
 */
function headerCandidates(viewModel: UsageViewModel): string[] {
	const { scope, view } = viewModel.state;
	const breakdown = shownBreakdown(viewModel);
	const totals = breakdown ? totalHeaderParts(breakdown.total) : [];
	const [usdPart] = totals;
	const usdOnly = usdPart ? [usdPart] : [];
	const asOfParts = scope === "month" && breakdown && viewModel.month ? [asOfLabel(viewModel.month.loadedAt)] : [];
	const join = (scopeText: string, shownTotals: readonly string[], ...more: string[]) => [scopeText, VIEW_TITLE[view], ...shownTotals, ...more].join(SEPARATOR);
	const heading = scopeHeading(scope, viewModel.now);
	return [join(heading, totals, ...asOfParts), join(heading, totals), join(SCOPE_TITLE[scope], totals), join(SCOPE_TITLE[scope], usdOnly)];
}

/** The key hints from most to least detailed: hints drop from the left, so "Esc close" is the last to go. */
function footerCandidates(state: UsageState): string[] {
	const otherScopeNoun = SCOPE_NOUN[state.scope === "session" ? "month" : "session"];
	let hints = ["Tab view", `s ${otherScopeNoun}`, "Esc close"];
	if (state.load.kind === "error") hints = ["s back", "Esc close"];
	else if (state.load.kind === "loading") hints = ["Tab view", "s cancel", "Esc close"];
	return hints.map((_, i) => hints.slice(i).join(SEPARATOR));
}

/** The first candidate that fits `width`, else the last one cut to it. */
function fitLine(candidates: readonly string[], width: number): string {
	return candidates.find((c) => visibleWidth(c) <= width) ?? cutToWidth(candidates.at(-1) ?? "", width);
}

/** Text that fills the chart area in place of a chart. */
interface Message {
	text: string;
	tone: "plain" | "error";
}

function loadingMessage(load: UsageState["load"]): string {
	return load.kind === "loading" && load.progress ? `${READING_SESSIONS} ${load.progress.done}/${load.progress.total} files` : READING_SESSIONS;
}

/** What replaces the chart when there is none to draw; undefined when the view has rows. */
function bodyMessage(viewModel: UsageViewModel, breakdown: UsageBreakdown | undefined): Message | undefined {
	const { state } = viewModel;
	if (state.load.kind === "loading") return { text: loadingMessage(state.load), tone: "plain" };
	if (state.load.kind === "error") return { text: loadFailedMessage(state.load.reason), tone: "error" };
	if (!breakdown || !hasUsage(breakdown.total)) return { text: `${emptyUsageMessage(state.scope)}${pressSHint(state.scope)}`, tone: "plain" };
	if (state.view === "agent" && breakdown.byAgent.length === 0) return { text: noSubagentUsageMessage(state.scope), tone: "plain" };
	return undefined;
}

function footnoteText(viewModel: UsageViewModel): string | undefined {
	const { state, month } = viewModel;
	const unreadable = state.scope === "month" && state.load.kind === "ready" ? (month?.unreadable ?? 0) : 0;
	return unreadableFilesNote(unreadable);
}

/** One split bar's lines: the bar, then its legend lines. */
interface SplitBlock {
	bar: string;
	legend: string[];
}

/** The split bars of splitSections(): providers (legend gives each share), then threads (legend gives each USD). */
function splitBlocks(breakdown: UsageBreakdown, options: Omit<SplitBarOptions, "formatValue">): SplitBlock[] {
	return splitSections(breakdown).flatMap((section): SplitBlock[] => {
		const formatValue = (usd: number, share: number) => (section.legend === "share" ? formatShare(share) : formatUsd(usd));
		const lines = splitBarLines(
			section.parts.map((p) => ({ label: p.label, amount: p.usd })),
			{ ...options, formatValue },
		);
		return lines.length ? [{ bar: lines[0], legend: lines.slice(1) }] : [];
	});
}

/** `count` split lines at most: every bar first, then legend lines block by block; each block stays in order. */
function fitSplitLines(blocks: readonly SplitBlock[], count: number): string[] {
	let legendBudget = Math.max(0, count - blocks.length);
	return blocks.slice(0, count).flatMap((block) => {
		const legend = block.legend.slice(0, legendBudget);
		legendBudget -= legend.length;
		return [block.bar, ...legend];
	});
}

/** What the panel would like to show, in lines. */
interface LayoutRequest {
	splitLineCount: number;
	/** The split bars without their legends: what is left when the legends give way. */
	splitBarCount: number;
	hasFootnote: boolean;
	chartRowCount: number;
}

interface Layout {
	/** Blank lines between header, split bar, chart and footer. */
	hasGaps: boolean;
	/** Split bar lines kept (the bar first, then its legend). */
	splitLineCount: number;
	hasFootnote: boolean;
	chartRowCount: number;
}

const PINNED_LINES = 2;
const FOOTNOTE_LINES = 1;
/** Chart rows worth keeping over the extras before the extras start to go. */
const MIN_CHART_ROWS = 3;
/** Blank lines after the header and before the footer. */
const OUTER_GAP_LINES = 2;
/** The blank line after the split bar, when there is one. */
const SPLIT_GAP_LINES = 1;

/** The blank lines kept between header, split bar (when there is one), chart and footer. */
const gapLineCount = (hasSplit: boolean) => OUTER_GAP_LINES + (hasSplit ? SPLIT_GAP_LINES : 0);

/**
 * Decides which lines are pinned and which flex for `height`. The header and footer always stay; the
 * rest give way in order (blank gaps, footnote, split legends, split bars) until the chart gets
 * MIN_CHART_ROWS rows or what it asked for, whichever is fewer. What is left goes to the chart.
 */
function planLayout(height: number, request: LayoutRequest): Layout {
	const free = Math.max(0, height - PINNED_LINES);
	const { splitLineCount, hasFootnote } = request;
	const options: Layout[] = [
		{ hasGaps: true, splitLineCount, hasFootnote, chartRowCount: 0 },
		{ hasGaps: false, splitLineCount, hasFootnote, chartRowCount: 0 },
		{ hasGaps: false, splitLineCount, hasFootnote: false, chartRowCount: 0 },
		{ hasGaps: false, splitLineCount: Math.min(request.splitBarCount, splitLineCount), hasFootnote: false, chartRowCount: 0 },
		{ hasGaps: false, splitLineCount: 0, hasFootnote: false, chartRowCount: 0 },
	];
	const withChartRows = (o: Layout): Layout => ({
		...o,
		chartRowCount: Math.max(0, free - (o.hasGaps ? gapLineCount(splitLineCount > 0) : 0) - o.splitLineCount - (o.hasFootnote ? FOOTNOTE_LINES : 0)),
	});
	const sized = options.map(withChartRows);
	return sized.find((o) => o.chartRowCount >= Math.min(request.chartRowCount, MIN_CHART_ROWS)) ?? sized[sized.length - 1];
}

export function renderUsage(viewModel: UsageViewModel, { width, height, style }: RenderOptions): string[] {
	const breakdown = shownBreakdown(viewModel);
	const message = bodyMessage(viewModel, breakdown);
	// The split bars show whenever there is spend to split, even when the view's own chart is empty.
	const showSplit = !!breakdown && hasUsage(breakdown.total) && viewModel.state.load.kind !== "loading";
	const blocks = showSplit ? splitBlocks(breakdown, { width, style }) : [];
	const splitLineCount = blocks.reduce((sum, b) => sum + 1 + b.legend.length, 0);
	const footnote = footnoteText(viewModel);
	const rankedRows: UsageRow[] = breakdown ? viewRows(viewModel.state.view, breakdown) : [];
	const plan = planLayout(height, { splitLineCount, splitBarCount: blocks.length, hasFootnote: !!footnote, chartRowCount: message ? 1 : rankedRows.length });

	const splitLines = fitSplitLines(blocks, plan.splitLineCount);
	const paint = message?.tone === "error" ? style.error : (text: string) => text;
	const body = message
		? plan.chartRowCount > 0 ? [paint(cutToWidth(message.text, width))] : []
		: barChartLines(rankedRows, { width, maxRows: plan.chartRowCount, format: CHART_FORMAT, wantedColumns: wantedColumns(rankedRows), style });
	const gapLines = plan.hasGaps ? [""] : [];
	return [
		style.title(fitLine(headerCandidates(viewModel), width)),
		...gapLines,
		...(splitLines.length ? [...splitLines, ...gapLines] : []),
		...body,
		...(footnote && plan.hasFootnote ? [style.muted(cutToWidth(footnote, width))] : []),
		...gapLines,
		style.muted(fitLine(footerCandidates(viewModel.state), width)),
	];
}
