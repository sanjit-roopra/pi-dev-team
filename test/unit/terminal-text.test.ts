import assert from "node:assert/strict";
import { test } from "node:test";
import { cutToWidth, sanitizeTerminalText, toSingleLine, toSpacedSingleLine } from "../../extensions/dev-team/lib/terminal-text.ts";

// SGR, OSC 52 (clipboard), erase screen, OSC 8 hyperlink, 8-bit CSI, CR and NUL.
const HOSTILE = "x\x1b[31m\x1b]52;c;ZXZpbA==\x07\x1b[2J\x1b]8;;https://x\x1b\\y\x1b]8;;\x1b\\\x9b31m\rFAKE\x00";
const UNSAFE = /[\x00-\x1f\x7f-\x9f\ufff9-\ufffb]/;

test("sanitizeTerminalText removes escape sequences and controls, keeps tab and newline", () => {
	assert.equal(sanitizeTerminalText(HOSTILE), "xy31m\nFAKE");
	assert.equal(sanitizeTerminalText("a\tb\nc\r\nd"), "a\tb\nc\nd");
	assert.equal(sanitizeTerminalText("a\ufff9b\ufffbc"), "abc");
});

test("toSingleLine also removes tabs and newlines, joining what they separated", () => {
	assert.equal(toSingleLine(HOSTILE), "xy31mFAKE");
	assert.equal(toSingleLine("bad\x1b[31m\t\nname"), "badname");
});

test("toSpacedSingleLine turns each run of control characters into one space, after removing escape sequences", () => {
	assert.equal(toSpacedSingleLine("a\x00b"), "a b");
	assert.equal(toSpacedSingleLine("a\n\t\r\nb\x0c\x0cc"), "a b c");
	assert.equal(toSpacedSingleLine("EACCES\x85open"), "EACCES open");
	assert.equal(toSpacedSingleLine("foo\x1b[0mbar\x1b]0;title\x07!"), "foobar!");
	assert.ok(!UNSAFE.test(toSpacedSingleLine(HOSTILE)), JSON.stringify(toSpacedSingleLine(HOSTILE)));
	assert.equal(toSpacedSingleLine("a\ufff9b"), "ab");
});

test("cutToWidth keeps text that fits, cuts with an ellipsis, and returns nothing when not even that fits", () => {
	assert.equal(cutToWidth("abc", 3), "abc");
	assert.equal(cutToWidth("abcdef", 4), "abc…");
	assert.equal(cutToWidth("abc", 0), "");
	assert.equal(cutToWidth("日本語", 4), "日…");
});
