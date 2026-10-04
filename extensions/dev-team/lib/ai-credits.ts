/**
 * GitHub Copilot AI credits: what Copilot bills for model use, shown next to pi's USD cost.
 *
 * Copilot prices models per token and converts the total at 1 AI credit = $0.01 USD
 * (docs.github.com/en/copilot/reference/copilot-billing/models-and-pricing). pi's catalog prices the
 * `github-copilot` provider at those same per-token rates (checked against pi-ai's catalog for 11
 * models, long-context tiers included, in October 2026), so a Copilot run's credits are its USD cost
 * x 100: exact by formula (tokens x GitHub's per-token rates / $0.01). The figures are gross usage:
 * they do not subtract a plan's monthly allowance.
 */
import { costUsd, type PiUsage, sessionSpend } from "./session-spend.ts";

export const COPILOT_PROVIDER = "github-copilot";
const CREDITS_PER_USD = 100;
/** The finest precision shown; a session below it shows no status line. */
const FINEST_DIGITS = 2;

/** True for a "provider/model" id served by GitHub Copilot. */
export function isCopilotModel(model: string | undefined): boolean {
	return !!model && model.startsWith(`${COPILOT_PROVIDER}/`);
}

/** One run's AI credits: its USD cost x 100 when Copilot served it, else 0. */
export function runAiCredits(run: { model?: string; usage: PiUsage }): number {
	return isCopilotModel(run.model) ? costUsd(run.usage) * CREDITS_PER_USD : 0;
}

/** The AI credits of the runs served by Copilot; every other run counts 0. */
export function runsAiCredits(runs: Iterable<{ model?: string; usage: PiUsage }>): number {
	return Array.from(runs).reduce((credits, run) => credits + runAiCredits(run), 0);
}

/** Decimal places for a credits value: 2 below 10, 1 below 1000, else 0, judged after rounding. */
function creditDigits(credits: number): number {
	if (Number(credits.toFixed(FINEST_DIGITS)) < 10) return FINEST_DIGITS;
	return Number(credits.toFixed(1)) < 1000 ? 1 : 0;
}

/** "0.12", "12.3", "1,234": a credits value without its unit, fewer decimals as the number grows. */
export function formatCredits(credits: number): string {
	const digits = creditDigits(credits);
	// Print the value the tier was judged on: Intl rounds some halves the other way than toFixed.
	const shown = Number(credits.toFixed(digits));
	return shown.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

/** "0.12 AI credits", "12.3 AI credits", "1,234 AI credits": fewer decimals as the number grows. */
export function formatAiCredits(credits: number): string {
	return `${formatCredits(credits)} AI credits`;
}

/**
 * The session's Copilot AI credits (every branch, like pi's footer): the main thread's turns, every
 * dispatched agent (nested ones included) and pi's other usage entries such as cache warming, each
 * counted when a Copilot model served it.
 */
export function sessionAiCredits(entries: readonly Record<string, unknown>[]): number {
	return runsAiCredits(sessionSpend(entries));
}

/** The status line text, or undefined (hidden) while the session's credits round to 0.00. */
export function aiCreditsStatus(entries: readonly Record<string, unknown>[]): string | undefined {
	const credits = sessionAiCredits(entries);
	return Number(credits.toFixed(FINEST_DIGITS)) > 0 ? `GitHub Copilot: ${formatAiCredits(credits)}` : undefined;
}
