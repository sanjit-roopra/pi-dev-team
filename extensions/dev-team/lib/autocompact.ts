/**
 * Autocompact: dev-team v14 replaced its context ceiling guard with the harness's own compaction at
 * CLAUDE_AUTOCOMPACT_PCT_OVERRIDE percent (written by /setup via scripts/set_autocompact_env.py).
 * pi only compacts at `contextWindow - reserveTokens`, so the extension lowers that to the configured
 * percentage, measured with ctx.getContextUsage(), which knows every model's window.
 *
 * The port adds a token ceiling (`autocompactMaxTokens`) on top. Every turn re-reads the whole
 * context, so a 1M-token window that grows to 400k+ makes each turn cost several times more, and
 * a cache miss after a long human wait rewrites all of it. The ceiling applies whether or not a
 * percentage is configured; whichever is reached first compacts.
 */
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { readSmallFile } from "./safe-read.ts";

export const AUTOCOMPACT_KEY = "CLAUDE_AUTOCOMPACT_PCT_OVERRIDE";
/** Plain integer 1-100: no sign, no whitespace, no decimal point, no leading zero (as upstream). */
const PCT_RE = /^(?:100|[1-9][0-9]?)$/;

export interface AutocompactSetting {
	/** Valid threshold 1-100, or undefined when absent or invalid. */
	thresholdPct?: number;
	/** Where the first definition was found, as upstream labels it (shown in diagnostics and tests). */
	origin?: string;
}

function envBlock(file: string): Record<string, unknown> | undefined {
	const text = readSmallFile(file);
	if (text === undefined) return undefined;
	try {
		const data = JSON.parse(text);
		return data && typeof data === "object" && data.env && typeof data.env === "object" && !Array.isArray(data.env) ? data.env : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Same precedence as upstream hooks/lib/autocompact_config.py `detect`: process env,
 * `.claude/settings.local.json`, `.claude/settings.json`, then user settings. The first source that
 * defines the key decides. Project files are skipped when the project is not trusted in pi.
 */
export function autocompactSetting(
	projectDir: string,
	opts: { env?: NodeJS.ProcessEnv; projectTrusted: boolean },
): AutocompactSetting {
	const env = opts.env ?? process.env;
	const settingFrom = (raw: unknown, origin: string): AutocompactSetting => ({
		thresholdPct: typeof raw === "string" && PCT_RE.test(raw) ? Number(raw) : undefined,
		origin,
	});
	if (env[AUTOCOMPACT_KEY] !== undefined) return settingFrom(env[AUTOCOMPACT_KEY], "process env");
	const userSettings = env.CLAUDE_CONFIG_DIR
		? path.join(env.CLAUDE_CONFIG_DIR, "settings.json")
		: path.join(env.HOME || os.homedir(), ".claude", "settings.json");
	const candidates: [string, string][] = [
		...(!opts.projectTrusted
			? []
			: ([
					["settings.local.json", path.join(projectDir, ".claude", "settings.local.json")],
					["settings.json", path.join(projectDir, ".claude", "settings.json")],
				] as [string, string][])),
		["user settings.json", userSettings],
	];
	for (const [label, file] of candidates) {
		const block = envBlock(file);
		if (block && AUTOCOMPACT_KEY in block) return settingFrom(block[AUTOCOMPACT_KEY], label);
	}
	return {};
}

/** Why autocompaction is due: the configured percentage, the context-token ceiling, or both. */
export interface AutocompactDue {
	usedPct: number;
	/** The configured percentage, when that is what was reached. */
	thresholdPct?: number;
	/** The ceiling and the current context tokens, when that is what was reached (always set together). */
	tokens?: { max: number; used: number };
}

/**
 * Why the session should compact now, else undefined: usage at or over the configured percentage, or
 * context tokens at or over `maxContextTokens` (0 or an invalid value turns the ceiling off). Without
 * either, pi's own threshold applies (and the autocompact_setup_nudge advisory runs at session start).
 */
export function autocompactDue(
	ctx: Pick<ExtensionContext, "cwd" | "getContextUsage" | "isProjectTrusted">,
	opts: { env?: NodeJS.ProcessEnv; maxContextTokens?: number } = {},
): AutocompactDue | undefined {
	const { env = process.env, maxContextTokens = 0 } = opts;
	const { thresholdPct } = autocompactSetting(ctx.cwd, { env, projectTrusted: ctx.isProjectTrusted() });
	const max = Number.isFinite(maxContextTokens) && maxContextTokens > 0 ? maxContextTokens : undefined;
	if (thresholdPct === undefined && max === undefined) return undefined;
	const usage = ctx.getContextUsage();
	if (!usage || usage.percent == null) return undefined;
	const byPct = thresholdPct !== undefined && usage.percent >= thresholdPct;
	const used = usage.tokens;
	const byTokens = max !== undefined && used != null && used >= max;
	if (!byPct && !byTokens) return undefined;
	return {
		usedPct: usage.percent,
		...(byPct ? { thresholdPct } : {}),
		...(byTokens ? { tokens: { max, used } } : {}),
	};
}

/** The notice shown when compacting: every reason that fired. */
export function describeAutocompact(due: AutocompactDue): string {
	const formatThousands = (n: number) => `${Math.round(n / 1000)}k`;
	const reasons = [
		...(due.thresholdPct !== undefined ? [`autocompact threshold ${due.thresholdPct}%`] : []),
		...(due.tokens ? [`${formatThousands(due.tokens.used)} tokens, autocompactMaxTokens ${formatThousands(due.tokens.max)}`] : []),
	];
	return `dev-team: context at ${Math.round(due.usedPct)}% (${reasons.join("; ")}), compacting.`;
}
