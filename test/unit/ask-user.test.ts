import assert from "node:assert/strict";
import { type TestContext, test } from "node:test";
import { type AnswerMode, DEFAULT_CONFIG, type DevTeamConfig } from "../../extensions/dev-team/lib/config.ts";
import { confirmCaution, dialogTimeoutMs, registerAskUser } from "../../extensions/dev-team/lib/tools-misc.ts";

type Result = { content: { text: string }[]; details: { answered: boolean } };
type Execute = (id: string, params: unknown, signal: AbortSignal | undefined, onUpdate: unknown, ctx: unknown) => Promise<Result>;

interface AwayNote {
	title: string;
	text: string;
}

function askUser(config: Partial<DevTeamConfig> = {}, answerMode?: () => AnswerMode): { execute: Execute; away: AwayNote[] } {
	let execute: Execute | undefined;
	const away: AwayNote[] = [];
	registerAskUser({ registerTool: (def: { execute: Execute }) => (execute = def.execute) } as never, () => ({ ...DEFAULT_CONFIG, ...config }), {
		answerMode,
		onAway: (title, text) => void away.push({ title, text }),
	});
	return { execute: execute as Execute, away };
}

/** The human pressed Esc: the dialog returns undefined at once. */
const SKIP = Symbol("skip");

/**
 * A human UI whose dialogs answer from `answers` in order and record their calls. `undefined` is a
 * real timeout: the clock (performance.now, mocked) moves on by the dialog's timeout before it
 * returns. SKIP returns undefined with no time spent.
 */
function fakeUi(t: TestContext, answers: unknown[]) {
	const calls: { method: string; title: string; options?: unknown; opts?: { timeout?: number } }[] = [];
	const notices: string[] = [];
	let now = 1_000;
	t.mock.method(performance, "now", () => now);
	const dialog = (method: string) => async (title: string, arg?: unknown, opts?: { timeout?: number }) => {
		calls.push({ method, title, options: arg, opts });
		const answer = answers.shift();
		if (answer === SKIP) return undefined;
		if (answer === undefined) now += opts?.timeout ?? 0;
		return answer;
	};
	const ui = { select: dialog("select"), input: dialog("input"), confirm: dialog("confirm"), notify: (text: string) => void notices.push(text) };
	return { ctx: { hasUI: true, ui }, calls, notices };
}

function interactive(t: TestContext, on = true) {
	const saved = process.env.DEV_TEAM_INTERACTIVE;
	if (on) process.env.DEV_TEAM_INTERACTIVE = "1";
	else delete process.env.DEV_TEAM_INTERACTIVE;
	t.after(() => {
		if (saved === undefined) delete process.env.DEV_TEAM_INTERACTIVE;
		else process.env.DEV_TEAM_INTERACTIVE = saved;
	});
}

const question = { question: "Approve the plan?", options: ["Approve (recommended)", "Change it"] };

test("ask_user dialogs time out after askTimeoutSec (default 120 s)", async (t) => {
	interactive(t);
	const { ctx, calls } = fakeUi(t, ["Approve (recommended)"]);
	const r = await askUser().execute("1", question, undefined, undefined, ctx);
	assert.equal(calls[0].opts?.timeout, 120_000);
	assert.match(r.content[0].text, /A: Approve \(recommended\)/);
	assert.equal(r.details.answered, true);
});

test("ask_user without an answer in time says so, tells the model to go on with the recommended option, and asks nothing more", async (t) => {
	interactive(t);
	const { ctx, calls } = fakeUi(t, [undefined, "never asked"]);
	const r = await askUser().execute("1", { questions: [question, { question: "Second?" }] }, undefined, undefined, ctx);
	assert.equal(calls.length, 1, "the second question waits for no one");
	assert.match(r.content[0].text, /No answer arrived within 120 s/);
	assert.match(r.content[0].text, /\(recommended\)/);
	assert.match(r.content[0].text, /keep going/);
	assert.equal(r.details.answered, false);
});

test("ask_user without a human opens no dialog and takes the non-interactive default", async (t) => {
	interactive(t, false);
	const { ctx, calls } = fakeUi(t, ["x"]);
	const r = await askUser().execute("1", question, undefined, undefined, ctx);
	assert.equal(calls.length, 0);
	assert.match(r.content[0].text, /^NON-INTERACTIVE/);
});

const CAUTION = "[destructive_guard] CAUTION: Destructive command detected (File destruction: rm -rf).\nCommand: rm -rf victim";

test("confirmCaution asks the human first, with the same timeout; yes runs the command", async (t) => {
	interactive(t);
	const { ctx, calls } = fakeUi(t, [true]);
	assert.equal(await confirmCaution(["[other] note", CAUTION], ctx as never, 120), undefined);
	assert.equal(calls[0].method, "confirm");
	assert.equal(calls[0].opts?.timeout, 120_000);
});

test("confirmCaution blocks only that command when the human says no or does not answer", async (t) => {
	interactive(t);
	const { ctx } = fakeUi(t, [false]);
	const reason = await confirmCaution([CAUTION], ctx as never, 120);
	assert.match(reason ?? "", /rm -rf victim/);
	assert.match(reason ?? "", /not run/);
	assert.match(reason ?? "", /120 s/);
});

test("confirmCaution without a human only warns, before the command runs", async (t) => {
	interactive(t, false);
	const { ctx, calls, notices } = fakeUi(t, [false]);
	assert.equal(await confirmCaution([CAUTION], ctx as never, 120), undefined);
	assert.equal(calls.length, 0);
	assert.deepEqual(notices, [CAUTION]);
});

test("confirmCaution ignores calls with no CAUTION advisory", async (t) => {
	interactive(t);
	const { ctx, calls, notices } = fakeUi(t, [false]);
	assert.equal(await confirmCaution(["[destructive_guard] something else"], ctx as never, 120), undefined);
	assert.equal(calls.length + notices.length, 0);
});

const second = { question: "Which store?", options: [{ label: "Postgres" }, { label: "SQLite (recommended)", description: "one file, no server" }] };

test("ask_user shows the recommended option first, as 'label: description', with Qn/N progress and the why line in the title", async (t) => {
	interactive(t);
	const { ctx, calls } = fakeUi(t, ["Approve (recommended)", "SQLite (recommended): one file, no server"]);
	const r = await askUser().execute("1", { questions: [{ ...question, options: question.options.map((label) => ({ label })) }, { ...second, why: "it sets the deploy" }] }, undefined, undefined, ctx);
	assert.match(calls[0].title, /^Q1\/2 · Approve the plan\?/);
	assert.match(calls[1].title, /^Q2\/2 · Which store\?\nWhy it matters: it sets the deploy/);
	assert.deepEqual(calls[1].options, ["SQLite (recommended): one file, no server", "Postgres", "Other (type an answer)"]);
	assert.match(r.content[0].text, /A: SQLite \(recommended\)$/m, "the answer is the label, not the shown line");
});

test("ask_user titles outside the TUI say when the run goes on alone, never a time left", async (t) => {
	interactive(t);
	const { ctx, calls } = fakeUi(t, ["Approve (recommended)"]);
	await askUser().execute("1", { questions: [question] }, undefined, undefined, ctx);
	assert.match(calls[0].title, /\n⏱ goes on alone after 2:00$/);
	assert.doesNotMatch(calls[0].title, /left|w = wait/);
});

test("ask_user in wait mode passes no timeout and asks every question", async (t) => {
	interactive(t);
	const { ctx, calls } = fakeUi(t, ["Approve (recommended)", "Postgres"]);
	const { execute } = askUser({}, () => "wait");
	const r = await execute("1", { questions: [question, second] }, undefined, undefined, ctx);
	assert.equal(calls.length, 2);
	for (const c of calls) assert.equal(c.opts?.timeout, undefined);
	for (const c of calls) assert.match(c.title, /\n⏸ waiting for you$/);
	assert.equal(r.details.answered, true);
});

test("ask_user with answerMode 'wait' in the config passes no timeout and asks every question", async (t) => {
	interactive(t);
	const { ctx, calls } = fakeUi(t, ["Approve (recommended)", "Postgres"]);
	const r = await askUser({ answerMode: "wait" }).execute("1", { questions: [question, second] }, undefined, undefined, ctx);
	assert.equal(calls.length, 2);
	for (const c of calls) assert.equal(c.opts?.timeout, undefined);
	assert.equal(r.details.answered, true);
});

test("ask_user that the user closed (Esc) says so and tells no one they are away", async (t) => {
	interactive(t);
	const { ctx, calls } = fakeUi(t, [SKIP, "never asked"]);
	const { execute, away } = askUser();
	const r = await execute("1", { questions: [question, second] }, undefined, undefined, ctx);
	assert.equal(calls.length, 1);
	assert.match(r.content[0].text, /The user closed the question without an answer/);
	assert.doesNotMatch(r.content[0].text, /No answer arrived/);
	assert.equal(away.length, 0);
	assert.equal(r.details.answered, false);
});

test("ask_user that times out tells the away user once, listing the unanswered questions", async (t) => {
	interactive(t);
	const { ctx } = fakeUi(t, ["Approve (recommended)", undefined]);
	const { execute, away } = askUser();
	await execute("1", { questions: [question, second, { question: "Third?" }] }, undefined, undefined, ctx);
	assert.equal(away.length, 1);
	assert.match(away[0].text, /- Which store\?/);
	assert.match(away[0].text, /- Third\?/);
	assert.doesNotMatch(away[0].text, /Approve the plan/, "an answered question is not listed");
});

test("ask_user timeout note says to mark the guess 'assumed (timeout)' and list it under 'Decide these'", async (t) => {
	interactive(t);
	const { ctx } = fakeUi(t, [undefined]);
	const r = await askUser().execute("1", question, undefined, undefined, ctx);
	assert.match(r.content[0].text, /assumed \(timeout\)/);
	assert.match(r.content[0].text, /Decide these/);
});

test("confirmCaution in wait mode passes no timeout and does not mention seconds when declined", async (t) => {
	interactive(t);
	const { ctx, calls } = fakeUi(t, [false]);
	const reason = await confirmCaution([CAUTION], ctx as never, 120, "wait");
	assert.equal(calls[0].opts?.timeout, undefined);
	assert.doesNotMatch(reason ?? "", /120 s/);
	assert.match(reason ?? "", /not run/);
});

test("dialogTimeoutMs: seconds as milliseconds, none in wait mode or when the timeout is 0", () => {
	assert.equal(dialogTimeoutMs("timeout", 120), 120_000);
	assert.equal(dialogTimeoutMs("timeout", 0), undefined);
	assert.equal(dialogTimeoutMs("wait", 120), undefined);
});
