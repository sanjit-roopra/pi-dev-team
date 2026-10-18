import assert from "node:assert/strict";
import { type TestContext, test } from "node:test";
import { DEFAULT_CONFIG } from "../../extensions/dev-team/lib/config.ts";
import { confirmCaution, registerAskUser } from "../../extensions/dev-team/lib/tools-misc.ts";

type Result = { content: { text: string }[]; details: { answered: boolean } };
type Execute = (id: string, params: unknown, signal: AbortSignal | undefined, onUpdate: unknown, ctx: unknown) => Promise<Result>;

function askUser(): Execute {
	let execute: Execute | undefined;
	registerAskUser({ registerTool: (def: { execute: Execute }) => (execute = def.execute) } as never, () => DEFAULT_CONFIG);
	return execute as Execute;
}

/** A human UI whose dialogs answer from `answers` in order (undefined = timed out) and record their options. */
function fakeUi(answers: unknown[]) {
	const calls: { method: string; title: string; opts?: { timeout?: number } }[] = [];
	const notices: string[] = [];
	const dialog = (method: string) => async (title: string, _arg?: unknown, opts?: { timeout?: number }) => {
		calls.push({ method, title, opts });
		return answers.shift();
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
	const { ctx, calls } = fakeUi(["Approve (recommended)"]);
	const r = await askUser()("1", question, undefined, undefined, ctx);
	assert.equal(calls[0].opts?.timeout, 120_000);
	assert.match(r.content[0].text, /A: Approve \(recommended\)/);
	assert.equal(r.details.answered, true);
});

test("ask_user without an answer in time says so, tells the model to go on with the recommended option, and asks nothing more", async (t) => {
	interactive(t);
	const { ctx, calls } = fakeUi([undefined, "never asked"]);
	const r = await askUser()("1", { questions: [question, { question: "Second?" }] }, undefined, undefined, ctx);
	assert.equal(calls.length, 1, "the second question waits for no one");
	assert.match(r.content[0].text, /No answer arrived within 120 s/);
	assert.match(r.content[0].text, /\(recommended\)/);
	assert.match(r.content[0].text, /keep going/);
	assert.equal(r.details.answered, false);
});

test("ask_user without a human opens no dialog and takes the non-interactive default", async (t) => {
	interactive(t, false);
	const { ctx, calls } = fakeUi(["x"]);
	const r = await askUser()("1", question, undefined, undefined, ctx);
	assert.equal(calls.length, 0);
	assert.match(r.content[0].text, /^NON-INTERACTIVE/);
});

const CAUTION = "[destructive_guard] CAUTION: Destructive command detected (File destruction: rm -rf).\nCommand: rm -rf victim";

test("confirmCaution asks the human first, with the same timeout; yes runs the command", async (t) => {
	interactive(t);
	const { ctx, calls } = fakeUi([true]);
	assert.equal(await confirmCaution(["[other] note", CAUTION], ctx as never, 120), undefined);
	assert.equal(calls[0].method, "confirm");
	assert.equal(calls[0].opts?.timeout, 120_000);
});

test("confirmCaution blocks only that command when the human says no or does not answer", async (t) => {
	interactive(t);
	const { ctx } = fakeUi([false]);
	const reason = await confirmCaution([CAUTION], ctx as never, 120);
	assert.match(reason ?? "", /rm -rf victim/);
	assert.match(reason ?? "", /not run/);
	assert.match(reason ?? "", /120 s/);
});

test("confirmCaution without a human only warns, before the command runs", async (t) => {
	interactive(t, false);
	const { ctx, calls, notices } = fakeUi([false]);
	assert.equal(await confirmCaution([CAUTION], ctx as never, 120), undefined);
	assert.equal(calls.length, 0);
	assert.deepEqual(notices, [CAUTION]);
});

test("confirmCaution ignores calls with no CAUTION advisory", async (t) => {
	interactive(t);
	const { ctx, calls, notices } = fakeUi([false]);
	assert.equal(await confirmCaution(["[destructive_guard] something else"], ctx as never, 120), undefined);
	assert.equal(calls.length + notices.length, 0);
});
