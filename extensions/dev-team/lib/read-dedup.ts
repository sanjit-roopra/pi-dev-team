/**
 * Read dedup: when the agent reads the same file range again and gets exactly the text it already has
 * in its context, the tool result becomes a one-line note instead of a second copy. Every later turn
 * re-sends the whole context, so a repeated 10k-token read costs 10k tokens on every turn after it.
 *
 * The note is safe only while the earlier result is still in the context, so the caller resets the
 * tracker whenever the context is rebuilt (compaction, a branch switch, a new or resumed session).
 * A note is given once per reference: reading the same range again right after a note returns the
 * full text, which becomes the new reference. That way an agent that cannot find the earlier result
 * (another extension edited the context, for example) gets the text by asking twice.
 */
import { createHash } from "node:crypto";
import * as path from "node:path";

/** Reads shorter than this are cheaper to repeat than to explain. */
export const MIN_DEDUP_CHARS = 2_000;

interface Reference {
	hash: string;
	/** A note already pointed at this reference; the next identical read returns the full text. */
	noted: boolean;
}

export interface ReadCall {
	cwd: string;
	input: Record<string, unknown>;
	text: string;
}

export class ReadDedup {
	private readonly refs = new Map<string, Reference>();

	/** Forget every reference (the context no longer holds the earlier results). */
	reset(): void {
		this.refs.clear();
	}

	/** The note to return instead of `text`, or undefined to return the text unchanged. */
	check({ cwd, input, text }: ReadCall): string | undefined {
		const file = typeof input.path === "string" ? input.path : undefined;
		if (!file) return undefined;
		const key = rangeKey(path.resolve(cwd, file), input.offset, input.limit);
		if (text.length < MIN_DEDUP_CHARS) {
			this.refs.delete(key);
			return undefined;
		}
		const hash = createHash("sha256").update(text).digest("hex");
		const ref = this.refs.get(key);
		if (ref && ref.hash === hash && !ref.noted) {
			ref.noted = true;
			return note(file, input.offset, input.limit);
		}
		this.refs.set(key, { hash, noted: false });
		return undefined;
	}
}

function rangeKey(file: string, offset: unknown, limit: unknown): string {
	return JSON.stringify([file, offset ?? null, limit ?? null]);
}

function note(file: string, offset: unknown, limit: unknown): string {
	const range = offset !== undefined || limit !== undefined ? ` (offset ${offset ?? 1}, limit ${limit ?? "none"})` : "";
	return `[dev-team: ${file}${range} is unchanged. This read returned exactly the text of your earlier read in this conversation, which is still above. If you cannot find it, read again to get the full text.]`;
}
