/**
 * Read dedup: when the agent reads the same file range again and gets exactly the text it already has
 * in its context, the tool result becomes a one-line note instead of a second copy. Every later turn
 * re-sends the whole context, so a repeated 10k-token read costs 10k tokens on every turn after it.
 *
 * The note is safe only while the earlier result is still in the context, so the caller resets the
 * tracker whenever the context is rebuilt (compaction, a branch switch, a new or resumed session) and
 * passes only reads the model itself sees (isModelVisibleRead: not the nested calls of a codemode script). The reference
 * must come from an earlier turn: parallel reads in one turn may complete in any order, so "above"
 * would not hold. A note is given once per reference: reading the same range again right after a note
 * returns the full text, which becomes the new reference. That way an agent that cannot find the
 * earlier result (another extension edited the context, for example) gets the text by asking twice.
 */
import { createHash } from "node:crypto";
import * as path from "node:path";

/** Reads shorter than this are cheaper to repeat than to explain. */
export const MIN_DEDUP_CHARS = 2_000;

interface Reference {
	hash: string;
	/** The turn whose result holds the text. */
	turn: number;
	/** A note already pointed at this reference; the next identical read returns the full text. */
	noteGiven: boolean;
}

/** A tool result as the tracker needs it. */
export interface ToolResultLike {
	toolName: string;
	parentToolCallId?: string;
	isError: boolean;
	content: { type: string }[];
}

/** A successful text `read` the model itself sees: a codemode script's nested calls never reach the transcript. */
export function isModelVisibleRead(event: ToolResultLike): boolean {
	return event.toolName === "read" && !event.parentToolCallId && !event.isError && event.content.every((c) => c.type === "text");
}

export interface ReadCall {
	cwd: string;
	input: Record<string, unknown>;
	text: string;
}

export class ReadTracker {
	private readonly refs = new Map<string, Reference>();
	private turn = 0;

	/** Forget every reference (the context no longer holds the earlier results). */
	reset(): void {
		this.refs.clear();
	}

	/** A model turn ended: its reads can now be pointed at. */
	endTurn(): void {
		this.turn++;
	}

	/**
	 * Record a read the model sees and return the note to send instead of its text, or undefined to send
	 * the text. Not a pure query: it records the read as the new reference or marks the note as given.
	 */
	noteForRepeatedRead({ cwd, input, text }: ReadCall): string | undefined {
		const file = typeof input.path === "string" ? input.path : undefined;
		if (!file) return undefined;
		const key = rangeKey(path.resolve(cwd, file), input.offset, input.limit);
		if (text.length < MIN_DEDUP_CHARS) {
			this.refs.delete(key);
			return undefined;
		}
		const hash = createHash("sha256").update(text).digest("hex");
		const ref = this.refs.get(key);
		if (ref && ref.hash === hash && ref.turn < this.turn && !ref.noteGiven) {
			ref.noteGiven = true;
			return unchangedNote(file, input.offset, input.limit);
		}
		if (ref && ref.hash === hash && ref.turn === this.turn) return undefined; // same turn: keep the first as reference
		this.refs.set(key, { hash, turn: this.turn, noteGiven: false });
		return undefined;
	}
}

function rangeKey(file: string, offset: unknown, limit: unknown): string {
	return JSON.stringify([file, offset ?? null, limit ?? null]);
}

function unchangedNote(file: string, offset: unknown, limit: unknown): string {
	const range = offset !== undefined || limit !== undefined ? ` (offset ${offset ?? 1}, limit ${limit ?? "none"})` : "";
	return `[dev-team: ${file}${range} is unchanged. This read returned exactly the text of your earlier read in this conversation, which is still above. If you cannot find it, read again to get the full text.]`;
}
