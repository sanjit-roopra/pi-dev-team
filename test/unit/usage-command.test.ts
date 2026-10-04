process.env.TZ = "UTC";
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseUsageArgs, runUsage, type UsageDeps } from "../../extensions/dev-team/lib/usage-command.ts";
import type { SpendHistory } from "../../extensions/dev-team/lib/usage-history.ts";
import { OVERLAY_HEIGHT_PERCENT } from "../../extensions/dev-team/lib/usage-view.ts";
import { NOW, run } from "../helpers/usage-fixtures.ts";

const SESSION_DIR = "/home/u/.pi/agent/sessions/--proj--";

const copilotTurn = (id: string, credits: number) => ({
	type: "message",
	id,
	timestamp: "2026-10-02T10:00:00.000Z",
	message: { role: "assistant", provider: "github-copilot", model: "gpt-5", usage: { cost: { total: credits / 100 } } },
});

type Custom = (factory: (...args: any[]) => any, options?: any) => Promise<unknown>;

function fakeCtx({ hasUI, entries = [], custom }: { hasUI: boolean; entries?: unknown[]; custom?: Custom }) {
	return {
		hasUI,
		ui: { custom: custom ?? (() => Promise.reject(new Error("custom() must not be called without a UI"))) },
		sessionManager: { getEntries: () => entries, getSessionDir: () => SESSION_DIR },
	} as never;
}

function fakeDeps(history: Partial<SpendHistory> | Error = {}) {
	const emitted: string[] = [];
	const loads: Parameters<UsageDeps["loadHistory"]>[0][] = [];
	const deps: UsageDeps = {
		now: () => NOW,
		emit: (text) => void emitted.push(text),
		// double-waiver: B1 — loadSpendHistory reads session files from disk
		loadHistory: async (options) => {
			loads.push(options);
			if (history instanceof Error) throw history;
			return { records: [], unreadable: 0, aborted: false, ...history };
		},
	};
	return { deps, emitted, loads };
}

const fakeTui = (rows = 30) => ({ terminal: { rows }, requestRender() {} });
const fakeTheme = { fg: (color: string, text: string) => `<${color}>${text}</${color}>`, bold: (text: string) => `*${text}*` };

test("without a UI the session summary is printed, no overlay is opened", async () => {
	const { deps, emitted } = fakeDeps();
	await runUsage(fakeCtx({ hasUI: false, entries: [copilotTurn("a", 40), copilotTurn("b", 20)] }), "", deps);
	assert.equal(emitted.length, 1);
	assert.ok(emitted[0].startsWith("This session · $0.60 · 60.0 AI credits\nProviders  github-copilot $0.60 100.0%\nThreads  main $0.60"), emitted[0]);
});

test("without a UI and without Copilot spend it prints the empty state", async () => {
	const { deps, emitted } = fakeDeps();
	await runUsage(fakeCtx({ hasUI: false }), "", deps);
	assert.deepEqual(emitted, ["No usage in this session"]);
});

test("a UI whose custom() is a stub that never runs the factory (RPC) gets the text summary", async () => {
	const { deps, emitted } = fakeDeps();
	const custom: Custom = async () => undefined;
	await runUsage(fakeCtx({ hasUI: true, entries: [copilotTurn("a", 40)], custom }), "", deps);
	assert.equal(emitted.length, 1);
	assert.ok(emitted[0].startsWith("This session · $0.40 · 40.0 AI credits"));
});

test("a stub custom() that never runs the factory (RPC) gets this month's text summary, loaded from the session root", async () => {
	const { deps, emitted, loads } = fakeDeps({ records: [{ timestamp: "2026-10-02T10:00:00.000Z", run: run("gpt-5", 30) }] });
	const custom: Custom = async () => undefined;
	await runUsage(fakeCtx({ hasUI: true, custom }), "month", deps);
	assert.equal(loads.length, 1);
	assert.equal(loads[0].root, "/home/u/.pi/agent/sessions");
	assert.equal(emitted.length, 1);
	assert.ok(emitted[0].startsWith("This month (Oct 1 – Oct 4) · $0.30 · 30.0 AI credits"), emitted[0]);
});

test("a custom() that rejects falls back to the text summary instead of throwing", async () => {
	const { deps, emitted } = fakeDeps();
	const custom: Custom = () => Promise.reject(new Error("tui is gone"));
	await runUsage(fakeCtx({ hasUI: true, entries: [copilotTurn("a", 40)], custom }), "", deps);
	assert.equal(emitted.length, 1);
	assert.ok(emitted[0].startsWith("This session · $0.40 · 40.0 AI credits"), emitted[0]);
});

test("when the overlay opened and closed, no text is printed", async () => {
	const { deps, emitted } = fakeDeps();
	let options: any;
	const custom: Custom = async (factory, o) => {
		options = o;
		factory(fakeTui(), fakeTheme, undefined, () => {});
		return undefined;
	};
	await runUsage(fakeCtx({ hasUI: true, entries: [copilotTurn("a", 40)], custom }), "", deps);
	assert.deepEqual(emitted, []);
	assert.deepEqual(options, { overlay: true, overlayOptions: { maxHeight: "90%" } });
});

test("the overlay component renders this session, themed, within the terminal height, and closes through done()", async () => {
	const { deps } = fakeDeps();
	let view: any;
	let closed = 0;
	const custom: Custom = async (factory) => {
		view = factory(fakeTui(20), fakeTheme, undefined, () => void closed++);
	};
	await runUsage(fakeCtx({ hasUI: true, entries: [copilotTurn("a", 40)], custom }), "", deps);
	const lines: string[] = view.render(80);
	assert.ok(lines.length <= Math.floor((20 * OVERLAY_HEIGHT_PERCENT) / 100));
	assert.ok(lines[0].includes("This session · By model · $0.40 · 40.0 AI credits"), lines[0]);
	assert.ok(lines.some((l) => l.includes("<accent>")), "bars use the accent colour");
	view.handleInput("q");
	assert.equal(closed, 1);
});

test("/dev-team usage month opens the overlay on this month and reads history from the session root", async () => {
	const { deps, loads } = fakeDeps();
	const custom: Custom = async (factory) => {
		factory(fakeTui(), fakeTheme, undefined, () => {});
	};
	await runUsage(fakeCtx({ hasUI: true, custom }), "month", deps);
	assert.equal(loads.length, 1);
	assert.equal(loads[0].root, "/home/u/.pi/agent/sessions");
	assert.equal(loads[0].since.toISOString(), "2026-10-01T00:00:00.000Z");
	assert.ok(loads[0].signal && loads[0].onProgress);
});

test("in text mode this month is loaded without progress and summarised", async () => {
	const { deps, emitted, loads } = fakeDeps({ records: [{ timestamp: "2026-10-02T10:00:00.000Z", run: run("gpt-5", 30) }], unreadable: 1 });
	await runUsage(fakeCtx({ hasUI: false }), "month", deps);
	assert.equal(loads.length, 1);
	assert.equal(loads[0].onProgress, undefined);
	assert.equal(loads[0].since.toISOString(), "2026-10-01T00:00:00.000Z");
	const lines = emitted[0].split("\n");
	assert.equal(lines[0], "This month (Oct 1 – Oct 4) · $0.30 · 30.0 AI credits · as of 14:05");
	assert.equal(lines.at(-1), "1 session file could not be read");
});

test("a month with no Copilot spend prints the empty state", async () => {
	const { deps, emitted } = fakeDeps();
	await runUsage(fakeCtx({ hasUI: false }), "month", deps);
	assert.deepEqual(emitted, ["No usage this month"]);
});

test("a history load that fails in text mode prints the reason and does not throw", async () => {
	const { deps, emitted } = fakeDeps(new Error("EACCES"));
	await runUsage(fakeCtx({ hasUI: false }), "month", deps);
	assert.deepEqual(emitted, ["Could not load history: EACCES"]);
});

test("an unknown argument reports the usage and opens nothing", async () => {
	const { deps, emitted, loads } = fakeDeps();
	await runUsage(fakeCtx({ hasUI: true }), "histroy", deps);
	assert.deepEqual(emitted, ["Usage: /dev-team usage [session|month]"]);
	assert.equal(loads.length, 0);
});

test("arguments select the scope, defaulting to this session", () => {
	assert.deepEqual(parseUsageArgs(""), { scope: "session" });
	assert.deepEqual(parseUsageArgs("session"), { scope: "session" });
	assert.deepEqual(parseUsageArgs("month"), { scope: "month" });
	assert.deepEqual(parseUsageArgs("  month  "), { scope: "month" });
	assert.deepEqual(parseUsageArgs("MONTH"), { scope: "month" });
});

test("an unknown or extra argument is a usage error", () => {
	for (const args of ["histroy", "month now", "week"]) {
		assert.deepEqual(parseUsageArgs(args), { error: "Usage: /dev-team usage [session|month]" }, args);
	}
});
