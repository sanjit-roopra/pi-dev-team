/**
 * The plain-text AI credits summary for /dev-team usage when no overlay can be shown (print mode, RPC),
 * and the wording both it and the overlay (usage-view.ts) use: scope names, header pieces, empty-state
 * and footnote sentences. Keeping the sentences here is what keeps the two presentations saying the
 * same thing.
 */
import { COPILOT_PROVIDER, formatAiCredits, formatCredits } from "./ai-credits.ts";
import { type CreditsRow, formatShare, type UsageBreakdown } from "./usage-breakdown.ts";
import { withoutControlChars } from "./usage-chart.ts";
import type { Scope } from "./usage-state.ts";

export const SEPARATOR = " · ";
export const SCOPE_TITLE: Record<Scope, string> = { session: "This session", month: "This month" };
export const SCOPE_NOUN: Record<Scope, string> = { session: "this session", month: "this month" };

/** "in this session", "this month": how a sentence refers to the scope. */
export const usageIn = (scope: Scope) => (scope === "session" ? "in this session" : "this month");

const monthDay = (date: Date) => date.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

/** "This session", or "This month (Oct 1 – Oct 4)": the billing month's UTC dates, 1st to `now`. */
export function scopeHeading(scope: Scope, now: Date): string {
	if (scope === "session") return SCOPE_TITLE.session;
	const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
	return `${SCOPE_TITLE.month} (${monthDay(start)} – ${monthDay(now)})`;
}

/** "as of 14:05": local time, so it reads against the user's own clock. */
export const asOfLabel = (date: Date) => `as of ${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;

/** Every row is GitHub Copilot, so the provider prefix is noise. */
export const modelLabel = (model: string) => (model.startsWith(`${COPILOT_PROVIDER}/`) ? model.slice(COPILOT_PROVIDER.length + 1) : model);

export const emptyUsageMessage = (scope: Scope) => `No GitHub Copilot usage ${usageIn(scope)}`;
export const noSubagentUsageMessage = (scope: Scope) => `No subagent usage ${usageIn(scope)}`;
export const loadFailedMessage = (reason: string) => `Could not load history: ${reason}`;

/** The footnote for session files that could not be read, or undefined when every file was. */
export function skippedFilesNote(skipped: number): string | undefined {
	return skipped > 0 ? `${skipped} session ${skipped === 1 ? "file" : "files"} could not be read` : undefined;
}

export interface UsageSummaryInput {
	scope: Scope;
	breakdown: UsageBreakdown;
	now: Date;
	/** Present for this month: how the load went. */
	month?: { skipped: number; loadedAt: Date };
}

/** Rows as aligned "  label  credits  share" lines. */
function rankedLines(rows: readonly CreditsRow[]): string[] {
	const cells = rows.map((r) => [withoutControlChars(r.label), formatCredits(r.credits), formatShare(r.share)]);
	const widths = [0, 1, 2].map((col) => Math.max(...cells.map((c) => c[col].length)));
	return cells.map(([label, credits, share]) => `  ${label.padEnd(widths[0])}  ${credits.padStart(widths[1])}  ${share.padStart(widths[2])}`);
}

/** Header line, split line, then the models and the agents ranked; or the empty-state sentence alone. */
export function usageSummary({ scope, breakdown, now, month }: UsageSummaryInput): string {
	if (breakdown.total === 0) return emptyUsageMessage(scope);
	const header = [scopeHeading(scope, now), formatAiCredits(breakdown.total), ...(month ? [asOfLabel(month.loadedAt)] : [])].join(SEPARATOR);
	const split = breakdown.byThread.map((r) => `${r.label} ${formatCredits(r.credits)}`).join(SEPARATOR);
	const models = rankedLines(breakdown.byModel.map((r) => ({ ...r, label: modelLabel(r.label) })));
	const agents = breakdown.byAgent.length ? rankedLines(breakdown.byAgent) : [`  ${noSubagentUsageMessage(scope)}`];
	const note = skippedFilesNote(month?.skipped ?? 0);
	return [header, split, "", "By model", ...models, "", "By agent", ...agents, ...(note ? ["", note] : [])].join("\n");
}
