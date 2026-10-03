import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { type TestContext, test } from "node:test";
import { MAX_REPO_FILE_BYTES, readSmallFile } from "../../extensions/dev-team/lib/safe-read.ts";

function tempDir(t: TestContext): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dt-read-"));
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	return dir;
}

test("readSmallFile reads a small regular file, also through a symlink", (t) => {
	const dir = tempDir(t);
	fs.writeFileSync(path.join(dir, "a.md"), "hello");
	fs.symlinkSync(path.join(dir, "a.md"), path.join(dir, "link.md"));
	assert.equal(readSmallFile(path.join(dir, "a.md")), "hello");
	assert.equal(readSmallFile(path.join(dir, "link.md")), "hello");
});

test("readSmallFile: a file of exactly the limit is read, one byte more is not", (t) => {
	const dir = tempDir(t);
	fs.writeFileSync(path.join(dir, "at.md"), "x".repeat(MAX_REPO_FILE_BYTES));
	fs.writeFileSync(path.join(dir, "over.md"), "x".repeat(MAX_REPO_FILE_BYTES + 1));
	assert.equal(readSmallFile(path.join(dir, "at.md"))?.length, MAX_REPO_FILE_BYTES);
	assert.equal(readSmallFile(path.join(dir, "over.md")), undefined);
});

test("readSmallFile skips missing files, directories and links to directories", (t) => {
	const dir = tempDir(t);
	fs.mkdirSync(path.join(dir, "sub"));
	fs.symlinkSync(path.join(dir, "sub"), path.join(dir, "to-dir"));
	assert.equal(readSmallFile(path.join(dir, "missing")), undefined);
	assert.equal(readSmallFile(path.join(dir, "sub")), undefined);
	assert.equal(readSmallFile(path.join(dir, "to-dir")), undefined);
});

test("readSmallFile skips a FIFO without blocking", (t) => {
	const dir = tempDir(t);
	const fifo = path.join(dir, "pipe.md");
	if (process.platform === "win32" || spawnSync("mkfifo", [fifo]).status !== 0) return t.skip("mkfifo unavailable");
	assert.equal(readSmallFile(fifo), undefined);
});
