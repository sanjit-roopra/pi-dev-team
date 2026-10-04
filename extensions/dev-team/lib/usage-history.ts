/**
 * Timestamped runs of spend loaded from every saved pi session file, for the "This month" scope of
 * /dev-team usage. All providers are loaded; grouping them is usage-breakdown's job.
 * Reads are stat-first and async so a large session history does not stall the TUI. Spend is
 * classified by sessionSpendByEntry() (session-spend.ts), the same walk the status line uses, so both
 * views agree on what a run is.
 */
import { createReadStream, type Dirent } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import * as path from "node:path";
import { createInterface } from "node:readline";
import { sessionSpendByEntry, type SpendRun } from "./session-spend.ts";

/** One run of spend, with when its session entry was written (the entry's ISO 8601 `timestamp`, as stored). */
export interface SpendRecord {
	timestamp: string;
	run: SpendRun;
}

export interface SpendHistory {
	records: SpendRecord[];
	/** Session files that could not be read. Files skipped for being too old, or gone before they were read, are not counted. */
	unreadable: number;
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

const SESSION_FILE_EXTENSION = ".jsonl";

const isNotFound = (err: unknown): boolean => (err as { code?: string } | undefined)?.code === "ENOENT";

/** By code unit, so the order that decides which copy of a shared entry wins is the same on every machine and locale. */
const sortedByName = (dirents: readonly Dirent[]): Dirent[] => [...dirents].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

/** The session files among a folder's dirents, in name order. */
const sessionFilesIn = (dir: string, dirents: readonly Dirent[]): string[] =>
	sortedByName(dirents).filter((dirent) => dirent.isFile() && dirent.name.endsWith(SESSION_FILE_EXTENSION)).map((dirent) => path.join(dir, dirent.name));

/**
 * Session files directly under the root (`<root>/*.jsonl`, a flat custom session dir) or one folder
 * down (`<root>/<project>/*.jsonl`, pi's default layout), and nothing deeper: another extension keeps
 * its own `<session>/<hash>/run-N/session.jsonl` transcripts under the same root, and those are not
 * this session history. A missing root is no history; any other failure to list it is thrown. A project
 * folder that cannot be listed counts as one unreadable file, since its sessions are unknown.
 */
async function listSessionFiles(root: string): Promise<{ files: string[]; unlistable: number }> {
	const files: string[] = [];
	let unlistable = 0;
	let rootDirents;
	try {
		rootDirents = await readdir(root, { withFileTypes: true });
	} catch (err) {
		if (isNotFound(err)) return { files, unlistable };
		throw err;
	}
	files.push(...sessionFilesIn(root, rootDirents));
	for (const folder of sortedByName(rootDirents).filter((dirent) => dirent.isDirectory())) {
		const dir = path.join(root, folder.name);
		try {
			files.push(...sessionFilesIn(dir, await readdir(dir, { withFileTypes: true })));
		} catch (err) {
			if (!isNotFound(err)) unlistable++;
		}
	}
	return { files, unlistable };
}

/**
 * A line's JSON object, or undefined for a blank line, a truncated last line or any other line that is
 * not an entry. pi's own parseSessionEntries is not used: pi exports it for its tests only, and it keeps
 * any parsed value, where a line that is not an object (`null`, `[1]`, `7`) cannot be an entry and is
 * dropped here.
 */
function parseEntry(line: string): Record<string, unknown> | undefined {
	if (!line.trim()) return undefined;
	try {
		const value: unknown = JSON.parse(line);
		return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
	} catch {
		return undefined;
	}
}

/**
 * A file's entries, read line by line so the file's text is never held whole; only the parsed entries
 * are, since a compaction's model depends on entries before it. `signal` is checked between lines, and
 * the stream is destroyed however the read ends. Undefined when aborted partway: the file is then
 * unfinished and must add nothing. Throws when the file cannot be opened or read.
 */
async function readEntries(file: string, signal: AbortSignal | undefined): Promise<Record<string, unknown>[] | undefined> {
	const entries: Record<string, unknown>[] = [];
	const input = createReadStream(file, { encoding: "utf8" });
	const lines = createInterface({ input, crlfDelay: Infinity });
	try {
		for await (const line of lines) {
			if (signal?.aborted) return undefined;
			const entry = parseEntry(line);
			if (entry) entries.push(entry);
		}
	} finally {
		lines.close();
		input.destroy();
	}
	return entries;
}

/**
 * Identifies an entry across session files: a fork or clone copies entries verbatim, id and timestamp
 * included, so the same pair in two files is one piece of spend. Undefined for an entry without an id.
 */
const entryKey = (entry: Record<string, unknown>): string | undefined => (typeof entry.id === "string" ? `${entry.id}|${entry.timestamp}` : undefined);

/**
 * One session file's runs of spend since `since`, leaving out entries whose key is in `seenKeys` (kept
 * from earlier files) or that repeat an earlier entry of this file, and the keys of the entries it
 * kept. Throws when the file cannot be read or holds an entry sessionSpendByEntry() cannot make sense
 * of; nothing partial is returned, so an unreadable file adds no records and claims no keys. Undefined
 * when `signal` aborted the read partway.
 */
async function readRecords(file: string, since: Date, seenKeys: ReadonlySet<string>, signal: AbortSignal | undefined): Promise<{ records: SpendRecord[]; entryKeys: string[] } | undefined> {
	const entries = await readEntries(file, signal);
	if (!entries) return undefined;
	const records: SpendRecord[] = [];
	const entryKeys = new Set<string>();
	for (const { entry, runs } of sessionSpendByEntry(entries)) {
		const { timestamp } = entry;
		// An entry with no usable time cannot be placed in the month, so it is left out.
		if (typeof timestamp !== "string" || !(Date.parse(timestamp) >= since.getTime())) continue;
		const key = entryKey(entry);
		if (runs.length === 0 || (key !== undefined && (seenKeys.has(key) || entryKeys.has(key)))) continue;
		if (key !== undefined) entryKeys.add(key);
		for (const run of runs) records.push({ timestamp, run });
	}
	return { records, entryKeys: [...entryKeys] };
}

export interface LoadOptions {
	/** The folder holding the project session folders (see sessionRoot). */
	root: string;
	/** Entries stamped before this are left out. */
	since: Date;
	/**
	 * Called after each file that was read (or failed to be), over the files modified since `since`.
	 * An error it throws is swallowed: progress display must not be able to fail the load.
	 */
	onProgress?: (done: number, total: number) => void;
	/**
	 * Stops the load, between files and between a file's lines; the result is then `aborted`, with the
	 * files read whole so far (a file cut off partway adds nothing).
	 */
	signal?: AbortSignal;
}

/**
 * Every run of spend in the saved session files under `root`, with the time of the entry that spent
 * it. A file last modified before `since` cannot hold an entry from after it, so it is never opened.
 * An entry shared by several files (a fork or clone of a session) is counted once, from the first
 * file read: root-level files by name, then each project folder's by name.
 */
export async function loadSpendHistory({ root, since, onProgress, signal }: LoadOptions): Promise<SpendHistory> {
	const { files, unlistable } = await listSessionFiles(root);
	const recentFiles: string[] = [];
	let unreadable = unlistable;
	for (const file of files) {
		if (signal?.aborted) return { records: [], unreadable, aborted: true };
		try {
			if ((await stat(file)).mtimeMs >= since.getTime()) recentFiles.push(file);
		} catch (err) {
			if (!isNotFound(err)) unreadable++;
		}
	}
	const records: SpendRecord[] = [];
	const seenKeys = new Set<string>();
	for (const [i, file] of recentFiles.entries()) {
		if (signal?.aborted) return { records, unreadable, aborted: true };
		try {
			const fileResult = await readRecords(file, since, seenKeys, signal);
			if (!fileResult) return { records, unreadable, aborted: true };
			for (const record of fileResult.records) records.push(record);
			for (const key of fileResult.entryKeys) seenKeys.add(key);
		} catch (err) {
			if (!isNotFound(err)) unreadable++;
		}
		try {
			onProgress?.(i + 1, recentFiles.length);
		} catch {
			// a failing progress display must not fail the load
		}
	}
	return { records, unreadable, aborted: false };
}
