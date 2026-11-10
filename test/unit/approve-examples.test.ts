import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { type TestContext, test } from "node:test";
import { APPROVE, EDIT, MAX_EXAMPLE_LINES, REJECT, registerApproveExamples } from "../../extensions/dev-team/lib/approve-examples.ts";
import { type AnswerMode, DEFAULT_CONFIG } from "../../extensions/dev-team/lib/config.ts";
import { REQUEST_DIR } from "../../extensions/dev-team/lib/skills.ts";

type Result = { content: { text: string }[]; details: { approved: boolean; source: string; path?: string; rejected?: boolean } };
type Execute = (id: string, params: unknown, signal: AbortSignal | undefined, onUpdate: unknown, ctx: unknown) => Promise<Result>;

const EXAMPLES = "```\n$ greet --name Ada\nHello, Ada\n```";

function tool(answerMode?: () => AnswerMode) {
	let execute: Execute | undefined;
	const away: string[] = [];
	registerApproveExamples({ registerTool: (def: { execute: Execute }) => (execute = def.execute) } as never, {
		getConfig: () => DEFAULT_CONFIG,
		answerMode,
		onAway: (title) => void away.push(title),
	});
	return { execute: execute as Execute, away };
}

/** The human pressed Esc: the dialog returns undefined at once. */
const SKIP = Symbol("skip");

/** A human UI (rpc mode, so pickOne uses select) answering from `answers` in order; undefined is a real timeout. */
function fakeUi(t: TestContext, answers: unknown[]) {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "dt-approve-"));
	t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
	const calls: { method: string; title: string; arg?: unknown; opts?: { timeout?: number } }[] = [];
	let now = 1_000;
	t.mock.method(performance, "now", () => now);
	const dialog = (method: string) => async (title: string, arg?: unknown, opts?: { timeout?: number }) => {
		calls.push({ method, title, arg, opts });
		const answer = answers.shift();
		if (answer === SKIP) return undefined;
		if (answer === undefined) now += opts?.timeout ?? 0;
		return answer;
	};
	const ui = { select: dialog("select"), editor: dialog("editor"), notify: () => {} };
	const saved = () => (fs.existsSync(path.join(cwd, REQUEST_DIR)) ? fs.readdirSync(path.join(cwd, REQUEST_DIR)) : []);
	return { ctx: { hasUI: true, mode: "rpc", cwd, ui }, calls, saved, cwd };
}

function interactive(t: TestContext, on = true) {
	const before = process.env.DEV_TEAM_INTERACTIVE;
	if (on) process.env.DEV_TEAM_INTERACTIVE = "1";
	else delete process.env.DEV_TEAM_INTERACTIVE;
	t.after(() => {
		if (before === undefined) delete process.env.DEV_TEAM_INTERACTIVE;
		else process.env.DEV_TEAM_INTERACTIVE = before;
	});
}

test("approve_examples without a human opens no dialog and saves nothing", async (t) => {
	interactive(t, false);
	const { ctx, calls, saved } = fakeUi(t, [APPROVE]);
	const r = await tool().execute("1", { examples: EXAMPLES }, undefined, undefined, ctx);
	assert.equal(calls.length, 0);
	assert.deepEqual(saved(), []);
	assert.deepEqual(r.details, { approved: false, source: "no human" });
	assert.match(r.content[0].text, /assumed \(no human\)/);
});

test("approve_examples saves exactly the shown examples when the human approves", async (t) => {
	interactive(t);
	const { ctx, calls, saved, cwd } = fakeUi(t, [APPROVE]);
	const r = await tool().execute("1", { criteria: "Greets by name", examples: EXAMPLES }, undefined, undefined, ctx);
	assert.equal(calls[0].method, "select");
	assert.ok(calls[0].title.includes(EXAMPLES), "the dialog shows the examples whole");
	assert.equal(calls[0].opts?.timeout, 120_000);
	assert.equal(r.details.approved, true);
	assert.equal(r.details.source, "user");
	assert.match(saved()[0], /^approved-\d{4}-.*Z\.md$/);
	assert.equal(fs.readFileSync(path.join(cwd, r.details.path!), "utf-8"), EXAMPLES);
	assert.match(r.content[0].text, /\*\*Approved examples\*\*/);
});

test("approve_examples saves the human's edited text, not the proposal", async (t) => {
	interactive(t);
	const edited = "```\n$ greet --name Ada\nHi, Ada!\n```\n";
	const { ctx, calls, cwd } = fakeUi(t, [EDIT, edited]);
	const r = await tool().execute("1", { examples: EXAMPLES }, undefined, undefined, ctx);
	assert.equal(calls[1].method, "editor");
	assert.equal(calls[1].arg, EXAMPLES, "the editor starts from the proposal");
	assert.equal(fs.readFileSync(path.join(cwd, r.details.path!), "utf-8"), edited);
	assert.ok(r.content[0].text.includes(edited));
});

test("approve_examples saves nothing when the editor is closed or left empty", async (t) => {
	interactive(t);
	for (const answer of [SKIP, "  \n"]) {
		const { ctx, saved } = fakeUi(t, [EDIT, answer]);
		const r = await tool().execute("1", { examples: EXAMPLES }, undefined, undefined, ctx);
		assert.deepEqual(saved(), []);
		assert.equal(r.details.approved, false);
		assert.equal(r.details.source, "skipped");
	}
});

test("approve_examples saves nothing on a rejection", async (t) => {
	interactive(t);
	const { ctx, saved } = fakeUi(t, [REJECT]);
	const r = await tool().execute("1", { examples: EXAMPLES }, undefined, undefined, ctx);
	assert.deepEqual(saved(), []);
	assert.deepEqual(r.details, { approved: false, source: "user", rejected: true });
});

test("approve_examples saves nothing on a timeout and tells the absent human once", async (t) => {
	interactive(t);
	const { ctx, saved } = fakeUi(t, [undefined]);
	const { execute, away } = tool();
	const r = await execute("1", { examples: EXAMPLES }, undefined, undefined, ctx);
	assert.deepEqual(saved(), []);
	assert.equal(r.details.source, "timeout");
	assert.match(r.content[0].text, /assumed \(timeout\)/);
	assert.equal(away.length, 1);
});

test("approve_examples saves nothing on Esc and sends no away note", async (t) => {
	interactive(t);
	const { ctx, saved } = fakeUi(t, [SKIP]);
	const { execute, away } = tool();
	const r = await execute("1", { examples: EXAMPLES }, undefined, undefined, ctx);
	assert.deepEqual(saved(), []);
	assert.equal(r.details.source, "skipped");
	assert.equal(away.length, 0);
});

test("approve_examples in wait mode waits for the human", async (t) => {
	interactive(t);
	const { ctx, calls } = fakeUi(t, [APPROVE]);
	await tool(() => "wait").execute("1", { examples: EXAMPLES }, undefined, undefined, ctx);
	assert.equal(calls[0].opts?.timeout, undefined);
});

test("approve_examples refuses text the dialog would not show as saved, before any dialog", async (t) => {
	interactive(t);
	const { ctx, calls, saved } = fakeUi(t, [APPROVE, APPROVE, APPROVE]);
	const tooLong = Array.from({ length: MAX_EXAMPLE_LINES + 1 }, (_, i) => `line ${i}`).join("\n");
	const hidden = ["\u00ad", "\u2028", "\u2029", "\u2060", "\u2063", "\u034f", "\u180e", "\u3164", "\u{E0041}", "\u200b", "\u202e"];
	for (const examples of [tooLong, "```\nHello\x1b[8m hidden\n```", "Hello\rBye", "  ", ...hidden.map((c) => `\`\`\`\nHel${c}lo\n\`\`\``)]) {
		await assert.rejects(tool().execute("1", { examples }, undefined, undefined, ctx));
	}
	await assert.rejects(tool().execute("1", { examples: EXAMPLES, criteria: "two\nlines" }, undefined, undefined, ctx));
	assert.equal(calls.length, 0);
	assert.deepEqual(saved(), []);
});

test("approve_examples saves nothing when the human opens the editor and walks away, or the run is aborted", async (t) => {
	interactive(t);
	const never = new Promise(() => {});
	{
		const { ctx, saved } = fakeUi(t, [EDIT, never]);
		t.mock.timers.enable({ apis: ["setTimeout"] });
		const { execute, away } = tool();
		const running = execute("1", { examples: EXAMPLES }, undefined, undefined, ctx);
		await new Promise((resolve) => setImmediate(resolve));
		t.mock.timers.tick(120_000);
		const r = await running;
		t.mock.timers.reset();
		assert.deepEqual(saved(), []);
		assert.equal(r.details.source, "timeout");
		assert.equal(away.length, 1);
	}
	{
		const { ctx, saved } = fakeUi(t, [EDIT, never]);
		const abort = new AbortController();
		const running = tool(() => "wait").execute("1", { examples: EXAMPLES }, abort.signal, undefined, ctx);
		await new Promise((resolve) => setImmediate(resolve));
		abort.abort();
		const r = await running;
		assert.deepEqual(saved(), []);
		assert.equal(r.details.approved, false);
		assert.equal(r.details.source, "skipped");
	}
});
