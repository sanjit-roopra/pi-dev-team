/**
 * Block-character bar charts for the AI credits overlay: ranked horizontal bars (barChartLines) and
 * a stacked thread split (splitBarLines). Pure string rendering: every line is built from plain
 * text, measured with pi-tui's visibleWidth, cut where needed and only then styled, so a line never
 * exceeds the width it was asked for and colour comes from the injected style alone. Formatting
 * (credits, share) is injected too, which keeps this module free of the breakdown and theme code
 * that feeds it.
 */
import { visibleWidth } from "@earendil-works/pi-tui";

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
const MAX_BAR_CELLS = 30;
/** `▏` to `▉`: one to seven eighths of a cell; a full cell is `█`. */
const PARTIAL_BLOCKS = "▏▎▍▌▋▊▉";
const FULL_BLOCK = "█";
const EIGHTHS_PER_CELL = 8;
/** Narrowest label and bar worth drawing; below these the layout drops a column instead of squeezing. */
const MIN_LABEL_CELLS = 6;
const MIN_BAR_CELLS = 6;
const ELLIPSIS = "…";
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/g;
const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/**
 * `text` cut to at most `max` columns, ending in an ellipsis when something was cut ("" when not
 * even the ellipsis fits). Plain text in, plain text out: unlike pi-tui's truncateToWidth it never
 * appends an SGR reset, so colour stays with the caller's style.
 */
export function cutToWidth(text: string, max: number): string {
	if (visibleWidth(text) <= max) return text;
	const room = max - visibleWidth(ELLIPSIS);
	if (room < 0) return "";
	let kept = "";
	let used = 0;
	for (const { segment } of graphemes.segment(text)) {
		const width = visibleWidth(segment);
		if (used + width > room) break;
		kept += segment;
		used += width;
	}
	return kept + ELLIPSIS;
}

/** Labels come from session files; a control character (ESC included) must not reach the terminal. */
export const withoutControlChars = (text: string) => text.replace(CONTROL_CHARS, "");

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
	share: boolean;
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
	for (const share of [true, false]) {
		const gaps = share ? 3 : 2;
		const room = width - natural.value - (share ? natural.share : 0) - gaps * GAP_WIDTH;
		const label = Math.min(natural.label, room - MIN_BAR_CELLS);
		if (label >= minLabel) return { label, bar: Math.min(MAX_BAR_CELLS, room - label), share, value: natural.value };
	}
	const label = Math.min(natural.label, width - natural.value - GAP_WIDTH);
	if (label > 0) return { label, bar: 0, share: false, value: natural.value };
	return { label: 0, bar: 0, share: false, value: Math.max(0, Math.min(natural.value, width)) };
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
		if (columns.share) cells.push(style.muted(padStart(shares[i], natural.share)));
		return cells.join(COLUMN_GAP);
	});
}

/** The closed set of thread segments, in the order they are drawn. */
export type SplitLabel = "main" | "subagents" | "overhead";

/** One input to the split bar: credits spent by one thread, which becomes (part of) a segment. */
export interface SplitPart {
	/** Any label outside SplitLabel is ignored (the input may be untyped session data). */
	label: SplitLabel;
	credits: number;
}

export interface SplitStyle {
	/** Colours the glyphs of the segment named `label`. */
	segment(label: SplitLabel, text: string): string;
	/** De-emphasises the legend separators. */
	muted(text: string): string;
}

export interface SplitBarOptions {
	width: number;
	formatValue(credits: number): string;
	style: SplitStyle;
	/** Cap on the bar; it also never exceeds `width`. */
	maxBarCells?: number;
}

/** Segment order, left to right, and the glyph that tells them apart without colour. */
const SPLIT_SEGMENTS: readonly { label: SplitLabel; glyph: string }[] = [
	{ label: "main", glyph: FULL_BLOCK },
	{ label: "subagents", glyph: "▓" },
	{ label: "overhead", glyph: "░" },
];
type Segment = { label: SplitLabel; glyph: string; credits: number };
const MAX_SPLIT_BAR_CELLS = 40;
const LEGEND_SEPARATOR = " · ";

/**
 * Splits `cells` across the segment weights by largest remainder, so the result always sums to
 * `cells` (ties go to the earlier weight). A segment that would get no cell borrows one from the
 * largest segment, so a small non-zero thread stays visible, as long as there are cells to go round.
 */
function allocateCells(weights: readonly number[], cells: number): number[] {
	const sum = (numbers: readonly number[]) => numbers.reduce((total, n) => total + n, 0);
	const total = sum(weights);
	const ideal = weights.map((w) => (w * cells) / total);
	const wholeCells = ideal.map(Math.floor);
	const remainder = (i: number) => ideal[i] - wholeCells[i];
	const indicesByRemainder = ideal.map((_, i) => i).sort((a, b) => remainder(b) - remainder(a) || a - b);
	const leftover = cells - sum(wholeCells);
	const gainsLeftover = new Set(indicesByRemainder.slice(0, leftover));
	return keepVisible(wholeCells.map((n, i) => (gainsLeftover.has(i) ? n + 1 : n)));
}

/** Moves one cell from the largest segment to each empty one (while the largest has cells to spare). */
function keepVisible(allocated: readonly number[]): number[] {
	return allocated.reduce(
		(segmentCells, _, i) => {
			if (segmentCells[i] > 0) return segmentCells;
			const largestIndex = segmentCells.indexOf(Math.max(...segmentCells));
			if (segmentCells[largestIndex] < 2) return segmentCells;
			return segmentCells.map((n, j) => (j === largestIndex ? n - 1 : j === i ? n + 1 : n));
		},
		[...allocated],
	);
}

/** A bar split into main █, subagents ▓ and overhead ░ segments by credits, then a legend naming each with its credits. */
export function splitBarLines(parts: readonly SplitPart[], { width, formatValue, style, maxBarCells = MAX_SPLIT_BAR_CELLS }: SplitBarOptions): string[] {
	const segments = SPLIT_SEGMENTS.flatMap((s): Segment[] => {
		const credits = parts.filter((p) => p.label === s.label).reduce((sum, p) => sum + p.credits, 0);
		return credits > 0 ? [{ ...s, credits }] : [];
	});
	if (!segments.length) return [];

	const segmentCells = allocateCells(segments.map((s) => s.credits), Math.max(0, Math.min(width, maxBarCells)));
	const bar = segments.map((s, i) => style.segment(s.label, s.glyph.repeat(segmentCells[i]))).join("");
	return [bar, ...legendLines(segments, { width, formatValue, style })];
}

/**
 * The legend ("█ main 30 · ▓ subagents 60"), packed onto as few lines as fit `width`. An entry
 * never splits across lines; one wider than `width` on its own is cut to it. Each entry is cut as
 * plain text, then its glyph is styled.
 */
function legendLines(
	segments: readonly Segment[],
	{ width, formatValue, style }: Pick<SplitBarOptions, "width" | "formatValue" | "style">,
): string[] {
	const separatorWidth = visibleWidth(LEGEND_SEPARATOR);
	const lines: string[] = [];
	let line = "";
	let lineWidth = 0;
	for (const s of segments) {
		const plain = cutToWidth(`${s.glyph} ${s.label} ${formatValue(s.credits)}`, width);
		const entry = plain && style.segment(s.label, plain.slice(0, s.glyph.length)) + plain.slice(s.glyph.length);
		const entryWidth = visibleWidth(plain);
		if (line && lineWidth + separatorWidth + entryWidth <= width) {
			line += style.muted(LEGEND_SEPARATOR) + entry;
			lineWidth += separatorWidth + entryWidth;
			continue;
		}
		if (line) lines.push(line);
		line = entry;
		lineWidth = entryWidth;
	}
	lines.push(line);
	return lines;
}
