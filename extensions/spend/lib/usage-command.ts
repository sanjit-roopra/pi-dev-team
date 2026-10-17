/**
 * `/spend [session|month]`: opens the usage overlay, or prints the plain-text summary
 * when no overlay can be shown. The overlay is out of reach without a UI (print mode) and in RPC mode,
 * where `ui.custom()` is a stub that resolves without ever calling the factory, so "the factory never
 * ran" is the signal to fall back to text. A `ui.custom()` that rejects falls back to text too.
 */
import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { type SpendRun, sessionEntries, sessionSpend } from "./session-spend.ts";
import { monthSnapshot, usageBreakdown } from "./usage-breakdown.ts";
import { loadSpendHistory, sessionRoot } from "./usage-history.ts";
import { usageMonthStart } from "./ai-credits.ts";
import type { UsageStyle } from "./usage-render.ts";
import { openUsage, type Scope, type Transition } from "./usage-state.ts";
import { errorReason, loadFailedMessage, usageSummary } from "./usage-text.ts";
import { OVERLAY_HEIGHT_PERCENT, UsageView } from "./usage-view.ts";

export interface UsageDeps {
	now(): Date;
	loadHistory: typeof loadSpendHistory;
	/** Shows text to the user (a notification with a UI, stdout without). */
	emit(text: string): void;
}

export const USAGE_SYNTAX = "Usage: /spend [session|month]";

const SCOPE_ARGS: ReadonlyMap<string, Scope> = new Map([
	["", "session"],
	["session", "session"],
	["month", "month"],
]);

/** The scope `/spend <args>` asks for (this session when none is given), or the usage message for an argument it does not know. */
export function parseUsageArgs(args: string): { scope: Scope } | { error: string } {
	const scope = SCOPE_ARGS.get(args.trim().toLowerCase());
	return scope ? { scope } : { error: USAGE_SYNTAX };
}

const sessionRunsOf = (ctx: ExtensionContext): SpendRun[] => [...sessionSpend(sessionEntries(ctx))];
const sessionRootOf = (ctx: ExtensionContext): string => sessionRoot(ctx.sessionManager.getSessionDir());

/**
 * Distinct pi theme colours, used in order: split segment slot N (one per glyph in SPLIT_GLYPHS,
 * usage-split-bar.ts, which tell the slots apart without colour) and chart row N share colour N, so
 * By provider paints each provider as the provider split does, up to the split's folded "other" slot.
 * Chart rows past the end cycle round.
 */
const PALETTE = ["accent", "success", "warning", "syntaxKeyword", "syntaxString", "syntaxType"] as const;

/** Widest the overlay gets; pi narrows it to the terminal. */
export const OVERLAY_WIDTH = 100;

/** pi theme tokens for the overlay: a framed panel on its own background, a distinct colour per chart row and split segment, muted secondary text. */
function themeStyle(theme: Theme): UsageStyle {
	return {
		title: (text) => theme.bold(theme.fg("accent", text)),
		border: (text) => theme.fg("borderAccent", text),
		panel: (line) => theme.bg("customMessageBg", line),
		error: (text) => theme.fg("error", text),
		bar: (row, text) => theme.fg(PALETTE[row % PALETTE.length], text),
		muted: (text) => theme.fg("muted", text),
		segment: (slot, text) => theme.fg(PALETTE[slot] ?? "muted", text),
	};
}

/** The text summary: this month is read from every saved session (no progress to show), a failed read is reported, never thrown. */
async function printSummary(ctx: ExtensionContext, scope: Scope, deps: UsageDeps): Promise<void> {
	const now = deps.now();
	if (scope === "session") {
		deps.emit(usageSummary({ scope, breakdown: usageBreakdown(sessionRunsOf(ctx)), now }));
		return;
	}
	try {
		const history = await deps.loadHistory({ root: sessionRootOf(ctx), since: usageMonthStart(now) });
		const snapshot = monthSnapshot(history, deps.now());
		deps.emit(usageSummary({ scope, breakdown: snapshot.breakdown, now, month: snapshot }));
	} catch (err) {
		deps.emit(loadFailedMessage(errorReason(err)));
	}
}

/** Shows the overlay; false when it could not be shown (the factory never ran, or `ui.custom()` rejected). */
async function showOverlay(ctx: ExtensionContext, initial: Transition, deps: UsageDeps): Promise<boolean> {
	let factoryRan = false;
	try {
		await ctx.ui.custom<void>(
			(tui, theme, _keybindings, done) => {
				factoryRan = true;
				return new UsageView(
					{
						sessionRuns: () => sessionRunsOf(ctx),
						now: deps.now,
						terminalRows: () => tui.terminal.rows,
						style: themeStyle(theme),
						requestRender: () => tui.requestRender(),
						close: () => done(),
						loadHistory: (options) => deps.loadHistory({ root: sessionRootOf(ctx), ...options }),
					},
					initial,
				);
			},
			{ overlay: true, overlayOptions: { width: OVERLAY_WIDTH, maxHeight: `${OVERLAY_HEIGHT_PERCENT}%` } },
		);
	} catch {
		return false;
	}
	return factoryRan;
}

export async function runUsage(ctx: ExtensionContext, args: string, deps: UsageDeps): Promise<void> {
	const parsed = parseUsageArgs(args);
	if ("error" in parsed) {
		deps.emit(parsed.error);
		return;
	}
	if (ctx.hasUI && (await showOverlay(ctx, openUsage(parsed.scope), deps))) return;
	await printSummary(ctx, parsed.scope, deps);
}
