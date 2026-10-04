/**
 * Writing style for the pull requests, issues and comments that the team opens on GitHub. The rules
 * join two sources: plain English after ASD-STE100 (AminBlg/SimpleEnglish: short sentences, active
 * voice, no hedges, no filler) and a layout for a reader with little attention to spare
 * (ayghri/i-have-adhd: the point first, short lists, one next step, details out of the way).
 *
 * `GITHUB_STYLE_GUIDE` goes into the system prompt of every session and subagent. `checkGhCommand`
 * finds the body of a `gh pr|issue create|edit|comment` bash command and returns what breaks the
 * mechanical rules, so the extension can stop the call before the text reaches GitHub.
 */
import * as path from "node:path";
import { readSmallFile } from "./safe-read.ts";

export type GithubStyleMode = "block" | "warn" | "off";

/** Visible words allowed, by kind. Code, <details> blocks and HTML comments do not count. */
export const WORD_LIMITS = { pr: 250, issue: 250, comment: 150 } as const;
export type GhTextKind = keyof typeof WORD_LIMITS;

export const MAX_SENTENCE_WORDS = 25;
export const MAX_LIST_ITEMS = 5;
export const MAX_TITLE_CHARS = 72;

export const GITHUB_STYLE_GUIDE = [
	"GitHub text style (pull request and issue titles, bodies, comments). Readers skim, so:",
	`- Title: at most ${MAX_TITLE_CHARS} characters, imperative ("Add rate limit to /login").`,
	"- First line of the body: one sentence that says what changes and why (issue: what is wrong and its effect).",
	`- Then short sections: Summary (at most 3 bullets), Test plan or Acceptance criteria. No more than ${MAX_LIST_ITEMS} items in a list.`,
	`- Plain English: at most ${MAX_SENTENCE_WORDS} words per sentence, active voice, simple tenses, one term for one thing. Use can/will/must, not should/may/might.`,
	"- No em-dashes, no bold, no emoji, no filler (simply, seamlessly, robust, comprehensive, leverage, crucial, in order to). State the fact, not its importance.",
	"- End with one next step for the reader, for example \"Review: start at `src/auth.ts:42`.\"",
	`- Keep the visible text under ${WORD_LIMITS.pr} words (comments: ${WORD_LIMITS.comment}). Put long required content (evidence bundles, decisions, logs, tables) at the end in one <details><summary>…</summary> block; it does not count toward the limit.`,
	"- Never change code, identifiers, commands, paths, error text or numbers to fit these rules.",
].join("\n");

const HEDGES = /\b(should|may|might)\b/gi;
const FILLER =
	/\b(simply|seamless(?:ly)?|robust|powerful|comprehensive|leverag(?:e|es|ed|ing)|crucial|delve|in order to|it is worth noting)\b/gi;

export interface GhText {
	kind: GhTextKind;
	title?: string;
	body?: string;
}

const GH_COMMAND = /\bgh\s+(pr|issue)\s+(create|edit|comment)\b/;

/** Text of a quoted shell word starting at `s[i]` (a quote), or undefined. */
function quoted(s: string, i: number): string | undefined {
	const q = s[i];
	if (q === "'") {
		const end = s.indexOf("'", i + 1);
		return end < 0 ? undefined : s.slice(i + 1, end);
	}
	if (q !== '"') return undefined;
	let out = "";
	for (let j = i + 1; j < s.length; j++) {
		const c = s[j];
		if (c === "\\" && j + 1 < s.length && '"\\$`'.includes(s[j + 1])) {
			out += s[++j];
			continue;
		}
		if (c === '"') return out;
		out += c;
	}
	return undefined;
}

/** First heredoc body at or after `from`. */
function heredoc(s: string, from: number): string | undefined {
	const re = /<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1[^\n]*\n/g;
	re.lastIndex = from;
	const m = re.exec(s);
	if (!m) return undefined;
	const start = m.index + m[0].length;
	const end = new RegExp(`^\\s*${m[2]}\\s*$`, "m");
	const rest = s.slice(start);
	const e = end.exec(rest);
	return e ? rest.slice(0, e.index).replace(/\n$/, "") : undefined;
}

/** Value of `--flag value`, `--flag=value` or `-f value`: quoted text, a heredoc in "$(cat <<EOF ...)", or a bare word. */
function flagValue(cmd: string, names: string[]): { value: string; at: number } | undefined {
	const re = new RegExp(`(?:^|\\s)(?:${names.map((n) => n.replace(/-/g, "\\-")).join("|")})(?:=|\\s+)`, "g");
	const m = re.exec(cmd);
	if (!m) return undefined;
	const at = m.index + m[0].length;
	if (cmd.startsWith('"$(', at) || cmd.startsWith("$(", at)) {
		const body = heredoc(cmd, at);
		if (body !== undefined) return { value: body, at };
	}
	const q = quoted(cmd, at);
	if (q !== undefined) return { value: q, at };
	const word = /^[^\s;|&)]+/.exec(cmd.slice(at));
	return word ? { value: word[0], at } : undefined;
}

/**
 * The title and body a `gh` command sends, or undefined when the command is not a pull request or
 * issue create/edit/comment. A body the command reads from a file is read (relative to `cwd`); a body
 * that cannot be found (a variable, a process substitution) is left undefined, so it is not checked.
 */
export function extractGhText(command: string, cwd: string): GhText | undefined {
	const m = GH_COMMAND.exec(command);
	if (!m) return undefined;
	const cmd = command.slice(m.index);
	const kind: GhTextKind = m[2] === "comment" ? "comment" : m[1] === "pr" ? "pr" : "issue";
	const title = flagValue(cmd, ["--title", "-t"])?.value;
	let body = flagValue(cmd, ["--body", "-b"])?.value;
	if (body === undefined) {
		const file = flagValue(cmd, ["--body-file", "-F"]);
		if (file?.value === "-") body = heredoc(cmd, file.at);
		else if (file && !/[$`]/.test(file.value)) body = readSmallFile(path.resolve(cwd, file.value));
	}
	if (body !== undefined && /^\$[({A-Za-z_]/.test(body.trim())) body = undefined;
	return { kind, title, body };
}

/** The body as the reader first sees it: no code, no collapsed details, no HTML comments, no tables. */
export function visibleText(body: string): string {
	return body
		.replace(/<details[\s\S]*?<\/details>/gi, "")
		.replace(/<!--[\s\S]*?-->/g, "")
		.replace(/^(\s*)(`{3,}|~{3,})[\s\S]*?^\1\2\s*$/gm, "")
		.split("\n")
		.filter((line) => !/^\s*\|/.test(line))
		.join("\n")
		.replace(/`[^`\n]*`/g, "CODE")
		.replace(/\]\([^)]*\)/g, "]")
		.replace(/https?:\/\/\S+/g, "URL");
}

function words(text: string): string[] {
	return text.match(/[A-Za-z0-9][\w'’./#:-]*/g) ?? [];
}

function clip(s: string, n = 60): string {
	const t = s.trim().replace(/\s+/g, " ");
	return t.length > n ? `${t.slice(0, n)}…` : t;
}

/** Breaks of the mechanical rules in GITHUB_STYLE_GUIDE. Empty when the text passes. */
export function lintGhText(text: GhText): string[] {
	const problems: string[] = [];
	if (text.title !== undefined && text.title.length > MAX_TITLE_CHARS) {
		problems.push(`Title has ${text.title.length} characters. Keep it at ${MAX_TITLE_CHARS} or fewer.`);
	}
	if (text.body === undefined) return problems;
	const visible = visibleText(text.body);
	const limit = WORD_LIMITS[text.kind];
	const count = words(visible.replace(/^\s*#+\s.*$/gm, "")).length;
	if (count > limit) {
		problems.push(`Body has ${count} visible words. Keep it at ${limit} or fewer: cut, or move long required content into one <details> block at the end.`);
	}
	if (/—/.test(visible)) problems.push("Remove the em-dashes (—). Write two sentences or name the relation (because, but).");
	const bold = visible.match(/\*\*[^*\n]+\*\*/g);
	if (bold) problems.push(`Remove the bold (${bold.slice(0, 3).map((b) => clip(b, 30)).join(", ")}).`);
	const hedges = [...new Set((visible.match(HEDGES) ?? []).map((h) => h.toLowerCase()))];
	if (hedges.length) problems.push(`Replace ${hedges.map((h) => `"${h}"`).join(", ")} with can, will or must, or delete it.`);
	const filler = [...new Set((visible.match(FILLER) ?? []).map((f) => f.toLowerCase()))];
	if (filler.length) problems.push(`Delete the filler words: ${filler.map((f) => `"${f}"`).join(", ")}.`);
	const long = visible
		.split("\n")
		.filter((line) => !/^\s*#/.test(line))
		.flatMap((line) => line.replace(/^\s*(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?/, "").split(/(?<=[.!?])\s+/))
		.filter((s) => words(s).length > MAX_SENTENCE_WORDS);
	if (long.length) {
		problems.push(`Split ${long.length} sentence(s) over ${MAX_SENTENCE_WORDS} words, for example: "${clip(long[0])}"`);
	}
	let run = 0;
	let longest = 0;
	for (const line of visible.split("\n")) {
		if (/^\s*(?:[-*+]|\d+[.)])\s+/.test(line)) longest = Math.max(longest, ++run);
		else if (line.trim() && !/^\s{2,}\S/.test(line)) run = 0;
	}
	if (longest > MAX_LIST_ITEMS) {
		problems.push(`A list has ${longest} items. Keep at most ${MAX_LIST_ITEMS}: group them, or move the rest into a <details> block.`);
	}
	return problems;
}

/** Problems with the GitHub text a bash command sends, or undefined when there is nothing to check. */
export function checkGhCommand(command: string, cwd: string): { text: GhText; problems: string[] } | undefined {
	const text = extractGhText(command, cwd);
	if (!text) return undefined;
	const problems = lintGhText(text);
	return problems.length ? { text, problems } : undefined;
}

export function styleFeedback(problems: string[]): string {
	return [
		"dev-team GitHub style: rewrite the text before you send it (see \"GitHub text style\" in the system prompt).",
		...problems.map((p) => `- ${p}`),
		"Keep code, identifiers, commands, paths, error text and numbers exactly as they are. If a rule cannot apply, send the same command again unchanged: the second identical call is not stopped.",
	].join("\n");
}
