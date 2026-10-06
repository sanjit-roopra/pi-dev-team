/**
 * dev-team skills as pi slash commands and as the `skill` tool (Claude Code's Skill tool).
 *
 * Claude Code semantics reproduced here:
 *   - `/name args` loads the skill body with `$ARGUMENTS`, `$ARGUMENTS[N]` and `$N` (0-based) substituted.
 *     If the body has no placeholder, the arguments are appended as "ARGUMENTS: ...".
 *   - Qualified names ("dev-team:plan") resolve to the bare skill.
 *   - Project skills (.pi/skills, .claude/skills) override package skills with the same name
 *     (e.g. the project-specific /pr that /setup generates).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { parseFrontmatter, stripFrontmatter } from "@earendil-works/pi-coding-agent";
import type { DevTeamConfig } from "./config.ts";
import { readSmallFile } from "./safe-read.ts";

export interface SkillDef {
	name: string;
	description: string;
	argumentHint?: string;
	userInvocable: boolean;
	filePath: string;
	baseDir: string;
	source: "project" | "package";
}

type SkillFrontmatter = {
	name?: unknown;
	description?: unknown;
	"argument-hint"?: unknown;
	"user-invocable"?: unknown;
};

function loadSkill(filePath: string, source: SkillDef["source"]): SkillDef | undefined {
	const content = readSmallFile(filePath);
	if (content === undefined) return undefined;
	let fm: SkillFrontmatter;
	try {
		fm = parseFrontmatter<SkillFrontmatter>(content).frontmatter;
	} catch {
		return undefined;
	}
	const dirName = path.basename(path.dirname(filePath));
	const name = typeof fm.name === "string" && fm.name.trim() ? fm.name.trim() : dirName;
	const description = typeof fm.description === "string" ? fm.description.replace(/\s+/g, " ").trim() : "";
	return {
		name,
		description,
		argumentHint: typeof fm["argument-hint"] === "string" ? fm["argument-hint"] : undefined,
		userInvocable: fm["user-invocable"] !== false,
		filePath,
		baseDir: path.dirname(filePath),
		source,
	};
}

function loadDir(dir: string, source: SkillDef["source"]): SkillDef[] {
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return [];
	}
	const out: SkillDef[] = [];
	for (const e of entries) {
		if (!e.isDirectory() && !e.isSymbolicLink()) continue;
		const file = path.join(dir, e.name, "SKILL.md");
		if (!fs.existsSync(file)) continue;
		const def = loadSkill(file, source);
		if (def) out.push(def);
	}
	return out;
}

/**
 * Project skills (.pi/skills, .claude/skills) first, then the package's. Project skills are
 * repo-supplied instructions, so pass `includeProject: ctx.isProjectTrusted()` as pi does for its own.
 */
export function discoverSkills(cwd: string, packageRoot: string, opts: { includeProject: boolean }): Map<string, SkillDef> {
	const map = new Map<string, SkillDef>();
	const add = (defs: SkillDef[]) => {
		for (const d of defs) if (!map.has(d.name)) map.set(d.name, d);
	};
	if (opts.includeProject) add(loadProjectSkills(cwd));
	add(loadDir(path.join(packageRoot, "skills"), "package"));
	return map;
}

function loadProjectSkills(cwd: string): SkillDef[] {
	return [...loadDir(path.join(cwd, ".pi", "skills"), "project"), ...loadDir(path.join(cwd, ".claude", "skills"), "project")];
}

/** First definition of each name wins. */
function byName(defs: SkillDef[]): Map<string, SkillDef> {
	const map = new Map<string, SkillDef>();
	for (const d of defs) if (!map.has(d.name)) map.set(d.name, d);
	return map;
}

/**
 * Skills a call may use. When pi reports the project untrusted, project skills are left out and
 * `skippedProjectSkills` names the requested ones that therefore cannot run. Unlike
 * skippedProjectAgents, a project skill that shadows a package skill is not listed: the package
 * skill runs instead, as pi does when it skips its own project skills.
 */
export function discoverInvocableSkills(
	cwd: string,
	packageRoot: string,
	projectTrusted: boolean,
	requested: string[],
): { skills: Map<string, SkillDef>; skippedProjectSkills: string[] } {
	const skills = discoverSkills(cwd, packageRoot, { includeProject: projectTrusted });
	if (projectTrusted) return { skills, skippedProjectSkills: [] };
	// Only the project directories are read again, to name what was left out.
	const projectOnly = byName(loadProjectSkills(cwd));
	const skippedProjectSkills = requested.filter((name) => !resolveSkillName(skills, name) && resolveSkillName(projectOnly, name));
	return { skills, skippedProjectSkills };
}

/** Why a skill cannot run now: the one wording for the skill tool and /commands. */
export function unavailableSkillReason(skippedForTrust: boolean): string {
	return skippedForTrust ? "is a project skill, and this project is not trusted in pi" : "can no longer be found (its SKILL.md is missing or unreadable)";
}

export function resolveSkillName(skills: Map<string, SkillDef>, requested: string): SkillDef | undefined {
	const bare = requested.trim().replace(/^\//, "").replace(/^[\w-]+:/, "");
	return skills.get(bare) ?? skills.get(bare.toLowerCase());
}

/** Shell-like split honoring single and double quotes. */
export function splitArgs(args: string): string[] {
	const out: string[] = [];
	let cur = "";
	let quote: string | null = null;
	let has = false;
	for (let i = 0; i < args.length; i++) {
		const ch = args[i];
		if (quote) {
			if (ch === quote) quote = null;
			else cur += ch;
			continue;
		}
		if (ch === '"' || ch === "'") {
			quote = ch;
			has = true;
			continue;
		}
		if (/\s/.test(ch)) {
			if (has || cur) out.push(cur);
			cur = "";
			has = false;
			continue;
		}
		cur += ch;
		has = true;
	}
	if (has || cur) out.push(cur);
	return out;
}

/** Claude Code argument substitution. */
export function substituteArguments(body: string, args: string): string {
	const positional = splitArgs(args);
	let used = false;
	let out = body.replace(/\$ARGUMENTS\[(\d+)\]/g, (_m, n: string) => {
		used = true;
		return positional[Number(n)] ?? "";
	});
	out = out.replace(/\$ARGUMENTS\b/g, () => {
		used = true;
		return args;
	});
	out = out.replace(/\$(\d)(?![\d\w])/g, (_m, n: string) => {
		used = true;
		return positional[Number(n)] ?? "";
	});
	if (!used && args.trim()) out = `${out.trimEnd()}\n\nARGUMENTS: ${args}`;
	return out;
}

/** The text a model sees when a skill is invoked (same wrapper pi uses for /skill:name). */
export function expandSkill(skill: SkillDef, args: string): string {
	// Read again with the same guard: the file may have changed since discovery.
	const raw = readSmallFile(skill.filePath);
	if (raw === undefined) throw new Error(`Skill "${skill.name}" can no longer be read: ${skill.filePath}`);
	const body = stripFrontmatter(raw).trim();
	const substituted = substituteArguments(body, args);
	const header = `References are relative to ${skill.baseDir}. \${CLAUDE_PLUGIN_ROOT} is set in the shell environment.`;
	return `<skill name="${skill.name}" location="${skill.filePath}">\n${header}\n\n${substituted}\n</skill>`;
}

export function commandText(skill: SkillDef, args: string): string {
	const invocation = `/${skill.name}${args.trim() ? ` ${args.trim()}` : ""}`;
	return `${expandSkill(skill, args)}\n\nThe user invoked \`${invocation}\`. Follow the skill above.`;
}

function truncate(text: string, max: number): string {
	if (text.length <= max) return text;
	const cut = text.slice(0, max);
	const dot = cut.lastIndexOf(". ");
	return (dot > max * 0.5 ? cut.slice(0, dot + 1) : `${cut.trimEnd()}…`).trim();
}

/** Skill index for the system prompt (Claude Code lists skills for its Skill tool the same way, budgeted). */
export function skillIndex(skills: Map<string, SkillDef>, mode: "compact" | "full", maxChars: number): string {
	const lines = [...skills.values()]
		.sort((a, b) => a.name.localeCompare(b.name))
		.map((s) => {
			const desc = mode === "full" ? s.description : truncate(s.description, maxChars);
			const cmd = s.userInvocable ? ` (/${s.name})` : "";
			return `- ${s.name}${cmd}: ${desc}`;
		});
	return lines.join("\n");
}

/**
 * The skills a subagent's instructions point to: its frontmatter `skills:`, every skill its body names
 * as `/name`, `/dev-team:name`, `skills/name` or `` `name` ``, and all project skills (the project's own
 * conventions, usually few). Subagents get this short list instead of the full index of ~90 skills
 * (21k characters in compact mode, about 5k tokens, on every turn of every dispatch); other skills
 * still load by name. Matching is loose on purpose: a path such as `src/build/` may add `build`, which
 * costs one line, while a missed skill costs the agent its instructions.
 */
export function namedSkills(skills: Map<string, SkillDef>, frontmatterSkills: readonly string[], body: string): Map<string, SkillDef> {
	const frontmatterNames = new Set(frontmatterSkills);
	// One pass over the body: longest names first, so `code-review` wins over a shorter prefix.
	const names = [...skills.keys()].sort((a, b) => b.length - a.length).map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
	const bodyNames = new Set<string>();
	if (names.length) {
		for (const m of body.matchAll(new RegExp(`(?:/(?:dev-team:)?|skills/|\`)(${names.join("|")})(?![\\w-])`, "g"))) bodyNames.add(m[1]);
	}
	const relevant = new Map<string, SkillDef>();
	for (const [name, def] of skills) {
		if (frontmatterNames.has(name) || bodyNames.has(name) || def.source === "project") relevant.set(name, def);
	}
	return relevant;
}

/**
 * The skill map an agent prompt lists from (see namedSkills), or undefined when `skillIndex` is off.
 * `projectTrusted` must be the trust of the directory the agent runs in.
 */
export function agentSkills(
	config: Pick<DevTeamConfig, "skillIndex">,
	cwd: string,
	packageRoot: string,
	projectTrusted: boolean,
): Map<string, SkillDef> | undefined {
	return config.skillIndex === "off" ? undefined : discoverSkills(cwd, packageRoot, { includeProject: projectTrusted });
}
