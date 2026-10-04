import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { type TestContext, test } from "node:test";
import { MAX_REPO_FILE_BYTES, readBoundedFile, readSmallFile } from "../../extensions/dev-team/lib/safe-read.ts";

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

/** A FIFO in a fresh temp dir, or undefined (and the test skipped) where mkfifo is unavailable. */
function makeFifo(t: TestContext): string | undefined {
	const fifo = path.join(tempDir(t), "pipe");
	if (process.platform === "win32" || spawnSync("mkfifo", [fifo]).status !== 0) {
		t.skip("mkfifo unavailable");
		return undefined;
	}
	return fifo;
}

test("readSmallFile skips a FIFO without blocking", { timeout: 5000 }, (t) => {
	const fifo = makeFifo(t);
	if (fifo) assert.equal(readSmallFile(fifo), undefined);
});

test("readSmallFile: an explicit maxBytes is the limit, at and one byte over", (t) => {
	const dir = tempDir(t);
	fs.writeFileSync(path.join(dir, "ten.md"), "x".repeat(10));
	assert.equal(readSmallFile(path.join(dir, "ten.md"), 10), "x".repeat(10));
	assert.equal(readSmallFile(path.join(dir, "ten.md"), 9), undefined);
});

test("readSmallFile skips a symlink to a FIFO without blocking", { timeout: 5000 }, (t) => {
	const fifo = makeFifo(t);
	if (!fifo) return;
	const link = path.join(path.dirname(fifo), "link.md");
	fs.symlinkSync(fifo, link);
	assert.equal(readSmallFile(link), undefined);
});

test("readSmallFile skips a device without reading it", { timeout: 5000 }, (t) => {
	if (process.platform === "win32") return t.skip("no /dev/zero");
	assert.equal(readSmallFile("/dev/zero"), undefined);
});

test("readBoundedFile says why a file was skipped", (t) => {
	const dir = tempDir(t);
	fs.writeFileSync(path.join(dir, "ten.md"), "x".repeat(10));
	assert.deepEqual(readBoundedFile(path.join(dir, "ten.md"), 10), { text: "x".repeat(10) });
	assert.deepEqual(readBoundedFile(path.join(dir, "ten.md"), 9), { skipped: "too-large" });
	assert.deepEqual(readBoundedFile(dir), { skipped: "not-a-file" });
	assert.deepEqual(readBoundedFile(path.join(dir, "missing")), { skipped: "unreadable" });
});

test("readSmallFile stops at maxBytes on a file that reports size 0 (Linux /proc)", (t) => {
	if (process.platform !== "linux") return t.skip("needs Linux /proc");
	assert.equal(readSmallFile("/proc/self/maps", 16), undefined);
	assert.ok(readSmallFile("/proc/self/maps")?.length);
});
