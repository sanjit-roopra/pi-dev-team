/**
 * Block-character ranked bar chart for the /dev-team usage overlay (barChartLines); the stacked
 * splits are usage-split-bar.ts. Pure string rendering: every line is built from plain
 * text, measured with pi-tui's visibleWidth, cut where needed and only then styled, so a line never
 * exceeds the width it was asked for and colour comes from the injected style alone. Formatting
 * (USD, credits, tokens, share) is injected too, which keeps this module free of the breakdown and
 * theme code that feeds it.
 */
import { visibleWidth } from "@earendil-works/pi-tui";
import { cutToWidth, toSingleLine } from "./terminal-text.ts";

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
	/** Colours a bar. */
	bar(text: string): string;
	/** De-emphasises the secondary columns (credits, tokens, share). */
	muted(text: string): string;
}

export interface ChartFormat {
	usd(usd: number): string;
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
	/** Whether a row has credits worth a column; rows without any leave the cell blank. */
	hasCredits(credits: number): boolean;
	style: ChartStyle;
}

const COLUMN_GAP = "  ";
const GAP_WIDTH = COLUMN_GAP.length;
/** Gaps between the label, bar and USD columns; each optional column adds one more. */
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
		const room = width - natural.usd - optionalWidth - GAPS_LABEL_BAR_VALUE * GAP_WIDTH;
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

/**
 * One line per row: label, bar scaled to the largest USD, USD, then credits (when any row has
 * some), tokens (when any row cost nothing, so a free model still says what it used) and share.
 */
export function barChartLines(allRows: readonly ChartRow[], { width, maxRows, format, hasCredits, style }: BarChartOptions): string[] {
	const rows = (maxRows > 0 ? foldRows(allRows, maxRows) : []).map((r) => ({ ...r, label: toSingleLine(r.label) }));
	if (!rows.length) return [];
	const cellsOf: Record<OptionalColumn, string[]> = {
		credits: rows.map((r) => (hasCredits(r.credits) ? format.credits(r.credits) : "")),
		tokens: rows.map((r) => format.tokens(r.tokens)),
		share: rows.map((r) => format.share(r.share)),
	};
	const usdCells = rows.map((r) => format.usd(r.usd));
	const widest = (cells: readonly string[]) => Math.max(...cells.map(visibleWidth));
	const natural = { label: widest(rows.map((r) => r.label)), usd: widest(usdCells), credits: widest(cellsOf.credits), tokens: widest(cellsOf.tokens), share: widest(cellsOf.share) };
	const wanted = OPTIONAL_COLUMNS.filter((column) => {
		if (column === "credits") return rows.some((r) => hasCredits(r.credits));
		if (column === "tokens") return rows.some((r) => !(r.usd > 0));
		return true;
	});
	const columns = fitColumns(width, natural, wanted);
	const max = Math.max(...rows.map((r) => r.usd));

	return rows.map((row, i) => {
		const cells: string[] = [];
		if (columns.label) cells.push(padEnd(cutToWidth(row.label, columns.label), columns.label));
		if (columns.bar) {
			const bar = barGlyphs(barEighths(row.usd, max, columns.bar));
			cells.push(style.bar(bar) + " ".repeat(columns.bar - visibleWidth(bar)));
		}
		cells.push(padStart(cutToWidth(usdCells[i], columns.usd), columns.usd));
		for (const column of OPTIONAL_COLUMNS) {
			if (columns.shown.has(column)) cells.push(style.muted(padStart(cellsOf[column][i], natural[column])));
		}
		return cells.join(COLUMN_GAP);
	});
}
