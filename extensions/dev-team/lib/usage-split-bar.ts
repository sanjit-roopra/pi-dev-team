/**
 * The stacked thread split for the AI credits overlay (splitBarLines): one bar cut into main █,
 * subagents ▓ and overhead ░ segments by credits, then a legend. Like the bar chart (usage-chart.ts)
 * it is pure string rendering: plain text is measured and cut first, then styled.
 */
import { visibleWidth } from "@earendil-works/pi-tui";
import { cutToWidth } from "./terminal-text.ts";
import type { ThreadLabel } from "./usage-breakdown.ts";
import { FULL_BLOCK } from "./usage-chart.ts";

/** A segment is named by its thread's label; there is one vocabulary for the threads. */
export type SplitLabel = ThreadLabel;

/** One input to the split bar: credits spent by one thread, which becomes (part of) a segment. */
export interface SplitPart {
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
