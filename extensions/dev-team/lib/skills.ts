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

/** SKILL.md files are small markdown; anything else (a FIFO, /dev/zero, a huge file) is skipped unread. */
const MAX_SKILL_FILE_BYTES = 1024 * 1024;

function loadSkill(filePath: string, source: SkillDef["source"]): SkillDef | undefined {
	let content: string;
	try {
		const st = fs.statSync(filePath);
		if (!st.isFile() || st.size > MAX_SKILL_FILE_BYTES) return undefined;
		content = fs.readFileSync(filePath, "utf-8");
	} catch {
		return undefined;
	}
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
	if (opts.includeProject) {
		add(loadDir(path.join(cwd, ".pi", "skills"), "project"));
		add(loadDir(path.join(cwd, ".claude", "skills"), "project"));
	}
	add(loadDir(path.join(packageRoot, "skills"), "package"));
	return map;
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
	const body = stripFrontmatter(fs.readFileSync(skill.filePath, "utf-8")).trim();
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
