import assert from "node:assert/strict";
import { test } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { barChartLines, type BarChartOptions, type ChartRow } from "../../extensions/dev-team/lib/usage-chart.ts";

const identity = (text: string) => text;
const style = { bar: identity, muted: identity };
const percent = (share: number) => `${(share * 100).toFixed(1)}%`;

// Layout is label | bar | value | share, two spaces apart. With one-character labels, two-character
// values and "83.3%"-style shares, a bar area of N cells needs a width of 1 + 2 + 5 + 3 * 2 + N.
const widthForBar = (cells: number) => 14 + cells;
const options = (width: number, extra: Partial<BarChartOptions> = {}): BarChartOptions => ({
	width,
	maxRows: 99,
	formatValue: String,
	formatShare: percent,
	style,
	...extra,
});
const row = (label: string, credits: number, share = 0.5): ChartRow => ({ label, credits, share });

test("bars scale to the largest row, with label, value and share on each line", () => {
	const lines = barChartLines([row("A", 50, 50 / 60), row("B", 10, 10 / 60)], options(widthForBar(10)));
	assert.deepEqual(lines, ["A  ██████████  50  83.3%", "B  ██          10  16.7%"]);
});

test("fractional bar lengths use eighth blocks", () => {
	const [, line] = barChartLines([row("A", 80), row("B", 44)], options(widthForBar(10)));
	assert.ok(line.includes("  █████▌    "), line);
});

test("a non-zero row is always visible", () => {
	const [, line] = barChartLines([row("A", 90), row("B", 0.09)], options(widthForBar(10), { formatValue: (n) => String(Math.round(n)) }));
	assert.ok(line.includes("  ▏         "), line);
});

test("a zero row has an empty bar", () => {
	const [, line] = barChartLines([row("A", 10), row("B", 0)], options(widthForBar(10)));
	assert.ok(line.includes("  " + " ".repeat(10) + "  "), line);
	assert.ok(!/[\u2588-\u258f]/.test(line), line);
});

// truncateToWidth closes a cut label with an SGR reset; the visible text is what matters here.
const plain = (text: string) => text.replace(/\x1b\[[0-9;]*m/g, "");
const LONG_LABEL = "model-with-a-very-long-name-1234567890-abc"; // 40 characters
const longRows = [row("model-a", 50, 50 / 60), row(LONG_LABEL, 10, 10 / 60)];

test("a wide terminal keeps the full label and fits the width", () => {
	const lines = barChartLines(longRows, options(80));
	assert.ok(lines.some((l) => l.includes(LONG_LABEL)));
	for (const l of lines) assert.ok(visibleWidth(l) <= 80, l);
});

test("a narrow terminal truncates the label first, keeping bar, value and share", () => {
	const lines = barChartLines(longRows, options(30)).map(plain);
	assert.ok(lines[1].startsWith("model-with…  "), lines[1]);
	assert.ok(lines[1].includes("█") && lines[1].includes("  10  16.7%"), lines[1]);
	for (const l of lines) assert.ok(visibleWidth(l) <= 30, l);
});

test("a very narrow terminal drops the share, then the bar, leaving label and value", () => {
	const noShare = barChartLines(longRows, options(24)).map(plain);
	assert.ok(noShare.every((l) => !l.includes("%") && l.includes("█")), noShare.join("\n"));
	const labelAndValue = barChartLines(longRows, options(10)).map(plain);
	assert.deepEqual(labelAndValue, ["model…  50", "model…  10"]);
});

test("no line is wider than the width, at every width", () => {
	for (let width = 0; width <= 100; width++) {
		for (const l of barChartLines(longRows, options(width))) assert.ok(visibleWidth(l) <= width, `${width}: ${l}`);
	}
});

// Credits 10, 9, ... 1 (total 55): the last three rows sum to 6 credits, 6/55 = 10.9%.
const countdown = Array.from({ length: 10 }, (_, i) => row(`m${i}`, 10 - i, (10 - i) / 55));

test("rows beyond the limit fold into an other row with the summed value and share", () => {
	const lines = barChartLines(countdown, options(60, { maxRows: 8 }));
	assert.equal(lines.length, 8);
	assert.ok(lines[6].startsWith("m6"), lines[6]);
	assert.ok(lines[7].startsWith("other (3)"), lines[7]);
	assert.ok(lines[7].endsWith("  6  10.9%"), lines[7]);
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
