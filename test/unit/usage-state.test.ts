import assert from "node:assert/strict";
import { test } from "node:test";
import { openUsage, reduce, type UsageAction, type UsageKey, type UsageState, usageKeyFor } from "../../extensions/dev-team/lib/usage-state.ts";

const key = (k: UsageKey): UsageAction => ({ type: "key", key: k });
const sessionIdle: UsageState = { scope: "session", view: "model", load: { kind: "idle" } };
const monthLoading: UsageState = { scope: "month", view: "model", load: { kind: "loading" } };
const monthReady: UsageState = { scope: "month", view: "model", load: { kind: "ready" } };

test("opening on this session starts idle on By model with nothing to load", () => {
	assert.deepEqual(openUsage("session"), { state: sessionIdle, effects: [] });
});

test("opening on this month starts the load", () => {
	assert.deepEqual(openUsage("month"), { state: monthLoading, effects: ["start-load"] });
});

test("Tab and Shift+Tab move between the views and wrap", () => {
	const onAgent = reduce(sessionIdle, key("next-view"));
	assert.deepEqual(onAgent, { state: { ...sessionIdle, view: "agent" }, effects: [] });
	assert.equal(reduce(onAgent.state, key("next-view")).state.view, "model");
	assert.equal(reduce(onAgent.state, key("previous-view")).state.view, "model");
	assert.equal(reduce(sessionIdle, key("previous-view")).state.view, "agent");
});

test("switching views while loading keeps the load running", () => {
	const t = reduce(monthLoading, key("next-view"));
	assert.deepEqual(t, { state: { ...monthLoading, view: "agent" }, effects: [] });
});

test("s from this session starts a load and shows progress, then the result", () => {
	const started = reduce(sessionIdle, key("toggle-scope"));
	assert.deepEqual(started, { state: monthLoading, effects: ["start-load"] });
	const progressed = reduce(started.state, { type: "progress", done: 2, total: 5 });
	assert.deepEqual(progressed.state.load, { kind: "loading", progress: { done: 2, total: 5 } });
	assert.deepEqual(reduce(progressed.state, { type: "loaded" }), { state: monthReady, effects: [] });
});

test("s while loading cancels the load and returns to this session", () => {
	const t = reduce(reduce(monthLoading, { type: "progress", done: 1, total: 4 }).state, key("toggle-scope"));
	assert.deepEqual(t, { state: sessionIdle, effects: ["cancel-load"] });
});

test("s again after a cancelled load restarts it", () => {
	const cancelled = reduce(monthLoading, key("toggle-scope")).state;
	assert.deepEqual(reduce(cancelled, key("toggle-scope")), { state: monthLoading, effects: ["start-load"] });
});

test("s again after a completed load reuses its result", () => {
	const back = reduce(monthReady, key("toggle-scope"));
	assert.deepEqual(back, { state: { ...monthReady, scope: "session" }, effects: [] });
	assert.deepEqual(reduce(back.state, key("toggle-scope")), { state: monthReady, effects: [] });
});

test("the view persists across scope toggles", () => {
	const onAgent = reduce(sessionIdle, key("next-view")).state;
	const loading = reduce(onAgent, key("toggle-scope")).state;
	assert.equal(loading.view, "agent");
	assert.equal(reduce(loading, { type: "loaded" }).state.view, "agent");
});

test("a failed load shows the reason, and s goes back and can retry", () => {
	const failed = reduce(monthLoading, { type: "failed", reason: "EACCES" });
	assert.deepEqual(failed, { state: { ...monthLoading, load: { kind: "error", reason: "EACCES" } }, effects: [] });
	const back = reduce(failed.state, key("toggle-scope"));
	assert.deepEqual(back, { state: sessionIdle, effects: [] });
	assert.deepEqual(reduce(back.state, key("toggle-scope")), { state: monthLoading, effects: ["start-load"] });
});

test("closing cancels a load that is still running", () => {
	assert.deepEqual(reduce(monthLoading, key("close")), { state: monthLoading, effects: ["cancel-load", "close"] });
	assert.deepEqual(reduce(monthReady, key("close")), { state: monthReady, effects: ["close"] });
	assert.deepEqual(reduce(sessionIdle, key("close")), { state: sessionIdle, effects: ["close"] });
});

test("load events that arrive when no load is running are dropped", () => {
	const cancelled = reduce(monthLoading, key("toggle-scope")).state;
	for (const late of [{ type: "progress", done: 1, total: 2 }, { type: "loaded" }, { type: "failed", reason: "x" }] as const) {
		assert.deepEqual(reduce(cancelled, late), { state: cancelled, effects: [] });
		assert.deepEqual(reduce(monthReady, late), { state: monthReady, effects: [] });
	}
});

test("keys map to actions, letters in either case", () => {
	const keys: [string, UsageKey | undefined][] = [
		["\t", "next-view"],
		["\x1b[Z", "previous-view"],
		["s", "toggle-scope"],
		["S", "toggle-scope"],
		["\x1b", "close"],
		["q", "close"],
		["Q", "close"],
		["\x03", "close"],
		["x", undefined],
		["", undefined],
		["\x1b[A", undefined],
	];
	for (const [data, expected] of keys) assert.equal(usageKeyFor(data), expected, JSON.stringify(data));
});
