/**
 * The plain-text usage summary for /dev-team usage when no overlay can be shown (print mode, RPC),
 * and the wording both it and the overlay (usage-render.ts) use: scope names, view titles, header
 * pieces, empty-state, failure and footnote sentences. Keeping the sentences here is what keeps the
 * two presentations saying the same thing.
 */
import { copilotBillingPeriodStart, formatAiCredits, formatCredits, hasVisibleCredits } from "./ai-credits.ts";
import {
	formatShare,
	formatTokens,
	formatUsd,
	hasCopilotSpend,
	hasUsage,
	type MonthSnapshot,
	type SpendAmounts,
	type UsageBreakdown,
	type UsageRow,
} from "./usage-breakdown.ts";
import type { ChartFormat } from "./usage-chart.ts";
import { toSpacedSingleLine, toSingleLine } from "./terminal-text.ts";
import type { Scope, View } from "./usage-state.ts";

export const SEPARATOR = " · ";
export const SCOPE_TITLE: Record<Scope, string> = { session: "This session", month: "This month" };
export const SCOPE_NOUN: Record<Scope, string> = { session: "this session", month: "this month" };
export const VIEW_TITLE: Record<View, string> = { model: "By model", provider: "By provider", agent: "By agent" };
/** The split bars' names, in the text summary and in narrow overlays. */
export const SPLIT_TITLE = { providers: "Providers", threads: "Threads" } as const;
/** The chart area's text while this month's files are read; the overlay appends the progress. */
export const READING_SESSIONS = "Reading sessions…";

/** "in this session", "this month": how a sentence refers to the scope. */
export const scopePhrase = (scope: Scope) => (scope === "session" ? "in this session" : "this month");

const monthDay = (date: Date) => date.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

/** "This session", or "This month (Oct 1 – Oct 4)": the billing month's UTC dates, 1st to `now`. */
export function scopeHeading(scope: Scope, now: Date): string {
	if (scope === "session") return SCOPE_TITLE.session;
	return `${SCOPE_TITLE.month} (${monthDay(copilotBillingPeriodStart(now))} – ${monthDay(now)})`;
}

/** "as of 14:05": local time, so it reads against the user's own clock. */
export const asOfLabel = (date: Date) => `as of ${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;

/** A row's AI credits in a column: "210 cr". */
export const formatCreditsCell = (credits: number) => `${formatCredits(credits)} cr`;

/** How the chart and the summary write each amount. */
export const CHART_FORMAT: ChartFormat = { usd: formatUsd, credits: formatCreditsCell, tokens: formatTokens, share: formatShare };

/** "$4.20" or "$4.20 · 312 AI credits": the total, with the credits when Copilot served any of it. */
export function totalParts(total: SpendAmounts): string[] {
	return [formatUsd(total.usd), ...(hasCopilotSpend(total) ? [formatAiCredits(total.credits)] : [])];
}

/** The ranked rows of a view. */
export function viewRows(view: View, breakdown: UsageBreakdown): UsageRow[] {
	if (view === "model") return breakdown.byModel;
	return view === "provider" ? breakdown.byProvider : breakdown.byAgent;
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

/**
 * Rows as aligned "  label  usd  credits  tokens  share" lines. The credits column shows when any row
 * has credits, the tokens column when any row cost nothing: the same rule as the overlay's chart.
 */
function rankedLines(rows: readonly UsageRow[]): string[] {
	const showCredits = rows.some((r) => hasVisibleCredits(r.credits));
	const showTokens = rows.some((r) => !(r.usd > 0));
	const cells = rows.map((r) => [
		toSingleLine(r.label),
		CHART_FORMAT.usd(r.usd),
		...(showCredits ? [hasVisibleCredits(r.credits) ? CHART_FORMAT.credits(r.credits) : ""] : []),
		...(showTokens ? [CHART_FORMAT.tokens(r.tokens)] : []),
		CHART_FORMAT.share(r.share),
	]);
	const widths = cells[0].map((_, column) => Math.max(...cells.map((row) => row[column].length)));
	return cells.map((row) => `  ${row.map((cell, column) => (column === 0 ? cell.padEnd(widths[column]) : cell.padStart(widths[column]))).join("  ")}`);
}

/** "Providers  github-copilot $3.12 74.3% · openai $1.08 25.7%". */
const splitLine = (title: string, rows: readonly UsageRow[]) =>
	`${title}  ${rows.map((r) => `${toSingleLine(r.label)} ${formatUsd(r.usd)} ${formatShare(r.share)}`).join(SEPARATOR)}`;

/** Header, the provider and thread splits, then models, providers and agents ranked; or the empty-state sentence. Either way the unreadable-files note ends it, as in the overlay. */
export function usageSummary({ scope, breakdown, now, month }: UsageSummaryInput): string {
	const note = unreadableFilesNote(month?.unreadable ?? 0);
	const noteLines = note ? ["", note] : [];
	if (!hasUsage(breakdown.total)) return [emptyUsageMessage(scope), ...noteLines].join("\n");
	const header = [scopeHeading(scope, now), ...totalParts(breakdown.total), ...(month ? [asOfLabel(month.loadedAt)] : [])].join(SEPARATOR);
	const section = (view: View) => {
		const rows = viewRows(view, breakdown);
		return ["", VIEW_TITLE[view], ...(rows.length ? rankedLines(rows) : [`  ${noSubagentUsageMessage(scope)}`])];
	};
	return [
		header,
		splitLine(SPLIT_TITLE.providers, breakdown.byProvider),
		splitLine(SPLIT_TITLE.threads, breakdown.byThread),
		...section("model"),
		...section("provider"),
		...section("agent"),
		...noteLines,
	].join("\n");
}
