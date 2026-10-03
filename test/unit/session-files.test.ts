import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { type TestContext, test } from "node:test";
import { removeProcessFiles, saveFullOutput, writeSessionFile } from "../../extensions/dev-team/lib/session-files.ts";
import { writeTranscript } from "../../extensions/dev-team/lib/transcript.ts";

function baseDir(t: TestContext): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dt-sf-"));
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	return dir;
}

test("a saved full output is readable only by the owner, in an owner-only directory", (t) => {
	const base = baseDir(t);
	const file = saveFullOutput("s1", "Explore", "abc", "complete text", base);
	assert.ok(file);
	assert.equal(fs.readFileSync(file, "utf-8"), "complete text");
	if (process.platform !== "win32") {
		assert.equal(fs.statSync(file).mode & 0o777, 0o600);
		assert.equal(fs.statSync(path.dirname(file)).mode & 0o777, 0o700);
	}
});

test("session files never follow or overwrite an existing path", (t) => {
	const base = baseDir(t);
	const target = path.join(base, "elsewhere.md");
	fs.writeFileSync(target, "original");
	const dir = path.dirname(writeSessionFile("s1", "subagent-output", "first.md", "x", base));
	fs.symlinkSync(target, path.join(dir, "planted.md"));
	assert.throws(() => writeSessionFile("s1", "subagent-output", "planted.md", "attacker-controlled", base));
	assert.equal(fs.readFileSync(target, "utf-8"), "original");
});

test("session and agent names cannot leave the session directory", (t) => {
	const base = baseDir(t);
	const file = saveFullOutput("../../etc", "../x", "1", "y", base);
	assert.ok(file);
	assert.ok(path.resolve(file).startsWith(path.resolve(base) + path.sep));
	assert.ok(!path.relative(base, file).split(path.sep).includes(".."));
});

test("a full output that cannot be saved degrades to no file", (t) => {
	const base = baseDir(t);
	assert.ok(saveFullOutput("s1", "a", "1", "first", base));
	assert.equal(saveFullOutput("s1", "a", "1", "second", base), undefined, "exclusive create refuses the existing file");
});

test("removing the process files is idempotent", (t) => {
	const base = baseDir(t);
	const file = saveFullOutput("mine", "a", "1", "y", base);
	removeProcessFiles(base);
	removeProcessFiles(base);
	assert.ok(file && !fs.existsSync(file));
	assert.ok(!fs.existsSync(base));
});

test("without a base directory, files go to one private per-process directory, removed whole", () => {
	removeProcessFiles(); // no root yet, or one from an earlier test: either way a no-op or a clean slate
	const output = saveFullOutput("s1", "a", "1", "y");
	const transcript = writeTranscript("s2", "abc", ['{"a":1}', '{"b":2}']);
	assert.ok(output);
	const root = path.dirname(path.dirname(path.dirname(output)));
	assert.equal(path.dirname(path.dirname(path.dirname(transcript))), root, "transcripts share the root");
	assert.match(path.basename(root), /^pi-dev-team-.{6}$/, "mkdtemp name");
	assert.equal(path.basename(transcript), "agent-abc.jsonl");
	assert.equal(fs.readFileSync(transcript, "utf-8"), '{"a":1}\n{"b":2}\n');
	if (process.platform !== "win32") {
		assert.equal(fs.statSync(root).mode & 0o777, 0o700);
		assert.equal(fs.statSync(transcript).mode & 0o777, 0o600);
	}
	removeProcessFiles();
	assert.ok(!fs.existsSync(root));
	const next = saveFullOutput("s1", "a", "1", "y");
	assert.ok(next && !next.startsWith(root + path.sep), "a fresh root after removal");
	removeProcessFiles();
});
