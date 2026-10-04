/**
 * The plain-text AI credits summary for /dev-team usage when no overlay can be shown (print mode, RPC),
 * and the wording both it and the overlay (usage-render.ts) use: scope names, view titles, header
 * pieces, empty-state, failure and footnote sentences. Keeping the sentences here is what keeps the
 * two presentations saying the same thing.
 */
import { COPILOT_PROVIDER, copilotBillingPeriodStart, formatAiCredits, formatCredits, hasVisibleCredits } from "./ai-credits.ts";
import { type CreditsRow, formatShare, type MonthSnapshot, type UsageBreakdown } from "./usage-breakdown.ts";
import { controlRunsToSpace, withoutControlChars } from "./terminal-text.ts";
import type { Scope, View } from "./usage-state.ts";

export const SEPARATOR = " · ";
export const SCOPE_TITLE: Record<Scope, string> = { session: "This session", month: "This month" };
export const SCOPE_NOUN: Record<Scope, string> = { session: "this session", month: "this month" };
export const VIEW_TITLE: Record<View, string> = { model: "By model", agent: "By agent" };
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

/** Every row is GitHub Copilot, so the provider prefix is noise. */
export const modelLabel = (modelId: string) => (modelId.startsWith(`${COPILOT_PROVIDER}/`) ? modelId.slice(COPILOT_PROVIDER.length + 1) : modelId);

/** The by-model rows as shown: ranked as in the breakdown, labelled without the provider prefix. */
export const modelRows = (breakdown: UsageBreakdown): CreditsRow[] => breakdown.byModel.map((row) => ({ ...row, label: modelLabel(row.label) }));

export const emptyUsageMessage = (scope: Scope) => `No GitHub Copilot usage ${scopePhrase(scope)}`;
export const noSubagentUsageMessage = (scope: Scope) => `No subagent usage ${scopePhrase(scope)}`;

/** Appended to the empty session message: this month may have spend even when this session has none. */
export const pressSHint = (scope: Scope) => (scope === "session" ? " — press s for this month" : "");

/** The reason is an error's message and may carry control characters or newlines; they become one space each run. */
export const loadFailedMessage = (reason: string) => `Could not load history: ${controlRunsToSpace(reason)}`;

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

/** Rows as aligned "  label  credits  share" lines. */
function rankedLines(rows: readonly CreditsRow[]): string[] {
	const cells = rows.map((r) => ({ label: withoutControlChars(r.label), credits: formatCredits(r.credits), share: formatShare(r.share) }));
	const widest = (pick: (cell: (typeof cells)[number]) => string) => Math.max(...cells.map((cell) => pick(cell).length));
	const [labelWidth, creditsWidth, shareWidth] = [widest((c) => c.label), widest((c) => c.credits), widest((c) => c.share)];
	return cells.map(({ label, credits, share }) => `  ${label.padEnd(labelWidth)}  ${credits.padStart(creditsWidth)}  ${share.padStart(shareWidth)}`);
}

/** Header line, split line, then the models and the agents ranked; or the empty-state sentence. Either way the unreadable-files note ends it, as in the overlay. */
export function usageSummary({ scope, breakdown, now, month }: UsageSummaryInput): string {
	const note = unreadableFilesNote(month?.unreadable ?? 0);
	const noteLines = note ? ["", note] : [];
	if (!hasVisibleCredits(breakdown.total)) return [emptyUsageMessage(scope), ...noteLines].join("\n");
	const header = [scopeHeading(scope, now), formatAiCredits(breakdown.total), ...(month ? [asOfLabel(month.loadedAt)] : [])].join(SEPARATOR);
	const split = breakdown.byThread.map((r) => `${r.label} ${formatCredits(r.credits)}`).join(SEPARATOR);
	const models = rankedLines(modelRows(breakdown));
	const agents = breakdown.byAgent.length ? rankedLines(breakdown.byAgent) : [`  ${noSubagentUsageMessage(scope)}`];
	return [header, split, "", VIEW_TITLE.model, ...models, "", VIEW_TITLE.agent, ...agents, ...noteLines].join("\n");
}
