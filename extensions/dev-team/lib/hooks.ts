/**
 * Hook bridge: runs the upstream Claude Code hook scripts (hooks/*.py, wired by hooks/hooks.json)
 * from pi events.
 *
 * Input contract (what the scripts read, see PORTING.md): one JSON object on stdin with
 *   hook_event_name, session_id, cwd, transcript_path, tool_name, tool_input, tool_response, prompt
 * Output contract:
 *   exit 2                       -> block (reason = stdout + stderr)
 *   exit 0 + JSON on stdout      -> hookSpecificOutput.updatedInput / additionalContext,
 *                                   {"decision":"block","reason"}, permissionDecision "deny", systemMessage
 *   exit 0 + text on stdout      -> advisory (context for SessionStart/UserPromptSubmit, tool-result note otherwise)
 *   exit 0 + stderr only         -> user notice
 *   anything else / timeout      -> ignored (fail-open), like Claude Code for non-2 exits
 */
import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { DEV_TEAM_SUBAGENT_TOOL } from "./agents.ts";
import { type DevTeamConfig, isHookEnabled } from "./config.ts";

export type ClaudeEvent =
	| "SessionStart"
	| "UserPromptSubmit"
	| "PreToolUse"
	| "PostToolUse"
	| "Stop"
	| "SubagentStop"
	| "SessionEnd";

export interface HookSpec {
	event: ClaudeEvent;
	matcher?: RegExp;
	name: string;
	script: string;
}

export interface HookRun {
	name: string;
	code: number | null;
	stdout: string;
	stderr: string;
	timedOut: boolean;
	json?: Record<string, unknown>;
}

export interface HookOutcome {
	block?: string;
	/** Advisory text meant for the model. */
	advisories: string[];
	/** Text meant only for the user. */
	notices: string[];
	updatedInput?: Record<string, unknown>;
	runs: HookRun[];
}

/** pi tool name -> Claude Code tool name used by hooks.json matchers and hook scripts. */
export const PI_TO_CLAUDE_TOOL: Record<string, string> = {
	bash: "Bash",
	read: "Read",
	write: "Write",
	edit: "Edit",
	grep: "Grep",
	find: "Glob",
	ls: "LS",
	skill: "Skill",
	[DEV_TEAM_SUBAGENT_TOOL]: "Agent",
	ask_user: "AskUserQuestion",
	web_fetch: "WebFetch",
};

export function claudeToolName(piName: string): string {
	return PI_TO_CLAUDE_TOOL[piName] ?? piName;
}

function abs(cwd: string, p: unknown): string | undefined {
	if (typeof p !== "string" || !p) return undefined;
	const expanded = p.startsWith("~/") ? path.join(process.env.HOME ?? "", p.slice(2)) : p;
	return path.isAbsolute(expanded) ? expanded : path.resolve(cwd, expanded);
}

/** Build Claude's tool_input from pi tool arguments. */
export function toClaudeInput(piName: string, input: Record<string, unknown>, cwd: string): Record<string, unknown> {
	switch (piName) {
		case "write": {
			const file = abs(cwd, input.path);
			return { file_path: file, path: file, content: input.content };
		}
		case "edit": {
			const file = abs(cwd, input.path);
			const edits = Array.isArray(input.edits) ? (input.edits as { oldText?: string; newText?: string }[]) : [];
			if (!edits.length && typeof input.oldText === "string") edits.push({ oldText: input.oldText as string, newText: input.newText as string });
			return {
				file_path: file,
				path: file,
				old_string: edits.map((e) => e.oldText ?? "").join("\n"),
				new_string: edits.map((e) => e.newText ?? "").join("\n"),
				replace_all: false,
			};
		}
		case "read": {
			const file = abs(cwd, input.path);
			return { file_path: file, path: file, offset: input.offset, limit: input.limit };
		}
		case "grep":
			return { pattern: input.pattern, path: abs(cwd, input.path) ?? cwd, glob: input.glob };
		case "find":
			return { pattern: input.pattern, path: abs(cwd, input.path) ?? cwd };
		case "ls":
			return { path: abs(cwd, input.path) ?? cwd };
		case "bash":
			return { command: input.command, timeout: input.timeout };
		case "skill":
			return { skill: input.name, name: input.name, args: input.args ?? "" };
		case DEV_TEAM_SUBAGENT_TOOL:
			return {
				subagent_type: input.agent,
				prompt: input.task,
				description: input.description ?? "",
				model: input.model,
			};
		default:
			return { ...input };
	}
}

/** Apply a hook's updatedInput (Claude field names) back onto pi arguments, for the fields that have a clear mapping. */
export function applyUpdatedInput(piName: string, piInput: Record<string, unknown>, updated: Record<string, unknown>): void {
	if (piName === "bash" && typeof updated.command === "string") piInput.command = updated.command;
	if (piName === DEV_TEAM_SUBAGENT_TOOL) {
		if (typeof updated.prompt === "string") piInput.task = updated.prompt;
		if (typeof updated.additionalContext === "string" && typeof piInput.task === "string") {
			piInput.task = `${piInput.task}\n\n${updated.additionalContext}`;
		}
	}
	if ((piName === "write" || piName === "edit" || piName === "read") && typeof updated.file_path === "string") {
		piInput.path = updated.file_path;
	}
	if (piName === "write" && typeof updated.content === "string") piInput.content = updated.content;
}

function compileMatcher(m: unknown): RegExp | undefined {
	if (typeof m !== "string" || m === "" || m === "*") return undefined;
	try {
		return new RegExp(`^(?:${m})$`);
	} catch {
		return undefined;
	}
}

export function loadHookSpecs(packageRoot: string): HookSpec[] {
	const file = path.join(packageRoot, "hooks", "hooks.json");
	let data: { hooks?: Record<string, { matcher?: string; hooks?: { command?: string }[] }[]> };
	try {
		data = JSON.parse(fs.readFileSync(file, "utf-8"));
	} catch {
		return [];
	}
	const specs: HookSpec[] = [];
	for (const [event, groups] of Object.entries(data.hooks ?? {})) {
		for (const group of groups ?? []) {
			const matcher = compileMatcher(group.matcher);
			for (const h of group.hooks ?? []) {
				const scripts = [...String(h.command ?? "").matchAll(/hooks\/([\w.-]+\.py)/g)].map((m) => m[1]);
				const script = scripts[scripts.length - 1];
				if (!script) continue;
				specs.push({
					event: event as ClaudeEvent,
					matcher,
					name: script.replace(/\.py$/, ""),
					script: path.join(packageRoot, "hooks", script),
				});
			}
		}
	}
	return specs;
}

let cachedPython: string | null | undefined;
export function resolvePython(): string | null {
	if (cachedPython !== undefined) return cachedPython;
	const candidates = [process.env.DEV_TEAM_PYTHON, "python3", "python"].filter((c): c is string => !!c);
	for (const c of candidates) {
		const r = spawnSync(c, ["-c", "import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)"], { stdio: "ignore" });
		if (r.status === 0) {
			cachedPython = c;
			return c;
		}
	}
	cachedPython = null;
	return null;
}

export class HookBridge {
	private specs: HookSpec[];
	private readonly packageRoot: string;
	private readonly getConfig: () => DevTeamConfig;
	readonly python: string | null;

	constructor(packageRoot: string, getConfig: () => DevTeamConfig) {
		this.packageRoot = packageRoot;
		this.getConfig = getConfig;
		this.specs = loadHookSpecs(packageRoot);
		this.python = resolvePython();
	}

	get all(): HookSpec[] {
		return this.specs;
	}

	select(event: ClaudeEvent, claudeTool?: string): HookSpec[] {
		const config = this.getConfig();
		if (!this.python) return [];
		const seen = new Set<string>();
		return this.specs.filter((s) => {
			if (s.event !== event) return false;
			if (claudeTool !== undefined && s.matcher && !s.matcher.test(claudeTool)) return false;
			if (!isHookEnabled(config, s.name)) return false;
			// the same script registered twice for one event+tool (e.g. telemetry) runs once
			const key = s.name;
			if (seen.has(key)) return false;
			seen.add(key);
			return true;
		});
	}

	private runOne(spec: HookSpec, payload: Record<string, unknown>, cwd: string, extraEnv: Record<string, string>): Promise<HookRun> {
		const config = this.getConfig();
		return new Promise((resolve) => {
			const run: HookRun = { name: spec.name, code: null, stdout: "", stderr: "", timedOut: false };
			let proc: ReturnType<typeof spawn>;
			try {
				proc = spawn(this.python as string, [spec.script], {
					cwd: fs.existsSync(cwd) ? cwd : undefined,
					env: {
						...process.env,
						...config.env,
						CLAUDE_PLUGIN_ROOT: this.packageRoot,
						CLAUDE_PROJECT_DIR: cwd,
						...extraEnv,
					},
					stdio: ["pipe", "pipe", "pipe"],
				});
			} catch {
				resolve(run);
				return;
			}
			const timer = setTimeout(() => {
				run.timedOut = true;
				proc.kill("SIGKILL");
			}, Math.max(1, config.hooks.timeoutSec) * 1000);
			proc.stdout?.on("data", (d) => {
				run.stdout += d.toString();
			});
			proc.stderr?.on("data", (d) => {
				run.stderr += d.toString();
			});
			proc.on("error", () => {
				clearTimeout(timer);
				resolve(run);
			});
			proc.on("close", (code) => {
				clearTimeout(timer);
				run.code = code;
				const trimmed = run.stdout.trim();
				if (trimmed.startsWith("{")) {
					try {
						run.json = JSON.parse(trimmed);
					} catch {
						/* plain text */
					}
				}
				resolve(run);
			});
			proc.stdin?.on("error", () => {});
			proc.stdin?.end(JSON.stringify(payload));
		});
	}

	/** Run one hook script by name regardless of hooks.json wiring or the disabled list (e.g. post_format). */
	async runScript(name: string, event: ClaudeEvent, payload: Record<string, unknown>, cwd: string): Promise<HookOutcome> {
		const script = path.join(this.packageRoot, "hooks", `${name}.py`);
		if (!this.python || !fs.existsSync(script)) return { advisories: [], notices: [], runs: [] };
		return this.execute([{ event, name, script }], event, payload, cwd, {});
	}

	async run(
		event: ClaudeEvent,
		payload: Record<string, unknown>,
		cwd: string,
		opts: { claudeTool?: string; extraEnv?: Record<string, string> } = {},
	): Promise<HookOutcome> {
		return this.execute(this.select(event, opts.claudeTool), event, payload, cwd, opts);
	}

	private async execute(
		specs: HookSpec[],
		event: ClaudeEvent,
		payload: Record<string, unknown>,
		cwd: string,
		opts: { extraEnv?: Record<string, string> },
	): Promise<HookOutcome> {
		const outcome: HookOutcome = { advisories: [], notices: [], runs: [] };
		if (!specs.length) return outcome;
		const full = { hook_event_name: event, ...payload };
		const runs = await Promise.all(specs.map((s) => this.runOne(s, full, cwd, opts.extraEnv ?? {})));
		outcome.runs = runs;
		const blocks: string[] = [];
		for (const r of runs) {
			if (r.timedOut) continue;
			const out = r.stdout.trim();
			const err = r.stderr.trim();
			if (r.code === 2) {
				const reason = [...new Set([out, err].filter(Boolean))].join("\n") || `${r.name} blocked this action.`;
				blocks.push(`[${r.name}] ${reason}`);
				continue;
			}
			if (r.code !== 0) continue;
			if (r.json) {
				const j = r.json;
				const hso = (j.hookSpecificOutput ?? {}) as Record<string, unknown>;
				if (hso.updatedInput && typeof hso.updatedInput === "object") {
					outcome.updatedInput = { ...(outcome.updatedInput ?? {}), ...(hso.updatedInput as Record<string, unknown>) };
				}
				if (typeof hso.additionalContext === "string" && hso.additionalContext.trim()) {
					outcome.advisories.push(`[${r.name}] ${hso.additionalContext.trim()}`);
				}
				const deny = hso.permissionDecision === "deny" || j.decision === "block";
				const reason = (hso.permissionDecisionReason ?? j.reason ?? "") as string;
				if (deny) blocks.push(`[${r.name}] ${reason || "blocked"}`);
				if (typeof j.systemMessage === "string" && j.systemMessage.trim()) outcome.notices.push(j.systemMessage.trim());
				if (err) outcome.notices.push(`[${r.name}] ${err}`);
				continue;
			}
			if (out) outcome.advisories.push(`[${r.name}] ${out}`);
			if (err) outcome.notices.push(`[${r.name}] ${err}`);
		}
		if (blocks.length) outcome.block = blocks.join("\n\n");
		return outcome;
	}
}
