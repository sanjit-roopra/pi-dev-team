/**
 * Block-character charts for the /spend overlay: the ranked bar chart (barChartLines), the month's
 * daily bars (dailyChartLines) and their one-line fallback (sparkline); the stacked
 * splits are usage-split-bar.ts. Pure string rendering: every line is built from plain
 * text, measured with pi-tui's visibleWidth, cut where needed and only then styled, so a line never
 * exceeds the width it was asked for and colour comes from the injected style alone. Formatting
 * (USD, credits, tokens, share) is injected too, which keeps this module free of the breakdown and
 * theme code that feeds it.
 */
import { visibleWidth } from "@earendil-works/pi-tui";
import { cutToWidth, toSingleLine } from "../../shared/terminal-text.ts";

export interface ChartRow {
	label: string;
	/** The bar's length and the first value column. */
	usd: number;
	/** AI credits; a column of its own when any row has some. */
	credits: number;
	tokens: number;
	/** Fraction (0 to 1), shown through `format.share`. */
	share: number;
}

export interface ChartStyle {
	/** Colours the bar of the row at rank `row` (0 for the top row), so neighbouring rows tell apart. */
	bar(row: number, text: string): string;
	/** De-emphasises the secondary columns (credits, tokens, share). */
	muted(text: string): string;
}

export interface ChartFormat {
	usd(usd: number): string;
	/** "" for a row without credits worth showing; the cell stays blank. */
	credits(credits: number): string;
	tokens(tokens: number): string;
	share(share: number): string;
}

export interface BarChartOptions {
	/** Terminal columns every returned line must fit in. */
	width: number;
	/** Most lines to return; rows beyond that fold into one "other (N)" line that takes the last slot. */
	maxRows: number;
	format: ChartFormat;
	/**
	 * Which optional columns the rows want, decided by the caller over all rows (before any fold into
	 * "other"), so the overlay and the text summary apply one rule. Share is always wanted.
	 */
	wantedColumns: { credits: boolean; tokens: boolean };
	style: ChartStyle;
}

const COLUMN_GAP = "  ";
const GAP_WIDTH = COLUMN_GAP.length;
/** Gaps between the label, bar and USD columns; each optional column adds one more. */
const GAPS_LABEL_BAR_USD = 2;
const MAX_BAR_CELLS = 30;
/** `▏` to `▉`: one to seven eighths of a cell; a full cell is `█`. */
const PARTIAL_BLOCKS = "▏▎▍▌▋▊▉";
export const FULL_BLOCK = "█";
const EIGHTHS_PER_CELL = 8;
/** Narrowest label and bar worth drawing; below these the layout drops a column instead of squeezing. */
const MIN_LABEL_CELLS = 6;
const MIN_BAR_CELLS = 6;
/** `eighths` eighths of a cell as glyphs: whole cells of `█`, then one partial block. */
function barGlyphs(eighths: number): string {
	const rest = eighths % EIGHTHS_PER_CELL;
	return FULL_BLOCK.repeat(Math.floor(eighths / EIGHTHS_PER_CELL)) + (rest ? PARTIAL_BLOCKS[rest - 1] : "");
}

/** Bar length in eighths of a cell; any non-zero value gets at least one so it never vanishes. */
function barEighths(value: number, max: number, cells: number): number {
	if (value <= 0 || max <= 0) return 0;
	return Math.max(1, Math.round((value / max) * cells * EIGHTHS_PER_CELL));
}

const padEnd = (text: string, width: number) => text + " ".repeat(Math.max(0, width - visibleWidth(text)));
const padStart = (text: string, width: number) => " ".repeat(Math.max(0, width - visibleWidth(text))) + text;

/** The columns after the bar, in drop order: the first one listed goes last. */
const OPTIONAL_COLUMNS = ["credits", "tokens", "share"] as const;
type OptionalColumn = (typeof OPTIONAL_COLUMNS)[number];

interface Columns {
	/** 0 drops the label column and its gap. */
	label: number;
	/** 0 drops the bar column. */
	bar: number;
	/** The optional columns kept, each at its natural width. */
	shown: ReadonlySet<OptionalColumn>;
	/** Narrower than the natural USD width only when the USD value alone overflows the line. */
	usd: number;
}

/**
 * Splits `width` across the columns. The label truncates first (down to MIN_LABEL_CELLS, or its
 * natural width when shorter); when the bar would fall below MIN_BAR_CELLS the optional columns go,
 * share first, then tokens, then credits; then the bar, then the label, leaving the USD value alone,
 * which is cut (with an ellipsis) only when it overflows the line by itself. USD is never dropped.
 */
function fitColumns(width: number, natural: { label: number; usd: number } & Record<OptionalColumn, number>, wanted: readonly OptionalColumn[]): Columns {
	const minLabel = Math.min(natural.label, MIN_LABEL_CELLS);
	for (let keep = wanted.length; keep >= 0; keep--) {
		const shown = new Set(wanted.slice(0, keep));
		const optionalWidth = [...shown].reduce((sum, column) => sum + natural[column] + GAP_WIDTH, 0);
		const room = width - natural.usd - optionalWidth - GAPS_LABEL_BAR_USD * GAP_WIDTH;
		const label = Math.min(natural.label, room - MIN_BAR_CELLS);
		if (label >= minLabel) return { label, bar: Math.min(MAX_BAR_CELLS, room - label), shown, usd: natural.usd };
	}
	const none = new Set<OptionalColumn>();
	const label = Math.min(natural.label, width - natural.usd - GAP_WIDTH);
	if (label > 0) return { label, bar: 0, shown: none, usd: natural.usd };
	return { label: 0, bar: 0, shown: none, usd: Math.max(0, Math.min(natural.usd, width)) };
}

/** The first `maxRows - 1` rows, then "other (N)" summing the rest; all rows when they fit. */
function foldRows(rows: readonly ChartRow[], maxRows: number): ChartRow[] {
	if (rows.length <= maxRows) return [...rows];
	const kept = rows.slice(0, Math.max(0, maxRows - 1));
	const folded = rows.slice(kept.length);
	const sum = (pick: (r: ChartRow) => number) => folded.reduce((total, r) => total + pick(r), 0);
	return [...kept, { label: `other (${folded.length})`, usd: sum((r) => r.usd), credits: sum((r) => r.credits), tokens: sum((r) => r.tokens), share: sum((r) => r.share) }];
}

/** One line per row: label, bar scaled to the largest USD, USD, then the wanted optional columns (credits, tokens) and share. */
export function barChartLines(allRows: readonly ChartRow[], { width, maxRows, format, wantedColumns, style }: BarChartOptions): string[] {
	const rows = (maxRows > 0 ? foldRows(allRows, maxRows) : []).map((r) => ({ ...r, label: toSingleLine(r.label) }));
	if (!rows.length) return [];
	const cellsOf: Record<OptionalColumn, string[]> = {
		credits: rows.map((r) => format.credits(r.credits)),
		tokens: rows.map((r) => format.tokens(r.tokens)),
		share: rows.map((r) => format.share(r.share)),
	};
	const usdCells = rows.map((r) => format.usd(r.usd));
	const widest = (cells: readonly string[]) => Math.max(...cells.map(visibleWidth));
	const natural = { label: widest(rows.map((r) => r.label)), usd: widest(usdCells), credits: widest(cellsOf.credits), tokens: widest(cellsOf.tokens), share: widest(cellsOf.share) };
	const wanted = OPTIONAL_COLUMNS.filter((column) => column === "share" || wantedColumns[column]);
	const columns = fitColumns(width, natural, wanted);
	const max = Math.max(...rows.map((r) => r.usd));

	return rows.map((row, i) => {
		const cells: string[] = [];
		if (columns.label) cells.push(padEnd(cutToWidth(row.label, columns.label), columns.label));
		if (columns.bar) {
			const bar = barGlyphs(barEighths(row.usd, max, columns.bar));
			cells.push(style.bar(i, bar) + " ".repeat(columns.bar - visibleWidth(bar)));
		}
		cells.push(padStart(cutToWidth(usdCells[i], columns.usd), columns.usd));
		for (const column of OPTIONAL_COLUMNS) {
			if (columns.shown.has(column)) cells.push(style.muted(padStart(cellsOf[column][i], natural[column])));
		}
		return cells.join(COLUMN_GAP);
	});
}

/** `▁` to `█`: one to eight eighths of a cell high. */
const SPARK_BLOCKS = "▁▂▃▄▅▆▇█";

/** One glyph per value, its height scaled to the largest value; a value of 0 or less is a space. */
export function sparkline(values: readonly number[]): string {
	const max = Math.max(0, ...values);
	return values.map((v) => (v > 0 ? SPARK_BLOCKS[Math.max(0, Math.ceil((v / max) * SPARK_BLOCKS.length) - 1)] : " ")).join("");
}

export interface DailyChartOptions {
	/** Terminal columns every returned line must fit in. */
	width: number;
	/** Lines of bars; each holds eight steps of height. */
	rows: number;
	/** Days the axis spans (the whole month); the last value given is today, and the days after it stay empty. */
	days: number;
	/** The axis labels: the peak at the top, 0 at the baseline. */
	formatValue(value: number): string;
	style: ChartStyle;
}

/** Days with a tick and a number under the axis; today and the month's last day are added. */
const DAY_TICKS = [1, 5, 10, 15, 20, 25];
/** "┤" or "│" between the value labels and the bars. */
const AXIS_GAP = 2;

/**
 * Vertical bars, one column per day from the 1st, `rows` high and scaled to the largest value, with
 * the peak and 0 marked on a value axis at the left and day numbers under a tick axis, today's in the
 * bar colour. Days go a column apart when the width allows, side by side when not; [] when even that does not fit, so the
 * caller can fall back to the sparkline. A day that cost nothing is a `·` on the baseline, so it reads
 * as zero rather than as missing.
 */
export function dailyChartLines(values: readonly number[], { width, rows, days, formatValue, style }: DailyChartOptions): string[] {
	const max = Math.max(0, ...values);
	if (rows < 1 || !(max > 0)) return [];
	const topLabel = formatValue(max);
	const baseLabel = formatValue(0);
	const labelWidth = Math.max(visibleWidth(topLabel), visibleWidth(baseLabel));
	const plotWidth = width - labelWidth - AXIS_GAP;
	const step = days * 2 - 1 <= plotWidth ? 2 : days <= plotWidth ? 1 : 0;
	if (!step) return [];
	const columnOf = (day: number) => (day - 1) * step;
	const plotColumns = columnOf(days) + 1;
	const heights = values.map((v) => (v > 0 ? Math.max(1, Math.round((v / max) * rows * EIGHTHS_PER_CELL)) : 0));

	const barRow = (row: number): string => {
		const below = (rows - 1 - row) * EIGHTHS_PER_CELL;
		let line = "";
		for (let day = 1; day <= days; day++) {
			if (day > 1 && step === 2) line += " ";
			const height = heights[day - 1];
			const level = Math.min(EIGHTHS_PER_CELL, Math.max(0, (height ?? 0) - below));
			if (level > 0) line += style.bar(0, SPARK_BLOCKS[level - 1]);
			else line += height === 0 && row === rows - 1 ? style.muted("·") : " ";
		}
		return line;
	};
	const axisLabel = (row: number) => (row === 0 ? topLabel : row === rows - 1 ? baseLabel : "");
	const bars = Array.from({ length: rows }, (_, row) => {
		const label = axisLabel(row);
		return style.muted(`${" ".repeat(labelWidth - visibleWidth(label))}${label} ${label ? "┤" : "│"}`) + barRow(row);
	});

	const today = Math.min(values.length, days);
	// Today first, then the ends, then the rest: a number less than two spaces from one already placed is left out (its tick stays).
	const ticks = [...new Set([today, 1, days, ...DAY_TICKS.filter((d) => d < days)])].filter((d) => d >= 1);
	const tickColumns = new Set(ticks.map(columnOf));
	let axis = "";
	for (let column = 0; column < plotColumns; column++) axis += tickColumns.has(column) ? "┬" : "─";
	const placed: { day: number; from: number; to: number }[] = [];
	for (const day of ticks) {
		const from = columnOf(day);
		const to = from + String(day).length;
		if (!placed.some((p) => from <= p.to + 1 && to + 1 >= p.from)) placed.push({ day, from, to });
	}
	const indent = " ".repeat(labelWidth + 2);
	let numbers = "";
	let used = visibleWidth(indent);
	for (const { day, from } of placed.sort((a, b) => a.from - b.from)) {
		const text = String(day);
		const start = visibleWidth(indent) + from;
		if (start + text.length > width) break;
		const gap = " ".repeat(start - used);
		numbers += style.muted(gap) + (day === today ? style.bar(0, text) : style.muted(text));
		used = start + text.length;
	}
	return [...bars, style.muted(`${" ".repeat(labelWidth + 1)}└${axis}`), style.muted(indent) + numbers];
}
