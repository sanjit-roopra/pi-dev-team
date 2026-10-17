/**
 * The /spend overlay's frame (frameLines): a rounded border with the header set into its top edge
 * and the key hints into its bottom edge, every row padded to the full width and painted as one
 * panel. pi composites an overlay over the transcript without a border or background of its own, so
 * without this the panel's edge is only where its text happens to end. Pure string rendering, like
 * the charts: plain text is measured and cut first, then styled.
 */
import { visibleWidth } from "@earendil-works/pi-tui";
import { cutToWidth } from "../../shared/terminal-text.ts";

export interface FrameStyle {
	/** The border glyphs. */
	border(text: string): string;
	/** The header text set into the top edge. */
	title(text: string): string;
	/** The key hints set into the bottom edge. */
	muted(text: string): string;
	/** A whole framed line, border included: the panel's background. */
	panel(line: string): string;
}

export interface FrameOptions {
	width: number;
	/** Plain text for the top edge; cut to fit. */
	title: string;
	/** Plain text for the bottom edge; cut to fit. */
	footer: string;
	style: FrameStyle;
}

/** Columns the frame takes from each line: the border and one space of padding, on each side. */
export const FRAME_SIDE_COLUMNS = 4;
/** Lines the frame adds: the top and bottom edges. */
export const FRAME_EDGE_LINES = 2;
/** "╭─ " and " ─╮" around an edge's text. */
export const EDGE_TEXT_INSET = 6;
/** Narrowest width that gets a frame; below it the body is shown bare. */
export const FRAME_MIN_WIDTH = FRAME_SIDE_COLUMNS + 2;

/** The width left for the body lines inside a frame `width` wide. */
export const frameBodyWidth = (width: number) => (width < FRAME_MIN_WIDTH ? width : width - FRAME_SIDE_COLUMNS);
/** The width left for an edge's text in a frame `width` wide. */
export const frameEdgeTextWidth = (width: number) => (width < FRAME_MIN_WIDTH ? width : width - EDGE_TEXT_INSET);

const padEnd = (text: string, width: number) => text + " ".repeat(Math.max(0, width - visibleWidth(text)));

/** "╭─ text ──────╮" (or the bottom corners), exactly `width` wide; text that does not fit is cut, and an edge with no room for text is a plain rule. */
function edgeLine(left: string, right: string, text: string, width: number, paintText: (text: string) => string, style: FrameStyle): string {
	const shown = cutToWidth(text, width - EDGE_TEXT_INSET);
	if (!shown) return style.border(left + "─".repeat(Math.max(0, width - 2)) + right);
	const fill = "─".repeat(Math.max(0, width - EDGE_TEXT_INSET - visibleWidth(shown)));
	return style.border(`${left}─ `) + paintText(shown) + style.border(` ${fill}─${right}`);
}

/**
 * `body` (lines already fitted to frameBodyWidth) inside the frame: one line per body line plus the
 * two edges, each exactly `width` columns. Below FRAME_MIN_WIDTH, the edges' text and the body are
 * shown bare instead.
 */
export function frameLines(body: readonly string[], { width, title, footer, style }: FrameOptions): string[] {
	if (width < FRAME_MIN_WIDTH) return [style.title(cutToWidth(title, width)), ...body, style.muted(cutToWidth(footer, width))];
	const inner = width - FRAME_SIDE_COLUMNS;
	const side = style.border("│");
	return [
		edgeLine("╭", "╮", title, width, style.title, style),
		...body.map((line) => `${side} ${padEnd(line, inner)} ${side}`),
		edgeLine("╰", "╯", footer, width, style.muted, style),
	].map(style.panel);
}
