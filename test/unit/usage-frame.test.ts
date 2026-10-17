import assert from "node:assert/strict";
import { test } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { type FrameStyle, frameLines } from "../../extensions/spend/lib/usage-frame.ts";

const identity = (text: string) => text;
const plain: FrameStyle = { border: identity, title: identity, muted: identity, panel: identity };

test("frame: the title sits in the top edge, the footer in the bottom one, and every body line is padded between the sides", () => {
	assert.deepEqual(frameLines(["ab", ""], { width: 16, title: "Spend", footer: "Esc", style: plain }), [
		"╭─ Spend ──────╮",
		"│ ab           │",
		"│              │",
		"╰─ Esc ────────╯",
	]);
});

test("frame: edge text that does not fit is cut, and an edge without room for any is a plain rule", () => {
	assert.deepEqual(frameLines(["x"], { width: 12, title: "This session", footer: "", style: plain }), ["╭─ This … ─╮", "│ x        │", "╰──────────╯"]);
});

test("frame: each part gets its own style and the panel wraps every whole line", () => {
	const tagged: FrameStyle = { border: (t) => `b(${t})`, title: (t) => `t(${t})`, muted: (t) => `m(${t})`, panel: (l) => `p(${l})` };
	assert.deepEqual(frameLines(["x"], { width: 10, title: "T", footer: "F", style: tagged }), [
		"p(b(╭─ )t(T)b( ────╮))",
		"p(b(│) x      b(│))",
		"p(b(╰─ )m(F)b( ────╯))",
	]);
});

test("frame: every line is exactly the width, and below the minimum the parts are shown bare and cut", () => {
	for (let width = 6; width <= 40; width++) {
		const lines = frameLines(["", "b"], { width, title: "This month (Oct 1 – Oct 4)", footer: "Tab view · Esc close", style: plain });
		for (const line of lines) assert.equal(visibleWidth(line), width, `${width}: "${line}"`);
	}
	assert.deepEqual(frameLines(["b"], { width: 4, title: "Title", footer: "Esc close", style: plain }), ["Tit…", "b", "Esc…"]);
});
