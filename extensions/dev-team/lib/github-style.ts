/**
 * Writing style for the pull requests, issues and comments that the team opens on GitHub. The rules
 * join two sources: plain English after ASD-STE100 (AminBlg/SimpleEnglish: short sentences, active
 * voice, no hedges, no filler) and a layout for a reader with little attention to spare
 * (ayghri/i-have-adhd: the point first, short lists, one next step, details out of the way).
 *
 * `GITHUB_STYLE_GUIDE` goes into the system prompt of every session and subagent. `createStyleGate`
 * finds each `gh pr|issue create|edit|comment` in a bash command, checks the title and body it sends,
 * and decides whether the extension blocks the call (once), adds a note, or lets it pass.
 */
import { createHash } from "node:crypto";
import * as path from "node:path";
import type { GitHubStyleMode } from "./config.ts";
import { readSmallFile } from "./safe-read.ts";

/** Visible words allowed, by kind. Code, <details> blocks, HTML comments and tables do not count. */
export const WORD_LIMITS = { pr: 250, issue: 250, comment: 150 } as const;
export type GhTextKind = keyof typeof WORD_LIMITS;

export const MAX_SENTENCE_WORDS = 25;
export const MAX_LIST_ITEMS = 5;
/** Matches the "<70 chars" title rule of the /pr skill. */
export const MAX_TITLE_CHARS = 69;
/** Text longer than this is reported as too long and not checked further, so the check stays fast. */
export const MAX_LINT_CHARS = 100_000;
/** Blocked commands remembered for the block-once rule; the oldest is forgotten first. */
export const MAX_REMEMBERED_BLOCKS = 200;

export const FILLER_TERMS = [
	"simply",
	"seamless",
	"seamlessly",
	"robust",
	"powerful",
	"comprehensive",
	"leverage",
	"leverages",
	"leveraged",
	"leveraging",
	"crucial",
	"delve",
	"in order to",
	"it is worth noting",
] as const;

const EXAMPLE_SENTENCE_CHARS = 60;
const EXAMPLE_BOLD_CHARS = 30;
const MAX_BOLD_EXAMPLES = 3;

export const GITHUB_STYLE_GUIDE = [
	"GitHub text style (pull request and issue titles, bodies, comments). Readers skim, so:",
	`- Title: fewer than ${MAX_TITLE_CHARS + 1} characters, imperative ("Add rate limit to /login").`,
	"- First line of the body: one sentence that says what changes and why (issue: what is wrong and its effect).",
	`- Then short sections: Summary (at most 3 bullets), Test plan or Acceptance criteria. No more than ${MAX_LIST_ITEMS} items in a list.`,
	`- Plain English: at most ${MAX_SENTENCE_WORDS} words per sentence, active voice, simple tenses, one term for one thing. Use can/will/must, not should/may/might.`,
	`- No em-dashes, no bold, no emoji, no filler (${FILLER_TERMS.join(", ")}). State the fact, not its importance.`,
	"- End with one next step for the reader, for example \"Review: start at `src/auth.ts:42`.\"",
	`- Keep the visible text under ${WORD_LIMITS.pr} words (comments: ${WORD_LIMITS.comment}). Put long required content (evidence bundles, decisions, logs) at the end in one <details><summary>…</summary> block; it does not count toward the limit.`,
	"- Keep every heading, section and marker that a skill template requires: shorten its content or move it into <details>, never drop or rename it.",
	"- Never change code, identifiers, commands, paths, error text or numbers to fit these rules.",
].join("\n");

export interface GhText {
	kind: GhTextKind;
	title?: string;
	body?: string;
}

// ---------------------------------------------------------------- shell scanning

/**
 * A shell word. `dynamic` means the shell computes part of it ($VAR, `cmd`, a substitution other than
 * `$(cat <<EOF ...)`), so its text is not what gh receives. `heredoc` is set on a `<<DELIM` redirect.
 */
interface ShellWord {
	text: string;
	dynamic: boolean;
	heredoc?: string;
}
type ShellSegment = ShellWord[];
interface PendingHeredoc {
	word: ShellWord;
	delimiter: string;
	stripTabs: boolean;
}

/** Body lines up to the delimiter line for each pending heredoc, in order. Returns the index after them. */
function readHeredocBodies(s: string, start: number, pending: PendingHeredoc[]): number {
	let i = start;
	for (const p of pending) {
		const lines: string[] = [];
		p.word.heredoc = "";
		while (i < s.length) {
			const nl = s.indexOf("\n", i);
			const raw = s.slice(i, nl < 0 ? s.length : nl);
			i = nl < 0 ? s.length : nl + 1;
			const line = p.stripTabs ? raw.replace(/^\t+/, "") : raw;
			if (line === p.delimiter) break;
			lines.push(line);
		}
		p.word.heredoc = lines.join("\n");
	}
	pending.length = 0;
	return i;
}

/** `<<DELIM` / `<<-'DELIM'` at `start` (after the `<<`): registers the heredoc on a new word in `segment`. */
function readHeredocOperator(s: string, start: number, segment: ShellSegment, pending: PendingHeredoc[]): number {
	let i = start;
	const stripTabs = s[i] === "-";
	if (stripTabs) i++;
	while (s[i] === " " || s[i] === "\t") i++;
	let delimiter = "";
	const quote = s[i];
	if (quote === "'" || quote === '"') {
		const end = s.indexOf(quote, i + 1);
		delimiter = s.slice(i + 1, end < 0 ? s.length : end);
		i = end < 0 ? s.length : end + 1;
	} else {
		while (i < s.length && !/[\s;&|<>()]/.test(s[i])) delimiter += s[i++];
	}
	const word: ShellWord = { text: "<<", dynamic: false, heredoc: "" };
	segment.push(word);
	pending.push({ word, delimiter, stripTabs });
	return i;
}

/** `"..."` from `start` (after the opening quote) into `word`. Returns the index after the closing quote. */
function readDoubleQuoted(s: string, start: number, word: ShellWord): number {
	let i = start;
	while (i < s.length) {
		const c = s[i];
		if (c === '"') return i + 1;
		if (c === "\\" && i + 1 < s.length && '"\\$`\n'.includes(s[i + 1])) {
			if (s[i + 1] !== "\n") word.text += s[i + 1];
			i += 2;
		} else if (c === "$" && s[i + 1] === "(") {
			i = readSubstitution(s, i + 2, word);
		} else if (c === "`" || (c === "$" && /[A-Za-z_{0-9@*#?$!-]/.test(s[i + 1] ?? ""))) {
			word.dynamic = true;
			word.text += c;
			i++;
		} else {
			word.text += c;
			i++;
		}
	}
	word.dynamic = true;
	return i;
}

/** `$( ... )` from `start` (after `$(`). Only `$(cat <<DELIM ...)` has known text: the heredoc body. */
function readSubstitution(s: string, start: number, word: ShellWord): number {
	const inner = scanShell(s, start, true);
	const [only] = inner.segments;
	const isCatHeredoc = inner.segments.length === 1 && only.length === 2 && only[0].text === "cat" && !only[0].dynamic && only[1].heredoc !== undefined;
	if (isCatHeredoc) word.text += only[1].heredoc;
	else word.dynamic = true;
	return inner.end;
}

/**
 * Split shell text into simple commands (segments) of words, honoring quotes, escapes, `$(...)` and
 * heredocs. Not a full shell parser: enough to find gh commands and their literal flag values. Each
 * character is visited a bounded number of times, so the scan is linear in the input.
 */
function scanShell(s: string, start: number, inSubstitution: boolean): { segments: ShellSegment[]; end: number } {
	const segments: ShellSegment[] = [];
	const pending: PendingHeredoc[] = [];
	let segment: ShellSegment = [];
	let word: ShellWord | undefined;
	const current = (): ShellWord => (word ??= { text: "", dynamic: false });
	const endWord = () => {
		if (word) segment.push(word);
		word = undefined;
	};
	const endSegment = () => {
		endWord();
		if (segment.length) segments.push(segment);
		segment = [];
	};
	let i = start;
	while (i < s.length) {
		const c = s[i];
		if (c === "\n") {
			endSegment();
			i = readHeredocBodies(s, i + 1, pending);
		} else if (c === " " || c === "\t") {
			endWord();
			i++;
		} else if (c === ";" || c === "&" || c === "|" || c === "(") {
			endSegment();
			i++;
		} else if (c === ")") {
			endSegment();
			if (inSubstitution) return { segments, end: i + 1 };
			i++;
		} else if (c === "#" && !word) {
			const nl = s.indexOf("\n", i);
			i = nl < 0 ? s.length : nl;
		} else if (c === "\\") {
			if (s[i + 1] !== "\n") current().text += s[i + 1] ?? "";
			i += 2;
		} else if (c === "'") {
			const end = s.indexOf("'", i + 1);
			current().text += s.slice(i + 1, end < 0 ? s.length : end);
			if (end < 0) current().dynamic = true;
			i = end < 0 ? s.length : end + 1;
		} else if (c === '"') {
			i = readDoubleQuoted(s, i + 1, current());
		} else if (c === "$" && s[i + 1] === "(") {
			i = readSubstitution(s, i + 2, current());
		} else if (c === "`" || (c === "$" && /[A-Za-z_{0-9@*#?$!-]/.test(s[i + 1] ?? ""))) {
			current().dynamic = true;
			current().text += c;
			i++;
		} else if (c === "<" && s[i + 1] === "<" && s[i + 2] !== "<") {
			endWord();
			i = readHeredocOperator(s, i + 2, segment, pending);
		} else {
			current().text += c;
			i++;
		}
	}
	endSegment();
	return { segments, end: i };
}

// ---------------------------------------------------------------- gh commands

const TITLE_FLAGS = new Set(["--title", "-t"]);
const BODY_FLAGS = new Set(["--body", "-b"]);
const BODY_FILE_FLAGS = new Set(["--body-file", "-F"]);
const GH_GROUPS = new Set(["pr", "issue"]);
const GH_ACTIONS = new Set(["create", "edit", "comment"]);

function readBodyFile(value: ShellWord, stdin: string | undefined, cwd: string): string | undefined {
	if (value.dynamic) return undefined;
	if (value.text === "-") return stdin;
	return readSmallFile(path.resolve(cwd, value.text), MAX_LINT_CHARS * 4);
}

/** The text one simple command sends, when it is `[NAME=value ...] gh pr|issue create|edit|comment ...`. */
function findGhText(segment: ShellSegment, cwd: string): GhText | undefined {
	let k = 0;
	while (k < segment.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(segment[k].text)) k++;
	const [command, group, action] = segment.slice(k, k + 3);
	if (!command || command.dynamic || path.basename(command.text) !== "gh") return undefined;
	if (!group || !GH_GROUPS.has(group.text) || !action || !GH_ACTIONS.has(action.text)) return undefined;
	const args = segment.slice(k + 3);
	const stdin = args.find((w) => w.heredoc !== undefined)?.heredoc;
	const text: GhText = { kind: action.text === "comment" ? "comment" : group.text === "pr" ? "pr" : "issue" };
	for (let j = 0; j < args.length; j++) {
		const arg = args[j];
		if (arg.heredoc !== undefined) continue;
		const inline = /^(--[a-z-]+)=([\s\S]*)$/.exec(arg.text);
		const flag = inline ? inline[1] : arg.text;
		if (!TITLE_FLAGS.has(flag) && !BODY_FLAGS.has(flag) && !BODY_FILE_FLAGS.has(flag)) continue;
		const value: ShellWord | undefined = inline ? { text: inline[2], dynamic: arg.dynamic } : args[++j];
		if (!value || value.heredoc !== undefined) continue;
		if (TITLE_FLAGS.has(flag)) text.title = value.dynamic ? undefined : value.text;
		else if (BODY_FLAGS.has(flag)) text.body = value.dynamic ? undefined : value.text;
		else text.body = readBodyFile(value, stdin, cwd);
	}
	return text;
}

/**
 * The title and body that each `gh pr|issue create|edit|comment` in a bash command sends. A value the
 * shell computes ($VAR, `$(git log ...)`) is left undefined and not checked. `$(cat <<EOF ...)` and
 * `--body-file -` with a heredoc are read; a body file is read relative to `cwd`.
 */
export function extractGhTexts(command: string, cwd: string): GhText[] {
	if (!/\bgh\b/.test(command)) return [];
	return scanShell(command, 0, false)
		.segments.map((segment) => findGhText(segment, cwd))
		.filter((t): t is GhText => t !== undefined);
}

// ---------------------------------------------------------------- lint

/** Remove every `open ... close` span (case-insensitive), in one pass. An unclosed span runs to the end. */
function removeSpans(text: string, open: string, close: string): string {
	const lower = text.toLowerCase();
	let out = "";
	let i = 0;
	while (i < text.length) {
		const a = lower.indexOf(open, i);
		if (a < 0) break;
		out += text.slice(i, a);
		const b = lower.indexOf(close, a + open.length);
		i = b < 0 ? text.length : b + close.length;
	}
	return out + text.slice(i);
}

const FENCE = /^[ \t]*(`{3,}|~{3,})/;
const TABLE_ROW = /^[ \t]*\|/;
const HEADING = /^[ \t]*#{1,6}(?:[ \t]|$)/;
const LIST_MARKER = /^([ \t]*)(?:[-*+]|\d+[.)])[ \t]+(?:\[[ xX]\][ \t]+)?/;

/** The body as the reader first sees it: no code, no collapsed details, no HTML comments, no tables. */
export function visibleText(body: string): string {
	const lines: string[] = [];
	let fence: string | undefined;
	for (const line of removeSpans(removeSpans(body, "<!--", "-->"), "<details", "</details>").split("\n")) {
		const marker = FENCE.exec(line)?.[1];
		if (fence) {
			if (marker && marker[0] === fence[0] && marker.length >= fence.length) fence = undefined;
			continue;
		}
		if (marker) {
			fence = marker;
			continue;
		}
		if (!TABLE_ROW.test(line)) lines.push(line);
	}
	return lines
		.join("\n")
		.replace(/`[^`\n]*`/g, "")
		.replace(/https?:\/\/\S+/g, "");
}

function splitWords(text: string): string[] {
	return text.match(/[A-Za-z0-9][\w'’./#:-]*/g) ?? [];
}

function clip(s: string, maxChars = EXAMPLE_SENTENCE_CHARS): string {
	const t = s.trim().replace(/\s+/g, " ");
	return t.length > maxChars ? `${t.slice(0, maxChars)}…` : t;
}

/** Paragraphs and list items, each joined onto one line, so a hard-wrapped sentence is measured whole. */
function textBlocks(visible: string): string[] {
	const blocks: string[] = [];
	let current: string[] = [];
	const flush = () => {
		if (current.length) blocks.push(current.join(" "));
		current = [];
	};
	for (const line of visible.split("\n")) {
		if (!line.trim() || HEADING.test(line)) {
			flush();
			continue;
		}
		const item = LIST_MARKER.exec(line);
		if (item) flush();
		current.push(item ? line.slice(item[0].length) : line.trim());
	}
	flush();
	return blocks;
}

/** Items of the longest list. Deeper-indented items belong to their parent item, not to the list. */
function longestListRun(visible: string): number {
	let longest = 0;
	let run = 0;
	let runIndent = 0;
	for (const line of visible.split("\n")) {
		const item = LIST_MARKER.exec(line);
		if (item) {
			const indent = item[1].replace(/\t/g, "    ").length;
			if (run === 0 || indent <= runIndent) {
				run++;
				runIndent = indent;
			}
			longest = Math.max(longest, run);
		} else if (line.trim() && !/^[ \t]{2,}\S/.test(line)) run = 0;
	}
	return longest;
}

const HEDGES = /\b(?:[Ss]hould|[Mm]ight|may|May(?![ \t]+\d))\b/g;
const FILLER = new RegExp(`\\b(?:${FILLER_TERMS.join("|")})\\b`, "gi");

type LintRule = (text: GhText, visible: string) => string | undefined;

const unique = (matches: RegExpMatchArray | null) => [...new Set((matches ?? []).map((m) => m.toLowerCase()))];

const LINT_RULES: LintRule[] = [
	({ title }) =>
		title !== undefined && title.length > MAX_TITLE_CHARS
			? `Title has ${title.length} characters. Keep it at ${MAX_TITLE_CHARS} or fewer.`
			: undefined,
	({ kind }, visible) => {
		const limit = WORD_LIMITS[kind];
		const count = splitWords(visible.split("\n").filter((l) => !HEADING.test(l)).join("\n")).length;
		return count > limit
			? `Body has ${count} visible words. Keep it at ${limit} or fewer: cut, or move long required content into one <details> block at the end.`
			: undefined;
	},
	(_, visible) => (visible.includes("—") ? "Remove the em-dashes (—). Write two sentences or name the relation (because, but)." : undefined),
	(_, visible) => {
		const spans = visible.match(/\*\*[^*\n]+\*\*/g);
		return spans ? `Remove the bold (${spans.slice(0, MAX_BOLD_EXAMPLES).map((b) => clip(b, EXAMPLE_BOLD_CHARS)).join(", ")}).` : undefined;
	},
	(_, visible) => {
		const hedges = unique(visible.match(HEDGES));
		return hedges.length ? `Replace ${hedges.map((h) => `"${h}"`).join(", ")} with can, will or must, or delete it.` : undefined;
	},
	(_, visible) => {
		const filler = unique(visible.match(FILLER));
		return filler.length ? `Delete the filler words: ${filler.map((f) => `"${f}"`).join(", ")}.` : undefined;
	},
	(_, visible) => {
		const longSentences = textBlocks(visible)
			.flatMap((block) => block.split(/(?<=[.!?])\s+/))
			.filter((sentence) => splitWords(sentence).length > MAX_SENTENCE_WORDS);
		return longSentences.length
			? `Split ${longSentences.length} sentence(s) over ${MAX_SENTENCE_WORDS} words, for example: "${clip(longSentences[0])}"`
			: undefined;
	},
	(_, visible) => {
		const items = longestListRun(visible);
		return items > MAX_LIST_ITEMS
			? `A list has ${items} items. Keep at most ${MAX_LIST_ITEMS}: group them, or move the rest into a <details> block.`
			: undefined;
	},
];

/** Breaks of the mechanical rules in GITHUB_STYLE_GUIDE. Empty when the text passes. */
export function lintGhText(text: GhText): string[] {
	if (text.body !== undefined && text.body.length > MAX_LINT_CHARS) {
		return [`Body has ${text.body.length} characters. Keep it far below ${MAX_LINT_CHARS}: cut it, or link to a file.`];
	}
	const visible = text.body === undefined ? "" : visibleText(text.body);
	return LINT_RULES.map((rule) => rule(text, visible)).filter((p): p is string => p !== undefined);
}

export function styleFeedback(problems: string[]): string {
	return [
		"dev-team GitHub style: rewrite the text before you send it (see \"GitHub text style\" in the system prompt).",
		...problems.map((p) => `- ${p}`),
		"Keep code, identifiers, commands, paths, error text, numbers and required template sections exactly as they are. If a rule cannot apply, send the same command again unchanged: the second identical call is not blocked.",
	].join("\n");
}

// ---------------------------------------------------------------- gate

export interface StyleVerdict {
	/** Reason to block the call. */
	block?: string;
	/** Advisory for the model; the call runs. */
	note?: string;
}

/**
 * The block-once policy. In "block" mode a command whose text breaks the rules is blocked the first
 * time and passes when sent again unchanged, so a rule that cannot apply never traps the agent. The
 * gate remembers blocked commands by hash, at most `maxRemembered`, oldest forgotten first.
 */
export function createStyleGate(maxRemembered = MAX_REMEMBERED_BLOCKS): (mode: GitHubStyleMode, command: string, cwd: string) => StyleVerdict {
	const blocked = new Set<string>();
	return (mode, command, cwd) => {
		if (mode === "off") return {};
		const problems = extractGhTexts(command, cwd).flatMap(lintGhText);
		if (!problems.length) return {};
		const feedback = styleFeedback(problems);
		if (mode === "warn") return { note: feedback };
		const key = createHash("sha256").update(command).digest("hex");
		if (blocked.has(key)) return {};
		blocked.add(key);
		if (blocked.size > maxRemembered) blocked.delete(blocked.values().next().value as string);
		return { block: feedback };
	};
}
