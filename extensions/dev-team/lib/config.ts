/**
 * dev-team configuration.
 *
 * Merged, later wins:
 *   1. built-in defaults
 *   2. ~/.pi/agent/dev-team.json          (user)
 *   3. <project>/.pi/dev-team.json        (project, committed)
 *   4. <project>/.pi/dev-team.local.json  (project, personal, git-ignored)
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { readSmallFile } from "./safe-read.ts";

export type Tier = "opus" | "sonnet" | "haiku" | "fable" | string;

export interface HookConfig {
	/** Master switch for the Python hook bridge. */
	enabled: boolean;
	/** Hook script basenames (without .py) to skip. Replaces the default list when set. */
	disabled: string[];
	/** Hook script basenames to force-enable even if in the default disabled list. */
	enable: string[];
	/** Append advisory hook output (exit 0 stdout) to the tool result the model sees. */
	outputToModel: boolean;
	/** Per-hook timeout in seconds (fail-open on timeout). */
	timeoutSec: number;
}

export const GITHUB_STYLE_MODES = ["block", "warn", "off"] as const;
export type GitHubStyleMode = (typeof GITHUB_STYLE_MODES)[number];

export interface DevTeamConfig {
	/** Agent model tier -> "provider/model-id" or "inherit" (use the dispatching session's model). */
	models: Record<Tier, string>;
	/** Agent `effort` -> pi thinking level. */
	thinking: Record<string, string>;
	/** Maximum concurrently running subagent processes (across all calls). */
	maxParallelAgents: number;
	/** Maximum nesting depth of subagents (a subagent dispatching a subagent is depth 2). */
	maxSubagentDepth: number;
	/** Wall-clock limit per subagent in seconds (0 = none). */
	subagentTimeoutSec: number;
	hooks: HookConfig;
	/** Run hooks/post_format.py after write/edit (what /setup's formatter hook did). */
	autoFormat: boolean;
	/** Pull request and issue text that breaks the GitHub style rules: block the gh call once ("block"), only note it ("warn"), or skip the check and the style guide ("off"). */
	githubStyle: GitHubStyleMode;
	/** How dev-team skills are advertised in the system prompt. */
	skillIndex: "compact" | "full" | "off";
	/** Max description characters per skill in the compact index. */
	skillIndexChars: number;
	/** Put the `claude` -> `pi` CLI shim on PATH for scripts that call `claude -p`. */
	claudeShim: boolean;
	/** Extra environment variables for tools, hooks, scripts and subagents (e.g. DEV_TEAM_MAX_PARALLEL_BUILDS). */
	env: Record<string, string>;
}

/**
 * Hooks off by default. See PORTING.md section 4.
 * - replaced natively by the extension: cost_meter, subagent_skill_context
 * - need Claude transcripts / Claude-only config: code_intelligence_*, phase_marker, session_learning_trigger,
 *   mcp_json_repowise_nudge, version_check
 * - only act inside the upstream monorepo: the rest
 */
export const DEFAULT_DISABLED_HOOKS = [
	"cost_meter",
	"subagent_skill_context",
	"code_intelligence_nudge",
	"code_intelligence_turn_mark",
	"phase_marker",
	"session_learning_trigger",
	"mcp_json_repowise_nudge",
	"version_check",
	"contract_version_guard",
	"pre_commit_knowledge_index",
	"knowledge_index",
	"skills_index",
	"scan_bash_command_for_banned_scripts",
	"scan_worktree_for_banned_scripts",
	"eval_compliance_check",
];

export const DEFAULT_CONFIG: DevTeamConfig = {
	models: { opus: "inherit", sonnet: "inherit", haiku: "inherit", fable: "inherit" },
	thinking: { low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" },
	maxParallelAgents: 6,
	maxSubagentDepth: 2,
	subagentTimeoutSec: 3600,
	hooks: { enabled: true, disabled: DEFAULT_DISABLED_HOOKS, enable: [], outputToModel: true, timeoutSec: 60 },
	autoFormat: false,
	githubStyle: "block",
	skillIndex: "compact",
	skillIndexChars: 220,
	claudeShim: true,
	env: {},
};

/** Tier presets offered by `/dev-team models`. Values are provider/model ids from pi's catalog. */
export const MODEL_PRESETS: Record<string, Record<string, string>> = {
	"github-copilot": {
		opus: "github-copilot/claude-opus-5.5",
		sonnet: "github-copilot/claude-sonnet-5.5",
		haiku: "github-copilot/claude-haiku-4.5",
		fable: "github-copilot/claude-fable-5.1",
	},
	anthropic: {
		opus: "anthropic/claude-opus-5-5",
		sonnet: "anthropic/claude-sonnet-5-5",
		haiku: "anthropic/claude-haiku-4-5",
		fable: "anthropic/claude-fable-5-1",
	},
	inherit: { opus: "inherit", sonnet: "inherit", haiku: "inherit", fable: "inherit" },
};

export function userConfigPath(): string {
	return path.join(getAgentDir(), "dev-team.json");
}

export function projectConfigPath(cwd: string, local = false): string {
	return path.join(cwd, ".pi", local ? "dev-team.local.json" : "dev-team.json");
}

function readJson(file: string): Record<string, unknown> | undefined {
	const text = readSmallFile(file);
	if (text === undefined) return undefined;
	try {
		const parsed = JSON.parse(text);
		return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : undefined;
	} catch {
		return undefined;
	}
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
	return !!v && typeof v === "object" && !Array.isArray(v);
}

/** Deep merge for plain objects; arrays and scalars replace. */
export function mergeConfig<T>(base: T, override: unknown): T {
	if (!isPlainObject(override)) return base;
	const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
	for (const [k, v] of Object.entries(override)) {
		const cur = out[k];
		out[k] = isPlainObject(cur) && isPlainObject(v) ? mergeConfig(cur, v) : v;
	}
	return out as T;
}

/**
 * A project's config may set only these dev-team tuning settings, each to a plain number, word or
 * flag. pi asks about trust only when a repo has pi-protected files (.pi/settings.json, .pi/extensions,
 * ...), so a repo with just a .pi/dev-team.json is trusted without a prompt. Its env must therefore not
 * reach PATH, NODE_OPTIONS or PYTHONPATH, any file path the port reads or runs (DEV_TEAM_PY_CACHE is
 * executed by hooks/py.sh), a program choice, or a gate bypass (DEV_TEAM_AUTO_APPROVE,
 * DEV_TEAM_GUARD_OVERRIDE, *_SKIP, a threshold whose 0 disables a guard). Those stay available in the
 * user's own config and environment.
 */
export const PROJECT_ENV_SETTINGS: ReadonlySet<string> = new Set([
	"DEV_TEAM_MAX_PARALLEL_BUILDS",
	"DEV_TEAM_MAX_PARALLEL_REVIEW_AGENTS",
	"DEV_TEAM_AUTO_REVIEW",
	"DEV_TEAM_AUTO_REVIEW_THRESHOLD",
	"DEV_TEAM_REPO_REVIEW_PERCENT_THRESHOLD",
	"DEV_TEAM_REPO_REVIEW_MIN_ADDED_LINES",
	"DEV_TEAM_REPO_REVIEW_MAX_ADDED_LINES",
	"DEV_TEAM_REVIEW_CONTEXT_PACK",
	"DEV_TEAM_WORKTREE_BASE_FRESH",
	"DEV_TEAM_AUTOCOMPACT_NUDGE",
	"DEV_TEAM_COST_METER",
	"DEV_TEAM_TASK_METRICS",
	"DEV_TEAM_REVIEW_VALUE",
	"DEV_TEAM_TELEMETRY",
]);
const PLAIN_SETTING_VALUE = /^[A-Za-z0-9._-]{0,64}$/;

export function isProjectEnvSettingAllowed(key: string, value: unknown): boolean {
	return PROJECT_ENV_SETTINGS.has(key) && (typeof value === "string" || typeof value === "number" || typeof value === "boolean") && PLAIN_SETTING_VALUE.test(String(value));
}

/**
 * A project config file as it may apply: env limited to PROJECT_ENV_SETTINGS (an env that is not an
 * object is dropped whole), and no `hooks` at all, since hooks include the guards; hooks are set in the
 * user's own config. `ignored` names everything left out, as `env.KEY`, `env` or `hooks`.
 */
export function filterProjectConfig(data: Record<string, unknown>): { data: Record<string, unknown>; ignored: string[] } {
	const ignored: string[] = [];
	const { env, hooks, ...rest } = data;
	const out: Record<string, unknown> = rest;
	if (hooks !== undefined) ignored.push("hooks");
	if (env === undefined) return { data: out, ignored };
	if (!isPlainObject(env)) return { data: out, ignored: [...ignored, "env"] };
	const entries = Object.entries(env);
	out.env = Object.fromEntries(entries.filter(([k, v]) => isProjectEnvSettingAllowed(k, v)));
	for (const [k, v] of entries) if (!isProjectEnvSettingAllowed(k, v)) ignored.push(`env.${k}`);
	return { data: out, ignored };
}

/**
 * User config, then the project's .pi/dev-team.json and .pi/dev-team.local.json. Project files are
 * filtered (filterProjectConfig), so callers pass `includeProject: ctx.isProjectTrusted()`.
 */
export function loadConfig(
	cwd: string,
	opts: { includeProject: boolean; userConfigFile?: string },
): { config: DevTeamConfig; sources: string[]; ignoredProjectSettings: string[] } {
	let config = DEFAULT_CONFIG;
	const sources: string[] = [];
	const ignoredProjectSettings: string[] = [];
	const userFile = opts.userConfigFile ?? userConfigPath();
	const projectFiles = opts.includeProject ? [projectConfigPath(cwd), projectConfigPath(cwd, true)] : [];
	for (const file of [userFile, ...projectFiles]) {
		const raw = readJson(file);
		if (!raw) continue;
		const { data, ignored } = file === userFile ? { data: raw, ignored: [] } : filterProjectConfig(raw);
		config = mergeConfig(config, data);
		sources.push(file);
		ignoredProjectSettings.push(...ignored);
	}
	if (!(GITHUB_STYLE_MODES as readonly unknown[]).includes(config.githubStyle)) config = { ...config, githubStyle: DEFAULT_CONFIG.githubStyle };
	return { config, sources, ignoredProjectSettings };
}

/** Read-modify-write one config file (used by /dev-team models). */
export function updateConfigFile(file: string, patch: Record<string, unknown>): void {
	const current = readJson(file) ?? {};
	const next = mergeConfig(current, patch);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`, "utf-8");
}

export function isHookEnabled(config: DevTeamConfig, hookName: string): boolean {
	if (!config.hooks.enabled) return false;
	if (config.hooks.enable.includes(hookName)) return true;
	return !config.hooks.disabled.includes(hookName);
}
