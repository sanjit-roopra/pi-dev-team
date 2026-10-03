/**
 * Bounded read of a file a repository may control (agent and skill markdown, settings and config
 * JSON). Anything that is not a regular file of at most `maxBytes` (a FIFO, /dev/zero, a directory, a
 * huge file) is skipped without reading, so a repo cannot stall or exhaust the session. Symlinks are
 * followed, so the target is what gets checked.
 */
import * as fs from "node:fs";

export const MAX_REPO_FILE_BYTES = 1024 * 1024;

export function readSmallFile(file: string, maxBytes = MAX_REPO_FILE_BYTES): string | undefined {
	try {
		const st = fs.statSync(file);
		if (!st.isFile() || st.size > maxBytes) return undefined;
		return fs.readFileSync(file, "utf-8");
	} catch {
		return undefined;
	}
}
