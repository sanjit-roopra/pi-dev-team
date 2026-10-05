/**
 * The plain-text usage summary for /dev-team usage when no overlay can be shown (print mode, RPC),
 * and the wording both it and the overlay (usage-render.ts) use: scope names, view titles, header
 * pieces, empty-state, failure and footnote sentences. Keeping the sentences here is what keeps the
 * two presentations saying the same thing.
 */
import { formatAiCredits, formatCredits, hasVisibleCredits, usageMonthStart } from "./ai-credits.ts";
import {
	formatShare,
	formatTokens,
	formatUsd,
	hasUsage,
	type MonthSnapshot,
	type SpendAmounts,
	THREAD_ORDER,
	type UsageBreakdown,
	type UsageRow,
} from "./usage-breakdown.ts";
import type { BarChartOptions, ChartFormat } from "./usage-chart.ts";
import { toSpacedSingleLine, toSingleLine } from "./terminal-text.ts";
import type { Scope, View } from "./usage-state.ts";

export const SEPARATOR = " · ";
export const SCOPE_TITLE: Record<Scope, string> = { session: "This session", month: "This month" };
export const SCOPE_NOUN: Record<Scope, string> = { session: "this session", month: "this month" };
export const VIEW_TITLE: Record<View, string> = { model: "By model", provider: "By provider", agent: "By agent" };
/** Joins an agent and its provider in an agent row's label. */
export const AGENT_PROVIDER_SEPARATOR = " · ";
/** The chart area's text while this month's files are read; the overlay appends the progress. */
export const READING_SESSIONS = "Reading sessions…";

/** "in this session", "this month": how a sentence refers to the scope. */
export const scopePhrase = (scope: Scope) => (scope === "session" ? "in this session" : "this month");

const monthDay = (date: Date) => date.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

/** "This session", or "This month (Oct 1 – Oct 4)": the month's UTC dates, 1st to `now`. */
export function scopeHeading(scope: Scope, now: Date): string {
	if (scope === "session") return SCOPE_TITLE.session;
	return `${SCOPE_TITLE.month} (${monthDay(usageMonthStart(now))} – ${monthDay(now)})`;
}

/** "as of 14:05": local time, so it reads against the user's own clock. */
export const asOfLabel = (date: Date) => `as of ${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;

/** A row's AI credits in a column: "210 cr", or "" when Copilot served none of it. */
export const formatCreditsCell = (credits: number) => (hasVisibleCredits(credits) ? `${formatCredits(credits)} cr` : "");

/** How the chart and the summary write each amount. */
export const CHART_FORMAT: ChartFormat = { usd: formatUsd, credits: formatCreditsCell, tokens: formatTokens, share: formatShare };

/**
 * The optional columns a view's rows want, for the overlay's chart and the text summary alike: AI
 * credits when any row has some, tokens when any row cost nothing (so a free model still says what it
 * used). Judged over every row, before the chart folds any into "other".
 */
export function wantedColumns(rows: readonly UsageRow[]): BarChartOptions["wantedColumns"] {
	return { credits: rows.some((r) => hasVisibleCredits(r.credits)), tokens: rows.some((r) => !(r.usd > 0)) };
}

/** The total as header parts: "$4.20", then "312 AI credits" when Copilot served any of it. USD is always first. */
export function totalHeaderParts(total: SpendAmounts): string[] {
	return [formatUsd(total.usd), ...(hasVisibleCredits(total.credits) ? [formatAiCredits(total.credits)] : [])];
}

/** The ranked rows of a view; an agent row is labelled "agent · provider". */
export function viewRows(view: View, breakdown: UsageBreakdown): UsageRow[] {
	if (view === "model") return breakdown.byModel;
	if (view === "provider") return breakdown.byProvider;
	return breakdown.byAgent.map((row) => ({ ...row, label: `${row.label}${AGENT_PROVIDER_SEPARATOR}${row.provider}` }));
}

/** One split of the total: its parts in drawing order, each with its USD and share of the total. */
export interface SplitSection {
	title: "Providers" | "Threads";
	/** How the overlay's legend names a part's amount. */
	legend: "share" | "usd";
	parts: { label: string; usd: number; share: number }[];
}

/**
 * The splits both presentations show. Providers: only when two or more have a cost, the paid ones in
 * rank order. Threads: always main, subagents, overhead, in that order; a thread that spent nothing
 * stays with 0 so it keeps its place and its glyph. None when nothing cost anything.
 */
export function splitSections(breakdown: UsageBreakdown): SplitSection[] {
	const total = breakdown.total.usd;
	if (!(total > 0)) return [];
	const part = (label: string, usd: number) => ({ label, usd, share: usd / total });
	const paidProviders = breakdown.byProvider.filter((r) => r.usd > 0);
	const providers: SplitSection[] = paidProviders.length > 1 ? [{ title: "Providers", legend: "share", parts: paidProviders.map((r) => part(r.label, r.usd)) }] : [];
	const threadUsd = new Map(breakdown.byThread.map((r) => [r.label, r.usd]));
	return [...providers, { title: "Threads", legend: "usd", parts: THREAD_ORDER.map((label) => part(label, threadUsd.get(label) ?? 0)) }];
}

export const emptyUsageMessage = (scope: Scope) => `No usage ${scopePhrase(scope)}`;
export const noSubagentUsageMessage = (scope: Scope) => `No subagent usage ${scopePhrase(scope)}`;

/** Appended to the empty session message: this month may have spend even when this session has none. */
export const pressSHint = (scope: Scope) => (scope === "session" ? " — press s for this month" : "");

/** The reason is an error's message and may carry escape sequences, control characters or newlines: sequences go, each run of controls becomes one space. */
export const loadFailedMessage = (reason: string) => `Could not load history: ${toSpacedSingleLine(reason)}`;

/** The text of whatever a load rejected with. */
export const errorReason = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** The footnote for session files that could not be read, or undefined when every file was. */
export function unreadableFilesNote(unreadable: number): string | undefined {
	return unreadable > 0 ? `${unreadable} session ${unreadable === 1 ? "file" : "files"} could not be read` : undefined;
}

export interface UsageSummaryInput {
	scope: Scope;
	breakdown: UsageBreakdown;
	now: Date;
	/** Present for this month: how the load went. */
	month?: Omit<MonthSnapshot, "breakdown">;
}

/** Rows as aligned "  label  usd  credits  tokens  share" lines, with the columns wantedColumns() asks for. */
function rankedLines(rows: readonly UsageRow[]): string[] {
	const columns = wantedColumns(rows);
	const cells = rows.map((r) => [
		toSingleLine(r.label),
		CHART_FORMAT.usd(r.usd),
		...(columns.credits ? [CHART_FORMAT.credits(r.credits)] : []),
		...(columns.tokens ? [CHART_FORMAT.tokens(r.tokens)] : []),
		CHART_FORMAT.share(r.share),
	]);
	const widths = cells[0].map((_, column) => Math.max(...cells.map((row) => row[column].length)));
	return cells.map((row) => `  ${row.map((cell, column) => (column === 0 ? cell.padEnd(widths[column]) : cell.padStart(widths[column]))).join("  ")}`);
}

/** "Providers  github-copilot $3.12 74.3% · openai $1.08 25.7%": the parts that spent something. */
function splitLine({ title, parts }: SplitSection): string {
	const spent = parts.filter((p) => p.usd > 0);
	return `${title}  ${spent.map((p) => `${toSingleLine(p.label)} ${formatUsd(p.usd)} ${formatShare(p.share)}`).join(SEPARATOR)}`;
}

/** Header, the provider and thread splits, then models, providers and agents ranked; or the empty-state sentence. Either way the unreadable-files note ends it, as in the overlay. */
export function usageSummary({ scope, breakdown, now, month }: UsageSummaryInput): string {
	const note = unreadableFilesNote(month?.unreadable ?? 0);
	const noteLines = note ? ["", note] : [];
	if (!hasUsage(breakdown.total)) return [emptyUsageMessage(scope), ...noteLines].join("\n");
	const header = [scopeHeading(scope, now), ...totalHeaderParts(breakdown.total), ...(month ? [asOfLabel(month.loadedAt)] : [])].join(SEPARATOR);
	const section = (view: View) => {
		const rows = viewRows(view, breakdown);
		return ["", VIEW_TITLE[view], ...(rows.length ? rankedLines(rows) : [`  ${noSubagentUsageMessage(scope)}`])];
	};
	return [
		header,
		...splitSections(breakdown).map(splitLine),
		...section("model"),
		...section("provider"),
		...section("agent"),
		...noteLines,
	].join("\n");
}
