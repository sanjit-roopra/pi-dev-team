/**
 * Block-character ranked bar chart for the AI credits overlay (barChartLines); the stacked thread
 * split is usage-split-bar.ts. Pure string rendering: every line is built from plain
 * text, measured with pi-tui's visibleWidth, cut where needed and only then styled, so a line never
 * exceeds the width it was asked for and colour comes from the injected style alone. Formatting
 * (credits, share) is injected too, which keeps this module free of the breakdown and theme code
 * that feeds it.
 */
import { visibleWidth } from "@earendil-works/pi-tui";
import { cutToWidth, withoutControlChars } from "./terminal-text.ts";

export interface ChartRow {
	label: string;
	credits: number;
	/** Fraction (0 to 1), shown through `formatShare`. */
	share: number;
}

export interface ChartStyle {
	/** Colours a bar. */
	bar(text: string): string;
	/** De-emphasises the share column. */
	muted(text: string): string;
}

export interface BarChartOptions {
	/** Terminal columns every returned line must fit in. */
	width: number;
	/** Most lines to return; rows beyond that fold into one "other (N)" line that takes the last slot. */
	maxRows: number;
	formatValue(credits: number): string;
	formatShare(share: number): string;
	style: ChartStyle;
}

const COLUMN_GAP = "  ";
const GAP_WIDTH = COLUMN_GAP.length;
/** Gaps between the label, bar and value columns; the share column adds one more. */
const GAPS_LABEL_BAR_VALUE = 2;
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

interface Columns {
	/** 0 drops the label column and its gap. */
	label: number;
	/** 0 drops the bar column. */
	bar: number;
	showShare: boolean;
	/** Narrower than the natural value width only when the value alone overflows the line. */
	value: number;
}

/**
 * Splits `width` across the columns. The label truncates first (down to MIN_LABEL_CELLS, or its
 * natural width when shorter); when the bar would fall below MIN_BAR_CELLS the share column goes,
 * then the bar, then the label, leaving the value alone, which is cut (with an ellipsis) only when
 * it overflows the line by itself. The value is never dropped or shown shorter without a marker.
 */
function fitColumns(width: number, natural: { label: number; value: number; share: number }): Columns {
	const minLabel = Math.min(natural.label, MIN_LABEL_CELLS);
	for (const showShare of [true, false]) {
		const gaps = GAPS_LABEL_BAR_VALUE + (showShare ? 1 : 0);
		const room = width - natural.value - (showShare ? natural.share : 0) - gaps * GAP_WIDTH;
		const label = Math.min(natural.label, room - MIN_BAR_CELLS);
		if (label >= minLabel) return { label, bar: Math.min(MAX_BAR_CELLS, room - label), showShare, value: natural.value };
	}
	const label = Math.min(natural.label, width - natural.value - GAP_WIDTH);
	if (label > 0) return { label, bar: 0, showShare: false, value: natural.value };
	return { label: 0, bar: 0, showShare: false, value: Math.max(0, Math.min(natural.value, width)) };
}

/** The first `maxRows - 1` rows, then "other (N)" summing the rest; all rows when they fit. */
function foldRows(rows: readonly ChartRow[], maxRows: number): ChartRow[] {
	if (rows.length <= maxRows) return [...rows];
	const kept = rows.slice(0, Math.max(0, maxRows - 1));
	const folded = rows.slice(kept.length);
	const sum = (pick: (r: ChartRow) => number) => folded.reduce((total, r) => total + pick(r), 0);
	return [...kept, { label: `other (${folded.length})`, credits: sum((r) => r.credits), share: sum((r) => r.share) }];
}

/** One line per row: label, bar scaled to the largest row, value, share. */
export function barChartLines(allRows: readonly ChartRow[], { width, maxRows, formatValue, formatShare, style }: BarChartOptions): string[] {
	const rows = (maxRows > 0 ? foldRows(allRows, maxRows) : []).map((r) => ({ ...r, label: withoutControlChars(r.label) }));
	if (!rows.length) return [];
	const values = rows.map((r) => formatValue(r.credits));
	const shares = rows.map((r) => formatShare(r.share));
	const natural = {
		label: Math.max(...rows.map((r) => visibleWidth(r.label))),
		value: Math.max(...values.map(visibleWidth)),
		share: Math.max(...shares.map(visibleWidth)),
	};
	const columns = fitColumns(width, natural);
	const max = Math.max(...rows.map((r) => r.credits));

	return rows.map((row, i) => {
		const cells: string[] = [];
		if (columns.label) cells.push(padEnd(cutToWidth(row.label, columns.label), columns.label));
		if (columns.bar) {
			const bar = barGlyphs(barEighths(row.credits, max, columns.bar));
			cells.push(style.bar(bar) + " ".repeat(columns.bar - visibleWidth(bar)));
		}
		cells.push(padStart(cutToWidth(values[i], columns.value), columns.value));
		if (columns.showShare) cells.push(style.muted(padStart(shares[i], natural.share)));
		return cells.join(COLUMN_GAP);
	});
}
