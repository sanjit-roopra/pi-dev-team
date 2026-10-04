/**
 * Split bash text into simple commands (segments) of words, honoring quotes, escapes, `$(...)` and
 * heredocs. Not a full shell parser: enough to find a command and its literal arguments, and to know
 * when an argument is computed by the shell instead. Each character is visited a bounded number of
 * times, so the scan is linear in the input; `$(` nesting deeper than MAX_SUBSTITUTION_DEPTH is not
 * followed, so it cannot exhaust the stack.
 */

/**
 * A shell word. `dynamic` means the shell computes part of it ($VAR, `cmd`, a substitution other than
 * `$(cat <<'EOF' ...)`), so its text is not what the command receives. A `<<DELIM` heredoc or `<<<`
 * here-string operator is a word of its own with `redirect` set; a heredoc carries its `heredocBody`.
 */
export interface ShellWord {
	text: string;
	dynamic: boolean;
	redirect?: "heredoc" | "here-string";
	heredocBody?: string;
}
export type ShellSegment = ShellWord[];

export const MAX_SUBSTITUTION_DEPTH = 32;

interface PendingHeredoc {
	word: ShellWord;
	delimiter: string;
	stripTabs: boolean;
	/** `<<'EOF'` or `<<"EOF"`: the body is literal. Unquoted, the shell expands $ and ` in it. */
	quoted: boolean;
}

/** A `$` or backtick that starts an expansion, so the word's final text is computed by the shell. */
const SHELL_EXPANSION_START = /[A-Za-z_{0-9@*#?$!-]/;
function startsExpansion(source: string, i: number): boolean {
	return source[i] === "`" || (source[i] === "$" && SHELL_EXPANSION_START.test(source[i + 1] ?? ""));
}

/** Body lines up to the delimiter line for each pending heredoc, in order. Returns the index after them. */
function readHeredocBodies(source: string, start: number, pending: PendingHeredoc[]): number {
	let i = start;
	for (const heredoc of pending) {
		const lines: string[] = [];
		while (i < source.length) {
			const nl = source.indexOf("\n", i);
			const raw = source.slice(i, nl < 0 ? source.length : nl);
			i = nl < 0 ? source.length : nl + 1;
			const line = heredoc.stripTabs ? raw.replace(/^\t+/, "") : raw;
			if (line === heredoc.delimiter) break;
			lines.push(line);
		}
		const body = lines.join("\n");
		heredoc.word.heredocBody = body;
		if (!heredoc.quoted && /[$`]/.test(body)) heredoc.word.dynamic = true;
	}
	pending.length = 0;
	return i;
}

/** `<<DELIM` / `<<-'DELIM'` at `start` (after the `<<`): registers the heredoc on a new word in `segment`. */
function readHeredocOperator(source: string, start: number, segment: ShellSegment, pending: PendingHeredoc[]): number {
	let i = start;
	const stripTabs = source[i] === "-";
	if (stripTabs) i++;
	while (source[i] === " " || source[i] === "\t") i++;
	let delimiter = "";
	const quote = source[i];
	const quoted = quote === "'" || quote === '"';
	if (quoted) {
		const end = source.indexOf(quote, i + 1);
		delimiter = source.slice(i + 1, end < 0 ? source.length : end);
		i = end < 0 ? source.length : end + 1;
	} else {
		while (i < source.length && !/[\s;&|<>()]/.test(source[i])) delimiter += source[i++];
	}
	const word: ShellWord = { text: "<<", dynamic: false, redirect: "heredoc", heredocBody: "" };
	segment.push(word);
	pending.push({ word, delimiter, stripTabs, quoted });
	return i;
}

/** `"..."` from `start` (after the opening quote) into `word`. Returns the index after the closing quote. */
function readDoubleQuoted(source: string, start: number, word: ShellWord, depth: number): number {
	let i = start;
	while (i < source.length) {
		const char = source[i];
		if (char === '"') return i + 1;
		if (char === "\\" && i + 1 < source.length && '"\\$`\n'.includes(source[i + 1])) {
			if (source[i + 1] !== "\n") word.text += source[i + 1];
			i += 2;
		} else if (char === "$" && source[i + 1] === "(") {
			i = readSubstitution(source, i + 2, word, depth + 1);
		} else {
			if (startsExpansion(source, i)) word.dynamic = true;
			word.text += char;
			i++;
		}
	}
	word.dynamic = true;
	return i;
}

/** `$( ... )` from `start` (after `$(`). Only `$(cat <<'DELIM' ...)` with a literal body has known text. */
function readSubstitution(source: string, start: number, word: ShellWord, depth: number): number {
	if (depth > MAX_SUBSTITUTION_DEPTH) {
		word.dynamic = true;
		return source.length;
	}
	const inner = scanSegments(source, start, depth);
	const [only] = inner.segments;
	const catHeredoc = inner.segments.length === 1 && only.length === 2 && only[0].text === "cat" && !only[0].dynamic ? only[1] : undefined;
	if (catHeredoc?.redirect === "heredoc" && !catHeredoc.dynamic) word.text += catHeredoc.heredocBody;
	else word.dynamic = true;
	return inner.end;
}

function scanSegments(source: string, start: number, depth: number): { segments: ShellSegment[]; end: number } {
	const inSubstitution = depth > 0;
	const segments: ShellSegment[] = [];
	const pending: PendingHeredoc[] = [];
	let segment: ShellSegment = [];
	let word: ShellWord | undefined;
	const wordInProgress = (): ShellWord => (word ??= { text: "", dynamic: false });
	const endWord = () => {
		if (word) segment.push(word);
		word = undefined;
	};
	const endSegment = () => {
		endWord();
		if (segment.length) segments.push(segment);
		segment = [];
	};
	let i = start;
	while (i < source.length) {
		const char = source[i];
		if (char === "\n") {
			endSegment();
			i = readHeredocBodies(source, i + 1, pending);
		} else if (char === " " || char === "\t") {
			endWord();
			i++;
		} else if (char === ";" || char === "&" || char === "|" || char === "(") {
			endSegment();
			i++;
		} else if (char === ")") {
			endSegment();
			if (inSubstitution) return { segments, end: i + 1 };
			i++;
		} else if (char === "#" && !word) {
			const nl = source.indexOf("\n", i);
			i = nl < 0 ? source.length : nl;
		} else if (char === "\\") {
			if (source[i + 1] !== "\n") wordInProgress().text += source[i + 1] ?? "";
			i += 2;
		} else if (char === "'") {
			const end = source.indexOf("'", i + 1);
			wordInProgress().text += source.slice(i + 1, end < 0 ? source.length : end);
			if (end < 0) wordInProgress().dynamic = true;
			i = end < 0 ? source.length : end + 1;
		} else if (char === '"') {
			i = readDoubleQuoted(source, i + 1, wordInProgress(), depth);
		} else if (char === "$" && source[i + 1] === "(") {
			i = readSubstitution(source, i + 2, wordInProgress(), depth + 1);
		} else if (source.startsWith("<<<", i)) {
			// A here-string: the next word is stdin. Kept as an ordinary word, never a heredoc.
			endWord();
			segment.push({ text: "<<<", dynamic: false, redirect: "here-string" });
			i += 3;
		} else if (source.startsWith("<<", i)) {
			endWord();
			i = readHeredocOperator(source, i + 2, segment, pending);
		} else {
			if (startsExpansion(source, i)) wordInProgress().dynamic = true;
			wordInProgress().text += char;
			i++;
		}
	}
	endSegment();
	return { segments, end: i };
}

/** The simple commands of a bash command line, each as its words. */
export function scanShell(source: string): ShellSegment[] {
	return scanSegments(source, 0, 0).segments;
}
