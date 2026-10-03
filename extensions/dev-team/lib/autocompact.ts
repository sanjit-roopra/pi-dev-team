/**
 * Autocompact: dev-team v14 replaced its context ceiling guard with the harness's own compaction at
 * CLAUDE_AUTOCOMPACT_PCT_OVERRIDE percent (written by /setup via scripts/set_autocompact_env.py).
 * pi only compacts at `contextWindow - reserveTokens`, so the extension lowers that to the configured
 * percentage, measured with ctx.getContextUsage(), which knows every model's window.
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

/**
 * The threshold and current usage when the session should compact now, else undefined. Unconfigured
 * repos keep pi's default (and get the autocompact_setup_nudge advisory at session start).
 */
export function autocompactDue(
	ctx: Pick<ExtensionContext, "cwd" | "getContextUsage" | "isProjectTrusted">,
	env: NodeJS.ProcessEnv = process.env,
): { thresholdPct: number; usedPct: number } | undefined {
	const { thresholdPct } = autocompactSetting(ctx.cwd, { env, projectTrusted: ctx.isProjectTrusted() });
	if (thresholdPct === undefined) return undefined;
	const usage = ctx.getContextUsage();
	if (!usage || usage.percent == null) return undefined;
	return usage.percent >= thresholdPct ? { thresholdPct, usedPct: usage.percent } : undefined;
}
