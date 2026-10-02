/**
 * pi-dev-team — pi port of Bryan Finster's dev-team plugin (bdfinst/agentic-dev-team).
 *
 * This extension provides the Claude Code runtime contract the upstream content relies on:
 *   env (CLAUDE_PLUGIN_ROOT, ...), /commands for skills, the `skill` and `dev_team_subagent` tools,
 *   `ask_user`, `web_fetch`, the Python hook bridge, native cost meter and context-ceiling guard.
 * See PORTING.md for the full mapping.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { DEV_TEAM_SUBAGENT_TOOL, discoverAgents, mapTools, resolveAgentName, resolveModel, resolveThinking } from "./lib/agents.ts";
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
import { applyUpdatedInput, claudeToolName, HookBridge, type HookOutcome, toClaudeInput } from "./lib/hooks.ts";
import { contextCeiling, recordCost } from "./lib/metrics.ts";
import { commandText, discoverSkills, expandSkill, resolveSkillName, type SkillDef, skillIndex } from "./lib/skills.ts";
import { buildSystemPrompt, forwardedArgs, registerSubagentTool, SUBAGENT_USAGE_ENTRY } from "./lib/subagent.ts";
import { registerAskUser, registerWebFetch } from "./lib/tools-misc.ts";

function packageRootDir(): string {
	// extensions/dev-team/index.ts -> package root
	const here = typeof __dirname === "string" ? __dirname : path.dirname(new URL(import.meta.url).pathname);
	return path.resolve(here, "..", "..");
}

const SESSION_SOURCE: Record<string, string> = { startup: "startup", reload: "startup", new: "clear", resume: "resume", fork: "resume" };

export default function devTeam(pi: ExtensionAPI) {
	const packageRoot = packageRootDir();
	const isSubagent = process.env.DEV_TEAM_SUBAGENT === "1";
	const depth = Number(process.env.DEV_TEAM_SUBAGENT_DEPTH || 0) || 0;
	let cwd = process.cwd();
	let config: DevTeamConfig = loadConfig(cwd).config;
	const getConfig = () => config;
	const hooks = new HookBridge(packageRoot, getConfig);
	const pendingAdvisories = new Map<string, string[]>();
	let sessionContext: string[] = [];
	let running = 0;

	process.env.CLAUDE_PLUGIN_ROOT = packageRoot;
	process.env.DEV_TEAM_ROOT = packageRoot;

	pi.registerFlag("dev-team-agent", { type: "string", description: "Run this pi process as the named dev-team agent (used by the claude CLI shim)" });
	pi.registerFlag("dev-team-tier", { type: "string", description: "Model tier (opus|sonnet|haiku|fable) resolved through dev-team.json" });

	function applyEnv(ctx: ExtensionContext) {
		cwd = ctx.cwd;
		config = loadConfig(cwd).config;
		for (const [k, v] of Object.entries(config.env)) process.env[k] = String(v);
		process.env.CLAUDE_PLUGIN_ROOT = packageRoot;
		process.env.CLAUDE_PROJECT_DIR = ctx.cwd;
		process.env.CLAUDE_SESSION_ID = ctx.sessionManager.getSessionId();
		if (ctx.hasUI && !isSubagent) process.env.DEV_TEAM_INTERACTIVE = "1";
		else delete process.env.DEV_TEAM_INTERACTIVE;
		const forward = forwardedArgs();
		if (ctx.isProjectTrusted()) forward.push("--approve");
		process.env.DEV_TEAM_PI_ARGS = JSON.stringify(forward);
		const bin = path.join(packageRoot, "bin");
		const parts = (process.env.PATH ?? "").split(path.delimiter).filter((p) => p && p !== bin);
		process.env.PATH = (config.claudeShim ? [bin, ...parts] : parts).join(path.delimiter);
	}

	function notify(ctx: ExtensionContext, lines: string[], level: "info" | "warning" = "warning") {
		if (!lines.length || !ctx.hasUI) return;
		const text = lines.join("\n");
		ctx.ui.notify(text.length > 1200 ? `${text.slice(0, 1200)}…` : text, level);
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
			});
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
		parameters: Type.Object({
			name: Type.String({ description: "Skill name, e.g. plan, code-review, test-driven-development (a leading / or dev-team: prefix is accepted)" }),
			args: Type.Optional(Type.String({ description: "Arguments, exactly as they would follow the slash command" })),
		}),
		prepareArguments: (raw: unknown) => {
			const a = (raw ?? {}) as Record<string, unknown>;
			return { name: a.name ?? a.skill ?? a.command, args: a.args ?? a.arguments ?? "" } as never;
		},
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const skills = discoverSkills(ctx.cwd, packageRoot);
			const skill = resolveSkillName(skills, params.name);
			if (!skill) {
				throw new Error(`Unknown skill "${params.name}". Available: ${[...skills.keys()].sort().join(", ")}`);
			}
			return { content: [{ type: "text", text: expandSkill(skill, params.args ?? "") }], details: { skill: skill.name, path: skill.filePath } };
		},
	});

	// ---------------------------------------------------------------- commands (one per user-invocable skill)

	const commandSkills: SkillDef[] = [...discoverSkills(cwd, packageRoot).values()].filter((s) => s.userInvocable);
	for (const skill of commandSkills) {
		pi.registerCommand(skill.name, {
			description: `${skill.description.slice(0, 140)}${skill.argumentHint ? ` ${skill.argumentHint}` : ""}`,
			handler: async (args, ctx) => {
				const current = resolveSkillName(discoverSkills(ctx.cwd, packageRoot), skill.name) ?? skill;
				const verdict = contextCeiling(ctx, "skill", current.name);
				if (verdict.block) {
					ctx.ui.notify(verdict.block, "error");
					return;
				}
				if (verdict.warn) ctx.ui.notify(verdict.warn, "warning");
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
		description: "pi-dev-team: status | models | hooks | doctor",
		getArgumentCompletions: (prefix) =>
			["status", "models", "hooks", "doctor"].filter((s) => s.startsWith(prefix)).map((s) => ({ value: s, label: s })),
		handler: async (args, ctx) => {
			const sub = (args ?? "").trim().split(/\s+/)[0] || "status";
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
		const { config: cfg, sources } = loadConfig(ctx.cwd);
		const upstream = (() => {
			try {
				return JSON.parse(fs.readFileSync(path.join(packageRoot, "UPSTREAM.json"), "utf-8"));
			} catch {
				return {};
			}
		})();
		const agents = discoverAgents(ctx.cwd, packageRoot);
		const skills = discoverSkills(ctx.cwd, packageRoot);
		const enabledHooks = hooks.all.filter((h) => isHookEnabled(cfg, h.name));
		const lines = [
			`pi-dev-team (upstream dev-team v${upstream.version ?? "?"} @ ${String(upstream.commit ?? "").slice(0, 10)})`,
			`root: ${packageRoot}`,
			`config: ${sources.length ? sources.join(", ") : "defaults"}`,
			`tiers: ${Object.entries(cfg.models).map(([k, v]) => `${k}=${v}`).join("  ")}`,
			`agents: ${agents.size}  skills: ${skills.size} (${commandSkills.length} commands)`,
			`hooks: ${hooks.python ? `${new Set(enabledHooks.map((h) => h.name)).size} enabled via ${hooks.python}` : "DISABLED — no python >= 3.10 found"}`,
			`autoFormat: ${cfg.autoFormat}  claudeShim: ${cfg.claudeShim}  maxParallelAgents: ${cfg.maxParallelAgents}`,
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
		config = loadConfig(ctx.cwd).config;
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
			const def = resolveAgentName(discoverAgents(ctx.cwd, packageRoot), agentName);
			if (!def) {
				console.error(`dev-team: unknown agent "${agentName}"`);
				return;
			}
			agentPrompt = buildSystemPrompt(def, packageRoot, [], []);
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

	// ---------------------------------------------------------------- lifecycle

	pi.on("session_start", async (event, ctx) => {
		applyEnv(ctx);
		await applyAgentFlag(ctx);
		if (!hooks.python && ctx.hasUI) ctx.ui.notify("dev-team: python >= 3.10 not found — hook guards are disabled.", "warning");
		if (isSubagent) return;
		const out = await hooks.run("SessionStart", { ...basePayload(ctx), source: SESSION_SOURCE[event.reason] ?? "startup" }, ctx.cwd);
		sessionContext = out.advisories.map((a) => a.replace(/^\[[\w-]+\] /, ""));
		notify(ctx, out.notices, "info");
	});

	pi.on("before_agent_start", async (event, ctx) => {
		const opts = event.systemPromptOptions;
		const skills = discoverSkills(ctx.cwd, packageRoot);
		const index = config.skillIndex === "off" ? "" : skillIndex(skills, config.skillIndex, config.skillIndexChars);
		opts.sections = { ...(opts.sections ?? {}), dev_team: compatGuide(packageRoot, index, process.env.DEV_TEAM_INTERACTIVE === "1") };
		if (agentPrompt) opts.appendSystemPrompt = `${opts.appendSystemPrompt ? `${opts.appendSystemPrompt}\n\n` : ""}${agentPrompt}`;
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
		if (event.toolName === "skill") {
			const verdict = contextCeiling(ctx, "skill", String(input.name ?? "").replace(/^\/|^[\w-]+:/g, ""));
			if (verdict.block) return { block: true, reason: verdict.block };
			if (verdict.warn) notify(ctx, [verdict.warn]);
		}
		if (event.toolName === DEV_TEAM_SUBAGENT_TOOL) {
			// PreToolUse(Agent) hooks run per dispatch inside the tool; only the context ceiling applies here.
			const verdict = contextCeiling(ctx, "agent", String(input.agent ?? input.subagent_type ?? "tasks"));
			if (verdict.block) return { block: true, reason: verdict.block };
			if (verdict.warn) notify(ctx, [verdict.warn]);
			running++;
			if (ctx.hasUI) ctx.ui.setStatus("dev-team", `dev-team: ${running} agent call(s) running`);
			return undefined;
		}
		const claudeTool = claudeToolName(event.toolName);
		const out = await hooks.run(
			"PreToolUse",
			{ ...basePayload(ctx), tool_name: claudeTool, tool_use_id: event.toolCallId, tool_input: toClaudeInput(event.toolName, input, ctx.cwd) },
			ctx.cwd,
			{ claudeTool },
		);
		notify(ctx, out.notices);
		if (out.block) return { block: true, reason: out.block };
		if (out.updatedInput) applyUpdatedInput(event.toolName, input, out.updatedInput);
		if (out.advisories.length) pendingAdvisories.set(event.toolCallId, out.advisories);
		return undefined;
	});

	pi.on("tool_result", async (event, ctx) => {
		if (event.toolName === DEV_TEAM_SUBAGENT_TOOL) {
			running = Math.max(0, running - 1);
			if (ctx.hasUI) ctx.ui.setStatus("dev-team", running ? `dev-team: ${running} agent call(s) running` : undefined);
		}
		const claudeTool = claudeToolName(event.toolName);
		const input = event.input as Record<string, unknown>;
		const text = event.content
			.filter((c) => c.type === "text")
			.map((c) => (c as { text: string }).text)
			.join("\n");
		const structured = (event.structuredContent ?? {}) as Record<string, unknown>;
		const details = (event.details ?? {}) as Record<string, unknown>;
		const toolResponse: Record<string, unknown> =
			event.toolName === "bash"
				? {
						output: typeof structured.output === "string" ? structured.output : text,
						exit_code: typeof structured.exit_code === "number" ? structured.exit_code : event.isError ? 1 : 0,
						stdout: typeof structured.output === "string" ? structured.output : text,
						stderr: "",
						interrupted: false,
					}
				: { output: text, success: !event.isError, ...(typeof details === "object" ? {} : {}) };
		const payload = {
			...basePayload(ctx),
			tool_name: claudeTool,
			tool_use_id: event.toolCallId,
			tool_input: toClaudeInput(event.toolName, input, ctx.cwd),
			tool_response: toolResponse,
		};
		const outcomes: HookOutcome[] = [await hooks.run("PostToolUse", payload, ctx.cwd, { claudeTool })];
		if (config.autoFormat && !event.isError && (event.toolName === "write" || event.toolName === "edit")) {
			outcomes.push(await hooks.runScript("post_format", "PostToolUse", payload, ctx.cwd));
		}
		const advisories = [...(pendingAdvisories.get(event.toolCallId) ?? []), ...outcomes.flatMap((o) => o.advisories)];
		pendingAdvisories.delete(event.toolCallId);
		notify(ctx, outcomes.flatMap((o) => o.notices));
		const block = outcomes.map((o) => o.block).filter(Boolean).join("\n\n");
		if (!advisories.length && !block) return undefined;
		const extra: string[] = [];
		if (block) extra.push(`dev-team hook feedback (must address):\n${block}`);
		if (advisories.length) {
			if (config.hooks.outputToModel) extra.push(`dev-team hook notes:\n${advisories.join("\n")}`);
			else notify(ctx, advisories, "info");
		}
		if (!extra.length) return undefined;
		return {
			content: [...event.content, { type: "text" as const, text: `\n\n${extra.join("\n\n")}` }],
			structuredContent: event.structuredContent,
			...(block ? { isError: true } : {}),
		};
	});

	pi.on("agent_end", async (_event, ctx) => {
		if (isSubagent) return;
		recordCost(ctx);
		await hooks.run("Stop", { ...basePayload(ctx), stop_hook_active: false }, ctx.cwd);
	});

	pi.on("session_shutdown", async (event, ctx) => {
		if (isSubagent) return;
		await hooks.run("SessionEnd", { ...basePayload(ctx), reason: event.reason === "quit" ? "prompt_input_exit" : "other" }, ctx.cwd);
	});
}

function compatGuide(packageRoot: string, index: string, interactive: boolean): string {
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
		`- To run independent dev-team agents in parallel, issue several ${DEV_TEAM_SUBAGENT_TOOL} calls in one message (or one call with tasks[]). The agent sees only its task text, so pass paths, diff ranges and scope markers explicitly.`,
		index ? `\nDev-team skills (load with the skill tool; "(/x)" = also a user command):\n${index}` : "",
	].join("\n");
}
