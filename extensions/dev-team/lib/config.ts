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
	try {
		const parsed = JSON.parse(fs.readFileSync(file, "utf-8"));
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
 * Project config may set only dev-team's own settings variables. pi asks about trust only when a repo
 * has pi-protected files (.pi/settings.json, .pi/extensions, ...), so a repo with just a
 * .pi/dev-team.json is trusted without a prompt; its env must not reach PATH, NODE_OPTIONS, PYTHONPATH
 * or the variables that choose which programs the port runs.
 */
const PROJECT_ENV_KEY = /^DEV_TEAM_[A-Z0-9_]+$/;
const PROJECT_ENV_DENIED = new Set([
	"DEV_TEAM_PYTHON",
	"DEV_TEAM_PI_BIN",
	"DEV_TEAM_REAL_CLAUDE",
	"DEV_TEAM_PI_ARGS",
	"DEV_TEAM_TRUSTED_ROOT",
	"DEV_TEAM_ROOT",
	"DEV_TEAM_INTERACTIVE",
	"DEV_TEAM_SUBAGENT",
	"DEV_TEAM_SUBAGENT_DEPTH",
	"DEV_TEAM_AGENT_NAME",
	"DEV_TEAM_PARENT_SESSION_ID",
]);

export function isProjectEnvKeyAllowed(key: string): boolean {
	return PROJECT_ENV_KEY.test(key) && !PROJECT_ENV_DENIED.has(key);
}

/** A project config file with env keys outside the allowed set removed; `dropped` names them. */
export function filterProjectConfig(data: Record<string, unknown>): { data: Record<string, unknown>; dropped: string[] } {
	if (!isPlainObject(data.env)) return { data, dropped: [] };
	const entries = Object.entries(data.env);
	const kept = entries.filter(([k]) => isProjectEnvKeyAllowed(k));
	return { data: { ...data, env: Object.fromEntries(kept) }, dropped: entries.filter(([k]) => !isProjectEnvKeyAllowed(k)).map(([k]) => k) };
}

/**
 * User config, then the project's .pi/dev-team.json and .pi/dev-team.local.json. Project files can set
 * hooks and (filtered) env, so callers pass `includeProject: ctx.isProjectTrusted()`.
 */
export function loadConfig(
	cwd: string,
	opts: { includeProject: boolean; userConfigFile?: string },
): { config: DevTeamConfig; sources: string[]; droppedEnv: string[] } {
	let config = DEFAULT_CONFIG;
	const sources: string[] = [];
	const droppedEnv: string[] = [];
	const userFile = opts.userConfigFile ?? userConfigPath();
	const projectFiles = opts.includeProject ? [projectConfigPath(cwd), projectConfigPath(cwd, true)] : [];
	for (const file of [userFile, ...projectFiles]) {
		const raw = readJson(file);
		if (!raw) continue;
		const { data, dropped } = file === userFile ? { data: raw, dropped: [] } : filterProjectConfig(raw);
		config = mergeConfig(config, data);
		sources.push(file);
		droppedEnv.push(...dropped);
	}
	return { config, sources, droppedEnv };
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
