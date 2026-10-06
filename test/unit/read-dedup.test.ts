import assert from "node:assert/strict";
import { test } from "node:test";
import { MIN_DEDUP_CHARS, ReadDedup } from "../../extensions/dev-team/lib/read-dedup.ts";

const BIG = "x".repeat(MIN_DEDUP_CHARS);
const read = (dedup: ReadDedup, input: Record<string, unknown>, text = BIG) => dedup.check({ cwd: "/repo", input, text });

test("read dedup: the same text for the same range gets a note, once", () => {
	const dedup = new ReadDedup();
	assert.equal(read(dedup, { path: "src/a.ts" }), undefined, "first read is the reference");
	assert.match(read(dedup, { path: "src/a.ts" }) ?? "", /src\/a\.ts is unchanged/, "second read gets the note");
	assert.equal(read(dedup, { path: "src/a.ts" }), undefined, "asking again right after a note returns the text");
	assert.match(read(dedup, { path: "src/a.ts" }) ?? "", /unchanged/, "that text is the new reference");
});

test("read dedup: the same file by relative and absolute path is one reference", () => {
	const dedup = new ReadDedup();
	read(dedup, { path: "src/a.ts" });
	assert.match(read(dedup, { path: "/repo/src/a.ts" }) ?? "", /unchanged/);
});

test("read dedup: changed text, another range or a short read returns the text", () => {
	const dedup = new ReadDedup();
	read(dedup, { path: "a.ts" });
	assert.equal(read(dedup, { path: "a.ts" }, `${BIG}y`), undefined, "the file changed");
	assert.equal(read(dedup, { path: "a.ts", offset: 10 }), undefined, "another range is its own reference");
	assert.match(read(dedup, { path: "a.ts", offset: 10 }) ?? "", /\(offset 10, limit none\) is unchanged/, "the note names the range");
	const short = "y".repeat(MIN_DEDUP_CHARS - 1);
	read(dedup, { path: "b.ts" }, short);
	assert.equal(read(dedup, { path: "b.ts" }, short), undefined, "short reads are repeated as is");
	assert.equal(read(dedup, {}), undefined, "no path");
});

test("read dedup: reset forgets every reference", () => {
	const dedup = new ReadDedup();
	read(dedup, { path: "a.ts" });
	dedup.reset();
	assert.equal(read(dedup, { path: "a.ts" }), undefined);
});
