/**
 * spend — what pi sessions cost, for every provider: the `/spend` overlay (or text summary) and the
 * GitHub Copilot AI credits status line under pi's footer.
 *
 * Ships in the pi-dev-team package but needs nothing from the dev-team extension, so it can be loaded
 * alone (disable extensions/dev-team/index.ts in `pi config`). When dev-team runs too, its agents'
 * spend arrives as SUBAGENT_USAGE_ENTRY session entries and is split out per agent.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { aiCreditsStatus } from "./lib/ai-credits.ts";
import { sessionEntries } from "./lib/session-spend.ts";
import { DEV_TEAM_SUBAGENT_TOOL } from "./lib/subagent-usage.ts";
import { runUsage } from "./lib/usage-command.ts";
import { loadSpendHistory } from "./lib/usage-history.ts";

const AI_CREDITS_STATUS = "spend-ai-credits";

export default function spend(pi: ExtensionAPI) {
	// A dev-team agent runs as a child pi process with the same packages; its parent shows the spend.
	const isSubagent = process.env.DEV_TEAM_SUBAGENT === "1";

	pi.registerCommand("spend", {
		description: "What sessions spent (USD, GitHub Copilot AI credits): session | month",
		getArgumentCompletions: (prefix) => ["session", "month"].filter((s) => s.startsWith(prefix)).map((s) => ({ value: s, label: s })),
		handler: (args, ctx) => runUsage(ctx, args ?? "", { now: () => new Date(), loadHistory: loadSpendHistory, emit: (text) => report(ctx, text) }),
	});

	function report(ctx: ExtensionContext, text: string) {
		if (ctx.hasUI) ctx.ui.notify(text, "info");
		else console.log(text);
	}

	/**
	 * Refresh the session's GitHub Copilot AI credits status line (hidden at 0). Runs at turn end and
	 * when a dev-team dispatch returns, so spend pi records while idle (cache warming) shows from the next turn.
	 */
	function refreshAiCreditsStatus(ctx: ExtensionContext): void {
		if (isSubagent || !ctx.hasUI) return;
		ctx.ui.setStatus(AI_CREDITS_STATUS, aiCreditsStatus(sessionEntries(ctx)));
	}

	pi.on("session_start", async (_event, ctx) => refreshAiCreditsStatus(ctx));
	pi.on("turn_end", async (_event, ctx) => refreshAiCreditsStatus(ctx));
	pi.on("tool_result", async (event, ctx) => {
		if (event.toolName === DEV_TEAM_SUBAGENT_TOOL) refreshAiCreditsStatus(ctx);
	});
}
