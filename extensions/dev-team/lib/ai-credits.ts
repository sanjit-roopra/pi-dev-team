/**
 * GitHub Copilot AI credits: what Copilot bills for model use, shown next to pi's USD cost.
 *
 * Copilot prices models per token and converts the total at 1 AI credit = $0.01 USD
 * (docs.github.com/en/copilot/reference/copilot-billing/models-and-pricing). pi's catalog prices the
 * `github-copilot` provider at those same per-token rates, so a Copilot message's credits are its
 * usage.cost.total x 100. It is an estimate: GitHub documents no per-request rounding, and plan
 * allowances are not visible from a session.
 */
import { creditedRuns, SUBAGENT_USAGE_ENTRY, type SubagentUsageEntry } from "./subagent-types.ts";

export const COPILOT_PROVIDER = "github-copilot";
const CREDITS_PER_USD = 100;

/** True for a "provider/model" id served by GitHub Copilot. */
export function isCopilotModel(model: string | undefined): boolean {
	return !!model && model.startsWith(`${COPILOT_PROVIDER}/`);
}

export function usdToAiCredits(usd: number): number {
	return usd * CREDITS_PER_USD;
}

/** "0.12 AI credits", "12.3 AI credits", "1,234 AI credits": fewer decimals as the number grows. */
export function formatAiCredits(credits: number): string {
	const digits = credits < 10 ? 2 : credits < 1000 ? 1 : 0;
	return `${credits.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits })} AI credits`;
}

/**
 * Copilot AI credits the whole session spent (every branch, like pi's footer): the main thread's
 * Copilot turns plus every dispatched agent, nested ones included, that ran on a Copilot model.
 * Subagents are read from their usage entries, since a tool result's usage does not say which
 * provider served it.
 */
export function sessionAiCredits(entries: readonly Record<string, unknown>[]): number {
	let usd = 0;
	for (const entry of entries) {
		if (entry.type === "message") {
			const msg = entry.message as { role?: string; provider?: string; usage?: { cost?: { total?: number } } } | undefined;
			if (msg?.role === "assistant" && msg.provider === COPILOT_PROVIDER) usd += msg.usage?.cost?.total ?? 0;
		} else if (entry.type === "custom" && entry.customType === SUBAGENT_USAGE_ENTRY) {
			const d = entry.data as SubagentUsageEntry | undefined;
			if (!d?.usage) continue;
			for (const run of creditedRuns(d)) if (isCopilotModel(run.model)) usd += run.usage.cost;
		}
	}
	return usdToAiCredits(usd);
}
