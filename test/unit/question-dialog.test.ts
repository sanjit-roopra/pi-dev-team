import assert from "node:assert/strict";
import { type TestContext, test } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { clock, modeLine, pickOne, typeAnswer, type Waiter } from "../../extensions/dev-team/lib/question-dialog.ts";

const DOWN = "\x1b[B";
const UP = "\x1b[A";
const ENTER = "\r";
const ESCAPE = "\x1b";

type Component = { render(width: number): string[]; handleInput(data: string): void; dispose(): void };

/** A pi context in rpc mode whose dialogs record their arguments and answer `answer`. */
function rpcCtx(answer: string | undefined) {
	const calls: { method: string; title: string; arg: unknown; opts?: { timeout?: number; signal?: AbortSignal } }[] = [];
	const dialog = (method: string) => async (title: string, arg: unknown, opts?: { timeout?: number; signal?: AbortSignal }) => {
		calls.push({ method, title, arg, opts });
		return answer;
	};
	return { ctx: { mode: "rpc", ui: { select: dialog("select"), input: dialog("input") } } as never, calls };
}

/** A pi context in TUI mode whose custom dialog keeps the component so a test can drive it. */
function tuiCtx() {
	const state: { comp?: Component; renders: number } = { renders: 0 };
	const fakeTui = { requestRender: () => void state.renders++ };
	const fakeTheme = { fg: (_color: string, s: string) => s, bold: (s: string) => s };
	const ui = {
		custom: (factory: (tui: unknown, theme: unknown, keybindings: unknown, done: (v: unknown) => void) => Component) =>
			new Promise((resolve) => {
				state.comp = factory(fakeTui, fakeTheme, {}, resolve);
			}),
	};
	return { ctx: { mode: "tui", ui } as never, state };
}

const settled = async <T>(p: Promise<T>) => {
	let done = false;
	p.then(() => (done = true));
	await new Promise((r) => setImmediate(r));
	return done;
};

/** performance.now returns `start`, then `end`. */
function elapse(t: TestContext, ms: number) {
	const times = [1000, 1000 + ms];
	t.mock.method(performance, "now", () => times.shift() ?? 1000 + ms);
}

const request = (waiter: Waiter, extra: Partial<{ timeoutMs: number; signal: AbortSignal }> = {}) => ({
	title: "Q1/2 · Rate limit: per user or per key?",
	body: ["Why it matters: shared keys hit the limit faster."],
	options: ["per API key (recommended)", "per user"],
	waiter,
	...extra,
});

test("clock shows seconds as m:ss, rounding up and never below zero", () => {
	assert.equal(clock(107), "1:47");
	assert.equal(clock(5), "0:05");
	assert.equal(clock(59.2), "1:00");
	assert.equal(clock(0), "0:00");
	assert.equal(clock(-3), "0:00");
});

test("modeLine says waiting without a time, and shows the w key only where it works", () => {
	assert.equal(modeLine(undefined), "⏸ waiting for you");
	assert.equal(modeLine(107), "⏱ 1:47 left · w = wait");
	assert.equal(modeLine(107, false), "⏱ 1:47 left");
});

test("pickOne outside the TUI passes the timeout to pi's select and puts the mode line in the title", async () => {
	const { ctx, calls } = rpcCtx("per user");
	const waiter: Waiter = { waiting: false };
	const answer = await pickOne(ctx, request(waiter, { timeoutMs: 120_000 }));
	assert.equal(answer, "per user");
	assert.equal(calls[0].method, "select");
	assert.equal(calls[0].opts?.timeout, 120_000);
	assert.deepEqual(calls[0].arg, ["per API key (recommended)", "per user"]);
	assert.match(calls[0].title, /^Q1\/2 · Rate limit/);
	assert.match(calls[0].title, /Why it matters/);
	assert.match(calls[0].title, /⏱ 2:00 left$/);
	assert.doesNotMatch(calls[0].title, /w = wait/);
	assert.equal(waiter.timedOut, undefined);
});

test("pickOne outside the TUI has no timeout once the human chose to wait", async () => {
	const { ctx, calls } = rpcCtx("per user");
	await pickOne(ctx, request({ waiting: true }, { timeoutMs: 120_000 }));
	assert.equal(calls[0].opts?.timeout, undefined);
	assert.match(calls[0].title, /⏸ waiting for you$/);
});

test("pickOne outside the TUI marks a timeout only when the time ran out", async (t) => {
	elapse(t, 120_000);
	const waiter: Waiter = { waiting: false };
	assert.equal(await pickOne(rpcCtx(undefined).ctx, request(waiter, { timeoutMs: 120_000 })), undefined);
	assert.equal(waiter.timedOut, true);
});

test("pickOne outside the TUI treats a quick empty answer as a skip, not a timeout", async (t) => {
	elapse(t, 2_000);
	const waiter: Waiter = { waiting: false };
	assert.equal(await pickOne(rpcCtx(undefined).ctx, request(waiter, { timeoutMs: 120_000 })), undefined);
	assert.equal(waiter.timedOut, undefined);
});

test("pickOne in the TUI resolves undefined and marks a timeout when the countdown ends", async (t) => {
	t.mock.timers.enable({ apis: ["setInterval"] });
	const { ctx, state } = tuiCtx();
	const waiter: Waiter = { waiting: false };
	const answer = pickOne(ctx, request(waiter, { timeoutMs: 3000 }));
	assert.match(state.comp!.render(80).join("\n"), /⏱ 0:03 left · w = wait/);
	t.mock.timers.tick(1000);
	assert.match(state.comp!.render(80).join("\n"), /⏱ 0:02 left/);
	assert.equal(await settled(answer), false);
	t.mock.timers.tick(2000);
	assert.equal(await answer, undefined);
	assert.equal(waiter.timedOut, true);
});

test("pickOne in the TUI stops the timer when the human presses w", async (t) => {
	t.mock.timers.enable({ apis: ["setInterval"] });
	const { ctx, state } = tuiCtx();
	const waiter: Waiter = { waiting: false };
	const answer = pickOne(ctx, request(waiter, { timeoutMs: 3000 }));
	state.comp!.handleInput("w");
	t.mock.timers.tick(10_000);
	assert.equal(await settled(answer), false, "still open after the time");
	assert.equal(waiter.waiting, true);
	assert.equal(waiter.timedOut, undefined);
	assert.match(state.comp!.render(80).join("\n"), /⏸ waiting for you/);
	state.comp!.handleInput(ENTER);
	assert.equal(await answer, "per API key (recommended)");
});

test("pickOne in the TUI picks the option the arrows point at", async () => {
	const { ctx, state } = tuiCtx();
	const answer = pickOne(ctx, request({ waiting: false }));
	state.comp!.handleInput(DOWN);
	state.comp!.handleInput(DOWN);
	assert.match(state.comp!.render(80).join("\n"), /→ per user/);
	state.comp!.handleInput(UP);
	state.comp!.handleInput(DOWN);
	state.comp!.handleInput(ENTER);
	assert.equal(await answer, "per user");
});

test("pickOne in the TUI with no timeout shows the waiting line and never times out", async (t) => {
	t.mock.timers.enable({ apis: ["setInterval"] });
	const { ctx, state } = tuiCtx();
	const waiter: Waiter = { waiting: true };
	const answer = pickOne(ctx, request(waiter, { timeoutMs: 1000 }));
	t.mock.timers.tick(5000);
	assert.equal(await settled(answer), false);
	assert.match(state.comp!.render(80).join("\n"), /⏸ waiting for you/);
	state.comp!.handleInput(ESCAPE);
	assert.equal(await answer, undefined);
});

test("pickOne in the TUI resolves undefined on escape without marking a timeout", async () => {
	const { ctx, state } = tuiCtx();
	const waiter: Waiter = { waiting: false };
	const answer = pickOne(ctx, request(waiter, { timeoutMs: 60_000 }));
	state.comp!.handleInput(ESCAPE);
	assert.equal(await answer, undefined);
	assert.equal(waiter.timedOut, undefined);
	state.comp!.dispose();
});

test("pickOne in the TUI resolves undefined when the call is aborted", async () => {
	const { ctx } = tuiCtx();
	const controller = new AbortController();
	const waiter: Waiter = { waiting: false };
	const answer = pickOne(ctx, request(waiter, { signal: controller.signal }));
	assert.equal(await settled(answer), false);
	controller.abort();
	assert.equal(await answer, undefined);
	assert.equal(waiter.timedOut, undefined);
});

test("pickOne in the TUI resolves undefined for a signal aborted before it opened", async () => {
	const { ctx } = tuiCtx();
	assert.equal(await pickOne(ctx, request({ waiting: false }, { signal: AbortSignal.abort() })), undefined);
});

test("pickOne in the TUI never renders a line wider than the screen", async () => {
	const { ctx, state } = tuiCtx();
	const long = "a very long option label that goes on and on well past any narrow terminal width";
	const answer = pickOne(ctx, { ...request({ waiting: false }, { timeoutMs: 90_000 }), options: [long, "short"] });
	for (const width of [1, 5, 12, 20, 40, 120]) {
		for (const line of state.comp!.render(width)) assert.ok(visibleWidth(line) <= width, `"${line}" wider than ${width}`);
	}
	state.comp!.handleInput(ESCAPE);
	await answer;
});

test("typeAnswer passes the timeout to pi's input and puts the mode line in the title", async () => {
	const { ctx, calls } = rpcCtx("Berlin");
	const answer = await typeAnswer(ctx, { title: "Which city?", body: [], timeoutMs: 30_000, waiter: { waiting: false } });
	assert.equal(answer, "Berlin");
	assert.equal(calls[0].method, "input");
	assert.equal(calls[0].opts?.timeout, 30_000);
	assert.equal(calls[0].title, "Which city?\n⏱ 0:30 left");
});

test("typeAnswer has no timeout once the human chose to wait, and marks a real timeout", async (t) => {
	const waiting = rpcCtx("x");
	await typeAnswer(waiting.ctx, { title: "Q", body: [], timeoutMs: 30_000, waiter: { waiting: true } });
	assert.equal(waiting.calls[0].opts?.timeout, undefined);
	elapse(t, 30_000);
	const waiter: Waiter = { waiting: false };
	assert.equal(await typeAnswer(rpcCtx(undefined).ctx, { title: "Q", body: [], timeoutMs: 30_000, waiter }), undefined);
	assert.equal(waiter.timedOut, true);
});
