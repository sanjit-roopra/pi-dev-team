import assert from "node:assert/strict";
import { test } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { barChartLines, type BarChartOptions, type ChartRow } from "../../extensions/dev-team/lib/usage-chart.ts";
import { splitBarLines, type SplitBarOptions, type SplitPart } from "../../extensions/dev-team/lib/usage-split-bar.ts";

const identity = (text: string) => text;
const style = { bar: identity, muted: identity };
const percent = (share: number) => `${(share * 100).toFixed(1)}%`;

// Layout is label | bar | value | share, two spaces apart. With one-character labels, two-character
// values and "83.3%"-style shares, a bar area of N cells needs a width of 1 + 2 + 5 + 3 * 2 + N.
const widthForBar = (cells: number) => 14 + cells;
const format = { usd: String, credits: (c: number) => `${c} cr`, tokens: (t: number) => `${t} tok`, share: percent };
const options = (width: number, extra: Partial<BarChartOptions> = {}): BarChartOptions => ({
	width,
	maxRows: 99,
	format,
	hasCredits: (credits) => credits > 0,
	style,
	...extra,
});
const withUsd = (usd: (n: number) => string): Partial<BarChartOptions> => ({ format: { ...format, usd } });
const row = (label: string, usd: number, share = 0.5, more: Partial<ChartRow> = {}): ChartRow => ({ label, usd, credits: 0, tokens: 7, share, ...more });

test("bars scale to the largest row, with label, value and share on each line", () => {
	const lines = barChartLines([row("A", 50, 50 / 60), row("B", 10, 10 / 60)], options(widthForBar(10)));
	assert.deepEqual(lines, ["A  ██████████  50  83.3%", "B  ██          10  16.7%"]);
});

test("fractional bar lengths use eighth blocks", () => {
	const lines = barChartLines([row("A", 80), row("B", 44)], options(widthForBar(10)));
	assert.deepEqual(lines, ["A  ██████████  80  50.0%", "B  █████▌      44  50.0%"]);
});

test("a non-zero row is always visible", () => {
	const lines = barChartLines([row("A", 90), row("B", 0.09)], options(widthForBar(10), withUsd((n) => String(Math.round(n)))));
	assert.deepEqual(lines, ["A  ██████████  90  50.0%", "B  ▏            0  50.0%"]);
});

test("a zero row has an empty bar, and its tokens add a tokens column to every row", () => {
	const lines = barChartLines([row("A", 10), row("B", 0)], options(widthForBar(10) + 7));
	assert.deepEqual(lines, ["A  ██████████  10  7 tok  50.0%", `B  ${" ".repeat(10)}   0  7 tok  50.0%`]);
});

test("rows with no zero cost show no tokens column", () => {
	const lines = barChartLines([row("A", 10), row("B", 5)], options(80));
	assert.ok(lines.every((l) => !l.includes("tok")), lines.join("\n"));
});

test("a credits column shows when any row has credits; rows without leave it blank", () => {
	const lines = barChartLines([row("A", 50, 50 / 60, { credits: 5000 }), row("B", 10, 10 / 60)], options(widthForBar(10) + 9));
	assert.deepEqual(lines, ["A  ██████████  50  5000 cr  83.3%", `B  ██${" ".repeat(8)}  10           16.7%`]);
});

test("a narrow terminal drops share, then tokens, then credits, before the bar", () => {
	const rows = [row("A", 50, 0.5, { credits: 5000 }), row("B", 0, 0.5)];
	const full = barChartLines(rows, options(80));
	assert.ok(full[0].includes("5000 cr") && full[0].includes("7 tok") && full[0].includes("%"), full[0]);
	const columnsAt = (width: number) => {
		const [line] = barChartLines(rows, options(width));
		return { credits: line.includes("cr"), tokens: line.includes("tok"), share: line.includes("%"), bar: line.includes("█") };
	};
	const widths = Array.from({ length: 60 }, (_, i) => i + 10).map(columnsAt);
	for (const c of widths) {
		if (c.share) assert.ok(c.tokens && c.credits, "share goes first");
		if (c.tokens) assert.ok(c.credits, "tokens go before credits");
		if (c.credits) assert.ok(c.bar, "credits go before the bar");
	}
});

const LONG_LABEL = "model-with-a-very-long-name-1234567890-abc"; // 40 characters
const longRows = [row("model-a", 50, 50 / 60), row(LONG_LABEL, 10, 10 / 60)];

test("a wide terminal keeps the full label and fits the width", () => {
	const lines = barChartLines(longRows, options(80));
	assert.ok(lines.some((l) => l.includes(LONG_LABEL)));
	for (const l of lines) assert.ok(visibleWidth(l) <= 80, l);
});

test("a narrow terminal truncates the label first, keeping bar, value and share", () => {
	const lines = barChartLines(longRows, options(30));
	assert.ok(lines[1].startsWith("model-with…  "), lines[1]);
	assert.ok(lines[1].includes("█") && lines[1].includes("  10  16.7%"), lines[1]);
	for (const l of lines) assert.ok(visibleWidth(l) <= 30, l);
});

test("a very narrow terminal drops the share first, keeping label, bar and value", () => {
	const lines = barChartLines(longRows, options(24));
	assert.ok(lines.every((l) => !l.includes("%") && l.includes("█")), lines.join("\n"));
});

test("a narrower terminal then drops the bar, leaving label and value", () => {
	assert.deepEqual(barChartLines(longRows, options(10)), ["model…  50", "model…  10"]);
});

// Credits 10, 9, ... 1 (total 55): the last three rows sum to 6 credits, 6/55 = 10.9%.
const countdown = Array.from({ length: 10 }, (_, i) => row(`m${i}`, 10 - i, (10 - i) / 55));

// Every layout the width loops run over: its rows, its options, and the value each line must show.
const layouts: { name: string; rows: ChartRow[]; extra: Partial<BarChartOptions>; values: string[] }[] = [
	{ name: "long labels", rows: longRows, extra: {}, values: ["50", "10"] },
	{ name: "short labels", rows: [row("A", 50), row("B", 10)], extra: {}, values: ["50", "10"] },
	{ name: "folded rows", rows: countdown, extra: { maxRows: 4 }, values: ["10", "9", "8", "28"] },
	{ name: "wide characters", rows: [row("日本語のモデル名", 50), row("日本", 10)], extra: {}, values: ["50", "10"] },
];

test("no line is wider than the width, at every width and layout", () => {
	for (const { name, rows, extra } of layouts) {
		for (let width = 0; width <= 100; width++) {
			for (const l of barChartLines(rows, options(width, extra))) assert.ok(visibleWidth(l) <= width, `${name} at ${width}: ${l}`);
		}
	}
});

test("every line keeps its value once the width holds the value", () => {
	for (const { name, rows, extra, values } of layouts) {
		for (let width = 2; width <= 100; width++) {
			const lines = barChartLines(rows, options(width, extra));
			values.forEach((value, i) => assert.ok(lines[i].includes(value), `${name} at ${width}: ${lines[i]}`));
		}
	}
});

test("a wide-character label narrower than its column is cut within the width", () => {
	const lines = barChartLines([row("日本語のモデル名", 50)], options(12));
	assert.deepEqual(lines, ["日本語…   50"]); // 3 wide characters and the ellipsis fill 7 of the 8 label columns
});

test("rows beyond the limit fold into an other row with the summed value and share", () => {
	const lines = barChartLines(countdown, options(60, { maxRows: 8 }));
	assert.equal(lines.length, 8);
	assert.ok(lines[6].startsWith("m6"), lines[6]);
	assert.ok(lines.every((l) => !l.includes("tok")), "no zero row, so no tokens column");
	assert.ok(lines[7].startsWith("other (3)"), lines[7]);
	assert.ok(lines[7].endsWith("  6  10.9%"), lines[7]);
});

test("an other row larger than every ranked row gets the full-width bar", () => {
	const rows = [row("A", 1, 0.25), row("B", 1, 0.25), row("C", 5, 0.25), row("D", 5, 0.25)];
	const [, , other] = barChartLines(rows, options(60, { maxRows: 3 }));
	assert.equal(other, `other (2)  ${"█".repeat(30)}  10  50.0%`);
});

test("exactly the row limit shows every row and no other row", () => {
	const lines = barChartLines(countdown.slice(0, 8), options(60, { maxRows: 8 }));
	assert.equal(lines.length, 8);
	assert.ok(lines.every((l) => !l.includes("other")));
});

test("no rows, or no room for rows, give no lines", () => {
	assert.deepEqual(barChartLines([], options(60)), []);
	assert.deepEqual(barChartLines(countdown, options(60, { maxRows: 0 })), []);
});

test("a limit of one folds everything into other", () => {
	const lines = barChartLines(countdown, options(60, { maxRows: 1 }));
	assert.equal(lines.length, 1);
	assert.ok(lines[0].startsWith("other (10)"), lines[0]);
});

const splitStyle = { segment: (_position: number, text: string) => text, muted: identity };
const splitOptions = (width: number, extra: Partial<SplitBarOptions> = {}): SplitBarOptions => ({ width, formatValue: String, style: splitStyle, ...extra });
const split = (main: number, subagents: number, overhead: number): SplitPart[] => [
	{ label: "main", amount: main },
	{ label: "subagents", amount: subagents },
	{ label: "overhead", amount: overhead },
];

test("split bar: segments in the given order with a legend of values", () => {
	assert.deepEqual(splitBarLines(split(30, 60, 10), splitOptions(80, { maxBarCells: 10 })), [
		"███▓▓▓▓▓▓▒",
		"█ main 30 · ▓ subagents 60 · ▒ overhead 10",
	]);
});

test("split bar: the given order decides the segment order and glyphs", () => {
	assert.deepEqual(splitBarLines(split(30, 60, 10).reverse(), splitOptions(80, { maxBarCells: 10 })), ["█▓▓▓▓▓▓▒▒▒", "█ overhead 10 · ▓ subagents 60 · ▒ main 30"]);
});

test("split bar: the legend value can use the part's share of the total", () => {
	const lines = splitBarLines(split(30, 60, 10), splitOptions(80, { maxBarCells: 10, formatValue: (_, share) => `${Math.round(share * 100)}%` }));
	assert.equal(lines[1], "█ main 30% · ▓ subagents 60% · ▒ overhead 10%");
});

test("split bar: past four parts, the rest fold into one other segment", () => {
	const parts = ["a", "b", "c", "d", "e"].map((label, i) => ({ label, amount: 50 - i * 10 }));
	assert.deepEqual(splitBarLines(parts, splitOptions(80, { maxBarCells: 15 })), ["█████▓▓▓▓▒▒▒░░░", "█ a 50 · ▓ b 40 · ▒ c 30 · ░ other 30"]);
});

test("split bar: a label from a session file is made one line before it is drawn", () => {
	const [, legend] = splitBarLines([{ label: "evil\x1b[31m\nprovider", amount: 1 }], splitOptions(80));
	assert.ok(!/[\x00-\x1f]/.test(legend), JSON.stringify(legend));
});

test("split bar: a zero part is omitted from bar and legend, and the next part takes its glyph", () => {
	assert.deepEqual(splitBarLines(split(40, 0, 10), splitOptions(80, { maxBarCells: 10 })), ["████████▓▓", "█ main 40 · ▓ overhead 10"]);
	assert.deepEqual(splitBarLines([{ label: "main", amount: 5 }], splitOptions(80, { maxBarCells: 4 })), ["████", "█ main 5"]);
});

test("split bar: nothing to show when no part has an amount", () => {
	assert.deepEqual(splitBarLines(split(0, 0, 0), splitOptions(10)), []);
	assert.deepEqual(splitBarLines([], splitOptions(10)), []);
});

test("split bar: an uneven split fills the bar exactly, by largest remainder", () => {
	const [bar] = splitBarLines(split(1, 1, 1), splitOptions(10));
	assert.equal(bar, "████▓▓▓▒▒▒");
	const [skewed] = splitBarLines(split(5, 3, 1), splitOptions(10)); // ideal 5.56, 3.33, 1.11
	assert.equal(skewed, "██████▓▓▓▒");
});

test("split bar: a tiny part keeps at least one cell", () => {
	const [bar] = splitBarLines(split(99, 0, 1), splitOptions(10));
	assert.equal(bar, "█████████▓");
});

test("split bar: a narrow width wraps the legend between entries", () => {
	const lines = splitBarLines(split(30, 60, 10), splitOptions(30));
	assert.deepEqual(lines, ["█".repeat(9) + "▓".repeat(18) + "▒".repeat(3), "█ main 30 · ▓ subagents 60", "▒ overhead 10"]);
});

test("split bar: an entry wider than the width is truncated", () => {
	const lines = splitBarLines(split(1234567, 0, 0), splitOptions(8, { formatValue: (n: number) => n.toLocaleString("en-US") }));
	assert.deepEqual(lines, ["████████", "█ main …"]);
});

test("split bar: no line is wider than the width, at every width", () => {
	for (let width = 0; width <= 100; width++) {
		for (const l of splitBarLines(split(30, 60, 10), splitOptions(width))) assert.ok(visibleWidth(l) <= width, `${width}: ${l}`);
	}
});

test("split bar: the bar is as wide as the width, up to the default cap of 40", () => {
	for (let width = 0; width <= 100; width++) {
		const [bar] = splitBarLines(split(30, 60, 10), splitOptions(width));
		assert.equal(visibleWidth(bar), Math.min(width, 40), `${width}: ${bar}`);
	}
});

test("split bar: with too few cells, each segment gets one before the largest keeps two", () => {
	assert.deepEqual(splitBarLines(split(98, 1, 1), splitOptions(3)).slice(0, 1), ["█▓▒"]);
	assert.deepEqual(splitBarLines(split(98, 1, 1), splitOptions(2)).slice(0, 1), ["█▓"]);
	assert.deepEqual(splitBarLines(split(98, 1, 1), splitOptions(0)).slice(0, 1), [""]);
});

const noEscapes = (lines: string[], context: string) => {
	for (const l of lines) assert.ok(!/\x1b/.test(l), `${context}: ${JSON.stringify(l)}`);
};

test("identity styling leaves no escape codes in any bar chart line, at any width", () => {
	for (let width = 0; width <= 40; width++) noEscapes(barChartLines(longRows, options(width)), `bar chart at ${width}`);
});

test("identity styling leaves no escape codes in any split bar line, at any width", () => {
	for (let width = 0; width <= 40; width++) noEscapes(splitBarLines(split(30, 60, 10), splitOptions(width)), `split bar at ${width}`);
});

test("a value is cut with an ellipsis, never shown as a shorter number", () => {
	const thousands = (n: number) => n.toLocaleString("en-US");
	const at = (width: number) => barChartLines([row("model", 1234, 1)], options(width, withUsd(thousands)));
	assert.deepEqual([4, 5, 6, 7].map(at), [["1,2…"], ["1,234"], ["1,234"], ["1,234"]]);
});

test("escape sequences and control characters in a label are stripped whole before it is drawn", () => {
	const [line] = barChartLines([row("evil\x1b[31m\u009b\tred", 10)], options(40));
	assert.ok(!/[\x00-\x1f\x7f-\x9f]/.test(line), JSON.stringify(line));
	assert.ok(line.startsWith("evilred  "), line);
});

// Escape codes only, so a styled line measures as wide as a plain one; the code tells which style ran.
const sgr = (code: number, text: string) => `\x1b[${code}m${text}\x1b[0m`;
const SEGMENT_CODES = [31, 32, 33, 35];
const BAR_CODE = 34;
const MUTED_CODE = 2;
const taggedStyle: BarChartOptions["style"] = { bar: (t) => sgr(BAR_CODE, t), muted: (t) => sgr(MUTED_CODE, t) };
const taggedSplitStyle: SplitBarOptions["style"] = { segment: (position, t) => sgr(SEGMENT_CODES[position], t), muted: (t) => sgr(MUTED_CODE, t) };

test("bar chart: bar styling wraps the bar glyphs and muted wraps the share, nothing else", () => {
	const lines = barChartLines([row("A", 50, 50 / 60), row("B", 10, 10 / 60)], options(widthForBar(10), { style: taggedStyle }));
	assert.deepEqual(lines, [
		`A  ${sgr(BAR_CODE, "██████████")}  50  ${sgr(MUTED_CODE, "83.3%")}`,
		`B  ${sgr(BAR_CODE, "██")}${" ".repeat(8)}  10  ${sgr(MUTED_CODE, "16.7%")}`,
	]);
});

test("bar chart: styled lines are no wider than the width, at every width and layout", () => {
	for (const { name, rows, extra } of layouts) {
		for (let width = 0; width <= 100; width++) {
			for (const l of barChartLines(rows, options(width, { ...extra, style: taggedStyle }))) assert.ok(visibleWidth(l) <= width, `${name} at ${width}: ${JSON.stringify(l)}`);
		}
	}
});

test("split bar: each segment's style wraps its own glyphs, and muted wraps the legend separators", () => {
	const lines = splitBarLines(split(30, 60, 10), splitOptions(80, { maxBarCells: 10, style: taggedSplitStyle }));
	assert.deepEqual(lines, [
		sgr(31, "███") + sgr(32, "▓▓▓▓▓▓") + sgr(33, "▒"),
		`${sgr(31, "█")} main 30${sgr(MUTED_CODE, " · ")}${sgr(32, "▓")} subagents 60${sgr(MUTED_CODE, " · ")}${sgr(33, "▒")} overhead 10`,
	]);
});

test("split bar: styled lines are no wider than the width, at every width", () => {
	for (let width = 0; width <= 100; width++) {
		for (const l of splitBarLines(split(30, 60, 10), splitOptions(width, { style: taggedSplitStyle }))) assert.ok(visibleWidth(l) <= width, `${width}: ${JSON.stringify(l)}`);
	}
});
