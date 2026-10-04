/**
 * Writing style for the pull requests, issues and comments that the team opens on GitHub. The rules
 * join two sources: plain English after ASD-STE100 (AminBlg/SimpleEnglish: short sentences, active
 * voice, no hedges, no filler) and a layout for a reader with little attention to spare
 * (ayghri/i-have-adhd: the point first, short lists, one next step, details out of the way).
 *
 * `styleGuideFor` gives the rules for the system prompt of every session and subagent.
 * `createStyleGate` checks the text each `gh pr|issue create|edit|comment` in a bash command sends
 * (see gh-command.ts) and decides whether the extension blocks the call (once), adds a note, or lets
 * it pass.
 */
import { createHash } from "node:crypto";
import type { GitHubStyleMode } from "./config.ts";
import { extractGhTexts, type GhText, MAX_LINT_CHARS, WORD_LIMITS } from "./gh-command.ts";

export { extractGhTexts, type GhText, type GhTextKind, MAX_BODY_FILE_BYTES, MAX_LINT_CHARS, WORD_LIMITS } from "./gh-command.ts";

export const MAX_SENTENCE_WORDS = 25;
export const MAX_LIST_ITEMS = 5;
/** Matches the "<70 chars" title rule of the /pr skill. */
export const MAX_TITLE_CHARS = 69;
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
const TAB_WIDTH = 4;

export const GITHUB_STYLE_GUIDE = [
	"GitHub text style (pull request and issue titles, bodies, comments). Readers skim, so:",
	`- Title: at most ${MAX_TITLE_CHARS} characters, imperative ("Add rate limit to /login").`,
	"- First line of the body: one sentence that says what changes and why (issue: what is wrong and its effect).",
	`- Then short sections: Summary (at most 3 bullets), Test plan or Acceptance criteria. No more than ${MAX_LIST_ITEMS} items in a list or sub-list.`,
	`- Plain English: at most ${MAX_SENTENCE_WORDS} words per sentence, active voice, simple tenses, one term for one thing. Use can/will/must, not should/may/might.`,
	`- No em-dashes, no bold, no emoji, no filler (${FILLER_TERMS.join(", ")}). State the fact, not its importance.`,
	"- End with one next step for the reader, for example \"Review: start at `src/auth.ts:42`.\"",
	`- Keep the visible text at ${WORD_LIMITS.pr} words or fewer (comments: ${WORD_LIMITS.comment}). Code, tables, headings and <details> blocks do not count. Put long required content (evidence bundles, decisions, logs) at the end in one <details><summary>…</summary> block.`,
	"- Keep every heading, section and marker that a skill template requires: shorten its content or move it into <details>, never drop or rename it.",
	"- Never change code, identifiers, commands, paths, error text or numbers to fit these rules.",
].join("\n");

/** The rules for the system prompt, or undefined when the style is off. */
export function styleGuideFor(mode: GitHubStyleMode): string | undefined {
	return mode === "off" ? undefined : GITHUB_STYLE_GUIDE;
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

/** Items of the longest list. A sub-list is a list of its own; its items do not count for the parent. */
function longestListRun(visible: string): number {
	let longest = 0;
	const open: { indent: number; items: number }[] = [];
	for (const line of visible.split("\n")) {
		const item = LIST_MARKER.exec(line);
		if (item) {
			const indent = item[1].replace(/\t/g, " ".repeat(TAB_WIDTH)).length;
			while (open.length && open[open.length - 1].indent > indent) open.pop();
			const top = open[open.length - 1];
			if (top?.indent === indent) top.items++;
			else open.push({ indent, items: 1 });
			longest = Math.max(longest, open[open.length - 1].items);
		} else if (line.trim() && !/^[ \t]{2,}\S/.test(line)) open.length = 0;
	}
	return longest;
}

const HEDGES = /\b(?:should|might|may)\b/gi;
const FILLER = new RegExp(`\\b(?:${FILLER_TERMS.join("|")})\\b`, "gi");

type LintRule = (text: GhText, visible: string) => string | undefined;

const uniqueLowercased = (matches: string[]) => [...new Set(matches.map((m) => m.toLowerCase()))];

/** Hedge words in any case, except "May" as a month ("May 2026"). */
function findHedges(visible: string): string[] {
	return [...visible.matchAll(HEDGES)].filter((m) => !/^May[ \t]+\d/.test(visible.slice(m.index, m.index + 8))).map((m) => m[0]);
}

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
		const hedges = uniqueLowercased(findHedges(visible));
		return hedges.length ? `Replace ${hedges.map((h) => `"${h}"`).join(", ")} with can, will or must, or delete it.` : undefined;
	},
	(_, visible) => {
		const filler = uniqueLowercased(visible.match(FILLER) ?? []);
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
	if (text.bodyFileTooLarge || (text.body !== undefined && text.body.length > MAX_LINT_CHARS)) {
		return [`The body is longer than ${MAX_LINT_CHARS} characters. Cut it, or link to a file in the repository.`];
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
 * gate remembers blocked commands by hash, at most `maxRememberedBlocks`, oldest forgotten first.
 */
export function createStyleGate(maxRememberedBlocks = MAX_REMEMBERED_BLOCKS): (mode: GitHubStyleMode, command: string, cwd: string) => StyleVerdict {
	const blockedCommandHashes = new Set<string>();
	return (mode, command, cwd) => {
		if (mode === "off") return {};
		const problems = extractGhTexts(command, cwd).flatMap(lintGhText);
		if (!problems.length) return {};
		const feedback = styleFeedback(problems);
		if (mode === "warn") return { note: feedback };
		const key = createHash("sha256").update(command).digest("hex");
		if (blockedCommandHashes.has(key)) return {};
		blockedCommandHashes.add(key);
		if (blockedCommandHashes.size > maxRememberedBlocks) blockedCommandHashes.delete(blockedCommandHashes.values().next().value as string);
		return { block: feedback };
	};
}
