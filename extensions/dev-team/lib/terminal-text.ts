/**
 * Plain-text helpers for anything drawn in the terminal from untrusted text (child output, session
 * files): sanitizers that keep that text from driving the terminal, and a width-safe cut. One copy, so
 * a fix to what counts as an escape reaches the subagent renderer and the usage overlay alike.
 */
import { visibleWidth } from "@earendil-works/pi-tui";

// ANSI CSI/OSC/other escape sequences, then remaining C0/C1 controls (keeping \t and \n) and the
// interlinear annotation characters pi's sanitizeBinaryOutput also removes. A bare \r would let a line
// overwrite itself, so CR and CRLF become \n first.
const ANSI_RE = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[@-Z\\-_])/g;
const CONTROL_RE = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f￹-￻]/g;
/** What sanitizeTerminalText keeps that a single line cannot hold. */
const TAB_OR_NEWLINE = /[\t\n]/g;
/** Every C0/C1 control, tab and newline included: in one-line text with spacing kept, a run of them becomes one space. */
const CONTROL_RUNS = /[\x00-\x1f\x7f-\x9f]+/g;
const ANNOTATION_CHARS = /[￹-￻]/g;
const ELLIPSIS = "…";
const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** Multi-line text with its escape sequences and controls removed; tab and newline stay. */
export function sanitizeTerminalText(text: string): string {
	return text.replace(/\r\n?/g, "\n").replace(ANSI_RE, "").replace(CONTROL_RE, "");
}

/** One-line text (a label): sanitized, with tabs and newlines removed too. */
export const toSingleLine = (text: string) => sanitizeTerminalText(text).replace(TAB_OR_NEWLINE, "");

/**
 * One-line text where words must stay apart (an error message): escape sequences are removed, then
 * each run of control characters (tab, newline, form feed, NUL...) becomes one space.
 */
export const toSpacedSingleLine = (text: string) => text.replace(ANSI_RE, "").replace(ANNOTATION_CHARS, "").replace(CONTROL_RUNS, " ");

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
