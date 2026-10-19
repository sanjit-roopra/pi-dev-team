/**
 * Plain language for what the team asks and tells the human in the terminal: ask_user questions and
 * dev_team_brief briefs. The same rules as GitHub text (github-style.ts: SimpleEnglish and the
 * i-have-adhd layout), plus a fixed question layout:
 *
 *   Q2/5 · Rate limit: per user or per API key?
 *   Why it matters: shared keys hit the limit faster.
 *   → per API key (recommended)
 *     per user
 *   ⏱ 1:47 left · w = wait
 */
import { createHash } from "node:crypto";
import type { GitHubStyleMode } from "./config.ts";
import { lintGhText, MAX_LIST_ITEMS, MAX_REMEMBERED_BLOCKS, type StyleVerdict } from "./github-style.ts";

export const MAX_HEADER_WORDS = 8;
export const RECOMMENDED = /\(recommended\)/i;

/** The question rules for the system prompt; `briefs` when routing is on and dev_team_brief is used. */
export function questionStyleGuide(briefs: boolean): string {
	return [
		`Questions (ask_user)${briefs ? " and briefs (dev_team_brief)" : ""} follow the same plain-English rules. The reader may have ADHD, so for each question:`,
		...QUESTION_RULES,
	].join("\n");
}

const QUESTION_RULES = [
	`- A header of at most ${MAX_HEADER_WORDS} words, one question, and one \`why\` line (why it matters).`,
	`- The option you would pick first, marked (recommended), so Enter or "yes" accepts it. At most ${MAX_LIST_ITEMS} options.`,
	'- Give jargon a short meaning: 429 (= "too many requests").',
	"- Ask only for decisions. Look facts up yourself.",
];

export interface PlainQuestion {
	question: string;
	header?: string;
	why?: string;
	options?: { label: string; description?: string }[];
}

const countWords = (text: string) => text.split(/\s+/).filter(Boolean).length;

/** Breaks of the plain-language rules in one question. Empty when it passes. */
export function lintQuestion(q: PlainQuestion): string[] {
	const problems: string[] = [];
	if (q.header && countWords(q.header) > MAX_HEADER_WORDS) problems.push(`Header "${q.header}" has ${countWords(q.header)} words. Keep at most ${MAX_HEADER_WORDS}.`);
	if ((q.options?.length ?? 0) > MAX_LIST_ITEMS) problems.push(`"${q.header ?? q.question}" has ${q.options?.length} options. Keep at most ${MAX_LIST_ITEMS}.`);
	const body = [q.header, q.question, q.why, ...(q.options ?? []).map((o) => `- ${o.label}${o.description ? `: ${o.description}` : ""}`)].filter(Boolean).join("\n\n");
	return [...problems, ...lintGhText({ kind: "comment", body })];
}

/** The recommended options first, in their order, then the rest. */
export function recommendedFirst<T extends { label: string }>(options: T[]): T[] {
	return [...options.filter((o) => RECOMMENDED.test(o.label)), ...options.filter((o) => !RECOMMENDED.test(o.label))];
}

/** Title and body lines of question `index` (0-based) of `total`. */
export function questionLayout(q: PlainQuestion, index: number, total: number): { title: string; body: string[] } {
	const head = q.header ? `${q.header}: ${q.question}` : q.question;
	return { title: total > 1 ? `Q${index + 1}/${total} · ${head}` : head, body: q.why ? [`Why it matters: ${q.why}`] : [] };
}

export function plainFeedback(what: string, problems: string[]): string {
	return [
		`dev-team plain language: rewrite the ${what} before the user sees it (see "Questions (ask_user)" in the system prompt).`,
		...problems.map((p) => `- ${p}`),
		"Keep code, identifiers, paths and numbers as they are. If a rule cannot apply, send the same call again: the second identical call is not blocked.",
	].join("\n");
}

/**
 * Block-once for ask_user and dev_team_brief calls, like the GitHub style gate: a call whose text
 * breaks the rules is blocked the first time and passes when sent again unchanged.
 */
export function createPlainGate(maxRememberedBlocks = MAX_REMEMBERED_BLOCKS): (mode: GitHubStyleMode, what: string, input: unknown, problems: string[]) => StyleVerdict {
	const blocked = new Set<string>();
	return (mode, what, input, problems) => {
		if (mode === "off" || !problems.length) return {};
		const feedback = plainFeedback(what, problems);
		if (mode === "warn") return { note: feedback };
		const key = createHash("sha256").update(JSON.stringify([what, input])).digest("hex");
		if (blocked.has(key)) return {};
		blocked.add(key);
		if (blocked.size > maxRememberedBlocks) blocked.delete(blocked.values().next().value as string);
		return { block: feedback };
	};
}
