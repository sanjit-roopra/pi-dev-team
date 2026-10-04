/**
 * Block-character bar charts for the AI credits overlay: ranked horizontal bars (barChartLines) and
 * a stacked thread split (splitBarLines). Pure string rendering: every line is built from plain
 * text, measured with pi-tui's visibleWidth, and only then styled, so a line never exceeds the
 * width it was asked for. Formatting (credits, share) and colour are injected, which keeps this
 * module free of the breakdown and theme code that feeds it.
 */
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

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
	label: number;
	/** 0 drops the bar column. */
	bar: number;
	share: boolean;
}

/**
 * Splits `width` across the columns. The label truncates first (down to MIN_LABEL_CELLS, or its
 * natural width when shorter); when the bar would fall below MIN_BAR_CELLS the share column goes,
 * then the bar, leaving label and value. The value is never dropped.
 */
function fitColumns(width: number, natural: { label: number; value: number; share: number }): Columns {
	const minLabel = Math.min(natural.label, MIN_LABEL_CELLS);
	for (const share of [true, false]) {
		const gaps = share ? 3 : 2;
		const room = width - natural.value - (share ? natural.share : 0) - gaps * GAP_WIDTH;
		const label = Math.min(natural.label, room - MIN_BAR_CELLS);
		if (label >= minLabel) return { label, bar: Math.min(MAX_BAR_CELLS, room - label), share };
	}
	return { label: Math.min(natural.label, width - natural.value - GAP_WIDTH), bar: 0, share: false };
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
	const rows = maxRows > 0 ? foldRows(allRows, maxRows) : [];
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
		const cells = [padEnd(truncateToWidth(row.label, Math.max(0, columns.label), ELLIPSIS), columns.label)];
		if (columns.bar) {
			const bar = barGlyphs(barEighths(row.credits, max, columns.bar));
			cells.push(style.bar(bar) + " ".repeat(columns.bar - visibleWidth(bar)));
		}
		cells.push(padStart(values[i], natural.value));
		if (columns.share) cells.push(style.muted(padStart(shares[i], natural.share)));
		return truncateToWidth(cells.join(COLUMN_GAP), width, "");
	});
}

export interface SplitPart {
	/** "main", "subagents" or "overhead"; any other label is ignored. */
	label: string;
	credits: number;
}

export interface SplitStyle {
	/** Colours the glyphs of the segment named `label` ("main", "subagents" or "overhead"). */
	segment(label: string, text: string): string;
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

/** Thread order, left to right, and the glyph that tells them apart without colour. */
const SPLIT_SEGMENTS = [
	{ label: "main", glyph: "█" },
	{ label: "subagents", glyph: "▓" },
	{ label: "overhead", glyph: "░" },
] as const;
type Segment = { label: string; glyph: string; credits: number };
const MAX_SPLIT_BAR_CELLS = 40;
const LEGEND_SEPARATOR = " · ";
/** A legend entry starts with its glyph and a space. */
const GLYPH_AND_SPACE_WIDTH = 2;

/**
 * Splits `cells` across the weights by largest remainder, so the result always sums to `cells`
 * (ties go to the earlier weight). A part that would get no cell borrows one from the largest part,
 * so a small non-zero thread stays visible, as long as there are cells to go round.
 */
function allocateCells(weights: readonly number[], cells: number): number[] {
	const total = weights.reduce((sum, w) => sum + w, 0);
	const ideal = weights.map((w) => (w * cells) / total);
	const allocated = ideal.map(Math.floor);
	const byRemainder = ideal.map((x, i) => i).sort((a, b) => ideal[b] - allocated[b] - (ideal[a] - allocated[a]) || a - b);
	for (let left = cells - allocated.reduce((sum, n) => sum + n, 0), i = 0; left > 0; left--, i++) allocated[byRemainder[i]]++;
	for (let i = 0; i < allocated.length; i++) {
		if (allocated[i] > 0) continue;
		const largest = allocated.indexOf(Math.max(...allocated));
		if (allocated[largest] < 2) break;
		allocated[largest]--;
		allocated[i]++;
	}
	return allocated;
}

/** A bar split into main █, subagents ▓ and overhead ░ by credits, then a legend naming each with its credits. */
export function splitBarLines(parts: readonly SplitPart[], { width, formatValue, style, maxBarCells = MAX_SPLIT_BAR_CELLS }: SplitBarOptions): string[] {
	const segments = SPLIT_SEGMENTS.flatMap((s): Segment[] => {
		const credits = parts.filter((p) => p.label === s.label).reduce((sum, p) => sum + p.credits, 0);
		return credits > 0 ? [{ ...s, credits }] : [];
	});
	if (!segments.length) return [];

	const cells = allocateCells(segments.map((s) => s.credits), Math.max(0, Math.min(width, maxBarCells)));
	const bar = segments.map((s, i) => style.segment(s.label, s.glyph.repeat(cells[i]))).join("");
	return [bar, ...legendLines(segments, { width, formatValue, style })];
}

/**
 * The legend ("█ main 30 · ▓ subagents 60"), packed onto as few lines as fit `width`. An entry
 * never splits across lines; one wider than `width` on its own is truncated.
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
		const caption = truncateToWidth(`${s.label} ${formatValue(s.credits)}`, Math.max(0, width - GLYPH_AND_SPACE_WIDTH), ELLIPSIS);
		const entry = `${style.segment(s.label, s.glyph)} ${caption}`;
		const entryWidth = GLYPH_AND_SPACE_WIDTH + visibleWidth(caption);
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
	return lines.map((l) => truncateToWidth(l, width, ""));
}
