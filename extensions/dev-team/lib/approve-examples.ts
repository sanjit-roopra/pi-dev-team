/**
 * dev_team_approve_examples: approved examples for the example check (`DEV_TEAM_EXAMPLES=on`, gate profile).
 *
 * example_replay.py accepts a case only when its `source` is word for word in a saved request, and a vague
 * request shows no examples, so the check passes with no cases. A spec /specs writes is the model's own
 * text and is never saved. Here /specs proposes concrete input-to-output examples and the human approves or
 * edits them in a dialog; on a real answer, code (not the model) saves exactly the approved or edited text to
 * `.dev-team/requests/approved-<time>.md`, so those examples become case sources. No human, a timeout,
 * Esc or a rejection saves nothing. The model cannot write that folder itself (request-guard.ts).
 *
 * Weak spot: a human who approves without reading turns this back into the model grading itself.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { AnswerMode, DevTeamConfig } from "./config.ts";
import { pickOne, type Waiter } from "./question-dialog.ts";
import { saveApprovedExamples } from "./skills.ts";
import { dialogTimeoutMs, humanAttached } from "./tools-misc.ts";

export const DEV_TEAM_APPROVE_EXAMPLES_TOOL = "dev_team_approve_examples";
/** The dialog shows every line at once; a longer block could scroll past what the human reads. */
export const MAX_EXAMPLE_LINES = 40;
export const MAX_EXAMPLE_CHARS = 4000;
const MAX_CRITERIA_CHARS = 300;
/**
 * Characters that could make the shown text differ from the saved bytes: control, format (bidi, zero-width,
 * soft hyphen, word joiner, tags), private-use and unassigned characters, line and paragraph separators, and
 * the blank fillers Unicode leaves as letters. Tab and newline stay allowed.
 */
const HIDDEN_CHARS = /(?![\t\n])[\p{Cc}\p{Cf}\p{Co}\p{Cn}\p{Zl}\p{Zp}\u034f\u115f\u1160\u180e\u3164\uffa0]/u;

export const APPROVE = "Approve: save as the request's tests (recommended)";
export const EDIT = "Edit them first";
export const REJECT = "Reject";

export type ApprovalSource = "user" | "timeout" | "skipped" | "no human";

export interface ApproveExamplesDeps {
	getConfig: () => DevTeamConfig;
	/** The answer mode now: the session's or the task's switch, else the config's. */
	answerMode?: () => AnswerMode;
	/** Tells an absent human what the run went on without. */
	onAway?: (title: string, text: string) => void;
}

const Params = Type.Object({
	criteria: Type.Optional(Type.String({ description: "One line: the acceptance criteria these examples are for" })),
	examples: Type.String({
		description: `The examples exactly as the human should approve them: one or more fenced blocks, each an input and its exact output. At most ${MAX_EXAMPLE_LINES} lines; ask in several calls for more.`,
	}),
});

/** Why the examples cannot be shown as they are, or undefined. */
export function examplesProblem(examples: string, criteria = ""): string | undefined {
	if (!examples.trim()) return "`examples` is empty.";
	if (examples.split("\n").length > MAX_EXAMPLE_LINES || examples.length > MAX_EXAMPLE_CHARS) {
		return `\`examples\` has more than ${MAX_EXAMPLE_LINES} lines or ${MAX_EXAMPLE_CHARS} characters, more than the dialog shows at once. Split them over several calls.`;
	}
	if (criteria.length > MAX_CRITERIA_CHARS || criteria.includes("\n")) return `\`criteria\` must be one line of at most ${MAX_CRITERIA_CHARS} characters.`;
	if (HIDDEN_CHARS.test(examples + criteria)) return "`examples` or `criteria` holds control, format or invisible characters, which the dialog would not show as saved. Remove them.";
	return undefined;
}

const reply = (text: string, details: { approved: boolean; source: ApprovalSource; path?: string; rejected?: boolean; examples?: string }) => ({
	content: [{ type: "text" as const, text }],
	details,
});

const NOT_SOURCES = "These examples are not approved and not saved: do not use them as case sources in `.dev-team/examples.json`.";

function savedReply(cwd: string, text: string, edited: boolean) {
	const rel = saveApprovedExamples(cwd, text);
	if (!rel) return reply(`The user approved, but the examples could not be saved. ${NOT_SOURCES} Log the approval with source user.`, { approved: true, source: "user" });
	const what = edited ? `The user edited the examples. Use this text, not your proposal:\n\n${text}\n\n` : "The user approved the examples. ";
	return reply(
		`${what}Saved word for word at \`${rel}\`. Log the answer with source \`user\` in the Decision Log, record \`**Approved examples**: ${rel}\` in the spec, and copy each example into \`.dev-team/examples.json\` as a case whose \`source\` quotes it character for character.`,
		{ approved: true, source: "user", path: rel, ...(edited ? { examples: text } : {}) },
	);
}

/**
 * pi's editor takes no timeout or abort signal, so it races both here: on a timeout or an abort the tool
 * returns and saves nothing; the editor stays open until closed, and what it returns then is dropped.
 */
async function editWithin(ctx: ExtensionContext, prefill: string, timeoutMs: number | undefined, signal: AbortSignal | undefined): Promise<{ text?: string; timedOut?: boolean }> {
	if (signal?.aborted) return {};
	let timer: ReturnType<typeof setTimeout> | undefined;
	let onAbort: (() => void) | undefined;
	const races: Promise<{ text?: string; timedOut?: boolean }>[] = [
		ctx.ui.editor("Edit the examples (saved word for word as the request's tests)", prefill).then((text) => ({ text })),
	];
	if (timeoutMs !== undefined) races.push(new Promise((resolve) => (timer = setTimeout(() => resolve({ timedOut: true }), timeoutMs))));
	if (signal) races.push(new Promise((resolve) => signal.addEventListener("abort", (onAbort = () => resolve({})), { once: true })));
	try {
		return await Promise.race(races);
	} finally {
		if (timer) clearTimeout(timer);
		if (onAbort) signal?.removeEventListener("abort", onAbort);
	}
}

export function registerApproveExamples(pi: ExtensionAPI, deps: ApproveExamplesDeps): void {
	pi.registerTool({
		name: DEV_TEAM_APPROVE_EXAMPLES_TOOL,
		label: "Approve examples",
		description:
			"Show the human concrete input-to-output examples for acceptance criteria and ask them to approve or edit them. Only a human approval saves them (word for word, by dev-team code) under .dev-team/requests/, where the example check accepts them as case sources. No human, a timeout or a rejection saves nothing. Never write that folder yourself.",
		promptSnippet: "Ask the human to approve examples for the acceptance criteria",
		parameters: Params,
		executionMode: "sequential",
		// It asks the human, so only the model may call it, never a codemode script.
		exposure: "model-only",
		// It writes .dev-team/requests/approved-*.md.
		annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
		async execute(_id, params, signal, _onUpdate, ctx: ExtensionContext) {
			const problem = examplesProblem(params.examples, params.criteria);
			if (problem) throw new Error(problem);
			if (!humanAttached(ctx)) {
				return reply(`NON-INTERACTIVE: no human is attached to this run. ${NOT_SOURCES} Mark them "assumed (no human)" in the Decision Log and list them under "Decide these".`, { approved: false, source: "no human" });
			}
			const config = deps.getConfig();
			const timeoutMs = dialogTimeoutMs(deps.answerMode?.() ?? config.answerMode, config.askTimeoutSec);
			const waiter: Waiter = { waiting: false };
			const body = [...(params.criteria ? [`For: ${params.criteria}`, ""] : []), ...params.examples.split("\n")];
			const timedOut = () => {
				deps.onAway?.("dev-team goes on without your examples", ["Not approved, so not used as tests:", ...params.examples.split("\n").slice(0, 6)].join("\n"));
				return reply(`No answer arrived within ${config.askTimeoutSec} s. ${NOT_SOURCES} Mark them "assumed (timeout)" in the Decision Log and list them under "Decide these".`, { approved: false, source: "timeout" });
			};
			const pick = await pickOne(ctx, { title: "Are these the right examples?", body, options: [APPROVE, EDIT, REJECT], timeoutMs, signal, waiter });
			if (pick === APPROVE) return savedReply(ctx.cwd, params.examples, false);
			if (pick === EDIT) {
				const edit = await editWithin(ctx, params.examples, timeoutMs, signal);
				if (edit.timedOut) return timedOut();
				const edited = edit.text;
				if (edited?.trim()) return savedReply(ctx.cwd, edited, true);
				return reply(`The user closed the editor without examples. ${NOT_SOURCES} Mark them "assumed (skipped)" in the Decision Log.`, { approved: false, source: "skipped" });
			}
			if (pick === REJECT) {
				return reply(`The user rejected these examples. ${NOT_SOURCES} Ask what is wrong with them, or propose different ones.`, { approved: false, source: "user", rejected: true });
			}
			if (waiter.timedOut) return timedOut();
			return reply(`The user closed the question without an answer. ${NOT_SOURCES} Mark them "assumed (skipped)" in the Decision Log.`, { approved: false, source: "skipped" });
		},
	});
}
