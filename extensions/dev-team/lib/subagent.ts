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
import type { Usage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { type AgentDef, DEV_TEAM_SUBAGENT_TOOL, discoverDispatchAgents, KNOWN_TIERS, mapTools, resolveAgentName, resolveModel, resolveThinking, shownModelId } from "./agents.ts";
import { DEFAULT_CONFIG, type DevTeamConfig } from "./config.ts";
import type { HookBridge } from "./hooks.ts";
import { applyChildEvent, type ChildEvent, newChildRunState } from "./child-run.ts";
import { Semaphore } from "./semaphore.ts";
import { recentCallLines, renderSubagentCall, renderSubagentResult, waitingText } from "./subagent-render.ts";
import {
	type AgentSource,
	type DispatchArgs,
	describeWorktree,
	dispatchAgent,
	dispatchTask,
	emptyPiUsage,
	isWaitingForSlot,
	type NestedUsage,
	type ProgressPatch,
	type SubagentDetails,
	type SubagentTaskView,
	sumPiUsage,
	toUsageTotals,
	type UsageTotals,
	type WorktreeInfo,
} from "./subagent-types.ts";
import { saveFullOutput } from "./session-files.ts";
import { discoverSkillPool, namedSkills, type SkillDef, skillIndex } from "./skills.ts";
import { buildTranscriptLines, type PiMessageLike, writeTranscript } from "./transcript.ts";
import { toSpacedSingleLine } from "./terminal-text.ts";
import { type ChildTrust, childTrusted, childTrustOf, trustArgs } from "./trust.ts";

export interface SubagentRunResult {
	agent: string;
	source?: AgentSource;
	task: string;
	ok: boolean;
	output: string;
	/** Where the complete output was saved when it is longer than the tool result may carry. */
	fullOutputFile?: string;
	error?: string;
	model?: string;
	tier?: string;
	stopReason?: string;
	/** The child's own turns. */
	usage: UsageTotals;
	/** Agents the child dispatched itself (any depth), credited to those agents. */
	nested: NestedUsage[];
	/** Everything the child cost, nested dispatches included, in pi's Usage shape for the tool result. */
	totalUsage?: Usage;
	messages: PiMessageLike[];
	worktree?: WorktreeInfo;
	blocked?: boolean;
	durationMs: number;
}

const TASK_PREVIEW_CHARS = 400;
/** Characters (code points) of a parallel call's label the progress header shows. */
export const LABEL_CHARS = 80;
const STATUS_LINE_CALLS = 3;

const OUTPUT_CAP = 50 * 1024;

/**
 * The label a parallel call's progress header shows: its own `description`, on one line, capped by
 * code points. A single dispatch shows its agent and task instead, so it has none.
 */
export function dispatchLabel(params: { tasks?: unknown[]; description?: unknown }): string | undefined {
	if (!params.tasks?.length || typeof params.description !== "string") return undefined;
	return Array.from(toSpacedSingleLine(params.description).trim()).slice(0, LABEL_CHARS).join("").trim() || undefined;
}

/**
 * The slot limit from `maxParallelAgents`: a whole number of at least 1. A project's own config can
 * set it, so anything else (text, NaN, 0.5) falls back to the default instead of blocking every slot.
 */
export function parallelLimit(value: unknown): number {
	return typeof value === "number" && Number.isInteger(value) && value >= 1 ? value : DEFAULT_CONFIG.maxParallelAgents;
}

/**
 * Wait for a slot while `update` reports the place in line, then report the start: the place is
 * cleared, and the agent's clock and its first model step start. Returns the slot's release, also
 * when that report throws: a view that fails to update must not keep the slot from its owner. When
 * `signal` aborted during the wait (Esc), the slot is given back at once and undefined is returned,
 * so no worktree or child is made for a dispatch already cancelled.
 */
export async function acquireSlot(
	semaphore: Semaphore,
	update: (patch: Pick<ProgressPatch, "queuePosition" | "slotGrantedAt" | "stepStartedAt">) => void,
	opts: { signal?: AbortSignal; readClock?: () => number } = {},
): Promise<(() => void) | undefined> {
	const release = await semaphore.acquire((position) => update({ queuePosition: position }));
	if (opts.signal?.aborted) {
		release();
		return undefined;
	}
	const now = (opts.readClock ?? Date.now)();
	try {
		update({ queuePosition: undefined, slotGrantedAt: now, stepStartedAt: now });
	} catch {
		// view only
	}
	return release;
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

/** The one rule for when a child's output is too long to return whole. */
export function isOversized(text: string): boolean {
	return Buffer.byteLength(text, "utf8") > OUTPUT_CAP;
}

/** The first OUTPUT_CAP bytes, cut on a character boundary. */
function cutOutput(text: string): string {
	return Buffer.from(text, "utf8").subarray(0, OUTPUT_CAP).toString("utf8").replace(/\uFFFD$/, "");
}

/** The output as the model gets it: cut when oversized, with where to read the complete text. */
export function outputForModel(text: string, fullOutputFile?: string): string {
	if (!isOversized(text)) return text;
	const fullOutputNote = fullOutputFile ? `; the complete output is in ${fullOutputFile} (read it with offset/limit)` : "";
	return `${cutOutput(text)}\n\n[output truncated at ${OUTPUT_CAP} bytes${fullOutputNote}]`;
}

/** The output as the TUI shows it: cut when oversized, naming the file without instructions for the model. */
export function outputForView(text: string, fullOutputFile?: string): string {
	if (!isOversized(text)) return text;
	return `${cutOutput(text)}\n\n[output truncated at ${OUTPUT_CAP} bytes${fullOutputFile ? `; complete output: ${fullOutputFile}` : ""}]`;
}

function git(cwd: string, args: string[]): { ok: boolean; out: string } {
	const r = spawnSync("git", args, { cwd, encoding: "utf-8" });
	return { ok: r.status === 0, out: `${r.stdout ?? ""}${r.stderr ?? ""}`.trim() };
}

function createWorktree(cwd: string, agent: string, id: string): { path: string; branch: string; base: string; repoRoot: string } {
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
	return { path: wtPath, branch, base: base.out.split("\n")[0], repoRoot: root };
}

function finishWorktree(wt: { path: string; branch: string; base: string }): WorktreeInfo {
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
	description: Type.Optional(
		Type.String({ description: 'Short 3-5 word label. On a call with `tasks`, the progress view shows it, e.g. "code-review round 2/4"' }),
	),
	tasks: Type.Optional(
		Type.Array(Type.Object(TaskFields), {
			description: "Run several agents concurrently. Each item has the same fields as a single dispatch.",
		}),
	),
});

export function registerSubagentTool(deps: SubagentDeps): void {
	const { pi, packageRoot, getConfig, hooks } = deps;
	const semaphore = new Semaphore(parallelLimit(getConfig().maxParallelAgents));

	async function runOne(
		input: DispatchArgs,
		ctx: ExtensionContext,
		signal: AbortSignal | undefined,
		agents: Map<string, AgentDef>,
		update: (patch: ProgressPatch) => void,
		trust: ChildTrust,
	): Promise<SubagentRunResult> {
		const started = Date.now();
		const config = getConfig();
		const requested = dispatchAgent(input);
		let task = dispatchTask(input);
		const empty = toUsageTotals(emptyPiUsage(), 0);
		const fail = (error: string, extra: Partial<SubagentRunResult> = {}): SubagentRunResult => ({
			agent: requested || "(none)",
			task,
			ok: false,
			output: "",
			error,
			usage: empty,
			nested: [],
			messages: [],
			durationMs: Date.now() - started,
			...extra,
		});
		if (!requested || !task) return fail("Both `agent` and `task` are required.");
		const def = resolveAgentName(agents, requested);
		if (!def) {
			return fail(`Unknown agent "${requested}". Available: ${[...agents.keys()].sort().join(", ")}`);
		}
		update({ agent: def.name, source: def.source });

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
			{ matchTarget: "Agent" },
		);
		if (pre.block) return fail(`Dispatch blocked by hook:\n${pre.block}`, { agent: def.name, blocked: true });
		if (pre.updatedInput) {
			if (typeof pre.updatedInput.prompt === "string") task = pre.updatedInput.prompt;
			if (typeof pre.updatedInput.additionalContext === "string") task = `${task}\n\n${pre.updatedInput.additionalContext}`;
		}

		const release = await acquireSlot(semaphore, update, { signal });
		if (!release) throw new Error(`Subagent ${def.name} was aborted`);
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

			// Project skills only from a directory the child itself is trusted in.
			const skillPool = discoverSkillPool(config, runCwd, packageRoot, childTrusted(trust, runCwd, wt?.repoRoot));
			const prompt = buildSystemPrompt(def, packageRoot, mapping?.scopedBash ?? [], mapping?.unmapped ?? [], skillPool, config.skillIndexChars);
			const promptFile = path.join(tmpDir, `agent-${def.name}.md`);
			fs.writeFileSync(promptFile, prompt, { encoding: "utf-8", mode: 0o600 });

			const args = ["--mode", "json", "-p", "--no-session", ...forwardedArgs()];
			args.push(...trustArgs(trust, runCwd, wt?.repoRoot));
			if (choice.model) args.push("--model", choice.model);
			if (thinking) args.push("--thinking", thinking);
			if (tools) args.push("--tools", tools.length ? tools.join(",") : "read");
			args.push("--append-system-prompt", promptFile);
			args.push(`--${AGENT_PROMPT_FLAG}`, AGENT_PROMPT_FLAG_VALUE);
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

			const run = newChildRunState(choice.model);
			let stderr = "";
			let aborted = false;
			let timedOut = false;

			const exitCode = await new Promise<number>((resolve) => {
				const inv = getPiInvocation(args);
				const proc = spawn(inv.command, inv.args, { cwd: runCwd, env, shell: false, stdio: ["ignore", "pipe", "pipe"] });
				let buf = "";
				const onLine = (line: string) => {
					if (!line.trim()) return;
					let ev: ChildEvent;
					try {
						ev = JSON.parse(line);
					} catch {
						return;
					}
					const patch = applyChildEvent(run, ev);
					try {
						if (patch) update(patch);
					} catch {
						/* a view that fails to update must not stop the run */
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
			const output = finalText(run.messages);
			const fullOutputFile = isOversized(output) ? saveFullOutput(sessionId, def.name, agentId, output) : undefined;
			const ok = exitCode === 0 && !aborted && !timedOut && run.stopReason !== "error" && run.stopReason !== "aborted";
			const result: SubagentRunResult = {
				agent: def.name,
				source: def.source,
				task,
				ok,
				output,
				fullOutputFile,
				error: ok
					? undefined
					: timedOut
						? `timed out after ${config.subagentTimeoutSec}s`
						: aborted
							? "aborted"
							: run.errorMessage || stderr.trim().slice(-4000) || `exit code ${exitCode}`,
				model: run.model,
				tier: choice.tier,
				stopReason: run.stopReason,
				usage: toUsageTotals(run.own, run.turns),
				nested: run.nested,
				totalUsage: run.turns ? run.total : undefined,
				messages: run.messages,
				worktree,
				durationMs: Date.now() - started,
			};

			// SubagentStop with a synthetic Claude-format transcript.
			try {
				const lines = buildTranscriptLines({ agentName: def.name, agentId, sessionId, cwd: runCwd, prompt: task, messages: run.messages });
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
		// Children run with their own tools (edit, write, bash) and call a model provider.
		annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
		parameters: SubagentParams,
		prepareArguments: (raw: unknown) => {
			const a = (raw ?? {}) as Record<string, unknown>;
			// Claude Agent/Task aliases, resolved once here by the same rule the tool uses everywhere.
			const norm = (t: Record<string, unknown>) => ({ ...t, agent: dispatchAgent(t as DispatchArgs), task: dispatchTask(t as DispatchArgs) });
			const out: Record<string, unknown> = norm(a);
			if (Array.isArray(a.tasks)) out.tasks = a.tasks.map((t) => norm((t ?? {}) as Record<string, unknown>));
			return out as never;
		},
		async execute(_id, params, signal, onUpdate, ctx) {
			semaphore.limit = parallelLimit(getConfig().maxParallelAgents);
			if (deps.depth >= getConfig().maxSubagentDepth) {
				throw new Error(`Subagent nesting limit reached (maxSubagentDepth=${getConfig().maxSubagentDepth}).`);
			}
			const list = (params.tasks?.length ? params.tasks : [params]) as DispatchArgs[];
			// Project agents are skipped only when the user declined pi's own trust prompt for this
			// project, as pi skips its other project resources. No extra prompt or setup step.
			// One trust decision per call, shared by every child.
			const trust = childTrustOf(ctx);
			const { agents, skippedProjectAgents } = discoverDispatchAgents(ctx.cwd, packageRoot, trust.projectTrusted, list.map(dispatchAgent));
			const progress = new DispatchProgress(list, skippedProjectAgents, onUpdate as DispatchUpdate | undefined, { label: dispatchLabel(params) });
			const results = await Promise.all(
				list.map(async (t, i) => {
					const r = await runOne(t, ctx, signal, agents, (patch) => progress.update(i, patch), trust);
					progress.finish(i, r);
					return r;
				}),
			);
			const usage = sumPiUsage(results.map((r) => r.totalUsage));
			const isKnownModel = (id: string) => {
				const [provider, ...rest] = id.split("/");
				return !!ctx.modelRegistry?.find(provider, rest.join("/"));
			};
			return {
				content: [{ type: "text", text: formatResultText(results, skippedProjectAgents, isKnownModel) }],
				details: progress.snapshot(),
				...(usage ? { usage } : {}),
				...(results.length === 1 && !results[0].ok ? { isError: true } : {}),
			};
		},
		renderCall: (args, theme) => renderSubagentCall(args as DispatchArgs & { tasks?: DispatchArgs[] }, theme),
		renderResult: (result, options, theme, context) => renderSubagentResult(result, options, theme, context),
	});
}

/** Live per-task views for the TUI, streamed through onUpdate while children run. */
export type DispatchUpdate = (r: { content: { type: "text"; text: string }[]; details: SubagentDetails }) => void;

export class DispatchProgress {
	private readonly views: SubagentTaskView[];
	private readonly skippedProjectAgents: string[];
	private readonly onUpdate: DispatchUpdate | undefined;
	private readonly dispatchStartedAt: number;
	private readonly label: string | undefined;
	constructor(
		list: DispatchArgs[],
		skippedProjectAgents: string[],
		onUpdate: DispatchUpdate | undefined,
		{ label, now = Date.now() }: { label?: string; now?: number } = {},
	) {
		this.skippedProjectAgents = skippedProjectAgents;
		this.onUpdate = onUpdate;
		this.dispatchStartedAt = now;
		this.label = label;
		this.views = list.map((t) => ({
			agent: dispatchAgent(t) || "(none)",
			task: dispatchTask(t).slice(0, TASK_PREVIEW_CHARS),
			status: "running",
			ok: false,
			turns: 0,
			recentCalls: [],
		}));
		this.emit();
	}
	snapshot(): SubagentDetails {
		return {
			results: this.views.map((v) => ({ ...v, recentCalls: [...v.recentCalls] })),
			dispatchStartedAt: this.dispatchStartedAt,
			...(this.label ? { label: this.label } : {}),
			...(this.skippedProjectAgents.length ? { skippedProjectAgents: this.skippedProjectAgents } : {}),
		};
	}
	update(taskIndex: number, patch: ProgressPatch): void {
		this.views[taskIndex] = { ...this.views[taskIndex], ...patch };
		this.emit();
	}
	finish(taskIndex: number, result: SubagentRunResult): void {
		this.views[taskIndex] = { ...withoutLiveFields(this.views[taskIndex]), ...viewFromResult(result) };
		this.emit();
	}
	private emit(): void {
		this.onUpdate?.({ content: [{ type: "text", text: this.views.map(statusLine).join("\n") }], details: this.snapshot() });
	}
}

function statusLine(v: SubagentTaskView): string {
	if (v.status !== "running") return `${v.agent}: ${v.status}`;
	if (isWaitingForSlot(v)) return `${v.agent}: ${waitingText(v.queuePosition)}`;
	const callLines = recentCallLines(v);
	const callsText = callLines.length ? ` → ${callLines.slice(-STATUS_LINE_CALLS).join(", ")}` : "";
	return `${v.agent}: turn ${v.turns}${callsText}`;
}

/**
 * A finished view keeps nothing that only a running agent has: its live subagents, its place in
 * line, its model step, and the executing marks of calls that never reported their end (the child
 * was stopped). Its slotGrantedAt stays, as when it started.
 */
export function withoutLiveFields(view: SubagentTaskView): SubagentTaskView {
	return {
		...view,
		recentCalls: view.recentCalls.map(({ runningSince: _, ...call }) => call),
		subagents: undefined,
		queuePosition: undefined,
		stepStartedAt: undefined,
	};
}

export function viewFromResult(r: SubagentRunResult): Partial<SubagentTaskView> {
	return {
		agent: r.agent,
		source: r.source,
		status: r.ok ? "ok" : "failed",
		ok: r.ok,
		model: r.model,
		tier: r.tier,
		turns: r.usage.turns,
		usage: r.usage,
		nested: r.nested.length ? r.nested : undefined,
		durationMs: r.durationMs,
		stopReason: r.stopReason,
		error: r.error,
		output: r.output ? outputForView(r.output, r.fullOutputFile) : undefined,
		worktree: r.worktree,
	};
}

/**
 * "provider/id, tier sonnet", or just the model when the dispatch named no tier (`inherit` or an
 * explicit provider/id): how a result names what it ran on. Both can come from a project's config
 * (a model pi rejected before the child reported its own), so only a model id and a known tier show.
 */
function modelTierLabel(r: Pick<SubagentRunResult, "model" | "tier">, isKnownModel?: (id: string) => boolean): string {
	return `${shownModelId(r.model, isKnownModel)}${r.tier && KNOWN_TIERS.includes(r.tier) ? `, tier ${r.tier}` : ""}`;
}

/** The model-facing result text (the TUI draws `details` instead). */
/** `isKnownModel` limits the model ids named to the ones pi's catalog has, as the Agent tiers line does. */
export function formatResultText(results: SubagentRunResult[], skippedProjectAgents: string[], isKnownModel?: (id: string) => boolean): string {
	const skipped = skippedProjectAgents.length
		? `\n\n[project agents not run (project not trusted): ${skippedProjectAgents.join(", ")}. You declined trust for this project in pi; package agents were used where they exist.]`
		: "";
	if (results.length === 1) {
		const r = results[0];
		const wt = r.worktree ? `\n\n[worktree ${describeWorktree(r.worktree)}]` : "";
		// Same model note as a parallel section's head; /build's stronger-tier retry reads it.
		const modelNote = r.model ? `\n\n[model ${modelTierLabel(r, isKnownModel)}]` : "";
		return `${r.ok ? outputForModel(r.output || "(no output)", r.fullOutputFile) : `Agent ${r.agent} failed: ${r.error}`}${wt}${modelNote}${skipped}`;
	}
	const section = (r: SubagentRunResult) => {
		const head = `### ${r.agent} — ${r.ok ? "completed" : "failed"}${r.model ? ` (${modelTierLabel(r, isKnownModel)})` : ""}`;
		const body = r.ok
			? outputForModel(r.output || "(no output)", r.fullOutputFile)
			: `Error: ${r.error}${r.output ? `\n\nLast output:\n${outputForModel(r.output, r.fullOutputFile)}` : ""}`;
		const wt = r.worktree ? `\n\nWorktree: ${describeWorktree(r.worktree)}` : "";
		return `${head}\n\n${body}${wt}`;
	};
	return `${results.filter((r) => r.ok).length}/${results.length} agents succeeded\n\n${results.map(section).join("\n\n---\n\n")}${skipped}`;
}

/** Flag on a dispatched child: its appended prompt is an agent prompt (own skill list, placed after the shared guide). */
export const AGENT_PROMPT_FLAG = "dev-team-agent-prompt";
/** The flag's value. Explicit, because pi reads the token after an extension flag as its value. */
export const AGENT_PROMPT_FLAG_VALUE = "1";

/**
 * The child's appended system prompt: agent body, runtime notes and, when `skillPool` is given, an index
 * of only the skills the agent's instructions name (see namedSkills). The child's dev-team guide
 * leaves out the full skill index, so this short list is all a subagent pays for.
 */
export function buildSystemPrompt(
	def: AgentDef,
	packageRoot: string,
	scopedBash: string[],
	unmapped: string[],
	skillPool?: Map<string, SkillDef>,
	skillIndexChars = DEFAULT_CONFIG.skillIndexChars,
): string {
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
	if (skillPool) {
		runtime.push(
			`Other dev-team skills: load any by name with the skill tool; the names are the folders in ${packageRoot}/skills.`,
		);
	}
	parts.push(`## Runtime (pi port of dev-team)\n\n${runtime.map((r) => `- ${r}`).join("\n")}`);
	const named = skillPool ? namedSkills(skillPool, def.skills, def.body) : undefined;
	if (named?.size) parts.push(`Dev-team skills your instructions name (load with the skill tool):\n${skillIndex(named, "compact", skillIndexChars)}`);
	return `${parts.join("\n\n")}\n`;
}
