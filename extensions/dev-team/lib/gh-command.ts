/**
 * The title and body that `gh pr|issue create|edit|comment` commands in a bash command line send.
 * Only literal values are returned: a value the shell computes is left undefined, so it is not checked.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { readSmallFile } from "./safe-read.ts";
import { type ShellSegment, type ShellWord, scanShell } from "./shell-scan.ts";

/** Visible words allowed, by kind. Code, <details> blocks, HTML comments, tables and headings do not count. */
export const WORD_LIMITS = { pr: 250, issue: 250, comment: 150 } as const;
export type GhTextKind = keyof typeof WORD_LIMITS;

/** Text longer than this is reported as too long and not checked further, so the check stays fast. */
export const MAX_LINT_CHARS = 100_000;
/** A body file is read up to this size: MAX_LINT_CHARS characters of UTF-8 take at most 4 bytes each. */
export const MAX_BODY_FILE_BYTES = MAX_LINT_CHARS * 4;

export interface GhText {
	kind: GhTextKind;
	title?: string;
	body?: string;
	/** The body file is larger than MAX_BODY_FILE_BYTES, so it was not read. */
	bodyFileTooLarge?: boolean;
}

const TITLE_FLAGS = new Set(["--title", "-t"]);
const BODY_FLAGS = new Set(["--body", "-b"]);
const BODY_FILE_FLAGS = new Set(["--body-file", "-F"]);
const GH_GROUPS = new Set(["pr", "issue"]);
const GH_ACTIONS = new Set(["create", "edit", "comment"]);
/** Words that can come before the command itself in a simple command. */
const COMMAND_PREFIXES = new Set(["if", "then", "elif", "else", "do", "while", "until", "!", "{", "time", "env", "command", "exec", "nohup"]);

function isRegularFileOver(file: string, bytes: number): boolean {
	try {
		const st = fs.statSync(file);
		return st.isFile() && st.size > bytes;
	} catch {
		return false;
	}
}

function readBodyFile(value: ShellWord, stdin: string | undefined, cwd: string, ghText: GhText): void {
	delete ghText.bodyFileTooLarge;
	ghText.body = undefined;
	if (value.dynamic) return;
	if (value.text === "-") {
		ghText.body = stdin;
		return;
	}
	const file = path.resolve(cwd, value.text);
	ghText.body = readSmallFile(file, MAX_BODY_FILE_BYTES);
	if (ghText.body === undefined && isRegularFileOver(file, MAX_BODY_FILE_BYTES)) ghText.bodyFileTooLarge = true;
}

/** Literal stdin from a `<<'EOF'` heredoc or a `<<<` here-string in the command's arguments. */
function readStdin(args: ShellWord[]): string | undefined {
	for (let argIndex = 0; argIndex < args.length; argIndex++) {
		const arg = args[argIndex];
		if (arg.redirect === "heredoc") return arg.dynamic ? undefined : arg.heredocBody;
		if (arg.redirect === "here-string") {
			const value = args[argIndex + 1];
			return value && !value.dynamic ? `${value.text}\n` : undefined;
		}
	}
	return undefined;
}

/** The text one simple command sends, when it is `[prefix ...] [NAME=value ...] gh pr|issue create|edit|comment ...`. */
function findGhText(segment: ShellSegment, cwd: string): GhText | undefined {
	let commandIndex = 0;
	while (
		commandIndex < segment.length &&
		!segment[commandIndex].dynamic &&
		(COMMAND_PREFIXES.has(segment[commandIndex].text) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(segment[commandIndex].text))
	) {
		commandIndex++;
	}
	const [command, group, action] = segment.slice(commandIndex, commandIndex + 3);
	if (!command || command.dynamic || path.basename(command.text) !== "gh") return undefined;
	if (!group || !GH_GROUPS.has(group.text) || !action || !GH_ACTIONS.has(action.text)) return undefined;
	const args = segment.slice(commandIndex + 3);
	const stdin = readStdin(args);
	const ghText: GhText = { kind: action.text === "comment" ? "comment" : group.text === "pr" ? "pr" : "issue" };
	for (let argIndex = 0; argIndex < args.length; argIndex++) {
		const arg = args[argIndex];
		if (arg.redirect) {
			argIndex += arg.redirect === "here-string" ? 1 : 0;
			continue;
		}
		const inlineFlag = /^(--[a-z-]+)=([\s\S]*)$/.exec(arg.text);
		const flag = inlineFlag ? inlineFlag[1] : arg.text;
		if (!TITLE_FLAGS.has(flag) && !BODY_FLAGS.has(flag) && !BODY_FILE_FLAGS.has(flag)) continue;
		const value: ShellWord | undefined = inlineFlag ? { text: inlineFlag[2], dynamic: arg.dynamic } : args[++argIndex];
		if (!value || value.redirect) continue;
		if (TITLE_FLAGS.has(flag)) ghText.title = value.dynamic ? undefined : value.text;
		else if (BODY_FLAGS.has(flag)) {
			ghText.body = value.dynamic ? undefined : value.text;
			delete ghText.bodyFileTooLarge;
		} else readBodyFile(value, stdin, cwd, ghText);
	}
	return ghText;
}

/**
 * The title and body that each `gh pr|issue create|edit|comment` in a bash command sends. A value the
 * shell computes ($VAR, `$(git log ...)`, an unquoted heredoc with $ in it) is left undefined and not
 * checked. `$(cat <<'EOF' ...)`, `--body-file -` with a heredoc or here-string, and a body file
 * (relative to `cwd`) are read. When a flag is given twice, the last one wins, as in gh.
 */
export function extractGhTexts(command: string, cwd: string): GhText[] {
	if (!/\bgh\b/.test(command)) return [];
	return scanShell(command)
		.map((segment) => findGhText(segment, cwd))
		.filter((t): t is GhText => t !== undefined);
}
