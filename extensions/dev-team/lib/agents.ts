/**
 * Agent discovery and Claude Code -> pi mapping.
 *
 * Agent files keep their upstream Claude Code frontmatter unchanged:
 *   name, description, tools ("Read, Grep, Glob, ..."), model (opus|sonnet|haiku|fable|inherit|provider/id),
 *   effort (low|medium|high|...), skills (list), color, memory.
 * They are mapped to pi at dispatch time.
 *
 * Lookup order (first wins):
 *   <project>/.pi/agents, <project>/.claude/agents   (project overrides, e.g. /setup's activated templates)
 *   <package>/agents                                  (upstream dev-team agents + port-provided Explore/general-purpose)
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { readSmallFile } from "./safe-read.ts";
import type { AgentSource } from "./subagent-types.ts";

export const DEV_TEAM_SUBAGENT_TOOL = "dev_team_subagent";

export interface AgentDef {
	name: string;
	description: string;
	/** Raw Claude tool list from frontmatter (undefined = all default tools). */
	claudeTools?: string[];
	/** Tier name or explicit provider/model id. */
	model?: string;
	effort?: string;
	skills: string[];
	body: string;
	filePath: string;
	source: AgentSource;
}

type AgentFrontmatter = {
	name?: unknown;
	description?: unknown;
	tools?: unknown;
	model?: unknown;
	effort?: unknown;
	skills?: unknown;
};

/** Split a Claude tools string on top-level commas: "Read, Bash(npx playwright *), Grep". */
export function splitToolList(value: unknown): string[] | undefined {
	if (Array.isArray(value)) return value.filter((v): v is string => typeof v === "string").map((v) => v.trim());
	if (typeof value !== "string") return undefined;
	const out: string[] = [];
	let depth = 0;
	let cur = "";
	for (const ch of value) {
		if (ch === "(") depth++;
		if (ch === ")") depth = Math.max(0, depth - 1);
		if (ch === "," && depth === 0) {
			if (cur.trim()) out.push(cur.trim());
			cur = "";
		} else cur += ch;
	}
	if (cur.trim()) out.push(cur.trim());
	return out.length ? out : undefined;
}

function toStringList(value: unknown): string[] {
	if (Array.isArray(value)) return value.filter((v): v is string => typeof v === "string").map((v) => v.trim());
	if (typeof value === "string") return value.split(",").map((v) => v.trim()).filter(Boolean);
	return [];
}

export function parseAgentFile(filePath: string, source: AgentSource): AgentDef | undefined {
	let content = readSmallFile(filePath);
	if (content === undefined) return undefined;
	// Upstream files sometimes have a blank line right after the opening '---'.
	content = content.replace(/^---\r?\n\s*\r?\n/, "---\n");
	let frontmatter: AgentFrontmatter;
	let body: string;
	try {
		({ frontmatter, body } = parseFrontmatter<AgentFrontmatter>(content));
	} catch {
		return undefined;
	}
	if (typeof frontmatter.name !== "string" || typeof frontmatter.description !== "string") return undefined;
	return {
		name: frontmatter.name,
		description: frontmatter.description,
		claudeTools: splitToolList(frontmatter.tools),
		model: typeof frontmatter.model === "string" ? frontmatter.model.trim() : undefined,
		effort: typeof frontmatter.effort === "string" ? frontmatter.effort.trim() : undefined,
		skills: toStringList(frontmatter.skills),
		body,
		filePath,
		source,
	};
}

function loadDir(dir: string, source: AgentSource): AgentDef[] {
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return [];
	}
	const out: AgentDef[] = [];
	for (const e of entries) {
		if (!e.name.endsWith(".md") || !(e.isFile() || e.isSymbolicLink())) continue;
		const def = parseAgentFile(path.join(dir, e.name), source);
		if (def) out.push(def);
	}
	return out;
}

/** Project agents (.pi/agents, .claude/agents) first, then the package's. Pass `includeProject: ctx.isProjectTrusted()`. */
export function discoverAgents(cwd: string, packageRoot: string, opts: { includeProject: boolean }): Map<string, AgentDef> {
	return byName([...(opts.includeProject ? loadProjectAgents(cwd) : []), ...loadDir(path.join(packageRoot, "agents"), "package")]);
}

function loadProjectAgents(cwd: string): AgentDef[] {
	return [...loadDir(path.join(cwd, ".pi", "agents"), "project"), ...loadDir(path.join(cwd, ".claude", "agents"), "project")];
}

/** First definition of each name wins. */
function byName(defs: AgentDef[]): Map<string, AgentDef> {
	const map = new Map<string, AgentDef>();
	for (const d of defs) if (!map.has(d.name)) map.set(d.name, d);
	return map;
}

/** Requested agents that resolve to a project agent (.pi/agents, .claude/agents). */
export function projectAgentsRequested(agents: Map<string, AgentDef>, requested: string[]): AgentDef[] {
	const out = new Map<string, AgentDef>();
	for (const name of requested) {
		const def = resolveAgentName(agents, name);
		if (def?.source === "project") out.set(def.filePath, def);
	}
	return [...out.values()];
}

/**
 * Agents a dispatch may use. When pi reports the project untrusted (the user declined pi's trust
 * prompt or ran with --no-approve), project agents are dropped and `skippedProjectAgents` names the
 * requested ones, so the caller can say why they did not run. Each directory is read once.
 */
export function discoverDispatchAgents(
	cwd: string,
	packageRoot: string,
	projectTrusted: boolean,
	requested: string[],
): { agents: Map<string, AgentDef>; skippedProjectAgents: string[] } {
	const project = loadProjectAgents(cwd);
	const packaged = loadDir(path.join(packageRoot, "agents"), "package");
	const all = byName([...project, ...packaged]);
	if (projectTrusted) return { agents: all, skippedProjectAgents: [] };
	return { agents: byName(packaged), skippedProjectAgents: projectAgentsRequested(all, requested.filter(Boolean)).map((d) => d.name) };
}

/** Accept Claude-style qualified names ("dev-team:security-review") and case differences. */
export function resolveAgentName(agents: Map<string, AgentDef>, requested: string): AgentDef | undefined {
	const bare = requested.trim().replace(/^[\w-]+:/, "");
	if (agents.has(bare)) return agents.get(bare);
	const lower = bare.toLowerCase();
	for (const [name, def] of agents) if (name.toLowerCase() === lower) return def;
	return undefined;
}

const CLAUDE_TO_PI_TOOL: Record<string, string[]> = {
	read: ["read"],
	grep: ["grep"],
	glob: ["find", "ls"],
	ls: ["ls"],
	bash: ["bash"],
	edit: ["edit"],
	multiedit: ["edit"],
	write: ["write"],
	notebookedit: ["edit"],
	skill: ["skill"],
	agent: [DEV_TEAM_SUBAGENT_TOOL],
	task: [DEV_TEAM_SUBAGENT_TOOL],
	askuserquestion: ["ask_user"],
	webfetch: ["web_fetch"],
	todowrite: [],
	websearch: [],
};

export interface ToolMapping {
	tools: string[];
	/** Claude entries with no pi equivalent (reported, not fatal). */
	unmapped: string[];
	/** Scoped Bash grants like "Bash(npx playwright *)" — pi cannot scope bash; recorded for the prompt. */
	scopedBash: string[];
}

/** Rewrite a Claude-plugin MCP tool name to pi's `mcp__<server>__<tool>` naming. */
function normaliseMcpName(name: string): string {
	// Claude plugin-provided servers are named mcp__plugin_<plugin>_<server>__tool.
	const m = name.match(/^mcp__plugin_[^_]+(?:_[^_]+)*?_([^_]+)__(.+)$/);
	if (m) return `mcp__${m[1]}__${m[2]}`;
	return name;
}

function globToRegex(glob: string): RegExp {
	return new RegExp(`^${glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`);
}

/**
 * Map a Claude tool list to pi tool names.
 * @param available names of tools registered in the parent pi session (for MCP pattern expansion)
 */
export function mapTools(claudeTools: string[] | undefined, available: string[]): ToolMapping | undefined {
	if (!claudeTools) return undefined;
	const tools = new Set<string>();
	const unmapped: string[] = [];
	const scopedBash: string[] = [];
	for (const raw of claudeTools) {
		const entry = raw.trim();
		if (!entry) continue;
		if (entry.startsWith("mcp__")) {
			const re = globToRegex(normaliseMcpName(entry));
			const hits = available.filter((t) => re.test(t));
			for (const h of hits) tools.add(h);
			if (hits.length && available.includes("codemode")) tools.add("codemode");
			continue;
		}
		const scoped = entry.match(/^(\w+)\((.*)\)$/s);
		const base = (scoped ? scoped[1] : entry).toLowerCase();
		if (scoped && base === "bash") scopedBash.push(scoped[2]);
		const mapped = CLAUDE_TO_PI_TOOL[base];
		if (mapped === undefined) {
			// Already a pi tool name?
			if (available.includes(entry)) tools.add(entry);
			else unmapped.push(entry);
			continue;
		}
		for (const t of mapped) tools.add(t);
	}
	return { tools: [...tools], unmapped, scopedBash };
}

export interface ModelChoice {
	/** provider/id to pass to --model, or undefined to inherit. */
	model?: string;
	/** Tier label for reporting (opus/sonnet/haiku/...). */
	tier?: string;
}

/**
 * Resolve an agent's model. `override` (per call) beats frontmatter.
 * Tier names go through the config table; "inherit" or an unmapped tier inherits the parent's model.
 */
export function resolveModel(
	frontmatterModel: string | undefined,
	override: string | undefined,
	tiers: Record<string, string>,
	parentModel: string | undefined,
): ModelChoice {
	const wanted = (override || frontmatterModel || "inherit").trim();
	if (wanted.includes("/")) return { model: wanted };
	const tier = wanted.toLowerCase();
	if (tier === "inherit") return { model: parentModel, tier: "inherit" };
	const mapped = tiers[tier];
	if (!mapped || mapped === "inherit") return { model: parentModel, tier };
	return { model: mapped, tier };
}

/** The tiers agent frontmatter can name; the tier table of a config may hold nothing else that reaches the prompt. */
const KNOWN_TIERS = ["opus", "sonnet", "haiku", "fable"] as const;
/**
 * A provider/model-id that can go into the prompt: no whitespace or line breaks, quotes, backticks
 * or backslashes, so it cannot add a line or text of its own. Every id in pi's model catalog passes
 * (a test checks this).
 */
export const MODEL_ID_SHAPE = /^[^\s"'`\\/]{1,100}\/[^\s"'`\\]{1,200}$/;

/** A model id for the system prompt: as is when it has the shape of one, otherwise a placeholder (a project's config sets it). */
function shownModelId(id: string): string {
	return MODEL_ID_SHAPE.test(id) ? id : "(not a model id)";
}

/**
 * One guide line naming the model each tier resolves to in this session, so the orchestrator can tell
 * whether a dispatch at a stronger tier would run on a different model (see the /build port note).
 */
export function tierModelsLine(tiers: Record<string, string>, parentModel: string | undefined): string {
	const sessionModelLabel = parentModel && MODEL_ID_SHAPE.test(parentModel) ? `this session's model (${parentModel})` : "this session's model";
	const tierModelPairs = KNOWN_TIERS.filter((tier) => Object.hasOwn(tiers, tier)).map((tier) => {
		const model = resolveModel(tier, undefined, tiers, undefined).model;
		return `${tier} = ${model === undefined ? sessionModelLabel : shownModelId(model)}`;
	});
	return `Agent tiers (the model a dispatch with \`model: "<tier>"\` runs on): ${tierModelPairs.join(", ")}.`;
}

export function resolveThinking(
	effort: string | undefined,
	override: string | undefined,
	table: Record<string, string>,
	parentThinking: string | undefined,
): string | undefined {
	const wanted = (override || effort || "").trim().toLowerCase();
	if (!wanted) return parentThinking;
	return table[wanted] ?? parentThinking;
}
