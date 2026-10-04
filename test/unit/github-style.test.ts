import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { type TestContext, test } from "node:test";
import {
	createStyleGate,
	extractGhTexts,
	type GhText,
	GITHUB_STYLE_GUIDE,
	FILLER_TERMS,
	lintGhText,
	MAX_LINT_CHARS,
	MAX_LIST_ITEMS,
	MAX_SENTENCE_WORDS,
	MAX_TITLE_CHARS,
	visibleText,
	WORD_LIMITS,
} from "../../extensions/dev-team/lib/github-style.ts";

function tempDir(t: TestContext): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dt-ghstyle-"));
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	return dir;
}

/** True when one of the problems matches. Order-free, so a new rule does not break other tests. */
const has = (problems: string[], re: RegExp) => problems.some((p) => re.test(p));

/** `n` words in sentences of at most 20 words each, so only the word count rule can fire. */
const sentences = (n: number) => Array.from({ length: n }, (_, i) => (i % 20 === 19 ? "word." : "word")).join(" ");

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

const heredocCommand = (prefix: string, body: string) => `${prefix} --body "$(cat <<'EOF'\n${body}\nEOF\n)"`;

// ---------------------------------------------------------------- extraction

test("extractGhTexts ignores commands that are not gh pr/issue create, edit or comment", () => {
	assert.deepEqual(extractGhTexts("git push origin main", "/"), []);
	assert.deepEqual(extractGhTexts("gh pr view 12 --json body", "/"), []);
	assert.deepEqual(extractGhTexts("gh issue list --label bug", "/"), []);
});

test("extractGhTexts ignores gh text inside another command's quoted argument", () => {
	assert.deepEqual(extractGhTexts(`git commit -m "docs: explain gh pr create --body usage"`, "/"), []);
	assert.deepEqual(extractGhTexts(`echo 'gh issue comment 1 --body "x — y"'`, "/"), []);
});

test("extractGhTexts maps each gh group and action to a kind", () => {
	const kind = (cmd: string) => extractGhTexts(cmd, "/")[0]?.kind;
	assert.equal(kind("gh pr create --body x"), "pr");
	assert.equal(kind("gh pr edit 3 --body x"), "pr");
	assert.equal(kind("gh issue create --body x"), "issue");
	assert.equal(kind("gh issue edit 3 --body x"), "issue");
	assert.equal(kind("gh pr comment 3 --body x"), "comment");
	assert.equal(kind("gh issue comment 3 --body x"), "comment");
});

test("extractGhTexts reads the title and a heredoc body from $(cat <<'EOF' ...)", () => {
	const cmd = heredocCommand(`gh pr create --title "Add login rate limit"`, GOOD_BODY);
	assert.deepEqual(extractGhTexts(cmd, "/"), [{ kind: "pr", title: "Add login rate limit", body: GOOD_BODY }]);
});

test("extractGhTexts finds gh after cd &&, after NAME=value prefixes, and in every chained command", () => {
	assert.equal(extractGhTexts(`cd repo && GH_PAGER= gh issue create -t T -b 'B'`, "/")[0]?.body, "B");
	const both = extractGhTexts(`gh pr create -t A -b 'one' && gh pr comment 1 -b 'two'`, "/");
	assert.deepEqual(both.map((t) => t.body), ["one", "two"]);
});

test("extractGhTexts: a title computed by $(...) is unknown and does not take the body's heredoc", () => {
	const cmd = heredocCommand(`gh pr create --title "$(git log -1 --format=%s)"`, GOOD_BODY);
	assert.deepEqual(extractGhTexts(cmd, "/"), [{ kind: "pr", title: undefined, body: GOOD_BODY }]);
});

test("extractGhTexts: flag-like text inside another value is not a flag", () => {
	const [text] = extractGhTexts(heredocCommand(`gh pr create --title "Fix --body parsing"`, "Real body."), "/");
	assert.deepEqual(text, { kind: "pr", title: "Fix --body parsing", body: "Real body." });
	const [early] = extractGhTexts(`gh pr create --body "$(cat <<'EOF'\nRun npm test -t foo.\nEOF\n)" --title Real`, "/");
	assert.equal(early.title, "Real");
});

test("extractGhTexts unquotes double-quoted escapes and reads --flag=value", () => {
	assert.equal(extractGhTexts(`gh issue create -t T -b "Say \\"hi\\" to \\$HOME"`, "/")[0]?.body, 'Say "hi" to $HOME');
	assert.equal(extractGhTexts(`gh pr comment 7 --body='Looks fine.'`, "/")[0]?.body, "Looks fine.");
});

test("extractGhTexts reads --body-file relative to cwd, and --body-file - from a heredoc", (t) => {
	const dir = tempDir(t);
	fs.writeFileSync(path.join(dir, "body.md"), "From a file.");
	assert.equal(extractGhTexts("gh pr create --title T --body-file body.md", dir)[0]?.body, "From a file.");
	assert.equal(extractGhTexts("gh issue create -t T -F - <<EOF\nFrom stdin.\nEOF", dir)[0]?.body, "From stdin.");
	assert.equal(extractGhTexts("gh issue create -t T -F - <<-EOF\n\tTabbed.\n\tEOF", dir)[0]?.body, "Tabbed.");
	assert.equal(extractGhTexts("gh pr create --title T --body-file missing.md", dir)[0]?.body, undefined);
});

test("extractGhTexts leaves a value it cannot see unchecked (variables, substitutions, open quotes)", () => {
	assert.equal(extractGhTexts(`gh pr create --title T --body "$BODY"`, "/")[0]?.body, undefined);
	assert.equal(extractGhTexts(`gh pr create --title T --body-file "$F"`, "/")[0]?.body, undefined);
	assert.equal(extractGhTexts(`gh pr create --title T --body "$(generate_body)"`, "/")[0]?.body, undefined);
	assert.equal(extractGhTexts(`gh pr create --title T --body "never closed`, "/")[0]?.body, undefined);
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
	assert.deepEqual(visibleText(body).split("\n").filter((l) => l.trim()), ["Kept.", "See  at "]);
});

test("visibleText: an unclosed <details> or comment hides the rest", () => {
	assert.equal(visibleText("Kept.\n<details>\nrest").trim(), "Kept.");
	assert.equal(visibleText("Kept.\n<!-- rest").trim(), "Kept.");
});

// ---------------------------------------------------------------- lint rules

test("lintGhText passes a short, plain body", () => {
	assert.deepEqual(lintGhText({ kind: "pr", title: "Add login rate limit", body: GOOD_BODY }), []);
});

test("lintGhText: the title limit", () => {
	assert.deepEqual(lintGhText({ kind: "pr", title: "x".repeat(MAX_TITLE_CHARS) }), []);
	assert.ok(has(lintGhText({ kind: "pr", title: "x".repeat(MAX_TITLE_CHARS + 1) }), new RegExp(`Title has ${MAX_TITLE_CHARS + 1} characters`)));
});

const ruleCases: { rule: string; bad: string; good: string; problem: RegExp }[] = [
	{ rule: "em-dash", bad: "It works — mostly.", good: "It works, mostly.", problem: /em-dashes/ },
	{ rule: "bold", bad: "This is **important**.", good: "This is important.", problem: /bold \(\*\*important\*\*\)/ },
	{ rule: "hedge", bad: "You should rerun it.", good: "You must rerun it.", problem: /"should"/ },
	{ rule: "hedge 'May' at sentence start", bad: "May fail on CI.", good: "Released in May 2026.", problem: /"may"/ },
	{ rule: "filler", bad: "A robust fix.", good: "A fix for the crash.", problem: /"robust"/ },
	{ rule: "multi-word filler", bad: "Cache it in order to save time.", good: "Cache it to save time.", problem: /"in order to"/ },
	{ rule: "hedge inside inline code is code", bad: "You might rerun it.", good: "Run `--might-fail` again.", problem: /"might"/ },
];

for (const c of ruleCases) {
	test(`lintGhText rule: ${c.rule}`, () => {
		assert.ok(has(lintGhText({ kind: "pr", body: c.bad }), c.problem), c.bad);
		assert.deepEqual(lintGhText({ kind: "pr", body: c.good }), [], c.good);
	});
}

test("lintGhText: sentence length at the limit passes, one word more fails", () => {
	const sentence = (n: number) => `${Array.from({ length: n }, () => "word").join(" ")}.`;
	assert.deepEqual(lintGhText({ kind: "pr", body: sentence(MAX_SENTENCE_WORDS) }), []);
	assert.ok(has(lintGhText({ kind: "pr", body: sentence(MAX_SENTENCE_WORDS + 1) }), /Split 1 sentence/));
});

test("lintGhText measures a hard-wrapped sentence whole, also inside a list item", () => {
	const wrapped = Array.from({ length: 4 }, () => "word word word word word word word word").join("\n");
	assert.ok(has(lintGhText({ kind: "pr", body: `${wrapped}.` }), /Split 1 sentence/));
	assert.ok(has(lintGhText({ kind: "pr", body: `- [x] ${wrapped.replace(/\n/g, "\n  ")}.` }), /Split 1 sentence/));
});

test("lintGhText: visible words at the limit pass, one more fails; comments have a lower limit", () => {
	assert.deepEqual(lintGhText({ kind: "pr", body: sentences(WORD_LIMITS.pr) }), []);
	assert.ok(has(lintGhText({ kind: "pr", body: sentences(WORD_LIMITS.pr + 1) }), new RegExp(`${WORD_LIMITS.pr + 1} visible words`)));
	assert.ok(has(lintGhText({ kind: "comment", body: sentences(WORD_LIMITS.comment + 1) }), new RegExp(`${WORD_LIMITS.comment + 1} visible words`)));
});

const hiddenPadding: { where: string; wrap: (padding: string) => string }[] = [
	{ where: "<details>", wrap: (p) => `<details><summary>Evidence</summary>\n\n${p}\n</details>` },
	{ where: "HTML comment", wrap: (p) => `<!-- ${p} -->` },
	{ where: "fenced code", wrap: (p) => `\`\`\`\n${p}\n\`\`\`` },
	{ where: "table", wrap: (p) => `| a |\n| ${p} |` },
	{ where: "headings", wrap: (p) => `## ${p}` },
];

for (const c of hiddenPadding) {
	test(`lintGhText: words in ${c.where} do not count`, () => {
		const padding = sentences(WORD_LIMITS.pr + 50);
		assert.deepEqual(lintGhText({ kind: "pr", body: `Short visible text.\n${c.wrap(padding)}` }), []);
	});
}

test("lintGhText: list item cap, across blank lines and wrapped items; separate lists count apart", () => {
	const items = (n: number) => Array.from({ length: n }, (_, i) => `- item ${i}\n  wrapped`).join("\n\n");
	assert.deepEqual(lintGhText({ kind: "issue", body: items(MAX_LIST_ITEMS) }), []);
	assert.ok(has(lintGhText({ kind: "issue", body: items(MAX_LIST_ITEMS + 1) }), new RegExp(`A list has ${MAX_LIST_ITEMS + 1} items`)));
	assert.deepEqual(lintGhText({ kind: "issue", body: `${items(4)}\n\nBetween.\n\n${items(4)}` }), []);
});

test("lintGhText: nested sub-bullets do not count toward the parent list", () => {
	const nested = Array.from({ length: 3 }, (_, i) => `- item ${i}\n  - sub a\n  - sub b`).join("\n");
	assert.deepEqual(lintGhText({ kind: "pr", body: nested }), []);
});

test("lintGhText: a body over MAX_LINT_CHARS gets one problem and no further checks", () => {
	const problems = lintGhText({ kind: "pr", body: "— ".repeat(MAX_LINT_CHARS) });
	assert.equal(problems.length, 1);
	assert.match(problems[0], /characters/);
});

test("lintGhText stays fast on pathological input up to the limit", () => {
	const inputs = ["\n".repeat(MAX_LINT_CHARS), "<details".repeat(MAX_LINT_CHARS / 8), "<!--".repeat(MAX_LINT_CHARS / 4), "](".repeat(MAX_LINT_CHARS / 2), "`".repeat(MAX_LINT_CHARS)];
	for (const body of inputs) {
		const start = performance.now();
		lintGhText({ kind: "pr", body });
		assert.ok(performance.now() - start < 500, `slow on ${JSON.stringify(body.slice(0, 10))}`);
	}
});

test("the style guide names every filler term the linter rejects", () => {
	for (const term of FILLER_TERMS) assert.ok(GITHUB_STYLE_GUIDE.includes(term), term);
});

// ---------------------------------------------------------------- gate

const BAD = `gh issue create --title "Crash" --body "It simply crashes — always."`;
const GOOD = heredocCommand(`gh pr create --title "Add login rate limit"`, GOOD_BODY);

test("gate in block mode: blocks a breaking command once, lets the same command pass when sent again", () => {
	const gate = createStyleGate();
	const first = gate("block", BAD, "/");
	assert.match(first.block ?? "", /em-dashes/);
	assert.match(first.block ?? "", /"simply"/);
	assert.deepEqual(gate("block", BAD, "/"), {});
});

test("gate in block mode: a changed command is checked again", () => {
	const gate = createStyleGate();
	assert.ok(gate("block", BAD, "/").block);
	assert.ok(gate("block", BAD.replace("always", "every time"), "/").block);
});

test("gate passes clean commands and non-gh commands in every mode", () => {
	const gate = createStyleGate();
	for (const mode of ["block", "warn", "off"] as const) {
		assert.deepEqual(gate(mode, GOOD, "/"), {});
		assert.deepEqual(gate(mode, "ls -la", "/"), {});
	}
});

test("gate in warn mode returns a note and never blocks", () => {
	const gate = createStyleGate();
	assert.match(gate("warn", BAD, "/").note ?? "", /em-dashes/);
	assert.match(gate("warn", BAD, "/").note ?? "", /em-dashes/);
	assert.equal(gate("warn", BAD, "/").block, undefined);
});

test("gate in off mode does nothing", () => {
	assert.deepEqual(createStyleGate()("off", BAD, "/"), {});
});

test("gate forgets the oldest blocked command past its memory limit", () => {
	const gate = createStyleGate(2);
	const commands = [1, 2, 3].map((n) => BAD.replace("Crash", `Crash ${n}`));
	for (const c of commands) assert.ok(gate("block", c, "/").block);
	assert.ok(gate("block", commands[0], "/").block, "forgotten, so blocked again");
	assert.deepEqual(gate("block", commands[2], "/"), {}, "remembered, so it passes");
});

test("lintGhText accepts the GhText shape the gate builds", () => {
	const text: GhText = { kind: "comment", body: "Fixed in #12." };
	assert.deepEqual(lintGhText(text), []);
});
