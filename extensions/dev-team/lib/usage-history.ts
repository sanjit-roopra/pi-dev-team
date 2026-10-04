/**
 * What GitHub Copilot cost this calendar month, read from every saved pi session file: the
 * "This month" scope of /dev-team usage. Reads are stat-first and async so a large session history
 * does not stall the TUI. Spend is classified by sessionSpend() (session-spend.ts), the same walk
 * the status line uses, so both views agree on what a run is.
 */
import type { Dirent } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import * as path from "node:path";
import { sessionSpend, type SpendRun } from "./session-spend.ts";

/** One run of spend, with when its session entry was written (the entry's ISO 8601 `timestamp`, as stored). */
export interface UsageRecord {
	timestamp: string;
	run: SpendRun;
}

export interface UsageHistory {
	records: UsageRecord[];
	/** Session files that could not be read. Files skipped for being too old are not counted. */
	skipped: number;
	/** True when the load was cancelled; `records` then hold only what was read before that. */
	aborted: boolean;
}

/** pi names a project's session folder `--<encoded cwd>--`. */
const PROJECT_DIR = /^--.+--$/;

/**
 * The folder every project's sessions live under: the parent of a session's own `--<cwd>--` folder,
 * or the folder itself when a custom session dir keeps its files flat.
 */
export function sessionRoot(sessionDir: string): string {
	return PROJECT_DIR.test(path.basename(sessionDir)) ? path.dirname(sessionDir) : sessionDir;
}

/**
 * The first instant of the calendar month `now` falls in, in UTC. GitHub resets Copilot's monthly
 * allowance on the 1st at 00:00:00 UTC:
 * https://docs.github.com/en/copilot/concepts/billing/copilot-requests ("Premium request counters
 * reset on the 1st of each month at 00:00:00 UTC", checked 2026-10-04). Local time would put the
 * boundary hours off for anyone not on UTC.
 */
export function monthStart(now: Date): Date {
	return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

const SESSION_FILE = ".jsonl";

const isNotFound = (err: unknown): boolean => (err as { code?: string } | undefined)?.code === "ENOENT";

const byName = (entries: readonly Dirent[]): Dirent[] => [...entries].sort((a, b) => a.name.localeCompare(b.name));

/** The session files among a folder's entries, in name order. */
const sessionFilesIn = (dir: string, entries: readonly Dirent[]): string[] =>
	byName(entries).filter((entry) => entry.isFile() && entry.name.endsWith(SESSION_FILE)).map((entry) => path.join(dir, entry.name));

/**
 * Session files directly under the root (`<root>/*.jsonl`, a flat custom session dir) or one folder
 * down (`<root>/<project>/*.jsonl`, pi's default layout), and nothing deeper: another extension keeps
 * its own `<session>/<hash>/run-N/session.jsonl` transcripts under the same root, and those are not
 * this session history. A missing root is no history; any other failure to list it is thrown. A project
 * folder that cannot be listed counts as one skipped file, since its sessions are unknown.
 */
async function listSessionFiles(root: string): Promise<{ files: string[]; unlistable: number }> {
	const files: string[] = [];
	let unlistable = 0;
	let top;
	try {
		top = await readdir(root, { withFileTypes: true });
	} catch (err) {
		if (isNotFound(err)) return { files, unlistable };
		throw err;
	}
	files.push(...sessionFilesIn(root, top));
	for (const folder of byName(top).filter((entry) => entry.isDirectory())) {
		const dir = path.join(root, folder.name);
		try {
			files.push(...sessionFilesIn(dir, await readdir(dir, { withFileTypes: true })));
		} catch (err) {
			if (!isNotFound(err)) unlistable++;
		}
	}
	return { files, unlistable };
}

/** The JSON objects among a file's lines; a truncated last line or any other non-JSON line is ignored. */
function parseEntries(text: string): Record<string, unknown>[] {
	const entries: Record<string, unknown>[] = [];
	for (const line of text.split("\n")) {
		if (!line.trim()) continue;
		try {
			const value: unknown = JSON.parse(line);
			if (value && typeof value === "object" && !Array.isArray(value)) entries.push(value as Record<string, unknown>);
		} catch {
			// not an entry
		}
	}
	return entries;
}

/**
 * Each entry with the runs it spent. The whole file goes through sessionSpend() in order, because a
 * compaction is booked to the model an earlier entry put in effect; entries are then matched to their
 * runs by count, which does not depend on that tracking: an entry yields the same runs on its own.
 */
function* entrySpend(entries: readonly Record<string, unknown>[]): Generator<{ entry: Record<string, unknown>; runs: SpendRun[] }> {
	const all = sessionSpend(entries);
	for (const entry of entries) {
		const runs: SpendRun[] = [];
		for (let n = Array.from(sessionSpend([entry])).length; n > 0; n--) runs.push(all.next().value as SpendRun);
		yield { entry, runs };
	}
}

/**
 * Identifies an entry across session files: a fork or clone copies entries verbatim, id and timestamp
 * included, so the same pair in two files is one piece of spend. Undefined for an entry without an id.
 */
const entryKey = (entry: Record<string, unknown>): string | undefined => (typeof entry.id === "string" ? `${entry.id}|${entry.timestamp}` : undefined);

/**
 * One session file's runs of spend since `since`, leaving out entries whose key is in `seen`, and the
 * keys of the entries it kept. Throws when the file cannot be read or holds an entry sessionSpend()
 * cannot make sense of; nothing partial is returned, so a skipped file adds no records and claims no keys.
 */
async function readRecords(file: string, since: Date, seen: ReadonlySet<string>): Promise<{ records: UsageRecord[]; keys: string[] }> {
	const records: UsageRecord[] = [];
	const keys: string[] = [];
	for (const { entry, runs } of entrySpend(parseEntries(await readFile(file, "utf8")))) {
		const { timestamp } = entry;
		// An entry with no usable time cannot be placed in the month, so it is left out.
		if (typeof timestamp !== "string" || !(Date.parse(timestamp) >= since.getTime())) continue;
		const key = entryKey(entry);
		if (runs.length === 0 || (key !== undefined && seen.has(key))) continue;
		if (key !== undefined) keys.push(key);
		for (const run of runs) records.push({ timestamp, run });
	}
	return { records, keys };
}

export interface LoadOptions {
	/** The folder holding the project session folders (see sessionRoot). */
	root: string;
	/** Entries stamped before this are left out. */
	since: Date;
	/** Called after each file that was read (or failed to be), over the files modified since `since`. */
	onProgress?: (done: number, total: number) => void;
	/** Stops the load between files; the result is then `aborted`, with what was read so far. */
	signal?: AbortSignal;
}

/**
 * Every run of spend in the saved session files under `root`, with the time of the entry that spent
 * it. A file last modified before `since` cannot hold an entry from after it, so it is never opened.
 * An entry shared by several files (a fork or clone of a session) is counted once, from the first
 * file read: root-level files by name, then each project folder's by name.
 */
export async function loadUsageHistory({ root, since, onProgress, signal }: LoadOptions): Promise<UsageHistory> {
	const { files, unlistable } = await listSessionFiles(root);
	const recent: string[] = [];
	let skipped = unlistable;
	for (const file of files) {
		if (signal?.aborted) return { records: [], skipped, aborted: true };
		try {
			if ((await stat(file)).mtimeMs >= since.getTime()) recent.push(file);
		} catch {
			skipped++;
		}
	}
	const records: UsageRecord[] = [];
	const seen = new Set<string>();
	for (const [i, file] of recent.entries()) {
		if (signal?.aborted) return { records, skipped, aborted: true };
		try {
			const read = await readRecords(file, since, seen);
			for (const record of read.records) records.push(record);
			for (const key of read.keys) seen.add(key);
		} catch {
			skipped++;
		}
		onProgress?.(i + 1, recent.length);
	}
	return { records, skipped, aborted: false };
}
