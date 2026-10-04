/**
 * Bounded read of a file a repository may control (agent and skill markdown, settings and config
 * JSON, a pull request body file). Anything that is not a regular file of at most `maxBytes` (a FIFO,
 * /dev/zero, a device, a directory, a huge file) is skipped, so a repo cannot stall or exhaust the
 * session. The type is checked before the file is opened, because opening a device or FIFO can have
 * side effects. The open descriptor must still be the same regular file, so it cannot be swapped
 * between the check and the read. The read stops after `maxBytes`, because some files (Linux /proc)
 * report size 0 and yield far more. Symlinks are followed, so the target is what gets checked.
 */
import * as fs from "node:fs";

export const MAX_REPO_FILE_BYTES = 1024 * 1024;
const READ_CHUNK_BYTES = 64 * 1024;

export type BoundedRead = { text: string } | { skipped: "too-large" | "not-a-file" | "unreadable" };

/** Like readSmallFile, but says why a file was skipped. */
export function readBoundedFile(file: string, maxBytes = MAX_REPO_FILE_BYTES): BoundedRead {
	let fd: number | undefined;
	try {
		const pathStat = fs.statSync(file);
		if (!pathStat.isFile()) return { skipped: "not-a-file" };
		if (pathStat.size > maxBytes) return { skipped: "too-large" };
		fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK ?? 0) | (fs.constants.O_NOCTTY ?? 0));
		const openStat = fs.fstatSync(fd);
		if (!openStat.isFile() || openStat.dev !== pathStat.dev || openStat.ino !== pathStat.ino) return { skipped: "not-a-file" };
		if (openStat.size > maxBytes) return { skipped: "too-large" };
		const chunks: Buffer[] = [];
		let total = 0;
		for (;;) {
			const chunk = Buffer.allocUnsafe(Math.min(READ_CHUNK_BYTES, maxBytes + 1 - total));
			const n = fs.readSync(fd, chunk, 0, chunk.length, null);
			if (n === 0) break;
			chunks.push(chunk.subarray(0, n));
			total += n;
			if (total > maxBytes) return { skipped: "too-large" };
		}
		return { text: Buffer.concat(chunks, total).toString("utf-8") };
	} catch {
		return { skipped: "unreadable" };
	} finally {
		if (fd !== undefined) fs.closeSync(fd);
	}
}

export function readSmallFile(file: string, maxBytes = MAX_REPO_FILE_BYTES): string | undefined {
	const result = readBoundedFile(file, maxBytes);
	return "text" in result ? result.text : undefined;
}
