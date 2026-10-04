import assert from "node:assert/strict";
import { test } from "node:test";
import {
	createStyleGate,
	FILLER_TERMS,
	GITHUB_STYLE_GUIDE,
	lintGhText,
	MAX_LINT_CHARS,
	MAX_LIST_ITEMS,
	MAX_SENTENCE_WORDS,
	MAX_TITLE_CHARS,
	styleGuideFor,
	visibleText,
	WORD_LIMITS,
} from "../../extensions/dev-team/lib/github-style.ts";

/** True when one of the problems matches. Order-free, so a new rule does not break other tests. */
const has = (problems: string[], re: RegExp) => problems.some((p) => re.test(p));

/** `wordCount` words in sentences short enough that only the word-count rule can fire. */
function textOfWords(wordCount: number): string {
	const perSentence = MAX_SENTENCE_WORDS - 5;
	return Array.from({ length: wordCount }, (_, i) => (i % perSentence === perSentence - 1 ? "word." : "word")).join(" ");
}

/** One sentence of `wordCount` words. */
const oneSentenceOfWords = (wordCount: number) => `${Array.from({ length: wordCount }, () => "word").join(" ")}.`;

const GOOD_BODY = [
	"Adds a rate limit to `/login` because bots tried 40k passwords last week.",
	"",
	"## Summary",
	"- Limit each IP to 10 attempts per minute.",
	"- Return 429 with a `Retry-After` header.",
	"",
	"## Test Plan",
	"- [x] `npm test -- login.spec.ts` passes.",
	"",
	"Review: start at `src/auth.ts:42`.",
].join("\n");

test("the limits are the ones README and the /pr skill state", () => {
	assert.deepEqual(
		{ MAX_TITLE_CHARS, WORD_LIMITS, MAX_SENTENCE_WORDS, MAX_LIST_ITEMS },
		{ MAX_TITLE_CHARS: 69, WORD_LIMITS: { pr: 250, issue: 250, comment: 150 }, MAX_SENTENCE_WORDS: 25, MAX_LIST_ITEMS: 5 },
	);
});

test("styleGuideFor gives the guide in block and warn mode, nothing when off", () => {
	assert.equal(styleGuideFor("block"), GITHUB_STYLE_GUIDE);
	assert.equal(styleGuideFor("warn"), GITHUB_STYLE_GUIDE);
	assert.equal(styleGuideFor("off"), undefined);
});

// ---------------------------------------------------------------- visible text

test("visibleText drops details, HTML comments, backtick and tilde fences, tables, inline code and URLs", () => {
	const body = [
		"Kept.",
		"<!-- comment -->",
		"<details><summary>Evidence</summary>\nhidden\n</details>",
		"```",
		"code",
		"```",
		"~~~",
		"tilde code",
		"~~~",
		"| a | b |",
		"See `x` at https://example.com/a.",
	].join("\n");
	assert.equal(visibleText(body).replace(/\s+/g, " ").trim(), "Kept. See at");
});

test("visibleText: an unclosed <details> or comment hides the rest", () => {
	assert.equal(visibleText("Kept.\n<details>\nrest").trim(), "Kept.");
	assert.equal(visibleText("Kept.\n<!-- rest").trim(), "Kept.");
});

// ---------------------------------------------------------------- lint rules

test("lintGhText passes a short, plain body", () => {
	assert.deepEqual(lintGhText({ kind: "pr", title: "Add login rate limit", body: GOOD_BODY }), []);
});

test("lintGhText: a title at the limit passes, one character more fails", () => {
	assert.deepEqual(lintGhText({ kind: "pr", title: "x".repeat(MAX_TITLE_CHARS) }), []);
	assert.ok(has(lintGhText({ kind: "pr", title: "x".repeat(MAX_TITLE_CHARS + 1) }), new RegExp(`Title has ${MAX_TITLE_CHARS + 1} characters`)));
});

const ruleCases: { rule: string; bad: string; good: string; problem: RegExp }[] = [
	{ rule: "em-dash", bad: "It works — mostly.", good: "It works, mostly.", problem: /em-dashes/ },
	{ rule: "bold", bad: "This is **important**.", good: "This is important.", problem: /bold \(\*\*important\*\*\)/ },
	{ rule: "hedge", bad: "You should rerun it.", good: "You must rerun it.", problem: /"should"/ },
	{ rule: "upper-case hedge", bad: "Clients MUST retry and SHOULD log.", good: "Clients MUST retry and log.", problem: /"should"/ },
	{ rule: "'May' as a hedge, not as a month", bad: "May fail on CI.", good: "Released in May 2026.", problem: /"may"/ },
	{ rule: "hedge outside inline code, not inside", bad: "Run `x`, it might fail.", good: "Run `--might-fail` again.", problem: /"might"/ },
	{ rule: "multi-word filler", bad: "Cache it in order to save time.", good: "Cache it to save time.", problem: /"in order to"/ },
];

for (const c of ruleCases) {
	test(`lintGhText rule: ${c.rule}`, () => {
		assert.ok(has(lintGhText({ kind: "pr", body: c.bad }), c.problem), c.bad);
		assert.deepEqual(lintGhText({ kind: "pr", body: c.good }), [], c.good);
	});
}

for (const term of FILLER_TERMS) {
	test(`lintGhText rejects the filler term "${term}" and the guide names it`, () => {
		assert.ok(has(lintGhText({ kind: "pr", body: `A ${term} fix.` }), new RegExp(`"${term}"`)));
		assert.ok(GITHUB_STYLE_GUIDE.includes(term));
	});
}

test("lintGhText: filler terms match whole words only", () => {
	assert.deepEqual(lintGhText({ kind: "pr", body: "The robustness tests and the simplyfied path." }), []);
});

test("lintGhText: a sentence at the limit passes, one word more fails", () => {
	assert.deepEqual(lintGhText({ kind: "pr", body: oneSentenceOfWords(MAX_SENTENCE_WORDS) }), []);
	assert.ok(has(lintGhText({ kind: "pr", body: oneSentenceOfWords(MAX_SENTENCE_WORDS + 1) }), /Split 1 sentence/));
});

test("lintGhText measures a hard-wrapped sentence whole, also inside a list item", () => {
	const wrapped = oneSentenceOfWords(MAX_SENTENCE_WORDS + 1).replace(/((?:word ){8})/g, "$1\n");
	assert.ok(has(lintGhText({ kind: "pr", body: wrapped }), /Split 1 sentence/));
	assert.ok(has(lintGhText({ kind: "pr", body: `- [x] ${wrapped.replace(/\n/g, "\n  ")}` }), /Split 1 sentence/));
});

test("lintGhText: visible words at the limit pass, one more fails; comments have a lower limit", () => {
	assert.deepEqual(lintGhText({ kind: "pr", body: textOfWords(WORD_LIMITS.pr) }), []);
	assert.ok(has(lintGhText({ kind: "pr", body: textOfWords(WORD_LIMITS.pr + 1) }), new RegExp(`${WORD_LIMITS.pr + 1} visible words`)));
	assert.ok(has(lintGhText({ kind: "comment", body: textOfWords(WORD_LIMITS.comment + 1) }), new RegExp(`${WORD_LIMITS.comment + 1} visible words`)));
});

const hiddenPadding: { where: string; wrap: (padding: string) => string }[] = [
	{ where: "<details>", wrap: (p) => `<details><summary>Evidence</summary>\n\n${p}\n</details>` },
	{ where: "an HTML comment", wrap: (p) => `<!-- ${p} -->` },
	{ where: "fenced code", wrap: (p) => `\`\`\`\n${p}\n\`\`\`` },
	{ where: "a table", wrap: (p) => `| a |\n| ${p} |` },
	{ where: "a heading", wrap: (p) => `## ${p}` },
];

for (const c of hiddenPadding) {
	test(`lintGhText: words in ${c.where} do not count`, () => {
		const padding = textOfWords(WORD_LIMITS.pr + 50);
		assert.deepEqual(lintGhText({ kind: "pr", body: `Short visible text.\n${c.wrap(padding)}` }), []);
	});
}

const listOf = (count: number, indent = "") => Array.from({ length: count }, (_, i) => `${indent}- item ${i}\n${indent}  wrapped`).join("\n\n");

test("lintGhText: a list at the cap passes, across blank lines and wrapped items", () => {
	assert.deepEqual(lintGhText({ kind: "issue", body: listOf(MAX_LIST_ITEMS) }), []);
});

test("lintGhText: a list over the cap fails", () => {
	assert.ok(has(lintGhText({ kind: "issue", body: listOf(MAX_LIST_ITEMS + 1) }), new RegExp(`A list has ${MAX_LIST_ITEMS + 1} items`)));
});

test("lintGhText: two lists split by a paragraph count apart", () => {
	const nearCap = listOf(MAX_LIST_ITEMS - 1);
	assert.deepEqual(lintGhText({ kind: "issue", body: `${nearCap}\n\nBetween.\n\n${nearCap}` }), []);
});

test("lintGhText: sub-bullets do not count toward the parent list", () => {
	const nested = Array.from({ length: MAX_LIST_ITEMS }, (_, i) => `- item ${i}\n  - sub a\n  - sub b`).join("\n");
	assert.deepEqual(lintGhText({ kind: "pr", body: nested }), []);
});

test("lintGhText: a sub-list over the cap fails on its own", () => {
	const body = `- Summary\n${Array.from({ length: MAX_LIST_ITEMS + 1 }, (_, i) => `  - sub ${i}`).join("\n")}`;
	assert.ok(has(lintGhText({ kind: "pr", body }), new RegExp(`A list has ${MAX_LIST_ITEMS + 1} items`)));
});

test("lintGhText: a body over MAX_LINT_CHARS, or a body file too large to read, gets one problem", () => {
	const longBody = lintGhText({ kind: "pr", body: "— ".repeat(MAX_LINT_CHARS) });
	assert.equal(longBody.length, 1);
	assert.match(longBody[0], /longer than/);
	assert.deepEqual(lintGhText({ kind: "pr", bodyFileTooLarge: true }), longBody);
});

test("lintGhText finishes on pathological input up to the limit", { timeout: 10_000 }, () => {
	const inputs = ["\n".repeat(MAX_LINT_CHARS), "<details".repeat(MAX_LINT_CHARS / 8), "<!--".repeat(MAX_LINT_CHARS / 4), "](".repeat(MAX_LINT_CHARS / 2), "`".repeat(MAX_LINT_CHARS)];
	for (const body of inputs) assert.ok(Array.isArray(lintGhText({ kind: "pr", body })));
});

// ---------------------------------------------------------------- gate

const BAD_COMMAND = `gh issue create --title "Crash" --body "It simply crashes — always."`;
const GOOD_COMMAND = `gh pr create --title "Add login rate limit" --body "$(cat <<'EOF'\n${GOOD_BODY}\nEOF\n)"`;

test("gate in block mode blocks a breaking command and names its problems", () => {
	const verdict = createStyleGate()("block", BAD_COMMAND, "/");
	assert.match(verdict.block ?? "", /em-dashes/);
	assert.match(verdict.block ?? "", /"simply"/);
});

test("gate in block mode lets the same command pass when sent again", () => {
	const gate = createStyleGate();
	gate("block", BAD_COMMAND, "/");
	assert.deepEqual(gate("block", BAD_COMMAND, "/"), {});
});

test("gate in block mode checks a changed command again", () => {
	const gate = createStyleGate();
	gate("block", BAD_COMMAND, "/");
	assert.ok(gate("block", BAD_COMMAND.replace("always", "every time"), "/").block);
});

test("gate passes clean commands and non-gh commands in every mode", () => {
	const gate = createStyleGate();
	for (const mode of ["block", "warn", "off"] as const) {
		assert.deepEqual(gate(mode, GOOD_COMMAND, "/"), {}, mode);
		assert.deepEqual(gate(mode, "ls -la", "/"), {}, mode);
	}
});

test("gate in warn mode notes a breaking command every time and never blocks", () => {
	const gate = createStyleGate();
	const first = gate("warn", BAD_COMMAND, "/");
	const repeat = gate("warn", BAD_COMMAND, "/");
	assert.match(first.note ?? "", /em-dashes/);
	assert.deepEqual(repeat, first, "a repeat is noted again, not passed");
	assert.equal(first.block, undefined);
});

test("gate in off mode does nothing", () => {
	assert.deepEqual(createStyleGate()("off", BAD_COMMAND, "/"), {});
});

test("gate forgets the oldest blocked command past its memory limit", () => {
	const gate = createStyleGate(2);
	const commands = [1, 2, 3].map((n) => BAD_COMMAND.replace("Crash", `Crash ${n}`));
	for (const command of commands) gate("block", command, "/");
	assert.ok(gate("block", commands[0], "/").block, "forgotten, so blocked again");
	assert.deepEqual(gate("block", commands[2], "/"), {}, "remembered, so it passes");
});
