/**
 * Files the port writes for a session: synthetic subagent transcripts (read by the SubagentStop hooks)
 * and the complete output of a subagent whose result was cut. All of it lives in one private
 * directory per pi process, created with mkdtemp (mode 0700, unpredictable name), so another local
 * user cannot pre-create or redirect it in a shared temp directory. Files are created exclusively
 * (`wx`). Everything is removed when pi quits; a reload, new, resumed or forked session keeps it, since
 * tool results already in a session may point at these files.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// Kept on globalThis so a /reload, which loads this module again, still finds and removes the same root.
const ROOT_KEY = Symbol.for("pi-dev-team.session-files.root");
const shared = globalThis as { [ROOT_KEY]?: string };

/** The private root for this process, created on first use. `baseDir` is for tests. */
function root(baseDir?: string): string {
	if (baseDir) return baseDir;
	shared[ROOT_KEY] ??= fs.mkdtempSync(path.join(os.tmpdir(), "pi-dev-team-"));
	return shared[ROOT_KEY];
}

function safeSegment(value: string): string {
	return value.replace(/[^\w.-]/g, "_").replace(/^\.+/, "_");
}

/** `<root>/<session>/<area>`, created owner-only. */
export function sessionDir(sessionId: string, area: string, baseDir?: string): string {
	const dir = path.join(root(baseDir), safeSegment(sessionId), safeSegment(area));
	fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
	return dir;
}

/** Write a new file owner-only; never follows or overwrites an existing path. */
export function writeSessionFile(sessionId: string, area: string, name: string, content: string, baseDir?: string): string {
	const file = path.join(sessionDir(sessionId, area, baseDir), safeSegment(name));
	fs.writeFileSync(file, content, { encoding: "utf-8", mode: 0o600, flag: "wx" });
	return file;
}

/** Remove everything this process wrote (idempotent; safe when nothing was written). */
export function removeProcessFiles(baseDir?: string): void {
	const base = baseDir ?? shared[ROOT_KEY];
	if (!base) return;
	fs.rmSync(base, { recursive: true, force: true });
	if (!baseDir) delete shared[ROOT_KEY];
}

/** Keep a subagent's complete output when its result was cut; undefined if it cannot be saved. */
export function saveFullOutput(sessionId: string, agent: string, agentId: string, output: string, baseDir?: string): string | undefined {
	try {
		return writeSessionFile(sessionId, "subagent-output", `${agent}-${agentId}.md`, output, baseDir);
	} catch {
		return undefined;
	}
}
