/**
 * The title and body that `gh pr|issue create|edit|comment` commands in a bash command line send.
 * Only literal values are returned: a value the shell computes is left undefined, so it is not checked.
 */
import * as path from "node:path";
import { readBoundedFile } from "./safe-read.ts";
import { type ShellSegment, type ShellWord, scanShell } from "./shell-scan.ts";

export const GH_TEXT_KINDS = ["pr", "issue", "comment"] as const;
export type GhTextKind = (typeof GH_TEXT_KINDS)[number];

/** A body file is read up to this size: 100,000 characters of UTF-8 take at most 4 bytes each. */
export const MAX_BODY_FILE_BYTES = 400_000;

export interface GhText {
	kind: GhTextKind;
	title?: string;
	body?: string;
	/** The body file is larger than MAX_BODY_FILE_BYTES, so it was not read. */
	bodyFileTooLarge?: boolean;
}

type BodyValue = Pick<GhText, "body" | "bodyFileTooLarge">;

const TITLE_FLAGS = new Set(["--title", "-t"]);
const BODY_FLAGS = new Set(["--body", "-b"]);
const BODY_FILE_FLAGS = new Set(["--body-file", "-F"]);
const GH_GROUPS = new Set(["pr", "issue"]);
const GH_ACTIONS = new Set(["create", "edit", "comment"]);
/** Words that can come before the command itself in a simple command. */
const COMMAND_PREFIXES = new Set(["if", "then", "elif", "else", "do", "while", "until", "!", "{", "time", "env", "command", "exec", "nohup"]);
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

/** The body a `--body-file` value gives: a file relative to `cwd`, or stdin for `-`. */
function bodyFromFile(value: ShellWord, stdin: string | undefined, cwd: string): BodyValue {
	if (value.dynamic) return { body: undefined };
	if (value.text === "-") return { body: stdin };
	const result = readBoundedFile(path.resolve(cwd, value.text), MAX_BODY_FILE_BYTES);
	if ("text" in result) return { body: result.text };
	return result.skipped === "too-large" ? { body: undefined, bodyFileTooLarge: true } : { body: undefined };
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

/** The kind and arguments when the segment is `[prefix ...] [NAME=value ...] gh pr|issue create|edit|comment ...`. */
function locateGhCommand(segment: ShellSegment): { kind: GhTextKind; args: ShellWord[] } | undefined {
	let commandIndex = 0;
	const isPrefix = (word: ShellWord) => (!word.dynamic && COMMAND_PREFIXES.has(word.text)) || ASSIGNMENT.test(word.text);
	while (commandIndex < segment.length && isPrefix(segment[commandIndex])) commandIndex++;
	const [command, group, action] = segment.slice(commandIndex, commandIndex + 3);
	if (!command || command.dynamic || path.basename(command.text) !== "gh") return undefined;
	if (!group || !GH_GROUPS.has(group.text) || !action || !GH_ACTIONS.has(action.text)) return undefined;
	const kind: GhTextKind = action.text === "comment" ? "comment" : group.text === "pr" ? "pr" : "issue";
	return { kind, args: segment.slice(commandIndex + 3) };
}

/** Title and body from the flags. When a flag is given twice, the last one wins, as in gh. */
function readTitleAndBody(kind: GhTextKind, args: ShellWord[], cwd: string): GhText {
	const stdin = readStdin(args);
	let titleValue: Pick<GhText, "title"> = {};
	let bodyValue: BodyValue = {};
	for (let argIndex = 0; argIndex < args.length; argIndex++) {
		const arg = args[argIndex];
		if (arg.redirect) {
			if (arg.redirect === "here-string") argIndex++;
			continue;
		}
		const inlineFlag = /^(--[a-z-]+)=([\s\S]*)$/.exec(arg.text);
		const flag = inlineFlag ? inlineFlag[1] : arg.text;
		if (!TITLE_FLAGS.has(flag) && !BODY_FLAGS.has(flag) && !BODY_FILE_FLAGS.has(flag)) continue;
		const value: ShellWord | undefined = inlineFlag ? { text: inlineFlag[2], dynamic: arg.dynamic } : args[++argIndex];
		if (!value || value.redirect) continue;
		if (TITLE_FLAGS.has(flag)) titleValue = { title: value.dynamic ? undefined : value.text };
		else if (BODY_FLAGS.has(flag)) bodyValue = { body: value.dynamic ? undefined : value.text };
		else bodyValue = bodyFromFile(value, stdin, cwd);
	}
	return { kind, ...titleValue, ...bodyValue };
}

/**
 * The title and body that each `gh pr|issue create|edit|comment` in a bash command sends. A value the
 * shell computes ($VAR, `$(git log ...)`, an unquoted heredoc with $ in it) is left undefined and not
 * checked. `$(cat <<'EOF' ...)`, `--body-file -` with a heredoc or here-string, and a body file
 * (relative to `cwd`) are read.
 */
export function extractGhTexts(command: string, cwd: string): GhText[] {
	if (!/\bgh\b/.test(command)) return [];
	return scanShell(command).flatMap((segment) => {
		const located = locateGhCommand(segment);
		return located ? [readTitleAndBody(located.kind, located.args, cwd)] : [];
	});
}
