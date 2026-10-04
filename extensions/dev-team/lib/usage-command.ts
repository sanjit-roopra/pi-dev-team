/**
 * `/dev-team usage [session|month]`: opens the AI credits overlay, or prints the plain-text summary
 * when no overlay can be shown. The overlay is out of reach without a UI (print mode) and in RPC mode,
 * where `ui.custom()` is a stub that resolves without ever calling the factory, so "the factory never
 * ran" is the signal to fall back to text.
 */
import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { copilotBillingPeriodStart } from "./ai-credits.ts";
import { sessionEntries, sessionSpend } from "./session-spend.ts";
import { usageBreakdown } from "./usage-breakdown.ts";
import { loadSpendHistory, sessionRoot } from "./usage-history.ts";
import { parseUsageArgs, type Scope } from "./usage-state.ts";
import { loadFailedMessage, usageSummary } from "./usage-text.ts";
import { OVERLAY_HEIGHT_PERCENT, UsageView, type UsageStyle } from "./usage-view.ts";

export interface UsageDeps {
	now(): Date;
	loadHistory: typeof loadSpendHistory;
	/** Shows text to the user (a notification with a UI, stdout without). */
	emit(text: string): void;
}

/** pi theme tokens for the overlay: accent bars, a distinct colour per split segment, muted secondary text. */
function themeStyle(theme: Theme): UsageStyle {
	const segmentColor = { main: "accent", subagents: "success", overhead: "warning" } as const;
	return {
		title: (text) => theme.bold(text),
		error: (text) => theme.fg("error", text),
		bar: (text) => theme.fg("accent", text),
		muted: (text) => theme.fg("muted", text),
		segment: (label, text) => theme.fg(segmentColor[label], text),
	};
}

/** The text summary: this month is read from every saved session (no progress to show), a failed read is reported, never thrown. */
async function printSummary(ctx: ExtensionContext, scope: Scope, deps: UsageDeps): Promise<void> {
	const now = deps.now();
	if (scope === "session") {
		const breakdown = usageBreakdown(sessionSpend(sessionEntries(ctx)));
		deps.emit(usageSummary({ scope, breakdown, now }));
		return;
	}
	try {
		const root = sessionRoot(ctx.sessionManager.getSessionDir());
		const history = await deps.loadHistory({ root, since: copilotBillingPeriodStart(now) });
		const breakdown = usageBreakdown(history.records.map((r) => r.run));
		deps.emit(usageSummary({ scope, breakdown, now, month: { skipped: history.skipped, loadedAt: deps.now() } }));
	} catch (err) {
		deps.emit(loadFailedMessage(err instanceof Error ? err.message : String(err)));
	}
}

export async function runUsage(ctx: ExtensionContext, args: string, deps: UsageDeps): Promise<void> {
	const start = parseUsageArgs(args);
	if ("error" in start) {
		deps.emit(start.error);
		return;
	}
	if (ctx.hasUI) {
		let factoryRan = false;
		await ctx.ui.custom<void>(
			(tui, theme, _keybindings, done) => {
				factoryRan = true;
				return new UsageView(
					{
						sessionRuns: () => [...sessionSpend(sessionEntries(ctx))],
						now: deps.now,
						rows: () => tui.terminal.rows,
						style: themeStyle(theme),
						requestRender: () => tui.requestRender(),
						close: () => done(),
						loadHistory: (options) => deps.loadHistory({ root: sessionRoot(ctx.sessionManager.getSessionDir()), ...options }),
					},
					start,
				);
			},
			{ overlay: true, overlayOptions: { maxHeight: `${OVERLAY_HEIGHT_PERCENT}%` } },
		);
		if (factoryRan) return;
	}
	await printSummary(ctx, start.state.scope, deps);
}
