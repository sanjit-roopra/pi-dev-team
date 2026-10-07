import assert from "node:assert/strict";
import { test } from "node:test";
import { MIN_DEDUP_CHARS, ReadTracker } from "../../extensions/dev-team/lib/read-dedup.ts";

const BIG = "x".repeat(MIN_DEDUP_CHARS);
const read = (tracker: ReadTracker, input: Record<string, unknown>, text = BIG, cwd = "/repo") => tracker.noteForRepeatedRead({ cwd, input, text });
/** A tracker that already holds `input` as a reference from an earlier turn. */
function withReference(input: Record<string, unknown>, text = BIG): ReadTracker {
	const tracker = new ReadTracker();
	read(tracker, input, text);
	tracker.endTurn();
	return tracker;
}

test("read dedup: a repeat in a later turn gets a note", () => {
	const tracker = withReference({ path: "src/a.ts" });
	assert.match(read(tracker, { path: "src/a.ts" }) ?? "", /^\[dev-team: src\/a\.ts is unchanged\./);
});

test("read dedup: one note per reference; asking again returns the text, which becomes the new reference", () => {
	const tracker = withReference({ path: "a.ts" });
	assert.ok(read(tracker, { path: "a.ts" }), "note");
	assert.equal(read(tracker, { path: "a.ts" }), undefined, "asked again: full text");
	tracker.endTurn();
	assert.ok(read(tracker, { path: "a.ts" }), "the full text is the new reference");
});

test("read dedup: a repeat in the same turn returns the text (parallel reads complete in any order)", () => {
	const tracker = new ReadTracker();
	read(tracker, { path: "a.ts" });
	assert.equal(read(tracker, { path: "a.ts" }), undefined);
});

test("read dedup: relative and absolute paths name one file; the cwd is part of the key", () => {
	assert.ok(read(withReference({ path: "src/a.ts" }), { path: "/repo/src/a.ts" }), "same file");
	assert.equal(read(withReference({ path: "src/a.ts" }), { path: "src/a.ts" }, BIG, "/other"), undefined, "other cwd");
});

test("read dedup: changed text returns the text and becomes the new reference", () => {
	const tracker = withReference({ path: "a.ts" });
	const changed = `${BIG}y`;
	assert.equal(read(tracker, { path: "a.ts" }, changed), undefined);
	tracker.endTurn();
	assert.ok(read(tracker, { path: "a.ts" }, changed));
});

test("read dedup: each range is its own reference, and the note names it", () => {
	const cases: [Record<string, unknown>, RegExp][] = [
		[{ offset: 10 }, /\(offset 10, limit none\) is unchanged/],
		[{ limit: 50 }, /\(offset 1, limit 50\) is unchanged/],
		[{ offset: 3, limit: 5 }, /\(offset 3, limit 5\) is unchanged/],
	];
	for (const [range, note] of cases) {
		const tracker = withReference({ path: "a.ts" });
		assert.equal(read(tracker, { path: "a.ts", ...range }), undefined, `${JSON.stringify(range)} is new`);
		tracker.endTurn();
		assert.match(read(tracker, { path: "a.ts", ...range }) ?? "", note);
	}
});

test("read dedup: short reads are repeated as is, and a short read drops the reference", () => {
	const short = "y".repeat(MIN_DEDUP_CHARS - 1);
	assert.equal(read(withReference({ path: "b.ts" }, short), { path: "b.ts" }, short), undefined, "short");
	const tracker = withReference({ path: "c.ts" });
	read(tracker, { path: "c.ts" }, short);
	tracker.endTurn();
	assert.equal(read(tracker, { path: "c.ts" }), undefined, "big, short, big: the short read dropped the reference");
});

test("read dedup: a call without a string path is never noted", () => {
	for (const input of [{}, { path: 42 }]) {
		const tracker = withReference(input);
		assert.equal(read(tracker, input), undefined, JSON.stringify(input));
	}
});

test("read dedup: reset forgets every reference", () => {
	const tracker = withReference({ path: "a.ts" });
	tracker.reset();
	assert.equal(read(tracker, { path: "a.ts" }), undefined);
});
