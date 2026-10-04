import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { type TestContext, test } from "node:test";
import {
	checkGhCommand,
	extractGhText,
	lintGhText,
	MAX_LIST_ITEMS,
	MAX_TITLE_CHARS,
	visibleText,
	WORD_LIMITS,
} from "../../extensions/dev-team/lib/github-style.ts";

function tempDir(t: TestContext): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dt-ghstyle-"));
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	return dir;
}

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

test("extractGhText ignores commands that are not gh pr/issue create, edit or comment", () => {
	assert.equal(extractGhText("git push origin main", "/"), undefined);
	assert.equal(extractGhText("gh pr view 12 --json body", "/"), undefined);
	assert.equal(extractGhText("gh issue list --label bug", "/"), undefined);
});

test("extractGhText reads the title and a heredoc body from $(cat <<'EOF' ...)", () => {
	const cmd = `gh pr create --title "Add login rate limit" --body "$(cat <<'EOF'\n${GOOD_BODY}\nEOF\n)" --base main`;
	assert.deepEqual(extractGhText(cmd, "/"), { kind: "pr", title: "Add login rate limit", body: GOOD_BODY });
});

test("extractGhText reads quoted bodies, --flag=value and short flags", () => {
	assert.deepEqual(extractGhText(`gh issue create -t 'Crash on start' -b "Line one.\\n\\"quoted\\" \\$HOME"`, "/"), {
		kind: "issue",
		title: "Crash on start",
		body: 'Line one.\\n"quoted" $HOME',
	});
	assert.equal(extractGhText(`gh pr comment 7 --body='Looks fine.'`, "/")?.body, "Looks fine.");
	assert.equal(extractGhText(`gh pr comment 7 --body 'x'`, "/")?.kind, "comment");
});

test("extractGhText reads --body-file from disk relative to cwd, and --body-file - from a heredoc", (t) => {
	const dir = tempDir(t);
	fs.writeFileSync(path.join(dir, "body.md"), "From a file.");
	assert.equal(extractGhText("gh pr create --title T --body-file body.md", dir)?.body, "From a file.");
	assert.equal(extractGhText("gh issue create -t T -F - <<EOF\nFrom stdin.\nEOF", dir)?.body, "From stdin.");
	assert.equal(extractGhText("gh pr create --title T --body-file missing.md", dir)?.body, undefined);
});

test("extractGhText leaves a body it cannot see unchecked (variables, substitutions)", () => {
	assert.equal(extractGhText(`gh pr create --title T --body "$BODY"`, "/")?.body, undefined);
	assert.equal(extractGhText(`gh pr create --title T --body-file "$F"`, "/")?.body, undefined);
	assert.deepEqual(checkGhCommand(`gh pr create --title T --body "$(generate_body)"`, "/"), undefined);
});

test("lintGhText passes a short, plain body", () => {
	assert.deepEqual(lintGhText({ kind: "pr", title: "Add login rate limit", body: GOOD_BODY }), []);
});

test("lintGhText flags a long title", () => {
	const [p] = lintGhText({ kind: "pr", title: "x".repeat(MAX_TITLE_CHARS + 1) });
	assert.match(p, /Title has 73 characters/);
	assert.deepEqual(lintGhText({ kind: "pr", title: "x".repeat(MAX_TITLE_CHARS) }), []);
});

test("lintGhText flags em-dashes, bold, hedges, filler and long sentences", () => {
	const body = [
		"This robust change — which you should review — is **important**.",
		"It may help in order to make the cache faster when the service restarts after a deploy that changed the schema of the session table today.",
	].join("\n");
	const problems = lintGhText({ kind: "pr", body }).join("\n");
	assert.match(problems, /em-dashes/);
	assert.match(problems, /bold \(\*\*important\*\*\)/);
	assert.match(problems, /"should", "may"/);
	assert.match(problems, /"robust", "in order to"/);
	assert.match(problems, /Split 1 sentence/);
});

test("lintGhText counts only visible words: details, code blocks, comments and tables are free", () => {
	const filler = "word ".repeat(WORD_LIMITS.pr + 50);
	const body = [
		"Short visible text.",
		"<!-- " + filler + " -->",
		"```",
		filler,
		"```",
		"| a | b |",
		`| ${filler} | x |`,
		"<details><summary>Evidence</summary>",
		"",
		"**Checks run** — " + filler,
		"</details>",
	].join("\n");
	assert.deepEqual(lintGhText({ kind: "pr", body }), []);
	assert.equal(visibleText(body).trim(), "Short visible text.");
});

test("lintGhText flags a body over the word limit; comments have a lower limit", () => {
	const words = (n: number) => Array.from({ length: n }, (_, i) => (i % 20 === 19 ? "word." : "word")).join(" ");
	assert.deepEqual(lintGhText({ kind: "pr", body: words(WORD_LIMITS.pr) }), []);
	assert.match(lintGhText({ kind: "pr", body: words(WORD_LIMITS.pr + 1) })[0], /251 visible words/);
	assert.match(lintGhText({ kind: "comment", body: words(WORD_LIMITS.comment + 1) })[0], /151 visible words/);
});

test("lintGhText flags a list longer than the cap, across blank lines and wrapped items", () => {
	const items = (n: number) => Array.from({ length: n }, (_, i) => `- item ${i}\n  wrapped`).join("\n\n");
	assert.deepEqual(lintGhText({ kind: "issue", body: items(MAX_LIST_ITEMS) }), []);
	assert.match(lintGhText({ kind: "issue", body: items(MAX_LIST_ITEMS + 1) })[0], /A list has 6 items/);
	const twoLists = `${items(4)}\n\nBetween.\n\n${items(4)}`;
	assert.deepEqual(lintGhText({ kind: "issue", body: twoLists }), []);
});

test("checkGhCommand returns the problems of a breaking command and nothing for a clean one", () => {
	const clean = `gh pr create --title "Add login rate limit" --body "$(cat <<'EOF'\n${GOOD_BODY}\nEOF\n)"`;
	assert.equal(checkGhCommand(clean, "/"), undefined);
	const bad = checkGhCommand(`gh issue create --title "Crash" --body "It simply crashes — always."`, "/");
	assert.equal(bad?.text.kind, "issue");
	assert.equal(bad?.problems.length, 2);
});
