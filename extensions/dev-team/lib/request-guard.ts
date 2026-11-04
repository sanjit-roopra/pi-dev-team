/**
 * The write guard on the saved requests (REQUEST_DIR, `.claude/memory/requests/`) under the example check
 * (`DEV_TEAM_EXAMPLES=on`, gate profile). example_replay.py accepts a case only when its `source` is word for
 * word in a saved request, so the check is only as honest as that directory: dev-team code writes it (the
 * typed request, the examples a human approved), the model must not. The tool_call handler blocks a write,
 * edit or bash call that visibly writes, moves or deletes there, or the `.claude` and `.claude/memory`
 * folders above it. Reads stay allowed (`cat`, `ls`, `example_replay.py --requests`).
 *
 * Not a sandbox: a program that builds the path at run time without naming the folder (`python -c` joining
 * strings, or a shell variable on a line that never mentions `.claude`) gets past this static scan.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { type BashCommand, bashCommands } from "./brief.ts";
import { REQUEST_DIR } from "./skills.ts";

export const REQUEST_DIR_BLOCK =
	"Saved requests are written by dev-team code only (the example check takes them as the human's own words). Do not write, move or delete anything under `.claude/memory/requests/`. To make an example a case source, show it to the human with dev_team_approve_examples: an approval saves it there.";

/** A command line that names the folder, also as joined parts (`'memory', 'requests'`). */
const NAMES_REQUEST_DIR = /memory[\W_]{1,8}requests/i;

/** Commands that only read, so a line that names the folder may still run them. */
const READ_ONLY_COMMANDS: ReadonlySet<string> = new Set([
	"cat", "ls", "head", "tail", "grep", "egrep", "fgrep", "rg", "wc", "diff", "cmp", "stat", "file", "sha256sum", "shasum", "md5sum",
	"cd", "pwd", "echo", "printf", "true", "jq", "less", "nl", "basename", "dirname", "realpath", "readlink", "du",
]);

const CASE_INSENSITIVE_FS = process.platform === "darwin" || process.platform === "win32";

/** The real path of the longest existing prefix of `p`, with the rest appended (symlinks resolved). */
function realish(p: string): string {
	const tail: string[] = [];
	for (let head = p; ; head = path.dirname(head)) {
		try {
			return path.join(fs.realpathSync.native(head), ...tail);
		} catch {
			if (path.dirname(head) === head) return p;
			tail.unshift(path.basename(head));
		}
	}
}

const inside = (parent: string, child: string) => {
	const rel = path.relative(parent, child);
	return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
};

/** Whether writing `file` changes REQUEST_DIR: a path in it, the folder itself, or a folder above it inside the project. */
export function touchesRequestDir(file: string, cwd: string): boolean {
	const fold = (p: string) => (CASE_INSENSITIVE_FS ? p.toLowerCase() : p);
	const root = fold(realish(path.resolve(cwd)));
	const dir = fold(realish(path.join(cwd, REQUEST_DIR)));
	const target = fold(realish(path.resolve(cwd, file.replace(/^~(?=$|\/)/, process.env.HOME ?? "~"))));
	return inside(dir, target) || (target !== root && inside(root, target) && inside(target, dir));
}

/** `python example_replay.py ...`: the script is the first word after the interpreter's flags, and no `-c` or `-m` runs other code. */
function runsExampleReplay(words: string[]): boolean {
    if (!/^python(?:3(?:\.\d+)?)?$/.test(path.basename(words[0] ?? ""))) return false;
    let i = 1;
    for (; words[i]?.startsWith("-"); i++) if (/^-[A-Za-z]*[cm]/.test(words[i])) return false;
    return path.basename(words[i] ?? "") === "example_replay.py";
}

const unquote = (word: string) => word.replace(/^(['"])(.*)\1$/s, "$2");

/**
 * The folders a bash line writes relative to: the project, then every `cd`/`pushd` target in turn (a
 * redirect resolves against the folder the shell is in, not ctx.cwd). `unknown`: a `cd` the scan cannot
 * follow (computed, `cd -`, `popd`).
 */
function cdBases(commands: BashCommand[], cwd: string): { bases: string[]; unknown: boolean } {
    const bases = [cwd];
    let base = cwd;
    let unknown = false;
    for (const c of commands) {
        if (c.name === "popd") unknown = true;
        if (c.name !== "cd" && c.name !== "pushd") continue;
        const arg = c.words.slice(1).find((w) => !/^-[LPe@]*$/.test(w));
        const dir = unquote(arg ?? "~");
        if (dir === "-" || /[$`*?]/.test(dir)) {
            unknown = true;
            continue;
        }
        base = path.resolve(base, dir.replace(/^~(?=$|\/)/, process.env.HOME ?? "~"));
        bases.push(base);
    }
    return { bases, unknown };
}

/**
 * Whether a tool call writes REQUEST_DIR. write and edit: their path. bash: a visible write target there
 * (redirect, cp, mv, tee, ln, touch, rm, sed -i, ...), resolved against the project and every folder the
 * line `cd`s into; when the line names the folder or `cd`s into `.claude` or below, a computed target or
 * any command that is not a known read (cat, ls, example_replay.py, ...); a computed target on any line
 * that mentions `.claude`; and any write after a `cd` the scan cannot follow on a line that mentions
 * `.claude`, `memory` or `requests`.
 */
export function writesRequestDir(toolName: string, input: Record<string, unknown>, cwd: string): boolean {
    if (toolName === "write" || toolName === "edit") {
        const file = input.path ?? input.file_path;
        return typeof file === "string" && file !== "" && touchesRequestDir(file, cwd);
    }
    // No parser for PowerShell: any line that names the folder is taken as a write.
    if (toolName === "powershell") return typeof input.command === "string" && NAMES_REQUEST_DIR.test(input.command);
    if (toolName !== "bash" || typeof input.command !== "string") return false;
    const command = input.command;
    const commands = bashCommands(command);
    const { bases, unknown } = cdBases(commands, cwd);
    const targets = commands.flatMap((c) => c.writes);
    if (targets.some((t) => !t.dynamic && bases.some((b) => touchesRequestDir(path.resolve(b, t.text.replace(/^~(?=$|\/)/, process.env.HOME ?? "~")), cwd)))) return true;
    if (targets.some((t) => t.dynamic) && /\.claude/i.test(command)) return true;
    if (unknown && targets.length && /\.claude|memory|requests/i.test(command)) return true;
    const cdNear = bases.slice(1).some((b) => touchesRequestDir(b, cwd));
    if (!cdNear && !NAMES_REQUEST_DIR.test(command)) return false;
    return targets.some((t) => t.dynamic) || commands.some((c) => c.name !== "" && !READ_ONLY_COMMANDS.has(c.name) && !runsExampleReplay(c.words));
}
