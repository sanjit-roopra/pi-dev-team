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

export function readSmallFile(file: string, maxBytes = MAX_REPO_FILE_BYTES): string | undefined {
	let fd: number | undefined;
	try {
		const before = fs.statSync(file);
		if (!before.isFile() || before.size > maxBytes) return undefined;
		fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK ?? 0) | (fs.constants.O_NOCTTY ?? 0));
		const st = fs.fstatSync(fd);
		if (!st.isFile() || st.dev !== before.dev || st.ino !== before.ino || st.size > maxBytes) return undefined;
		const chunks: Buffer[] = [];
		let total = 0;
		for (;;) {
			const chunk = Buffer.allocUnsafe(Math.min(READ_CHUNK_BYTES, maxBytes + 1 - total));
			const n = fs.readSync(fd, chunk, 0, chunk.length, null);
			if (n === 0) break;
			chunks.push(chunk.subarray(0, n));
			total += n;
			if (total > maxBytes) return undefined;
		}
		return Buffer.concat(chunks, total).toString("utf-8");
	} catch {
		return undefined;
	} finally {
		if (fd !== undefined) fs.closeSync(fd);
	}
}
