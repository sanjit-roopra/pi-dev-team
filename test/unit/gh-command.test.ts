import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { type TestContext, test } from "node:test";
import { extractGhTexts, type GhText, MAX_BODY_FILE_BYTES } from "../../extensions/dev-team/lib/gh-command.ts";
import { MAX_LINT_CHARS } from "../../extensions/dev-team/lib/github-style.ts";
import { MAX_SUBSTITUTION_DEPTH } from "../../extensions/dev-team/lib/shell-scan.ts";

test("a body file can hold MAX_LINT_CHARS characters of UTF-8 (4 bytes each at most)", () => {
	assert.equal(MAX_BODY_FILE_BYTES, MAX_LINT_CHARS * 4);
});

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
	{ name: "--body-file=- with a heredoc", command: "gh issue create -t T --body-file=- <<'EOF'\nInline flag.\nEOF", expected: { body: "Inline flag." } },
	{ name: "a <<\\EOF heredoc as literal", command: "gh issue create -t T -F - <<\\EOF\nCost: $5.\nEOF", expected: { body: "Cost: $5." } },
	{ name: "a partly quoted <<E\"OF\" heredoc as literal", command: 'gh issue create -t T -F - <<E"OF"\nCost: $5.\nEOF', expected: { body: "Cost: $5." } },
	{ name: "the last body flag: --body after a too-large file", command: "gh pr create --body-file big.md --body x", expected: { body: "x", bodyFileTooLarge: undefined } },
	{ name: "-t inside a heredoc is not the title", command: `gh pr create --body "$(cat <<'EOF'\nRun npm test -t foo.\nEOF\n)" --title Real`, expected: { title: "Real", body: "Run npm test -t foo." } },
];

for (const valueCase of literalValueCases) {
	test(`extractGhTexts reads ${valueCase.name}`, (t) => {
		const dir = tempDir(t);
		fs.writeFileSync(path.join(dir, "big.md"), "x".repeat(MAX_BODY_FILE_BYTES + 1));
		const [ghText] = extractGhTexts(valueCase.command, dir);
		for (const [key, value] of Object.entries(valueCase.expected)) assert.equal(ghText?.[key as keyof GhText], value, key);
	});
}

test("extractGhTexts finds gh after shell keywords, wrappers, cd &&, NAME=value prefixes and by path", () => {
	const ghCall = "gh issue create -t T -b 'B'";
	for (const command of [
		`cd repo && GH_PAGER= ${ghCall}`,
		`GH_TOKEN=$TOKEN ${ghCall}`,
		`GH_REPO=$(git remote get-url origin) ${ghCall}`,
		`if ${ghCall}; then echo ok; fi`,
		`if true; then ${ghCall}; else ${ghCall}; fi`,
		`while false; do ${ghCall}; done`,
		`! ${ghCall}`,
		`{ ${ghCall}; }`,
		`env GH_HOST=x ${ghCall}`,
		`time ${ghCall}`,
		`command ${ghCall}`,
		`nohup ${ghCall}`,
		`exec ${ghCall}`,
		`/usr/local/bin/${ghCall}`,
	]) {
		assert.equal(extractGhTexts(command, "/")[0]?.body, "B", command);
	}
});

test("extractGhTexts does not look inside bash -c or xargs (documented limit)", () => {
	assert.deepEqual(extractGhTexts(`bash -c "gh issue create -t T -b 'x — y'"`, "/"), []);
	assert.deepEqual(extractGhTexts("echo 1 | xargs gh issue comment -b 'x — y'", "/"), []);
});

test("extractGhTexts returns every chained gh command", () => {
	const texts = extractGhTexts("gh pr create -t A -b 'one' && gh pr comment 1 -b 'two'", "/");
	assert.deepEqual(texts.map((t) => t.body), ["one", "two"]);
});

const unseenCases: { name: string; command: string; kind: GhText["kind"] }[] = [
	{ name: "a variable", command: `gh pr create --title T --body "$BODY"`, kind: "pr" },
	{ name: "a variable as the body file", command: `gh pr create --title T --body-file "$F"`, kind: "pr" },
	{ name: "a command substitution", command: `gh pr create --title T --body "$(generate_body)"`, kind: "pr" },
	{ name: "a backtick substitution", command: "gh pr create --title T --body `generate_body`", kind: "pr" },
	{ name: "ANSI-C quoting", command: "gh pr create --title T --body $'## Summary\\n- a'", kind: "pr" },
	{ name: "an unclosed quote", command: `gh pr create --title T --body "never closed`, kind: "pr" },
	{ name: "an unquoted heredoc that expands $", command: "gh pr create --title T --body \"$(cat <<EOF\n$(cat notes.md)\nEOF\n)\"", kind: "pr" },
	{ name: "an unquoted stdin heredoc that expands $", command: "gh issue create -t T -F - <<EOF\nSee $URL\nEOF", kind: "issue" },
	{ name: "a here-string that expands $", command: `gh issue comment 1 -F - <<< "$NOTE"`, kind: "comment" },
];

for (const unseenCase of unseenCases) {
	test(`extractGhTexts leaves the body unchecked when it comes from ${unseenCase.name}`, () => {
		const [ghText] = extractGhTexts(unseenCase.command, "/");
		assert.equal(ghText?.kind, unseenCase.kind);
		assert.equal(ghText?.body, undefined);
	});
}

test("extractGhTexts: an unquoted heredoc without $ or backtick is literal", () => {
	assert.equal(extractGhTexts("gh issue create -t T -F - <<EOF\nPlain text.\nEOF", "/")[0]?.body, "Plain text.");
});

test("extractGhTexts reads --body-file relative to cwd, in both flag spellings", (t) => {
	const dir = tempDir(t);
	fs.writeFileSync(path.join(dir, "body.md"), "From a file.");
	for (const command of ["gh pr create --title T --body-file body.md", "gh pr create --title T --body-file=body.md"]) {
		assert.equal(extractGhTexts(command, dir)[0]?.body, "From a file.", command);
	}
});

test("extractGhTexts leaves a missing body file unchecked", (t) => {
	assert.deepEqual(extractGhTexts("gh pr create --title T --body-file missing.md", tempDir(t)), [{ kind: "pr", title: "T", body: undefined }]);
});

const bodyFileSizeCases: { name: string; flags: string; expected: Partial<GhText> }[] = [
	{ name: "a lone too-large file", flags: "--body-file big.md", expected: { body: undefined, bodyFileTooLarge: true } },
	{ name: "a too-large file, then a small one", flags: "--body-file big.md --body-file small.md", expected: { body: "Small." } },
	{ name: "a body, then a too-large file", flags: "--body x --body-file big.md", expected: { body: undefined, bodyFileTooLarge: true } },
];

for (const sizeCase of bodyFileSizeCases) {
	test(`extractGhTexts: body file size with ${sizeCase.name}`, (t) => {
		const dir = tempDir(t);
		fs.writeFileSync(path.join(dir, "big.md"), "x".repeat(MAX_BODY_FILE_BYTES + 1));
		fs.writeFileSync(path.join(dir, "small.md"), "Small.");
		assert.deepEqual(extractGhTexts(`gh pr create ${sizeCase.flags}`, dir), [{ kind: "pr", ...sizeCase.expected }]);
	});
}

test("extractGhTexts finishes on deeply nested substitutions, many heredocs or open quotes", { timeout: 10_000 }, () => {
	const deep = `gh pr create --body "${'$("'.repeat(MAX_SUBSTITUTION_DEPTH * 100)}`;
	assert.deepEqual(extractGhTexts(deep, "/"), [{ kind: "pr", body: undefined }]);
	assert.deepEqual(extractGhTexts(`gh pr create ${"<<EOF ".repeat(10_000)}\n`, "/"), [{ kind: "pr" }]);
	assert.deepEqual(extractGhTexts(`gh pr create -b ${`"'`.repeat(10_000)}`, "/"), [{ kind: "pr", body: undefined }]);
});
