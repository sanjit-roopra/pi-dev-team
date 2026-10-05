/**
 * A stacked split for the /dev-team usage overlay (splitBarLines): one bar cut into segments by
 * amount, then a legend. The overlay draws two: threads (main, subagents, overhead) and providers.
 * Segments keep the order the caller gives, and each input position has its own glyph (█ ▓ ▒ ░) and
 * colour, so the split reads without colour. A part with no amount draws nothing but keeps its
 * position, so a fixed list of parts (the threads) always draws the same part with the same glyph. When
 * there are more parts than glyphs, the parts with an amount are drawn in order and those past the
 * last glyph fold into one "other" segment. Like the bar
 * chart (usage-chart.ts) it is pure string rendering: plain text is measured and cut first, then
 * styled.
 */
import { visibleWidth } from "@earendil-works/pi-tui";
import { cutToWidth, toSingleLine } from "./terminal-text.ts";
import { FULL_BLOCK } from "./usage-chart.ts";

/** One input to the split bar: an amount, which becomes (part of) a segment. */
export interface SplitPart {
	label: string;
	amount: number;
}

export interface SplitStyle {
	/** Colours the glyphs of the segment in slot `slot` (0 to SPLIT_GLYPHS.length - 1). */
	segment(slot: number, text: string): string;
	/** De-emphasises the legend separators. */
	muted(text: string): string;
}

export interface SplitBarOptions {
	width: number;
	/** The legend's text for a part's amount; `share` is its fraction of the bar's total. */
	formatValue(amount: number, share: number): string;
	style: SplitStyle;
	/** Cap on the bar; it also never exceeds `width`. */
	maxBarCells?: number;
}

/** The glyph of each segment position; there are as many segments as glyphs at most. */
export const SPLIT_GLYPHS: readonly string[] = [FULL_BLOCK, "▓", "▒", "░"];
const OTHER_LABEL = "other";
type Segment = { label: string; slot: number; amount: number };
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

/** The parts with an amount, each in its slot: its input position, or its rank among them when the parts outnumber the glyphs. */
function toSegments(parts: readonly SplitPart[]): Segment[] {
	// Labels can come from session files, so they are made one line before they are measured.
	const slotted = (part: SplitPart, slot: number): Segment => ({ label: toSingleLine(part.label), slot, amount: part.amount });
	if (parts.length <= SPLIT_GLYPHS.length) return parts.map(slotted).filter((s) => s.amount > 0);
	const positive = parts.filter((p) => p.amount > 0);
	if (positive.length <= SPLIT_GLYPHS.length) return positive.map(slotted);
	const kept = positive.slice(0, SPLIT_GLYPHS.length - 1);
	const other = { label: OTHER_LABEL, amount: positive.slice(kept.length).reduce((sum, p) => sum + p.amount, 0) };
	return [...kept, other].map(slotted);
}

/** A bar split into segments by amount, in the given order, then a legend naming each with its value. */
export function splitBarLines(parts: readonly SplitPart[], { width, formatValue, style, maxBarCells = MAX_SPLIT_BAR_CELLS }: SplitBarOptions): string[] {
	const segments = toSegments(parts);
	if (!segments.length) return [];

	const segmentCells = allocateCells(segments.map((s) => s.amount), Math.max(0, Math.min(width, maxBarCells)));
	const bar = segments.map((s, i) => style.segment(s.slot, SPLIT_GLYPHS[s.slot].repeat(segmentCells[i]))).join("");
	return [bar, ...legendLines(segments, { width, formatValue, style })];
}

/**
 * The legend ("█ main $0.30 · ▓ subagents $0.60"), packed onto as few lines as fit `width`. An entry
 * never splits across lines; one wider than `width` on its own is cut to it. Each entry is cut as
 * plain text, then its glyph is styled.
 */
function legendLines(
	segments: readonly Segment[],
	{ width, formatValue, style }: Pick<SplitBarOptions, "width" | "formatValue" | "style">,
): string[] {
	const separatorWidth = visibleWidth(LEGEND_SEPARATOR);
	const total = segments.reduce((sum, s) => sum + s.amount, 0);
	const lines: string[] = [];
	let line = "";
	let lineWidth = 0;
	for (const s of segments) {
		const glyph = SPLIT_GLYPHS[s.slot];
		const plain = cutToWidth(`${glyph} ${s.label} ${formatValue(s.amount, s.amount / total)}`, width);
		const entry = plain && style.segment(s.slot, plain.slice(0, glyph.length)) + plain.slice(glyph.length);
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
