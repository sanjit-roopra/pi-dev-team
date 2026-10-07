/**
 * pi-dev-team — pi port of Bryan Finster's dev-team plugin (bdfinst/agentic-dev-team).
 *
 * This extension provides the Claude Code runtime contract the upstream content relies on:
 *   env (CLAUDE_PLUGIN_ROOT, ...), /commands for skills, the `skill` and `dev_team_subagent` tools,
 *   `ask_user`, `web_fetch`, the Python hook bridge, native cost meter and autocompact.
 * See PORTING.md for the full mapping.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { DEV_TEAM_SUBAGENT_TOOL, discoverAgents, discoverDispatchAgents, mapTools, resolveAgentName, resolveModel, resolveThinking } from "./lib/agents.ts";
import { autocompactDue, describeAutocompact } from "./lib/autocompact.ts";
import { isModelVisibleRead, ReadTracker } from "./lib/read-dedup.ts";
import {
	DEFAULT_CONFIG,
	type DevTeamConfig,
	isHookEnabled,
	loadConfig,
	MODEL_PRESETS,
	projectConfigPath,
	updateConfigFile,
	userConfigPath,
} from "./lib/config.ts";
import { createStyleGate, styleGuideFor } from "./lib/github-style.ts";
import { applyUpdatedInput, claudeToolName, HookBridge, type HookOutcome, toClaudeInput } from "./lib/hooks.ts";
import { aiCreditsStatus } from "./lib/ai-credits.ts";
import { recordCost } from "./lib/metrics.ts";
import { sessionEntries } from "./lib/session-spend.ts";
import { commandText, discoverSkillPool, discoverInvocableSkills, discoverSkills, expandSkill, resolveSkillName, type SkillDef, skillIndex, unavailableSkillReason } from "./lib/skills.ts";
import { AGENT_PROMPT_FLAG, AGENT_PROMPT_FLAG_VALUE, buildSystemPrompt, forwardedArgs, registerSubagentTool } from "./lib/subagent.ts";
import { SUBAGENT_USAGE_ENTRY, type SubagentUsageEntry } from "./lib/subagent-types.ts";
import { registerAskUser, registerWebFetch } from "./lib/tools-misc.ts";
import { removeProcessFiles } from "./lib/session-files.ts";
import { childTrustOf, shimTrustEnv } from "./lib/trust.ts";
import { runUsage } from "./lib/usage-command.ts";
import { loadSpendHistory } from "./lib/usage-history.ts";

function packageRootDir(): string {
	// extensions/dev-team/index.ts -> package root
	const here = typeof __dirname === "string" ? __dirname : path.dirname(new URL(import.meta.url).pathname);
	return path.resolve(here, "..", "..");
}

const HOOK_NAME_PREFIX = /^\[[\w-]+\] /;
const SESSION_SOURCE: Record<string, string> = { startup: "startup", reload: "startup", new: "clear", resume: "resume", fork: "resume" };

export default function devTeam(pi: ExtensionAPI) {
	const packageRoot = packageRootDir();
	const isSubagent = process.env.DEV_TEAM_SUBAGENT === "1";
	const depth = Number(process.env.DEV_TEAM_SUBAGENT_DEPTH || 0) || 0;
	let cwd = process.cwd();
	// Project config is read again at session start, once pi's trust decision is known.
	let config: DevTeamConfig = loadConfig(cwd, { includeProject: false }).config;
	const getConfig = () => config;
	const hooks = new HookBridge(packageRoot, getConfig);
	const pendingAdvisories = new Map<string, string[]>();
	const styleGate = createStyleGate();
	const readTracker = new ReadTracker();
	let sessionContext: string[] = [];
	let running = 0;

	process.env.CLAUDE_PLUGIN_ROOT = packageRoot;
	process.env.DEV_TEAM_ROOT = packageRoot;

	pi.registerFlag("dev-team-agent", { type: "string", description: "Run this pi process as the named dev-team agent (used by the claude CLI shim)" });
	pi.registerFlag(AGENT_PROMPT_FLAG, { type: "string", description: "Set by dev_team_subagent on its children: the appended prompt is a dev-team agent prompt, which lists the agent's own skills and goes after the shared guide" });
	pi.registerFlag("dev-team-tier", { type: "string", description: "Model tier (opus|sonnet|haiku|fable) resolved through dev-team.json" });

	function applyEnv(ctx: ExtensionContext) {
		cwd = ctx.cwd;
		// A project's .pi/dev-team.json counts only when pi trusts the project, and then filtered
		// (allow-listed env settings, no hooks; see filterProjectConfig).
		config = loadConfig(cwd, projectConfigOpts(ctx)).config;
		for (const [k, v] of Object.entries(config.env)) process.env[k] = String(v);
		process.env.CLAUDE_PLUGIN_ROOT = packageRoot;
		process.env.CLAUDE_PROJECT_DIR = ctx.cwd;
		process.env.CLAUDE_SESSION_ID = ctx.sessionManager.getSessionId();
		if (ctx.hasUI && !isSubagent) process.env.DEV_TEAM_INTERACTIVE = "1";
		else delete process.env.DEV_TEAM_INTERACTIVE;
		// The claude shim's children inherit this session's trust decision as dev_team_subagent's do
		// (see trust.ts); bin/claude adds --approve only in DEV_TEAM_TRUSTED_DIR itself.
		const shim = shimTrustEnv(childTrustOf(ctx), forwardedArgs());
		process.env.DEV_TEAM_PI_ARGS = JSON.stringify(shim.piArgs);
		if (shim.trustedDir) process.env.DEV_TEAM_TRUSTED_DIR = shim.trustedDir;
		else delete process.env.DEV_TEAM_TRUSTED_DIR;
		const bin = path.join(packageRoot, "bin");
		const parts = (process.env.PATH ?? "").split(path.delimiter).filter((p) => p && p !== bin);
		process.env.PATH = (config.claudeShim ? [bin, ...parts] : parts).join(path.delimiter);
	}

	function notify(ctx: ExtensionContext, lines: string[], level: "info" | "warning" = "warning") {
		if (!lines.length || !ctx.hasUI) return;
		const text = lines.join("\n");
		ctx.ui.notify(text.length > 1200 ? `${text.slice(0, 1200)}…` : text, level);
	}

	/** SessionStart hooks for one source; returns their model context with the "[hook] " prefix removed. */
	async function runSessionStart(ctx: ExtensionContext, source: string): Promise<{ context: string[] }> {
		const out = await hooks.run("SessionStart", { ...basePayload(ctx), source }, ctx.cwd, { matchTarget: source });
		notify(ctx, out.notices, "info");
		return { context: out.advisories.map((a) => a.replace(HOOK_NAME_PREFIX, "")) };
	}

	/** Project config only for a trusted project (and filtered, see filterProjectConfig). */
	function projectConfigOpts(ctx: ExtensionContext) {
		return { includeProject: ctx.isProjectTrusted() };
	}

	function basePayload(ctx: ExtensionContext): Record<string, unknown> {
		return {
			session_id: ctx.sessionManager.getSessionId(),
			cwd: ctx.cwd,
			transcript_path: ctx.sessionManager.getSessionFile() ?? "",
		};
	}

	// ---------------------------------------------------------------- tools

	registerSubagentTool({
		pi,
		packageRoot,
		getConfig,
		hooks,
		depth,
		onUsage: (r) => {
			pi.appendEntry(SUBAGENT_USAGE_ENTRY, {
				agent: r.agent,
				model: r.model,
				tier: r.tier,
				ok: r.ok,
				durationMs: r.durationMs,
				usage: { ...r.usage },
				...(r.nested.length ? { nested: r.nested } : {}),
			} satisfies SubagentUsageEntry);
		},
	});
	registerAskUser(pi);
	registerWebFetch(pi);

	pi.registerTool({
		name: "skill",
		label: "Skill",
		description:
			"Run a dev-team skill (Claude Code's Skill tool). Returns the skill's instructions with arguments substituted; then follow them. Use it whenever dev-team instructions say to run a slash command such as /plan, /build, /code-review or /pr, or to load a skill by name.",
		promptSnippet: "Load and run a dev-team skill / slash command by name",
		// Returns a skill's instructions; it reads files and changes nothing.
		annotations: { readOnlyHint: true, openWorldHint: false },
		parameters: Type.Object({
			name: Type.String({ description: "Skill name, e.g. plan, code-review, test-driven-development (a leading / or dev-team: prefix is accepted)" }),
			args: Type.Optional(Type.String({ description: "Arguments, exactly as they would follow the slash command" })),
		}),
		prepareArguments: (raw: unknown) => {
			const a = (raw ?? {}) as Record<string, unknown>;
			return { name: a.name ?? a.skill ?? a.command, args: a.args ?? a.arguments ?? "" } as never;
		},
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const { skills, skippedProjectSkills } = discoverInvocableSkills(ctx.cwd, packageRoot, ctx.isProjectTrusted(), [params.name]);
			const skill = resolveSkillName(skills, params.name);
			if (!skill) {
				throw new Error(
					skippedProjectSkills.length
						? `Skill "${params.name}" ${unavailableSkillReason(true)}.`
						: `Unknown skill "${params.name}". Available: ${[...skills.keys()].sort().join(", ")}`,
				);
			}
			return { content: [{ type: "text", text: expandSkill(skill, params.args ?? "") }], details: { skill: skill.name, path: skill.filePath } };
		},
	});

	// ---------------------------------------------------------------- commands (one per user-invocable skill)

	// Commands are registered before pi's trust decision is known, so a project skill's command is
	// registered by name and resolved again when run, with project skills only for a trusted project.
	const commandSkills: SkillDef[] = [...discoverSkills(cwd, packageRoot, { includeProject: true }).values()].filter((s) => s.userInvocable);
	for (const skill of commandSkills) {
		pi.registerCommand(skill.name, {
			description: `${skill.description.slice(0, 140)}${skill.argumentHint ? ` ${skill.argumentHint}` : ""}`,
			handler: async (args, ctx) => {
				const { skills, skippedProjectSkills } = discoverInvocableSkills(ctx.cwd, packageRoot, ctx.isProjectTrusted(), [skill.name]);
				const current = resolveSkillName(skills, skill.name);
				if (!current) {
					ctx.ui.notify(`/${skill.name} ${unavailableSkillReason(skippedProjectSkills.length > 0)}.`, "warning");
					return;
				}
				// UserPromptSubmit never sees extension commands in pi; fire it so telemetry records /command usage.
				void hooks.run("UserPromptSubmit", { ...basePayload(ctx), prompt: `/${current.name}${args ? ` ${args}` : ""}` }, ctx.cwd);
				const text = commandText(current, args ?? "");
				const before = ctx.sessionManager.getEntries().length;
				if (ctx.isIdle()) await pi.sendUserMessage(text);
				else await pi.sendUserMessage(text, { deliverAs: "followUp" });
				// print/json/rpc modes finish when the command returns; wait for the turn it started.
				if (ctx.mode !== "tui") {
					for (let i = 0; i < 200 && ctx.isIdle() && ctx.sessionManager.getEntries().length <= before; i++) {
						await new Promise((r) => setTimeout(r, 25));
					}
					await ctx.waitForIdle();
				}
			},
		});
	}

	pi.registerCommand("dev-team", {
		description: "pi-dev-team: status | models | hooks | doctor | usage",
		getArgumentCompletions: (prefix) =>
			["status", "models", "hooks", "doctor", "usage"].filter((s) => s.startsWith(prefix)).map((s) => ({ value: s, label: s })),
		handler: async (args, ctx) => {
			const [sub = "status", ...rest] = (args ?? "").trim().split(/\s+/).filter(Boolean);
			if (sub === "usage") return runUsage(ctx, rest.join(" "), { now: () => new Date(), loadHistory: loadSpendHistory, emit: (text) => report(ctx, text) });
			if (sub === "models") return configureModels(ctx);
			if (sub === "hooks") return showHooks(ctx);
			if (sub === "doctor") return doctor(ctx);
			return showStatus(ctx);
		},
	});

	function report(ctx: ExtensionContext, text: string) {
		if (ctx.hasUI) ctx.ui.notify(text, "info");
		else console.log(text);
	}

	function showStatus(ctx: ExtensionContext) {
		const { config: cfg, sources, ignoredProjectSettings } = loadConfig(ctx.cwd, projectConfigOpts(ctx));
		const upstream = (() => {
			try {
				return JSON.parse(fs.readFileSync(path.join(packageRoot, "UPSTREAM.json"), "utf-8"));
			} catch {
				return {};
			}
		})();
		const agents = discoverAgents(ctx.cwd, packageRoot, { includeProject: ctx.isProjectTrusted() });
		const skills = discoverSkills(ctx.cwd, packageRoot, { includeProject: ctx.isProjectTrusted() });
		const enabledHooks = hooks.all.filter((h) => isHookEnabled(cfg, h.name));
		const lines = [
			`pi-dev-team (upstream dev-team v${upstream.version ?? "?"} @ ${String(upstream.commit ?? "").slice(0, 10)})`,
			`root: ${packageRoot}`,
			`config: ${sources.length ? sources.join(", ") : "defaults"}`,
			...(ignoredProjectSettings.length ? [`project config ignored (see PORTING.md): ${ignoredProjectSettings.join(", ")}`] : []),
			`tiers: ${Object.entries(cfg.models).map(([k, v]) => `${k}=${v}`).join("  ")}`,
			`agents: ${agents.size}  skills: ${skills.size} (${commandSkills.length} commands)`,
			`hooks: ${hooks.python ? `${new Set(enabledHooks.map((h) => h.name)).size} enabled via ${hooks.python}` : "DISABLED — no python >= 3.10 found"}`,
			`autoFormat: ${cfg.autoFormat}  githubStyle: ${cfg.githubStyle}  claudeShim: ${cfg.claudeShim}  maxParallelAgents: ${cfg.maxParallelAgents}`,
			`interactive gates: ${process.env.DEV_TEAM_INTERACTIVE === "1" ? "on" : "off (non-interactive defaults)"}`,
		];
		report(ctx, lines.join("\n"));
	}

	function showHooks(ctx: ExtensionContext) {
		const byName = new Map<string, Set<string>>();
		for (const h of hooks.all) {
			const set = byName.get(h.name) ?? new Set<string>();
			set.add(`${h.event}${h.matcher ? `(${h.matcher.source.replace(/^\^\(\?:|\)\$$/g, "")})` : ""}`);
			byName.set(h.name, set);
		}
		const lines = [...byName.entries()]
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([name, events]) => `${isHookEnabled(config, name) ? "on " : "off"} ${name}  ${[...events].join(", ")}`);
		report(ctx, `hooks (${packageRoot}/hooks/hooks.json):\n${lines.join("\n")}\nChange with "hooks": {"disabled": [...], "enable": [...]} in dev-team.json`);
	}

	function doctor(ctx: ExtensionContext) {
		const which = (bin: string) => {
			for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
				if (dir && fs.existsSync(path.join(dir, bin))) return path.join(dir, bin);
			}
			return undefined;
		};
		const rows = [
			["python3 >= 3.10 (hooks, scripts)", hooks.python ?? undefined],
			["git", which("git")],
			["gh (PRs, issues)", which("gh")],
			["jq (some gates)", which("jq")],
			["claude shim", which("claude")],
			["semgrep (optional)", which("semgrep")],
		] as const;
		const model = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "none";
		const tierLines = Object.entries(config.models).map(([tier, m]) => {
			if (m === "inherit") return `  ${tier}: inherit (${model})`;
			const [prov, ...rest] = m.split("/");
			const found = ctx.modelRegistry.find(prov, rest.join("/"));
			const auth = found ? ctx.modelRegistry.hasConfiguredAuth(found) : false;
			return `  ${tier}: ${m} ${found ? (auth ? "ok" : "NO AUTH (/login)") : "UNKNOWN MODEL"}`;
		});
		report(
			ctx,
			[
				...rows.map(([name, p]) => `${p ? "ok     " : "MISSING"} ${name}${p ? `  ${p}` : ""}`),
				`model tiers:`,
				...tierLines,
			].join("\n"),
		);
	}

	async function configureModels(ctx: ExtensionContext) {
		if (!ctx.hasUI) {
			report(ctx, `Edit "models" in ${userConfigPath()} or ${projectConfigPath(ctx.cwd)}. Presets: ${Object.keys(MODEL_PRESETS).join(", ")}`);
			return;
		}
		const scope = await ctx.ui.select("Save tier mapping for", [`user (${userConfigPath()})`, `project (${projectConfigPath(ctx.cwd)})`]);
		if (!scope) return;
		const file = scope.startsWith("user") ? userConfigPath() : projectConfigPath(ctx.cwd);
		const mode = await ctx.ui.select("Map dev-team agent tiers (opus/sonnet/haiku/fable) to models", [
			...Object.keys(MODEL_PRESETS).map((p) => `preset: ${p}`),
			"custom: pick a model per tier",
		]);
		if (!mode) return;
		let models: Record<string, string>;
		if (mode.startsWith("preset: ")) {
			models = MODEL_PRESETS[mode.slice(8)];
		} else {
			const available = ctx.modelRegistry.getAvailable().map((m) => `${m.provider}/${m.id}`).sort();
			models = { ...config.models };
			for (const tier of Object.keys(DEFAULT_CONFIG.models)) {
				const pick = await ctx.ui.select(`Model for tier "${tier}" (current: ${models[tier]})`, ["inherit", ...available]);
				if (pick) models[tier] = pick;
			}
		}
		updateConfigFile(file, { models });
		config = loadConfig(ctx.cwd, projectConfigOpts(ctx)).config;
		ctx.ui.notify(`Saved to ${file}:\n${Object.entries(models).map(([k, v]) => `${k} = ${v}`).join("\n")}`, "info");
	}

	// ---------------------------------------------------------------- agent mode (claude shim: --dev-team-agent)

	async function applyAgentFlag(ctx: ExtensionContext) {
		const agentName = pi.getFlag("dev-team-agent");
		const tierFlag = pi.getFlag("dev-team-tier");
		const parentModel = process.env.PI_PROVIDER && process.env.PI_MODEL ? `${process.env.PI_PROVIDER}/${process.env.PI_MODEL}` : undefined;
		let frontmatterModel: string | undefined;
		let effort: string | undefined;
		if (typeof agentName === "string" && agentName) {
			// Same rule as dev_team_subagent: no project agents when pi trust was declined.
			const { agents, skippedProjectAgents } = discoverDispatchAgents(ctx.cwd, packageRoot, ctx.isProjectTrusted(), [agentName]);
			const def = resolveAgentName(agents, agentName);
			if (!def) {
				console.error(
					skippedProjectAgents.length
						? `dev-team: project agent "${agentName}" not run: this project is not trusted in pi`
						: `dev-team: unknown agent "${agentName}"`,
				);
				return;
			}
			agentPrompt = buildSystemPrompt(def, packageRoot, [], [], discoverSkillPool(config, ctx.cwd, packageRoot, ctx.isProjectTrusted()), config.skillIndexChars);
			frontmatterModel = def.model;
			effort = def.effort;
			const mapping = mapTools(def.claudeTools, pi.getAllTools().map((t) => t.name));
			if (mapping) pi.setActiveTools(mapping.tools);
		}
		if (typeof agentName === "string" || typeof tierFlag === "string") {
			const choice = resolveModel(frontmatterModel, typeof tierFlag === "string" ? tierFlag : undefined, config.models, parentModel);
			if (choice.model && choice.model !== (ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined)) {
				const [prov, ...rest] = choice.model.split("/");
				const m = ctx.modelRegistry.find(prov, rest.join("/"));
				if (m) await pi.setModel(m);
			}
			const thinking = resolveThinking(effort, undefined, config.thinking, undefined);
			if (thinking) pi.setThinkingLevel(thinking as never);
		}
	}
	let agentPrompt: string | undefined;

	/**
	 * Refresh the session's GitHub Copilot AI credits status line under pi's footer (hidden at 0). Runs
	 * at turn end and dispatch end, so spend pi records while idle (cache warming) shows from the next turn.
	 */
	function refreshAiCreditsStatus(ctx: ExtensionContext): void {
		if (isSubagent || !ctx.hasUI) return;
		ctx.ui.setStatus("dev-team-ai-credits", aiCreditsStatus(sessionEntries(ctx)));
	}

	// ---------------------------------------------------------------- lifecycle

	pi.on("session_start", async (event, ctx) => {
		readTracker.reset();
		applyEnv(ctx);
		await applyAgentFlag(ctx);
		if (!hooks.python && ctx.hasUI) ctx.ui.notify("dev-team: python >= 3.10 not found — hook guards are disabled.", "warning");
		if (isSubagent) return;
		refreshAiCreditsStatus(ctx);
		const out = await runSessionStart(ctx, SESSION_SOURCE[event.reason] ?? "startup");
		sessionContext = out.context;
	});

	pi.on("before_agent_start", async (event, ctx) => {
		const opts = event.systemPromptOptions;
		// A dispatched agent (flag set by dev_team_subagent) or a process run as an agent gets only the
		// skills its instructions name, in its agent prompt (buildSystemPrompt), so the guide stays the
		// same for every agent and cacheable. Not keyed on DEV_TEAM_SUBAGENT: a plain `claude -p` from a
		// subagent's bash inherits that env but has no agent prompt, and keeps the full index.
		const hasAgentPrompt = agentPrompt !== undefined || pi.getFlag(AGENT_PROMPT_FLAG) === AGENT_PROMPT_FLAG_VALUE;
		const index =
			hasAgentPrompt || config.skillIndex === "off"
				? ""
				: skillIndex(discoverSkills(ctx.cwd, packageRoot, { includeProject: ctx.isProjectTrusted() }), config.skillIndex, config.skillIndexChars);
		const guide = compatGuide(packageRoot, index, process.env.DEV_TEAM_INTERACTIVE === "1", styleGuideFor(config.githubStyle));
		opts.sections = { ...(opts.sections ?? {}), dev_team: guide };
		if (hasAgentPrompt) {
			// The agent's own text goes after the dev-team guide. pi renders the appended prompt before the
			// project context and the sections, so left there it would end the prefix that agents share;
			// moved behind the guide, agents with the same tools and model share one cached prefix up to
			// their own instructions. Extensions loaded later (pi's mcp) may still add sections after it.
			const agentText = [opts.appendSystemPrompt, agentPrompt].filter(Boolean).join("\n\n");
			opts.appendSystemPrompt = "";
			if (agentText) opts.sections = { ...opts.sections, dev_team_agent: agentText };
		}
		if (sessionContext.length) {
			const content = sessionContext.join("\n\n");
			sessionContext = [];
			return { message: { customType: "dev-team-session-start", content, display: true } };
		}
		return undefined;
	});

	pi.on("input", async (event, ctx) => {
		if (!isSubagent && event.source !== "extension") {
			void hooks.run("UserPromptSubmit", { ...basePayload(ctx), prompt: event.text }, ctx.cwd);
		}
		return { action: "continue" };
	});

	pi.on("tool_call", async (event, ctx) => {
		const input = event.input as Record<string, unknown>;
		if (event.toolName === DEV_TEAM_SUBAGENT_TOOL) {
			// PreToolUse(Agent) hooks run per dispatch inside the tool.
			running++;
			if (ctx.hasUI) ctx.ui.setStatus("dev-team", `dev-team: ${running} agent call(s) running`);
			return undefined;
		}
		const styleVerdict = event.toolName === "bash" && typeof input.command === "string" ? styleGate(config.githubStyle, input.command, ctx.cwd) : {};
		if (styleVerdict.block) return { block: true, reason: styleVerdict.block };
		const claudeTool = claudeToolName(event.toolName);
		const out = await hooks.run(
			"PreToolUse",
			{ ...basePayload(ctx), tool_name: claudeTool, tool_use_id: event.toolCallId, tool_input: toClaudeInput(event.toolName, input, ctx.cwd) },
			ctx.cwd,
			{ matchTarget: claudeTool },
		);
		notify(ctx, out.notices);
		if (out.block) return { block: true, reason: out.block };
		if (out.updatedInput) applyUpdatedInput(event.toolName, input, out.updatedInput);
		const advisories = styleVerdict.note ? [styleVerdict.note, ...out.advisories] : out.advisories;
		if (advisories.length) pendingAdvisories.set(event.toolCallId, advisories);
		return undefined;
	});

	pi.on("tool_result", async (event, ctx) => {
		if (event.toolName === DEV_TEAM_SUBAGENT_TOOL) {
			running = Math.max(0, running - 1);
			if (ctx.hasUI) ctx.ui.setStatus("dev-team", running ? `dev-team: ${running} agent call(s) running` : undefined);
			refreshAiCreditsStatus(ctx);
		}
		const claudeTool = claudeToolName(event.toolName);
		const input = event.input as Record<string, unknown>;
		const text = event.content
			.filter((c) => c.type === "text")
			.map((c) => (c as { text: string }).text)
			.join("\n");
		const structured = (event.structuredContent ?? {}) as Record<string, unknown>;
		const toolResponse: Record<string, unknown> =
			event.toolName === "bash"
				? {
						output: typeof structured.output === "string" ? structured.output : text,
						exit_code: typeof structured.exit_code === "number" ? structured.exit_code : event.isError ? 1 : 0,
						stdout: typeof structured.output === "string" ? structured.output : text,
						stderr: "",
						interrupted: false,
					}
				: { output: text, success: !event.isError };
		const payload = {
			...basePayload(ctx),
			tool_name: claudeTool,
			tool_use_id: event.toolCallId,
			tool_input: toClaudeInput(event.toolName, input, ctx.cwd),
			tool_response: toolResponse,
		};
		const outcomes: HookOutcome[] = [await hooks.run("PostToolUse", payload, ctx.cwd, { matchTarget: claudeTool })];
		// Hooks see the real text; the model gets a note when it already has this exact read in context.
		const readNote = config.readDedup && isModelVisibleRead(event) ? readTracker.noteForRepeatedRead({ cwd: ctx.cwd, input, text }) : undefined;
		const content = readNote ? [{ type: "text" as const, text: readNote }] : event.content;
		const unchanged = readNote ? { content } : undefined;
		if (config.autoFormat && !event.isError && (event.toolName === "write" || event.toolName === "edit")) {
			outcomes.push(await hooks.runScript("post_format", "PostToolUse", payload, ctx.cwd));
		}
		const advisories = [...(pendingAdvisories.get(event.toolCallId) ?? []), ...outcomes.flatMap((o) => o.advisories)];
		pendingAdvisories.delete(event.toolCallId);
		notify(ctx, outcomes.flatMap((o) => o.notices));
		const block = outcomes.map((o) => o.block).filter(Boolean).join("\n\n");
		if (!advisories.length && !block) return unchanged;
		const extra: string[] = [];
		if (block) extra.push(`dev-team hook feedback (must address):\n${block}`);
		if (advisories.length) {
			if (config.hooks.outputToModel) extra.push(`dev-team hook notes:\n${advisories.join("\n")}`);
			else notify(ctx, advisories, "info");
		}
		if (!extra.length) return unchanged;
		return {
			content: [...content, { type: "text" as const, text: `\n\n${extra.join("\n\n")}` }],
			structuredContent: event.structuredContent,
			...(block ? { isError: true } : {}),
		};
	});

	pi.on("turn_end", async (_event, ctx) => {
		readTracker.endTurn();
		refreshAiCreditsStatus(ctx);
	});

	pi.on("agent_end", async (_event, ctx) => {
		if (isSubagent) return;
		recordCost(ctx);
		await hooks.run("Stop", { ...basePayload(ctx), stop_hook_active: false }, ctx.cwd);
	});

	// Autocompact at the configured percentage or the autocompactMaxTokens ceiling. agent_settled, not agent_end: agent_end fires inside the
	// run, and ctx.compact() aborts a running turn, which would cancel pi's own retry and overflow
	// recovery. Inside one long run pi's own threshold remains the backstop. Print/json runs end here.
	pi.on("agent_settled", async (_event, ctx) => {
		if (isSubagent || (ctx.mode !== "tui" && ctx.mode !== "rpc")) return;
		const due = autocompactDue(ctx, { maxContextTokens: config.autocompactMaxTokens });
		if (!due) return;
		notify(ctx, [describeAutocompact(due)], "info");
		ctx.compact({ onError: () => {} });
	});

	// A branch switch rebuilds the context from another path of the session tree.
	pi.on("session_tree", async () => {
		readTracker.reset();
	});

	// Claude Code fires SessionStart(source=compact) after compaction; post_compact_state_reinject uses it
	// to restore /build state. triggerTurn: false adds it to the context (deferred to the end of the turn
	// when one is running) without starting a model turn, as Claude's additionalContext does.
	pi.on("session_compact", async (_event, ctx) => {
		readTracker.reset();
		if (isSubagent) return;
		const out = await runSessionStart(ctx, "compact");
		if (out.context.length) {
			pi.sendMessage({ customType: "dev-team-session-start", content: out.context.join("\n\n"), display: true }, { triggerTurn: false });
		}
	});

	pi.on("session_shutdown", async (event, ctx) => {
		try {
			if (isSubagent) return;
			await hooks.run("SessionEnd", { ...basePayload(ctx), reason: event.reason === "quit" ? "prompt_input_exit" : "other" }, ctx.cwd);
		} finally {
			// Only on quit: after a reload, new, resume or fork, tool results may still name these files.
			if (event.reason === "quit") removeProcessFiles();
		}
	});
}

function compatGuide(packageRoot: string, index: string, interactive: boolean, styleGuide: string | undefined): string {
	return [
		"This session has the dev-team plugin: a pi port of bdfinst/agentic-dev-team, a persona-driven development team written for Claude Code (orchestrator, specialist agents, review agents, skills, guard hooks; main flow /specs -> /plan -> /build -> /pr). Its text uses Claude Code terms. Map them like this:",
		`- Tools: Read=read, Write=write, Edit/MultiEdit=edit, Bash=bash, Grep=grep, Glob=find, Skill=skill, Agent/Task(subagent_type=X, prompt=P)=${DEV_TEAM_SUBAGENT_TOOL}(agent=X, task=P), AskUserQuestion=ask_user, WebFetch=web_fetch. WebSearch and TodoWrite do not exist (keep checklists in your replies).`,
		`- Always use ${DEV_TEAM_SUBAGENT_TOOL} for dev-team dispatch, including instructions that say to use the subagent tool. Other extensions' subagent tools do not apply the dev-team tier mappings or dispatch hooks.`,
		'- A slash command inside dev-team instructions ("run /plan", "invoke /code-review --internal", "/dev-team:project-init") means: call the skill tool with that name and the text after it as args, then follow what it returns. Never ask the user to type it.',
		`- \${CLAUDE_PLUGIN_ROOT} is ${packageRoot} and is exported in bash. knowledge/, scripts/, agents/, skills/, templates/, hooks/ paths in the instructions are relative to it.`,
		"- Runtime state lives under .claude/ in the project (memory, metrics, hooks, plans) exactly as the skills describe. Project instructions are AGENTS.md / CLAUDE.md.",
		'- Plugin hooks run on your tool calls. A blocked call returns the reason: follow it, do not work around it. Text after "dev-team hook notes:" in a tool result is advisory feedback from those hooks.',
		interactive
			? "- Human gates: a human is attached (DEV_TEAM_INTERACTIVE=1). Ask with ask_user and wait for the answer; never assume approval."
			: "- Human gates: no human is attached (non-interactive run, DEV_TEAM_INTERACTIVE unset). Apply each gate's documented non-interactive default and say so; do not wait.",
		`- The "orchestrator" the instructions describe is the session the user talks to, not the orchestrator agent. In that session, run skills that run commands or write files (/code-review, /build, /pr, /ship, /fix and the like) yourself; the orchestrator agent can only read and dispatch. Dispatch an agent only for its own role, and only when its \`tools:\` frontmatter covers the work (project .pi/agents/ or .claude/agents/ first, then agents/). A dispatched agent does its task and reports back; it does not start /code-review, /build, /pr, /ship or /fix unless its task or its own agent instructions say to.`,
		`- To run independent dev-team agents in parallel, issue several ${DEV_TEAM_SUBAGENT_TOOL} calls in one message (or one call with tasks[]). The agent sees only its task text, so pass paths, diff ranges and scope markers explicitly.`,
		styleGuide ? `\n${styleGuide}` : "",
		index ? `\nDev-team skills (load with the skill tool; "(/x)" = also a user command):\n${index}` : "",
	].join("\n");
}
