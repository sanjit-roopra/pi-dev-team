/**
 * dev-team configuration.
 *
 * Merged, later wins:
 *   1. built-in defaults
 *   2. ~/.pi/agent/dev-team.json          (user)
 *   3. <project>/.pi/dev-team.json        (project, committed)
 *   4. <project>/.pi/dev-team.local.json  (project, personal, git-ignored)
 *   5. DEV_TEAM_MAX_PARALLEL_AGENTS          (process environment; maxParallelAgents only)
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { readSmallFile } from "./safe-read.ts";

/** Model tiers, cheapest first (DEFAULT_CONFIG.models lists them). */
export type Tier = "small" | "standard" | "strong" | "max" | string;

/** Earlier tier names, after Claude models. They still work wherever a tier is named. */
export const TIER_ALIASES: Readonly<Record<string, string>> = { haiku: "small", sonnet: "standard", opus: "strong", fable: "max" };

/** The tier a name means: an earlier name becomes its tier, any other name stays as it is. */
export const tierName = (name: string): string => (Object.hasOwn(TIER_ALIASES, name) ? TIER_ALIASES[name] : name);

/** A tier table with earlier names renamed; when a table sets both names of a tier, the new name wins. */
export function normalizeTierTable<T>(models: Record<string, T>): Record<string, T> {
	return Object.fromEntries(
		Object.entries(models).flatMap(([name, model]) => {
			const tier = tierName(name);
			return tier === name || !Object.hasOwn(models, tier) ? [[tier, model]] : [];
		}),
	);
}

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

export const ANSWER_MODES = ["timeout", "wait"] as const;
export type AnswerMode = (typeof ANSWER_MODES)[number];

export const ROUTING_MODES = ["brief", "off"] as const;
export type RoutingMode = (typeof ROUTING_MODES)[number];

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
	/** Compact the main session between runs once its context reaches this many tokens (0 = off). */
	autocompactMaxTokens: number;
	/**
	 * Compact the main session between runs at this percentage of the context window: a whole number
	 * 1-100, or the same as a string ("40"). Unset = off. Read by autocompact.ts straight from the files
	 * (with DEV_TEAM_AUTOCOMPACT_PCT over them); never copied into the environment.
	 */
	autocompactPct?: number | string;
	/** Replace a repeated read whose text is already in the context with a one-line note (read-dedup.ts). */
	readDedup: boolean;
	/** Put bin/dev-team-run (headless `-p` runs through pi) on PATH for the scripts that call it. Older configs name it `claudeShim`. */
	cliShim: boolean;
	/** Let the model use the pi-subagents package's tools; off, dev-team hides and blocks them (pi-subagents.ts). User file only. */
	allowPiSubagents: boolean;
	/** Seconds a question or destructive-command confirm waits for the human before the run goes on without them; 0 = never ask (as if no human were attached). */
	askTimeoutSec: number;
	/** "timeout": a question waits askTimeoutSec, then the run goes on alone. "wait": a question waits for the human, however long. User file only. */
	answerMode: AnswerMode;
	/** "brief": a plain-text request gets a short "what I'm building" brief (dev_team_brief) before its first file change. */
	routing: RoutingMode;
	/** Where to send the brief and the assumed answers when the run goes on without the human: "ntfy:<topic>" or "ntfy:<https url>"; "" = nowhere. User file only. */
	notify: string;
	/** Extra environment variables for tools, hooks, scripts and subagents (e.g. DEV_TEAM_MAX_PARALLEL_BUILDS). */
	env: Record<string, string>;
}

/**
 * Hooks off by default (see docs/architecture.md).
 * - replaced natively by the extension: cost_meter, subagent_skill_context
 * - need data pi does not produce: code_intelligence_*, phase_marker
 * - opt-in: version_check (a daily check of the package checkout against its git origin)
 */
export const DEFAULT_DISABLED_HOOKS = [
	"cost_meter",
	"subagent_skill_context",
	"code_intelligence_nudge",
	"code_intelligence_turn_mark",
	"phase_marker",
	"version_check",
];

export const DEFAULT_CONFIG: DevTeamConfig = {
	models: { small: "inherit", standard: "inherit", strong: "inherit", max: "inherit" },
	thinking: { low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" },
	maxParallelAgents: 6,
	maxSubagentDepth: 2,
	subagentTimeoutSec: 3600,
	hooks: { enabled: true, disabled: DEFAULT_DISABLED_HOOKS, enable: [], outputToModel: true, timeoutSec: 60 },
	autoFormat: false,
	githubStyle: "block",
	skillIndex: "compact",
	skillIndexChars: 220,
	autocompactMaxTokens: 200_000,
	readDedup: true,
	cliShim: true,
	allowPiSubagents: false,
	askTimeoutSec: 120,
	answerMode: "timeout",
	routing: "brief",
	notify: "",
	env: {},
};

/** Tier presets offered by `/dev-team models`. Values are provider/model ids from pi's catalog. */
export const MODEL_PRESETS: Record<string, Record<string, string>> = {
	"github-copilot": {
		small: "github-copilot/claude-haiku-5.5",
		standard: "github-copilot/claude-sonnet-5.5",
		strong: "github-copilot/claude-opus-5.5",
		max: "github-copilot/claude-fable-5.2",
	},
	anthropic: {
		small: "anthropic/claude-haiku-5-5",
		standard: "anthropic/claude-sonnet-5-5",
		strong: "anthropic/claude-opus-5-5",
		max: "anthropic/claude-fable-5-2",
	},
	inherit: { small: "inherit", standard: "inherit", strong: "inherit", max: "inherit" },
};

/**
 * The tiers the package's agents use, cheapest first. No bundled agent names `max` in its
 * frontmatter (a test guards this); only a per-call override or a user or project agent uses it.
 */
const DEFAULT_USED_TIERS = ["small", "standard", "strong"] as const;

/** Whether pi can run a provider/model-id: in its catalog and with auth configured. */
export type ModelStatus = "ok" | "no-auth" | "unknown";

/** A tier and the model a change sets it to. */
export interface TierChange {
	tier: string;
	model: string;
}

/**
 * What `/dev-team doctor` advises for the session's provider. `tiersOnSessionModel` are default agent
 * tiers that run on the session model and that the preset would move to another model. `action`
 * "preset" applies the whole preset (it writes every tier, so it is advised only when no tier is
 * mapped to another model); "custom" sets the listed tiers one by one. `changes` is what the action
 * writes, and `unusable` the models among them pi cannot run.
 */
export interface PresetAdvice {
	/** The preset's name, which is its provider's id. */
	presetName: string;
	tiersOnSessionModel: string[];
	action: "preset" | "custom";
	changes: TierChange[];
	unusable: { model: string; status: ModelStatus }[];
}

/** A tier left to inherit the session model: unset, empty or "inherit". resolveModel uses this too. */
export const inherits = (model: unknown) => !model || model === "inherit";

/** The preset whose name is this provider id; the `inherit` reset option is not a provider's preset. */
function presetForProvider(provider: string): Record<string, string> | undefined {
	return provider !== "inherit" && Object.hasOwn(MODEL_PRESETS, provider) ? MODEL_PRESETS[provider] : undefined;
}

/**
 * The advice `/dev-team doctor` gives, or undefined when a preset would change nothing the agents
 * run on: no session model, no preset for its provider, or no default tier on the session model that
 * the preset maps elsewhere.
 */
export function presetAdvice(
	tierModels: Record<string, unknown>,
	sessionModel: string | undefined,
	getModelStatus: (model: string) => ModelStatus,
): PresetAdvice | undefined {
	if (!sessionModel) return undefined;
	const provider = sessionModel.split("/")[0];
	const presetTiers = presetForProvider(provider);
	if (!presetTiers) return undefined;
	const tiersOnSessionModel = DEFAULT_USED_TIERS.filter((t) => inherits(tierModels[t]) && presetTiers[t] && presetTiers[t] !== sessionModel);
	if (!tiersOnSessionModel.length) return undefined;
	const hasTierMappedElsewhere = Object.keys(presetTiers).some((t) => !inherits(tierModels[t]) && tierModels[t] !== presetTiers[t]);
	const action = hasTierMappedElsewhere ? "custom" : "preset";
	const changes =
		action === "preset"
			? Object.entries(presetTiers)
					.filter(([tier, model]) => tierModels[tier] !== model)
					.map(([tier, model]) => ({ tier, model }))
			: tiersOnSessionModel.map((tier) => ({ tier, model: presetTiers[tier] }));
	const unusable = [...new Set(changes.map((c) => c.model))].flatMap((model) => {
		const status = getModelStatus(model);
		return status === "ok" ? [] : [{ model, status }];
	});
	return { presetName: provider, tiersOnSessionModel: [...tiersOnSessionModel], action, changes, unusable };
}

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
 * reach PATH, NODE_OPTIONS or PYTHONPATH, any file path dev-team reads or runs (DEV_TEAM_PY_CACHE is
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
 * A valid autocompact percentage, else undefined: a whole number 1-100, or a string of one with no
 * sign, whitespace, decimal point or leading zero ("40", not "040", " 40" or "40.0").
 * hooks/lib/autocompact_config.py validates the same way.
 */
export function autocompactPctValue(raw: unknown): number | undefined {
	if (typeof raw === "number") return Number.isInteger(raw) && raw >= 1 && raw <= 100 ? raw : undefined;
	return typeof raw === "string" && /^(?:100|[1-9][0-9]?)$/.test(raw) ? Number(raw) : undefined;
}

/** Lowest context-token ceiling a project file may set; lower values would compact after nearly every run. */
export const MIN_PROJECT_AUTOCOMPACT_TOKENS = 50_000;

/** A project may turn the ceiling off (0) or set it at or above MIN_PROJECT_AUTOCOMPACT_TOKENS; the user's own file may set any value. */
export function isProjectAutocompactCeilingAllowed(value: unknown): boolean {
	return value === 0 || (typeof value === "number" && Number.isInteger(value) && value >= MIN_PROJECT_AUTOCOMPACT_TOKENS);
}

/** Most agents a project file may let run at once; more would start that many children (and their spend) at once. */
export const MAX_PROJECT_PARALLEL_AGENTS = 16;

/** A project may set a whole number of parallel agents from 1 to MAX_PROJECT_PARALLEL_AGENTS; the user's own file may set any. */
export function isProjectParallelLimitAllowed(value: unknown): boolean {
	return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= MAX_PROJECT_PARALLEL_AGENTS;
}

/**
 * A project config file as it may apply: env limited to PROJECT_ENV_SETTINGS (an env that is not an
 * object is dropped whole), no `hooks` at all, since hooks include the guards (hooks are set in the
 * user's own config), no `allowPiSubagents` (it lifts a block), no `askTimeoutSec` or `answerMode` (they decide whether and how long the human gates wait), no `notify` (it names where briefs are sent), `autocompactMaxTokens` only when isProjectAutocompactCeilingAllowed and
 * `maxParallelAgents` only when isProjectParallelLimitAllowed. `ignored` names everything left out, as
 * `env.KEY`, `env`, `hooks`, `allowPiSubagents`, `askTimeoutSec`, `answerMode`, `notify`, `autocompactMaxTokens` or `maxParallelAgents`.
 * `autocompactPct` passes as is: it is a top-level key, never env (autocompact.ts reads and validates it).
 */
export function filterProjectConfig(data: Record<string, unknown>): { data: Record<string, unknown>; ignored: string[] } {
	const ignored: string[] = [];
	const { env, hooks, allowPiSubagents, askTimeoutSec, answerMode, notify, autocompactMaxTokens, maxParallelAgents, ...rest } = data;
	const out: Record<string, unknown> = rest;
	if (hooks !== undefined) ignored.push("hooks");
	if (allowPiSubagents !== undefined) ignored.push("allowPiSubagents");
	if (askTimeoutSec !== undefined) ignored.push("askTimeoutSec");
	if (answerMode !== undefined) ignored.push("answerMode");
	if (notify !== undefined) ignored.push("notify");
	if (autocompactMaxTokens !== undefined) {
		if (isProjectAutocompactCeilingAllowed(autocompactMaxTokens)) out.autocompactMaxTokens = autocompactMaxTokens;
		else ignored.push("autocompactMaxTokens");
	}
	if (maxParallelAgents !== undefined) {
		if (isProjectParallelLimitAllowed(maxParallelAgents)) out.maxParallelAgents = maxParallelAgents;
		else ignored.push("maxParallelAgents");
	}
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
	opts: { includeProject: boolean; userConfigFile?: string; env?: NodeJS.ProcessEnv },
): { config: DevTeamConfig; sources: string[]; ignoredProjectSettings: string[]; oldTierNames: { file: string; names: string[] }[] } {
	let config = DEFAULT_CONFIG;
	const sources: string[] = [];
	const ignoredProjectSettings: string[] = [];
	const oldTierNames: { file: string; names: string[] }[] = [];
	const userFile = opts.userConfigFile ?? userConfigPath();
	const projectFiles = projectConfigFiles(cwd, opts);
	for (const file of [userFile, ...projectFiles]) {
		const raw = readJson(file);
		if (!raw) continue;
		const { data, ignored } = file === userFile ? { data: raw, ignored: [] } : filterProjectConfig(raw);
		// The CLI helper's earlier key: kept for old configs, `cliShim` wins when both are set.
		if ("claudeShim" in data) {
			if (!("cliShim" in data)) data.cliShim = data.claudeShim;
			delete data.claudeShim;
		}
		if ("githubStyle" in data && !(GITHUB_STYLE_MODES as readonly unknown[]).includes(data.githubStyle)) delete data.githubStyle;
		if ("askTimeoutSec" in data && !(Number.isInteger(data.askTimeoutSec) && (data.askTimeoutSec as number) >= 0)) delete data.askTimeoutSec;
		if ("answerMode" in data && !(ANSWER_MODES as readonly unknown[]).includes(data.answerMode)) delete data.answerMode;
		if ("routing" in data && !(ROUTING_MODES as readonly unknown[]).includes(data.routing)) delete data.routing;
		if ("notify" in data && typeof data.notify !== "string") delete data.notify;
		// A tier table that is not a table (null, a list) would replace the whole table; it sets nothing.
		if ("models" in data && !isPlainObject(data.models)) delete data.models;
		if (isPlainObject(data.models)) {
			const names = Object.keys(data.models).filter((name) => Object.hasOwn(TIER_ALIASES, name));
			if (names.length) oldTierNames.push({ file, names });
			data.models = normalizeTierTable(data.models);
		}
		config = mergeConfig(config, data);
		sources.push(file);
		ignoredProjectSettings.push(...ignored);
	}
	const envParallel = parallelAgentsFromEnv(opts.env ?? process.env);
	if (envParallel !== undefined) {
		config = { ...config, maxParallelAgents: envParallel };
		sources.push(`env ${PARALLEL_AGENTS_ENV}`);
	}
	return { config, sources, ignoredProjectSettings, oldTierNames };
}

/**
 * Sets maxParallelAgents from the process environment, over every config file, so a container can raise
 * the limit without a file under the agent dir (SlopCodeBench bind-mounts that dir). A whole number of at
 * least 1; anything else is ignored.
 */
export const PARALLEL_AGENTS_ENV = "DEV_TEAM_MAX_PARALLEL_AGENTS";

function parallelAgentsFromEnv(env: NodeJS.ProcessEnv): number | undefined {
	const raw = env[PARALLEL_AGENTS_ENV]?.trim();
	if (!raw || !/^[0-9]+$/.test(raw)) return undefined;
	const n = Number(raw);
	return n >= 1 ? n : undefined;
}

/** The project's config files loadConfig reads, in the order it merges them (later wins); none when untrusted. */
function projectConfigFiles(cwd: string, opts: { includeProject: boolean }): string[] {
	return opts.includeProject ? [projectConfigPath(cwd), projectConfigPath(cwd, true)] : [];
}

/**
 * The project config file whose setting wins for any of `tiers`, if a project file sets one: a change
 * saved anywhere else would not apply to that tier in this project.
 */
export function projectFileSettingTiers(cwd: string, opts: { includeProject: boolean }, tiers: readonly string[]): string | undefined {
	return projectConfigFiles(cwd, opts)
		.filter((file) => {
			const models = readJson(file)?.models;
			return isPlainObject(models) && tiers.some((t) => Object.hasOwn(normalizeTierTable(models), t));
		})
		.at(-1);
}

/** The tier models one config file sets itself, known tiers (earlier names renamed) with text values only; what `/dev-team models` starts from. */
export function fileTierModels(file: string): Record<string, string> {
	const models = readJson(file)?.models;
	if (!isPlainObject(models)) return {};
	return Object.fromEntries(
		Object.entries(normalizeTierTable(models)).filter((e): e is [string, string] => Object.hasOwn(DEFAULT_CONFIG.models, e[0]) && typeof e[1] === "string"),
	);
}

/**
 * Read-modify-write one config file (used by /dev-team models). A file it cannot parse is left alone, not
 * replaced. A patch of tier models also renames the file's earlier tier names, so it writes only new names.
 */
export function updateConfigFile(file: string, patch: Record<string, unknown>): void {
	const current = readJson(file);
	if (!current && fs.existsSync(file)) throw new Error(`${file} is not valid JSON; fix or remove it, then try again.`);
	if (current && "models" in patch && isPlainObject(current.models)) current.models = normalizeTierTable(current.models);
	const next = mergeConfig(current ?? {}, patch);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const target = current ? fs.realpathSync(file) : file; // a symlinked config keeps its link
	const tmp = `${target}.${process.pid}.tmp`;
	fs.writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, "utf-8");
	fs.renameSync(tmp, target);
}

export function isHookEnabled(config: DevTeamConfig, hookName: string): boolean {
	if (!config.hooks.enabled) return false;
	if (config.hooks.enable.includes(hookName)) return true;
	return !config.hooks.disabled.includes(hookName);
}
