import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { type TestContext, test } from "node:test";
import { extractGhTexts, type GhText, MAX_BODY_FILE_BYTES } from "../../extensions/dev-team/lib/gh-command.ts";
import { MAX_SUBSTITUTION_DEPTH } from "../../extensions/dev-team/lib/shell-scan.ts";

function tempDir(t: TestContext): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dt-ghcmd-"));
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	return dir;
}

const BODY = "Adds a rate limit to `/login`.\n\n## Summary\n- Limit each IP to 10 attempts per minute.";
const heredocCommand = (prefix: string, body: string) => `${prefix} --body "$(cat <<'EOF'\n${body}\nEOF\n)"`;

test("extractGhTexts ignores commands that are not gh pr/issue create, edit or comment", () => {
	for (const command of ["git push origin main", "gh pr view 12 --json body", "gh issue list --label bug", "ghost pr create --body x"]) {
		assert.deepEqual(extractGhTexts(command, "/"), [], command);
	}
});

test("extractGhTexts ignores gh text inside another command's quoted argument or a comment", () => {
	for (const command of [
		`git commit -m "docs: explain gh pr create --body usage"`,
		`echo 'gh issue comment 1 --body "x — y"'`,
		"ls # gh pr create --body 'x — y'",
	]) {
		assert.deepEqual(extractGhTexts(command, "/"), [], command);
	}
});

test("extractGhTexts maps each gh group and action to a kind", () => {
	const cases: [string, GhText["kind"]][] = [
		["gh pr create --body x", "pr"],
		["gh pr edit 3 --body x", "pr"],
		["gh issue create --body x", "issue"],
		["gh issue edit 3 --body x", "issue"],
		["gh pr comment 3 --body x", "comment"],
		["gh issue comment 3 --body x", "comment"],
	];
	for (const [command, kind] of cases) assert.equal(extractGhTexts(command, "/")[0]?.kind, kind, command);
});

test("extractGhTexts reads the title and a quoted-heredoc body from $(cat <<'EOF' ...)", () => {
	const command = heredocCommand(`gh pr create --title "Add login rate limit"`, BODY);
	assert.deepEqual(extractGhTexts(command, "/"), [{ kind: "pr", title: "Add login rate limit", body: BODY }]);
});

const literalValueCases: { name: string; command: string; expected: Partial<GhText> }[] = [
	{ name: "single and double quotes", command: `gh issue create -t 'T' -b "B"`, expected: { title: "T", body: "B" } },
	{ name: "double-quote escapes", command: String.raw`gh issue create -t T -b "Say \"hi\" to \$HOME"`, expected: { body: 'Say "hi" to $HOME' } },
	{ name: "the '\\'' idiom", command: String.raw`gh pr comment 1 -b 'it'\''s fixed'`, expected: { body: "it's fixed" } },
	{ name: "--flag=value", command: "gh pr comment 7 --body='Looks fine.' --title=T", expected: { title: "T", body: "Looks fine." } },
	{ name: "backslash-newline continuation", command: "gh pr create \\\n  --title T \\\n  --body 'B'", expected: { title: "T", body: "B" } },
	{ name: "the last flag wins", command: "gh pr create --body one --body two", expected: { body: "two" } },
	{ name: "--body-file - with a heredoc", command: "gh issue create -t T -F - <<EOF\nFrom stdin.\nEOF", expected: { body: "From stdin." } },
	{ name: "--body-file - with <<- strips tabs", command: "gh issue create -t T -F - <<-EOF\n\tTabbed.\n\tEOF", expected: { body: "Tabbed." } },
	{ name: "--body-file - with a here-string", command: `gh pr comment 1 -F - <<< "Short note."`, expected: { body: "Short note.\n" } },
	{ name: "a title from $(...) is unknown and does not take the body's heredoc", command: heredocCommand(`gh pr create --title "$(git log -1 --format=%s)"`, BODY), expected: { title: undefined, body: BODY } },
	{ name: "flag-like text inside a value is not a flag", command: heredocCommand(`gh pr create --title "Fix --body parsing"`, "Real."), expected: { title: "Fix --body parsing", body: "Real." } },
	{ name: "-t inside a heredoc is not the title", command: `gh pr create --body "$(cat <<'EOF'\nRun npm test -t foo.\nEOF\n)" --title Real`, expected: { title: "Real", body: "Run npm test -t foo." } },
];

for (const c of literalValueCases) {
	test(`extractGhTexts reads ${c.name}`, () => {
		const [text] = extractGhTexts(c.command, "/");
		for (const [key, value] of Object.entries(c.expected)) assert.equal(text?.[key as keyof GhText], value, key);
	});
}

test("extractGhTexts finds gh after shell keywords, wrappers, cd && and NAME=value prefixes", () => {
	for (const command of [
		"cd repo && GH_PAGER= gh issue create -t T -b 'B'",
		"if gh issue create -t T -b 'B'; then echo ok; fi",
		"! gh issue create -t T -b 'B'",
		"{ gh issue create -t T -b 'B'; }",
		"env GH_HOST=x gh issue create -t T -b 'B'",
		"time gh issue create -t T -b 'B'",
	]) {
		assert.equal(extractGhTexts(command, "/")[0]?.body, "B", command);
	}
});

test("extractGhTexts returns every chained gh command", () => {
	const texts = extractGhTexts("gh pr create -t A -b 'one' && gh pr comment 1 -b 'two'", "/");
	assert.deepEqual(texts.map((t) => t.body), ["one", "two"]);
});

const unseenCases: { name: string; command: string }[] = [
	{ name: "a variable", command: `gh pr create --title T --body "$BODY"` },
	{ name: "a variable as the body file", command: `gh pr create --title T --body-file "$F"` },
	{ name: "a command substitution", command: `gh pr create --title T --body "$(generate_body)"` },
	{ name: "a backtick substitution", command: "gh pr create --title T --body `generate_body`" },
	{ name: "an unclosed quote", command: `gh pr create --title T --body "never closed` },
	{ name: "an unquoted heredoc that expands $", command: "gh pr create --title T --body \"$(cat <<EOF\n$(cat notes.md)\nEOF\n)\"" },
	{ name: "an unquoted stdin heredoc that expands $", command: "gh issue create -t T -F - <<EOF\nSee $URL\nEOF" },
];

for (const c of unseenCases) {
	test(`extractGhTexts leaves the body unchecked when it comes from ${c.name}`, () => {
		const [text] = extractGhTexts(c.command, "/");
		assert.equal(text?.kind, c.command.includes("issue") ? "issue" : "pr");
		assert.equal(text?.body, undefined);
	});
}

test("extractGhTexts: an unquoted heredoc without $ or backtick is literal", () => {
	assert.equal(extractGhTexts("gh issue create -t T -F - <<EOF\nPlain text.\nEOF", "/")[0]?.body, "Plain text.");
});

test("extractGhTexts reads --body-file relative to cwd; a missing file is unchecked", (t) => {
	const dir = tempDir(t);
	fs.writeFileSync(path.join(dir, "body.md"), "From a file.");
	assert.equal(extractGhTexts("gh pr create --title T --body-file body.md", dir)[0]?.body, "From a file.");
	assert.equal(extractGhTexts("gh pr create --title T --body-file=body.md", dir)[0]?.body, "From a file.");
	assert.deepEqual(extractGhTexts("gh pr create --title T --body-file missing.md", dir), [{ kind: "pr", title: "T", body: undefined }]);
});

test("extractGhTexts marks a body file over MAX_BODY_FILE_BYTES as too large", (t) => {
	const dir = tempDir(t);
	fs.writeFileSync(path.join(dir, "big.md"), "x".repeat(MAX_BODY_FILE_BYTES + 1));
	assert.deepEqual(extractGhTexts("gh pr create --title T --body-file big.md", dir), [{ kind: "pr", title: "T", body: undefined, bodyFileTooLarge: true }]);
});

test("extractGhTexts does not throw on deeply nested substitutions, many heredocs or open quotes", () => {
	const deep = `gh pr create --body "${'$("'.repeat(MAX_SUBSTITUTION_DEPTH * 100)}`;
	assert.equal(extractGhTexts(deep, "/")[0]?.body, undefined);
	assert.doesNotThrow(() => extractGhTexts(`gh pr create ${"<<EOF ".repeat(10_000)}\n`, "/"));
	assert.doesNotThrow(() => extractGhTexts(`gh pr create ${`"'`.repeat(10_000)}`, "/"));
});
