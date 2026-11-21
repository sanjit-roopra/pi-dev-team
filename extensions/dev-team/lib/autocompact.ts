/**
 * Autocompact: dev-team compacts the main session at a configured percentage of the context window
 * (`autocompactPct`, written by /setup via scripts/set_autocompact_env.py, or DEV_TEAM_AUTOCOMPACT_PCT).
 * pi only compacts at `contextWindow - reserveTokens`, so the extension lowers that to the configured
 * percentage, measured with ctx.getContextUsage(), which knows every model's window.
 *
 * A token ceiling (`autocompactMaxTokens`) applies on top. Every turn re-reads the whole
 * context, so a 1M-token window that grows to 400k+ makes each turn cost several times more, and
 * a cache miss after a long human wait rewrites all of it. The ceiling applies whether or not a
 * percentage is configured; whichever is reached first compacts.
 */
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { autocompactPctValue, projectConfigPath, userConfigPath } from "./config.ts";
import { readSmallFile } from "./safe-read.ts";

export const AUTOCOMPACT_KEY = "DEV_TEAM_AUTOCOMPACT_PCT";
/** The top-level key in dev-team.json, dev-team.local.json and the user's dev-team.json. */
export const AUTOCOMPACT_CONFIG_KEY = "autocompactPct";

export interface AutocompactSetting {
	/** Valid threshold 1-100, or undefined when absent or invalid. */
	thresholdPct?: number;
	/** Where the first definition was found (shown in diagnostics and tests; hooks/lib/autocompact_config.py uses the same labels). */
	origin?: string;
}

/** The file's top-level object, or undefined when it is missing, too big or not a JSON object. */
function configObject(file: string): Record<string, unknown> | undefined {
	const text = readSmallFile(file);
	if (text === undefined) return undefined;
	try {
		const data = JSON.parse(text);
		return data && typeof data === "object" && !Array.isArray(data) ? data : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Same precedence as hooks/lib/autocompact_config.py `detect`: process env DEV_TEAM_AUTOCOMPACT_PCT,
 * then `autocompactPct` in `.pi/dev-team.local.json`, `.pi/dev-team.json`, then the user's
 * `<agentDir>/dev-team.json`. The first source that defines the key decides. Project files are
 * skipped when the project is not trusted in pi.
 */
export function autocompactSetting(
	projectDir: string,
	opts: { env?: NodeJS.ProcessEnv; projectTrusted: boolean; userConfigFile?: string },
): AutocompactSetting {
	const env = opts.env ?? process.env;
	const settingFrom = (raw: unknown, origin: string): AutocompactSetting => ({ thresholdPct: autocompactPctValue(raw), origin });
	if (env[AUTOCOMPACT_KEY] !== undefined) return settingFrom(env[AUTOCOMPACT_KEY], "process env");
	const candidates: [string, string][] = [
		...(!opts.projectTrusted
			? []
			: ([
					["dev-team.local.json", projectConfigPath(projectDir, true)],
					["dev-team.json", projectConfigPath(projectDir)],
				] as [string, string][])),
		["user dev-team.json", opts.userConfigFile ?? userConfigPath()],
	];
	for (const [label, file] of candidates) {
		const data = configObject(file);
		if (data && AUTOCOMPACT_CONFIG_KEY in data) return settingFrom(data[AUTOCOMPACT_CONFIG_KEY], label);
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
	opts: { env?: NodeJS.ProcessEnv; maxContextTokens?: number; userConfigFile?: string } = {},
): AutocompactDue | undefined {
	const { env = process.env, maxContextTokens = 0, userConfigFile } = opts;
	const { thresholdPct } = autocompactSetting(ctx.cwd, { env, projectTrusted: ctx.isProjectTrusted(), userConfigFile });
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
