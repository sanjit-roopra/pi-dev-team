/**
 * The write guard on the saved requests (REQUEST_DIR, `.dev-team/requests/`) under the example check
 * (`DEV_TEAM_EXAMPLES=on`, gate profile). example_replay.py accepts a case only when its `source` is word for
 * word in a saved request, so the check is only as honest as that directory: dev-team code writes it (the
 * typed request, the examples a human approved), the model must not. The tool_call handler blocks a write,
 * edit or bash call that visibly writes, moves or deletes there, or moves or deletes the `.dev-team` folder
 * above it. Reads stay allowed: on a line that names the folder, only a command that can write without the
 * scan seeing the path is blocked (an interpreter, a nested shell, `dd`, `cp -t`, `find -delete`, ...); the
 * paths of rm, mv, cp, tee, touch and the like are resolved and blocked only when they land in the folder.
 * A human edits the folder freely; only the model's tool calls are checked.
 *
 * Not a sandbox: a program that builds the path at run time without naming the folder (`python -c` joining
 * strings, or a shell variable on a line that never mentions the folder) gets past this static scan.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { type BashCommand, bashCommands, type WriteTarget } from "./brief.ts";
import { REQUEST_DIR } from "./skills.ts";

export const REQUEST_DIR_BLOCK =
	"Saved requests are written by dev-team code only (the example check takes them as the human's own words). Do not write, move or delete anything under `.dev-team/requests/`. To read them, use cat, ls, rg, find or `example_replay.py --requests`; a script that names the folder is blocked. To make an example a case source, show it to the human with dev_team_approve_examples: an approval saves it there.";

/** A command line that names the folder, also as joined parts (`'.dev-team', 'requests'`). */
const NAMES_REQUEST_DIR = /dev-team[\W_]{1,8}requests/i;
/** A line that may spell the folder in parts (`"$(printf .dev-team/req)uests"`, `.dev-team/$X`). */
const HINTS_REQUEST_DIR = /dev-team[\W_]{0,8}req|dev-team\S*[$`]|[$`]\S*quests/i;
/**
 * Shell forms that carry a path from one statement to another: loops, functions, read/set/mapfile, aliases,
 * process substitution, and an assignment whose value is computed or names `.dev-team`. On a line that names
 * the folder they make every statement count as naming it.
 */
const CARRIES_PATH = /(?:^|[\s;&|(])(?:for|while|until|select|function|read|mapfile|readarray|set|alias|declare|typeset|local|export)\b|\(\)\s*\{|[<>]\(|(?:^|[\s;&|(])[A-Za-z_]\w*(?:\[[^\]]*\])?\+?=(?:\S*(?:\$\(|`|dev-team)|\()/i;

/** Commands that only read, so a statement that names the folder may still run them. */
const READ_ONLY_COMMANDS: ReadonlySet<string> = new Set([
	"cat", "ls", "head", "tail", "grep", "egrep", "fgrep", "rg", "wc", "diff", "cmp", "stat", "file", "sha256sum", "shasum", "md5sum",
	"cd", "pwd", "echo", "printf", "true", "false", "test", "[", "jq", "less", "nl", "basename", "dirname", "realpath", "readlink", "du",
	"column", "cut", "tr", "fold", "rev", "comm", "join", "paste", "expand", "fmt", "od", "hexdump", "strings", "md5", "cksum",
]);
/** find actions that run a command; allowed only when the command is itself a known read. */
const FIND_EXEC = /^-(?:exec|execdir)$/;
/** find actions that delete, ask, or write a file. */
const FIND_WRITES = /^-(?:delete|ok|okdir|fprint0?|fprintf|fls)$/;
/** git subcommands that only read (without `--output`). */
const GIT_READS: ReadonlySet<string> = new Set([
	"status", "log", "diff", "show", "ls-files", "ls-tree", "grep", "blame", "rev-parse", "rev-list", "describe", "cat-file", "shortlog", "check-ignore", "whatchanged",
]);
/** A sed script that only prints, deletes or substitutes on stdout: address, then p/d/q/=/n, or s/../../ with read flags. */
const SED_READ_SCRIPT = /^(?:(?:\d+|\$|\/(?:\\.|[^\/\\])*\/)(?:,(?:\d+|\$|\/(?:\\.|[^\/\\])*\/))?)?\s*(?:[pdqn=]|s(.)(?:\\.|(?!\1).)*\1(?:\\.|(?!\1).)*\1[gpI0-9]*)?(?:\s*;\s*(?:(?:\d+|\$|\/(?:\\.|[^\/\\])*\/)(?:,(?:\d+|\$|\/(?:\\.|[^\/\\])*\/))?)?\s*[pdqn=])*$/;
/** An awk program that writes a file or runs a command: print/printf to `>` or `|`, system(), or `"cmd" | getline`. */
const AWK_WRITES = /system\s*\(|\|\s*getline|(?:print|printf)\b[^;}]*(?:>|\|)/;

const CASE_INSENSITIVE_FS = process.platform === "darwin" || process.platform === "win32";
const foldPath = (p: string) => (CASE_INSENSITIVE_FS ? p.toLowerCase() : p);

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

/** Whether `file` is REQUEST_DIR or inside it (symlinks resolved, case folded like touchesRequestDir). */
function insideRequestDir(file: string, cwd: string): boolean {
	const fold = (p: string) => (CASE_INSENSITIVE_FS ? p.toLowerCase() : p);
	return inside(fold(realish(path.join(cwd, REQUEST_DIR))), fold(realish(path.resolve(cwd, file))));
}

/** `python example_replay.py ...`: the script is the first word after the interpreter's flags, and no `-c` or `-m` runs other code. */
function runsExampleReplay(words: string[]): boolean {
    if (!/^python(?:3(?:\.\d+)?)?$/.test(path.basename(words[0] ?? ""))) return false;
    let i = 1;
    for (; words[i]?.startsWith("-"); i++) if (/^-[A-Za-z]*[cm]/.test(words[i])) return false;
    return path.basename(words[i] ?? "") === "example_replay.py";
}

const unquote = (word: string) => word.replace(/^(['"])(.*)\1$/s, "$2");

/** The first word after leading flags, skipping the value of each flag in `withValue`. */
function firstOperand(args: string[], withValue: RegExp): { word: string | undefined; at: number } {
	for (let i = 0; i < args.length; i++) {
		if (!args[i].startsWith("-") || args[i] === "-") return { word: args[i], at: i };
		if (withValue.test(args[i])) i++;
	}
	return { word: undefined, at: args.length };
}

/**
 * Whether a command only reads, so it may run in a statement that names the folder: a known read, find
 * without a writing action (`-exec` only with a known read), a git read subcommand without `--output`,
 * sort without `-o`, uniq with at most one file, sed with only print/substitute scripts and no `-i`/`-f`,
 * awk with no `-f` and a program that neither prints to a file or command nor calls system(), or
 * `python example_replay.py`. Anything else (interpreters, shells, xargs, wrappers, ln, cp, unknown tools)
 * counts as a possible write: the list fails closed.
 */
function readsOnly(c: BashCommand): boolean {
	const name = c.name;
	const args = c.words.slice(1);
	if (name === "") return true; // a bare redirect or assignment: its targets are checked on their own
	// rg --pre runs a program on every file it searches.
	if (name === "rg") return !args.some((w) => /^--pre(?:=|$)/.test(w));
	if (READ_ONLY_COMMANDS.has(name)) return true;
	if (runsExampleReplay(c.words)) return true;
	// cp out of the folder: its destination is the last path, which the write check resolves; -t would swap that.
	if (name === "cp") return c.writes.length === 1 && !c.writes[0].dynamic && !args.some((w) => /^-[A-Za-z]*t|^--target-directory/.test(w));
	if (name === "find") {
		if (args.some((w) => FIND_WRITES.test(w))) return false;
		return args.every((w, i) => !FIND_EXEC.test(w) || READ_ONLY_COMMANDS.has(path.basename(args[i + 1] ?? "")));
	}
	if (name === "git") {
		const { word } = firstOperand(args, /^-[Cc]$/);
		return word !== undefined && GIT_READS.has(word) && !args.some((w) => /^--output(?:=|$)|^-o$/.test(w));
	}
	if (name === "sort") return !args.some((w) => /^-[A-Za-z]*o|^--output/.test(w));
	if (name === "uniq") return args.filter((w, i) => !w.startsWith("-") && !/^-[fsw]$/.test(args[i - 1] ?? "")).length <= 1;
	if (name === "sed") {
		if (args.some((w) => /^-[A-Za-z]*[if]|^--in-place|^--file/.test(w))) return false;
		const scripts: string[] = [];
		for (let i = 0; i < args.length; i++) {
			if (args[i] === "-e" || args[i] === "--expression") scripts.push(args[++i] ?? "");
			else if (!args[i].startsWith("-") && !scripts.length) scripts.push(args[i]);
		}
		return scripts.length > 0 && scripts.every((sc) => SED_READ_SCRIPT.test(unquote(sc).trim()));
	}
	if (/^[gmn]?awk$/.test(name)) {
		// -f reads the program from a file; gawk -i inplace (or any -i/--include library) rewrites its inputs.
		if (args.some((w) => /^-[A-Za-z]*[fiE]$|^--(?:file|include|exec)/.test(w))) return false;
		const { word } = firstOperand(args, /^-[Fv]$/);
		return word !== undefined && !AWK_WRITES.test(unquote(word));
	}
	return false;
}

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
        const arg = c.words.slice(1).find((w) => !/^-[LPe@]*$/.test(w) && w !== "--");
        const dir = unquote(arg ?? "~");
        if (dir === "-" || /[$`*?]|^~[^/]/.test(dir)) {
            unknown = true;
            continue;
        }
        base = path.resolve(base, dir.replace(/^~(?=$|\/)/, process.env.HOME ?? "~"));
        bases.push(base);
    }
    return { bases, unknown };
}

/**
 * The statements of a bash line as text: split at `;`, `&&`, `||`, `&` and newlines outside quotes,
 * `$(...)`, backticks, parentheses and heredoc bodies. A pipeline stays one statement, so the command that
 * reads the folder and the command it feeds are checked together. Heredoc bodies stay with their statement.
 */
function statements(command: string): string[] {
	const out: string[] = [];
	let cur = "";
	let depth = 0;
	const heredocs: string[] = [];
	for (let i = 0; i < command.length; ) {
		const ch = command[i];
		if (ch === "\\") {
			cur += command.slice(i, i + 2);
			i += 2;
		} else if (ch === "'") {
			const end = command.indexOf("'", i + 1);
			const stop = end < 0 ? command.length : end + 1;
			cur += command.slice(i, stop);
			i = stop;
		} else if (ch === '"') {
			let j = i + 1;
			while (j < command.length && command[j] !== '"') j += command[j] === "\\" ? 2 : 1;
			cur += command.slice(i, j + 1);
			i = j + 1;
		} else if (ch === "`") {
			const end = command.indexOf("`", i + 1);
			const stop = end < 0 ? command.length : end + 1;
			cur += command.slice(i, stop);
			i = stop;
		} else if (command.startsWith("<<", i) && command[i + 2] !== "<") {
			const m = /^<<-?\s*(['"]?)([^\s'";&|<>()]+)\1/.exec(command.slice(i));
			if (m) heredocs.push(m[2]);
			const len = m ? m[0].length : 2;
			cur += command.slice(i, i + len);
			i += len;
		} else if (ch === "\n") {
			cur += ch;
			i++;
			// The bodies of heredocs opened on this line belong to the statement that opened them.
			while (heredocs.length) {
				const delim = heredocs.shift()!;
				for (;;) {
					const lineEnd = command.indexOf("\n", i);
					const line = command.slice(i, lineEnd < 0 ? command.length : lineEnd);
					cur += line + (lineEnd < 0 ? "" : "\n");
					i = lineEnd < 0 ? command.length : lineEnd + 1;
					if (line.replace(/^\t+/, "") === delim || lineEnd < 0) break;
				}
			}
			if (depth === 0) {
				out.push(cur);
				cur = "";
			}
		} else if (ch === "(" ) {
			depth++;
			cur += ch;
			i++;
		} else if (ch === ")") {
			depth = Math.max(0, depth - 1);
			cur += ch;
			i++;
		} else if (depth === 0 && (ch === ";" || (ch === "&" && command[i - 1] !== ">" && command[i + 1] !== ">") || (ch === "|" && command[i + 1] === "|"))) {
			out.push(cur);
			cur = "";
			i += ch === "|" || (ch === "&" && command[i + 1] === "&") ? 2 : 1;
		} else {
			cur += ch;
			i++;
		}
	}
	out.push(cur);
	return out.map((x) => x.trim()).filter(Boolean);
}

/**
 * Whether a tool call writes REQUEST_DIR. write and edit: their path. bash: a visible write target there
 * (redirect, cp, mv, tee, ln, touch, rm, sed -i, ...), resolved against the project and every folder the
 * line `cd`s into (`mkdir` of the `.dev-team` folder above it is fine); a computed target on a line that
 * mentions `dev-team`; any write after a `cd` the scan cannot follow on a line that mentions `dev-team`
 * or `requests`. Then, on a line that names the folder: each statement (pipeline) that names it may run
 * only commands that read (readsOnly), so `find .dev-team/requests; python -m unittest` runs but
 * `ls .dev-team/requests | xargs rm` or `echo ... .dev-team/requests ... | sh` do not. After a `cd` near
 * the folder or one the scan cannot follow (computed, `cd -`, `~+`), a loop, function, read/set, alias,
 * process substitution, a computed assignment, or a statement that writes the folder's name to a file (a
 * script run later), every statement of the line counts as naming the folder.
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
    const home = (p: string) => p.replace(/^~(?=$|\/)/, process.env.HOME ?? "~");
    const hits = (c: BashCommand, t: WriteTarget) =>
        !t.dynamic &&
        bases.some((b) => {
            const file = path.resolve(b, home(t.text));
            // mkdir -p .dev-team only creates the folder above; it cannot change a saved request.
            return c.name === "mkdir" ? insideRequestDir(file, cwd) : touchesRequestDir(file, cwd);
        });
    if (commands.some((c) => c.writes.some((t) => hits(c, t)))) return true;
    const targets = commands.flatMap((c) => c.writes);
    // A computed target whose literal start lies in .dev-team (`.dev-team/req$(echo uests)/a.md`), or on a line
    // that spells the folder in parts or carries a path in a variable or loop.
    const devTeam = path.dirname(REQUEST_DIR);
    const startsInDevTeam = (t: WriteTarget) => {
        const prefix = unquote(t.text.split(/[$`]/)[0]).replace(/^["']/, "");
        return prefix !== "" && bases.some((b) => inside(foldPath(realish(path.join(cwd, devTeam))), foldPath(realish(path.resolve(b, home(prefix))))));
    };
    if (targets.some((t) => t.dynamic && (startsInDevTeam(t) || HINTS_REQUEST_DIR.test(command) || CARRIES_PATH.test(command)))) return true;
    if (unknown && targets.length && /dev-team|requests/i.test(command)) return true;
    const cdNear = bases.slice(1).some((b) => touchesRequestDir(b, cwd));
    if (!cdNear && !NAMES_REQUEST_DIR.test(command)) return false;
    if (targets.some((t) => t.dynamic)) return true;
    const parts = statements(command).map((text) => ({ text, names: NAMES_REQUEST_DIR.test(text), commands: bashCommands(text) }));
    // A statement that names the folder and writes a file (`echo '... .dev-team/requests ...' > /tmp/w.sh`) may
    // be a script a later statement runs; a cd whose target the shell computes may land in the folder.
    const writesFolderName = parts.some((st) => st.names && st.commands.some((c) => c.writes.some((t) => !/^\/dev\/(?:null|stdout|stderr|tty)$/.test(t.text))));
    const computedCd = /(?:^|[\s;&|(])(?:cd|pushd)\s+[^;&|\n]*[$`]/.test(command);
    const lineWide = cdNear || unknown || computedCd || writesFolderName || CARRIES_PATH.test(command);
    return parts.some((st) => (lineWide || st.names) && !st.commands.every(readsOnly));
}
