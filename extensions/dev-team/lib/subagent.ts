/**
 * `dev_team_subagent` tool — pi equivalent of Claude Code's Agent/Task tool for dev-team agents.
 *
 * Each dispatch runs a child `pi --mode json -p --no-session` process with:
 *   - the agent's markdown body appended to the system prompt
 *   - its Claude tool list mapped to pi tools (Glob -> find/ls, Agent -> dev_team_subagent, Skill -> skill, ...)
 *   - its model tier (opus/sonnet/haiku/fable) resolved through dev-team.json, default: inherit
 *   - its `effort` mapped to --thinking
 * Around each dispatch it fires the upstream hooks Claude Code would fire:
 *   PreToolUse(Agent) before (dispatch ledger for the PR gate), SubagentStop after
 *   (review-verdict ledger, completion guard, task metrics) with a synthetic Claude transcript.
 */
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { type AgentDef, DEV_TEAM_SUBAGENT_TOOL, discoverAgents, mapTools, resolveAgentName, resolveModel, resolveThinking } from "./agents.ts";
import type { DevTeamConfig } from "./config.ts";
import type { HookBridge } from "./hooks.ts";
import { buildTranscriptLines, type PiMessageLike, writeTranscript } from "./transcript.ts";

export interface UsageTotals {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	turns: number;
}

export interface SubagentRunResult {
	agent: string;
	task: string;
	ok: boolean;
	output: string;
	error?: string;
	model?: string;
	tier?: string;
	stopReason?: string;
	usage: UsageTotals;
	messages: PiMessageLike[];
	worktree?: { path: string; branch: string; kept: boolean; dirty: boolean; commits: number };
	blocked?: boolean;
	durationMs: number;
}

export const SUBAGENT_USAGE_ENTRY = "dev-team-subagent-usage";

const OUTPUT_CAP = 50 * 1024;

class Semaphore {
	private active = 0;
	private readonly queue: (() => void)[] = [];
	limit: number;
	constructor(limit: number) {
		this.limit = limit;
	}
	async acquire(): Promise<() => void> {
		if (this.active >= this.limit) await new Promise<void>((r) => this.queue.push(r));
		this.active++;
		return () => {
			this.active--;
			this.queue.shift()?.();
		};
	}
}

function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
	if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}
	const execName = path.basename(process.execPath).toLowerCase();
	if (!/^(node|bun)(\.exe)?$/.test(execName)) return { command: process.execPath, args };
	return { command: "pi", args };
}

/** CLI flags of the parent process that children must share to see the same resources. */
export function forwardedArgs(argv: string[] = process.argv.slice(2)): string[] {
	const out: string[] = [];
	const withValue = new Set(["-e", "--extension", "--skill", "--prompt-template", "--provider"]);
	const flags = new Set(["-ne", "--no-extensions", "--no-skills", "-ns", "--offline"]);
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (withValue.has(a) && i + 1 < argv.length) {
			let v = argv[i + 1];
			if (!v.includes(":") && (v.startsWith(".") || v.includes("/"))) v = path.resolve(v);
			out.push(a, v);
			i++;
		} else if (flags.has(a)) out.push(a);
	}
	return out;
}

function finalText(messages: PiMessageLike[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i];
		if (m.role !== "assistant" || !Array.isArray(m.content)) continue;
		const texts = (m.content as { type: string; text?: string }[]).filter((c) => c.type === "text").map((c) => c.text ?? "");
		if (texts.join("").trim()) return texts.join("\n");
	}
	return "";
}

function cap(text: string): string {
	if (Buffer.byteLength(text, "utf8") <= OUTPUT_CAP) return text;
	return `${text.slice(0, OUTPUT_CAP)}\n\n[output truncated at ${OUTPUT_CAP} bytes]`;
}

function git(cwd: string, args: string[]): { ok: boolean; out: string } {
	const r = spawnSync("git", args, { cwd, encoding: "utf-8" });
	return { ok: r.status === 0, out: `${r.stdout ?? ""}${r.stderr ?? ""}`.trim() };
}

function createWorktree(cwd: string, agent: string, id: string): { path: string; branch: string; base: string } {
	const top = git(cwd, ["rev-parse", "--show-toplevel"]);
	if (!top.ok) throw new Error(`isolation "worktree" needs a git repository: ${top.out}`);
	const root = top.out.split("\n")[0];
	const base = git(root, ["rev-parse", "HEAD"]);
	if (!base.ok) throw new Error(`isolation "worktree" needs at least one commit: ${base.out}`);
	const wtPath = path.join(root, ".claude", "worktrees", `${agent}-${id}`);
	const branch = `dev-team/${agent}-${id}`;
	fs.mkdirSync(path.dirname(wtPath), { recursive: true });
	// Branch from local HEAD (Claude Code's worktree.baseRef=head), so freshly written specs/plans are visible.
	const add = git(root, ["worktree", "add", "-b", branch, wtPath, "HEAD"]);
	if (!add.ok) throw new Error(`git worktree add failed: ${add.out}`);
	return { path: wtPath, branch, base: base.out.split("\n")[0] };
}

function finishWorktree(wt: { path: string; branch: string; base: string }): SubagentRunResult["worktree"] {
	// Runtime state the hooks write under .claude/ does not count as work.
	const status = git(wt.path, ["status", "--porcelain", "--", ".", ":(exclude).claude"]);
	const dirty = status.ok && status.out.length > 0;
	const count = git(wt.path, ["rev-list", "--count", `${wt.base}..HEAD`]);
	const commits = count.ok ? Number(count.out) || 0 : 0;
	if (!dirty && commits === 0) {
		git(wt.path, ["worktree", "remove", "--force", wt.path]);
		git(path.dirname(path.dirname(path.dirname(wt.path))), ["branch", "-D", wt.branch]);
		return { path: wt.path, branch: wt.branch, kept: false, dirty, commits };
	}
	return { path: wt.path, branch: wt.branch, kept: true, dirty, commits };
}

export interface SubagentDeps {
	pi: ExtensionAPI;
	packageRoot: string;
	getConfig: () => DevTeamConfig;
	hooks: HookBridge;
	depth: number;
	onUsage: (r: SubagentRunResult) => void;
}

interface TaskInput {
	agent?: string;
	subagent_type?: string;
	task?: string;
	prompt?: string;
	description?: string;
	model?: string;
	thinking?: string;
	cwd?: string;
	isolation?: string;
}

const TaskFields = {
	agent: Type.Optional(Type.String({ description: "Agent name (Claude: subagent_type), e.g. security-review, software-engineer, Explore" })),
	task: Type.Optional(Type.String({ description: "Full task prompt for the agent (Claude: prompt). The agent sees only this, not the conversation." })),
	description: Type.Optional(Type.String({ description: "Short 3-5 word label" })),
	model: Type.Optional(
		Type.String({ description: "Override model: a tier (opus|sonnet|haiku|fable|inherit) or provider/model-id" }),
	),
	thinking: Type.Optional(Type.String({ description: "Override thinking/effort level (low|medium|high|xhigh)" })),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent" })),
	isolation: Type.Optional(
		Type.String({ description: 'Set "worktree" to run the agent in a new git worktree branched from HEAD' }),
	),
};

export const SubagentParams = Type.Object({
	...TaskFields,
	tasks: Type.Optional(
		Type.Array(Type.Object(TaskFields), {
			description: "Run several agents concurrently. Each item has the same fields as a single dispatch.",
		}),
	),
});

export function registerSubagentTool(deps: SubagentDeps): void {
	const { pi, packageRoot, getConfig, hooks } = deps;
	const semaphore = new Semaphore(getConfig().maxParallelAgents);

	async function runOne(
		input: TaskInput,
		ctx: ExtensionContext,
		signal: AbortSignal | undefined,
		agents: Map<string, AgentDef>,
		progress: (text: string) => void,
	): Promise<SubagentRunResult> {
		const started = Date.now();
		const config = getConfig();
		const requested = (input.agent ?? input.subagent_type ?? "").trim();
		let task = (input.task ?? input.prompt ?? "").trim();
		const empty: UsageTotals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
		const fail = (error: string, extra: Partial<SubagentRunResult> = {}): SubagentRunResult => ({
			agent: requested || "(none)",
			task,
			ok: false,
			output: "",
			error,
			usage: empty,
			messages: [],
			durationMs: Date.now() - started,
			...extra,
		});
		if (!requested || !task) return fail("Both `agent` and `task` are required.");
		const def = resolveAgentName(agents, requested);
		if (!def) {
			return fail(`Unknown agent "${requested}". Available: ${[...agents.keys()].sort().join(", ")}`);
		}

		const sessionId = ctx.sessionManager.getSessionId();
		const baseCwd = input.cwd ? path.resolve(ctx.cwd, input.cwd) : ctx.cwd;

		// PreToolUse(Agent): dispatch ledger etc. (one per dispatch, as Claude fires one per Agent call)
		const pre = await hooks.run(
			"PreToolUse",
			{
				session_id: sessionId,
				cwd: baseCwd,
				transcript_path: ctx.sessionManager.getSessionFile() ?? "",
				tool_name: "Agent",
				tool_input: { subagent_type: def.name, prompt: task, description: input.description ?? "" },
			},
			baseCwd,
			{ claudeTool: "Agent" },
		);
		if (pre.block) return fail(`Dispatch blocked by hook:\n${pre.block}`, { agent: def.name, blocked: true });
		if (pre.updatedInput) {
			if (typeof pre.updatedInput.prompt === "string") task = pre.updatedInput.prompt;
			if (typeof pre.updatedInput.additionalContext === "string") task = `${task}\n\n${pre.updatedInput.additionalContext}`;
		}

		const release = await semaphore.acquire();
		let wt: ReturnType<typeof createWorktree> | undefined;
		const agentId = randomUUID().replace(/-/g, "").slice(0, 16);
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-dev-team-agent-"));
		try {
			const runCwd = input.isolation === "worktree" ? (wt = createWorktree(baseCwd, def.name, agentId.slice(0, 8))).path : baseCwd;

			const parentModel = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
			const choice = resolveModel(def.model, input.model, config.models, parentModel);
			const thinking = resolveThinking(def.effort, input.thinking, config.thinking, ctx.thinkingLevel);

			const available = pi.getAllTools().map((t) => t.name);
			const mapping = mapTools(def.claudeTools, available);
			let tools = mapping?.tools;
			if (tools && deps.depth + 1 >= config.maxSubagentDepth) tools = tools.filter((t) => t !== DEV_TEAM_SUBAGENT_TOOL);

			const prompt = buildSystemPrompt(def, packageRoot, mapping?.scopedBash ?? [], mapping?.unmapped ?? []);
			const promptFile = path.join(tmpDir, `agent-${def.name}.md`);
			fs.writeFileSync(promptFile, prompt, { encoding: "utf-8", mode: 0o600 });

			const args = ["--mode", "json", "-p", "--no-session", ...forwardedArgs()];
			if (ctx.isProjectTrusted()) args.push("--approve");
			if (choice.model) args.push("--model", choice.model);
			if (thinking) args.push("--thinking", thinking);
			if (tools) args.push("--tools", tools.length ? tools.join(",") : "read");
			args.push("--append-system-prompt", promptFile);
			args.push(`Task: ${task}`);

			const env: NodeJS.ProcessEnv = {
				...process.env,
				...config.env,
				DEV_TEAM_SUBAGENT: "1",
				DEV_TEAM_SUBAGENT_DEPTH: String(deps.depth + 1),
				DEV_TEAM_AGENT_NAME: def.name,
				DEV_TEAM_PARENT_SESSION_ID: sessionId,
			};
			delete env.DEV_TEAM_INTERACTIVE;

			const messages: PiMessageLike[] = [];
			const usage: UsageTotals = { ...empty };
			let stderr = "";
			let model: string | undefined = choice.model;
			let stopReason: string | undefined;
			let errorMessage: string | undefined;
			let aborted = false;
			let timedOut = false;

			const exitCode = await new Promise<number>((resolve) => {
				const inv = getPiInvocation(args);
				const proc = spawn(inv.command, inv.args, { cwd: runCwd, env, shell: false, stdio: ["ignore", "pipe", "pipe"] });
				let buf = "";
				const onLine = (line: string) => {
					if (!line.trim()) return;
					let ev: { type?: string; message?: PiMessageLike & { errorMessage?: string; provider?: string } };
					try {
						ev = JSON.parse(line);
					} catch {
						return;
					}
					if (ev.type === "message_end" && ev.message?.role === "assistant") {
						const m = ev.message;
						messages.push(m);
						usage.turns++;
						const u = (m.usage ?? {}) as { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; cost?: { total?: number } };
						usage.input += u.input ?? 0;
						usage.output += u.output ?? 0;
						usage.cacheRead += u.cacheRead ?? 0;
						usage.cacheWrite += u.cacheWrite ?? 0;
						usage.cost += u.cost?.total ?? 0;
						if (m.model) model = m.provider ? `${m.provider}/${m.model}` : m.model;
						if (m.stopReason) stopReason = m.stopReason;
						if (m.errorMessage) errorMessage = m.errorMessage;
						const calls = Array.isArray(m.content)
							? (m.content as { type: string; name?: string }[]).filter((c) => c.type === "toolCall").map((c) => c.name)
							: [];
						progress(`${def.name}: turn ${usage.turns}${calls.length ? ` → ${calls.join(", ")}` : ""}`);
					} else if ((ev.type === "message_end" || ev.type === "tool_result_end") && ev.message?.role === "toolResult") {
						messages.push(ev.message);
					}
				};
				proc.stdout.on("data", (d) => {
					buf += d.toString();
					const lines = buf.split("\n");
					buf = lines.pop() ?? "";
					for (const l of lines) onLine(l);
				});
				proc.stderr.on("data", (d) => {
					stderr += d.toString();
				});
				const kill = () => {
					proc.kill("SIGTERM");
					setTimeout(() => {
						if (!proc.killed) proc.kill("SIGKILL");
					}, 5000);
				};
				const timer =
					config.subagentTimeoutSec > 0
						? setTimeout(() => {
								timedOut = true;
								kill();
							}, config.subagentTimeoutSec * 1000)
						: undefined;
				proc.on("close", (code) => {
					if (timer) clearTimeout(timer);
					if (buf.trim()) onLine(buf);
					resolve(code ?? 0);
				});
				proc.on("error", (e) => {
					if (timer) clearTimeout(timer);
					stderr += String(e);
					resolve(1);
				});
				if (signal) {
					const onAbort = () => {
						aborted = true;
						kill();
					};
					if (signal.aborted) onAbort();
					else signal.addEventListener("abort", onAbort, { once: true });
				}
			});

			const worktree = wt ? finishWorktree(wt) : undefined;
			const output = finalText(messages);
			const ok = exitCode === 0 && !aborted && !timedOut && stopReason !== "error" && stopReason !== "aborted";
			const result: SubagentRunResult = {
				agent: def.name,
				task,
				ok,
				output,
				error: ok
					? undefined
					: timedOut
						? `timed out after ${config.subagentTimeoutSec}s`
						: aborted
							? "aborted"
							: errorMessage || stderr.trim().slice(-4000) || `exit code ${exitCode}`,
				model,
				tier: choice.tier,
				stopReason,
				usage,
				messages,
				worktree,
				durationMs: Date.now() - started,
			};

			// SubagentStop with a synthetic Claude-format transcript.
			try {
				const lines = buildTranscriptLines({ agentName: def.name, agentId, sessionId, cwd: runCwd, prompt: task, messages });
				const transcript = writeTranscript(sessionId, agentId, lines);
				await hooks.run(
					"SubagentStop",
					{
						session_id: sessionId,
						cwd: baseCwd,
						transcript_path: transcript,
						agent_transcript_path: transcript,
						agent_id: agentId,
						agent_type: `dev-team:${def.name}`,
						stop_hook_active: false,
					},
					baseCwd,
				);
			} catch {
				/* fail-open */
			}
			deps.onUsage(result);
			if (aborted) throw new Error(`Subagent ${def.name} was aborted`);
			return result;
		} catch (e) {
			if (e instanceof Error && e.message.endsWith("was aborted")) throw e;
			return fail(e instanceof Error ? e.message : String(e), { agent: def.name });
		} finally {
			release();
			fs.rmSync(tmpDir, { recursive: true, force: true });
		}
	}

	pi.registerTool({
		name: DEV_TEAM_SUBAGENT_TOOL,
		label: "Dev-team subagent",
		description: [
			"Dispatch a dev-team agent (Claude Code's Agent/Task tool) in an isolated pi process with its own context.",
			"The agent sees only `task`, so include every file path, diff range, scope marker and constraint it needs.",
			"For parallel work either call this tool several times in one message or pass `tasks`.",
			'Accepts Claude field names too: subagent_type (= agent), prompt (= task). isolation: "worktree" runs it on a new branch in its own git worktree.',
			"Agents: any file in the package agents/ directory (e.g. software-engineer, qa-engineer, architect, security-review, test-review, spec-compliance-review, plan-review-*), project .pi/agents or .claude/agents, plus Explore and general-purpose.",
		].join(" "),
		promptSnippet: "Dispatch dev-team agents (Claude Agent/Task tool equivalent)",
		parameters: SubagentParams,
		prepareArguments: (raw: unknown) => {
			const a = (raw ?? {}) as Record<string, unknown>;
			const norm = (t: Record<string, unknown>) => ({
				...t,
				agent: t.agent ?? t.subagent_type,
				task: t.task ?? t.prompt,
			});
			const out: Record<string, unknown> = norm(a);
			if (Array.isArray(a.tasks)) out.tasks = a.tasks.map((t) => norm((t ?? {}) as Record<string, unknown>));
			return out as never;
		},
		async execute(_id, params, signal, onUpdate, ctx) {
			semaphore.limit = Math.max(1, getConfig().maxParallelAgents);
			if (deps.depth >= getConfig().maxSubagentDepth) {
				throw new Error(`Subagent nesting limit reached (maxSubagentDepth=${getConfig().maxSubagentDepth}).`);
			}
			const agents = discoverAgents(ctx.cwd, packageRoot);
			const list = (params.tasks?.length ? params.tasks : [params]) as TaskInput[];
			const status = new Map<number, string>();
			const progress = (i: number) => (text: string) => {
				status.set(i, text);
				onUpdate?.({ content: [{ type: "text", text: [...status.values()].join("\n") }], details: undefined });
			};
			const results = await Promise.all(list.map((t, i) => runOne(t, ctx, signal, agents, progress(i))));

			const render = (r: SubagentRunResult) => {
				const head = `### ${r.agent} — ${r.ok ? "completed" : "failed"}${r.model ? ` (${r.model}${r.tier && r.tier !== "inherit" ? `, tier ${r.tier}` : ""})` : ""}`;
				const wtLine = r.worktree
					? `\n\nWorktree: ${r.worktree.kept ? `kept at ${r.worktree.path}, branch ${r.worktree.branch} (${r.worktree.commits} commit(s)${r.worktree.dirty ? ", uncommitted changes" : ""})` : "no changes, removed"}`
					: "";
				const body = r.ok ? cap(r.output || "(no output)") : `Error: ${r.error}${r.output ? `\n\nLast output:\n${cap(r.output)}` : ""}`;
				return `${head}\n\n${body}${wtLine}`;
			};
			const text =
				results.length === 1
					? (() => {
							const r = results[0];
							const wt = r.worktree
								? `\n\n[worktree ${r.worktree.kept ? `kept: ${r.worktree.path} on branch ${r.worktree.branch}, ${r.worktree.commits} commit(s)${r.worktree.dirty ? ", uncommitted changes" : ""}` : "removed: no changes"}]`
								: "";
							return r.ok ? `${cap(r.output || "(no output)")}${wt}` : `Agent ${r.agent} failed: ${r.error}${wt}`;
						})()
					: `${results.filter((r) => r.ok).length}/${results.length} agents succeeded\n\n${results.map(render).join("\n\n---\n\n")}`;
			const details = {
				results: results.map((r) => ({
					agent: r.agent,
					ok: r.ok,
					model: r.model,
					tier: r.tier,
					stopReason: r.stopReason,
					usage: r.usage,
					durationMs: r.durationMs,
					worktree: r.worktree,
					error: r.error,
				})),
			};
			const allFailed = results.every((r) => !r.ok);
			if (allFailed && results.length === 1) {
				return { content: [{ type: "text", text }], details, isError: true };
			}
			return { content: [{ type: "text", text }], details };
		},
	});
}

export function buildSystemPrompt(def: AgentDef, packageRoot: string, scopedBash: string[], unmapped: string[]): string {
	const parts = [def.body.trim()];
	const runtime: string[] = [
		`You are the dev-team agent "${def.name}", dispatched as a subagent. Your final message is returned to the dispatcher verbatim; make it the complete deliverable (for review agents: the JSON result exactly as your output contract specifies).`,
		`Plugin root: ${packageRoot} (also $CLAUDE_PLUGIN_ROOT in bash). Relative references like knowledge/X.md, skills/X/SKILL.md and scripts/X.py are under it.`,
		`Tool names: Read=read, Grep=grep, Glob=find, Bash=bash, Edit=edit, Write=write, Skill=skill, Agent/Task=${DEV_TEAM_SUBAGENT_TOOL}.`,
		`Use ${DEV_TEAM_SUBAGENT_TOOL} for dev-team dispatch, including instructions that say to use the subagent tool. Other extensions' subagent tools do not apply the dev-team tier mappings or dispatch hooks.`,
		"You run non-interactively: never wait for a human; where instructions ask the user, take the documented non-interactive default and report it.",
	];
	if (def.skills.length) {
		runtime.push(
			`Relevant skills for this dispatch (per your frontmatter \`skills:\` list): ${def.skills.join(", ")}. Load one with the skill tool (or read ${packageRoot}/skills/<name>/SKILL.md) when the task calls for it.`,
		);
	}
	if (scopedBash.length) runtime.push(`Only use bash for: ${scopedBash.join("; ")}.`);
	if (unmapped.length) runtime.push(`Unavailable in this runtime (fall back as your instructions describe): ${unmapped.join(", ")}.`);
	parts.push(`## Runtime (pi port of dev-team)\n\n${runtime.map((r) => `- ${r}`).join("\n")}`);
	return `${parts.join("\n\n")}\n`;
}
