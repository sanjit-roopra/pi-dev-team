process.env.TZ = "UTC"; // the header's "as of" is local time; pin it so the expected strings hold everywhere
import assert from "node:assert/strict";
import { test } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { SpendRun } from "../../extensions/dev-team/lib/session-spend.ts";
import type { SpendHistory } from "../../extensions/dev-team/lib/usage-history.ts";
import type { UsageStyle } from "../../extensions/dev-team/lib/usage-render.ts";
import { openUsage } from "../../extensions/dev-team/lib/usage-state.ts";
import { OVERLAY_HEIGHT_PERCENT, UsageView, type UsageViewDeps } from "../../extensions/dev-team/lib/usage-view.ts";
import { NOW, run } from "../helpers/usage-fixtures.ts";

const identity = (text: string) => text;
const style: UsageStyle = { title: identity, error: identity, bar: identity, muted: identity, segment: (_label, text) => text };

/** A UsageView on stub deps, recording what it asked of the host. */
function viewOn(runs: SpendRun[], extra: Partial<UsageViewDeps> = {}) {
	const calls = { renders: 0, closes: 0 };
	const deps: UsageViewDeps = {
		sessionRuns: () => runs,
		now: () => NOW,
		terminalRows: () => 40,
		style,
		requestRender: () => void calls.renders++,
		close: () => void calls.closes++,
		// double-waiver: B1 — loadSpendHistory reads session files from disk
		loadHistory: () => Promise.reject(new Error("no loader in this test")),
		...extra,
	};
	return { view: new UsageView(deps, openUsage("session")), calls, deps };
}
const tab = "\t";
const shiftTab = "\x1b[Z";
const escape = "\x1b";
const overlayHeight = (terminalRows: number) => Math.floor((terminalRows * OVERLAY_HEIGHT_PERCENT) / 100);

const manyCredits = Array.from({ length: 30 }, (_, i) => 50 - i);
const manyRuns = manyCredits.map((credits, i) => run(`model-${i}`, credits));

test("the component renders this session by model, headed with the session's total", () => {
	const total = manyCredits.reduce((sum, credits) => sum + credits, 0);
	assert.equal(viewOn(manyRuns).view.render(80)[0], `This session · By model · ${total.toLocaleString("en-US")} AI credits`);
});

test("the component fits the overlay's share of the terminal height at any width", () => {
	for (const rows of [12, 40]) {
		const { view } = viewOn(manyRuns, { terminalRows: () => rows });
		for (const width of [10, 30, 80]) {
			const lines = view.render(width);
			assert.ok(lines.length <= overlayHeight(rows), `${width}x${rows}: ${lines.length} lines`);
			assert.ok(lines.every((l) => visibleWidth(l) <= width));
		}
	}
});

test("the component keeps the header and the close hint when the terminal is small", () => {
	const lines = viewOn(manyRuns, { terminalRows: () => 12 }).view.render(30);
	assert.match(lines[0], /^This sess/);
	assert.ok(lines.at(-1)!.includes("Esc close"));
});

test("Tab and Shift+Tab switch the view and ask for a re-render; the split bar stays", () => {
	const { view, calls } = viewOn([run("gpt-5", 30, "subagent", "Explore"), run("gpt-5", 20)]);
	view.handleInput(tab);
	assert.ok(view.render(80)[0].includes("By agent"));
	assert.ok(view.render(80).some((l) => l.includes("█ main 20.0")), "split bar still shown");
	view.handleInput(shiftTab);
	assert.ok(view.render(80)[0].includes("By model"));
	assert.ok(calls.renders >= 1);
});

test("Esc closes the overlay", () => {
	const { view, calls } = viewOn([run("gpt-5", 20)]);
	view.handleInput(escape);
	assert.equal(calls.closes, 1);
});

test("an unrelated key changes nothing and asks for nothing", () => {
	const { view, calls } = viewOn([run("gpt-5", 20)]);
	const before = view.render(80);
	view.handleInput("x");
	assert.deepEqual(view.render(80), before);
	assert.deepEqual(calls, { renders: 0, closes: 0 });
});

test("invalidate rebuilds the session's breakdown from the runs; until then it is cached", () => {
	const runs = [run("gpt-5", 20)];
	const { view } = viewOn(runs);
	assert.ok(view.render(80)[0].includes("20.0 AI credits"));
	runs.push(run("gpt-5", 30));
	assert.ok(view.render(80)[0].includes("20.0 AI credits"), "cached");
	view.invalidate();
	assert.ok(view.render(80)[0].includes("50.0 AI credits"), "rebuilt");
});

// ---------------------------------------------------------------------------------------------- this-month load

/** A loader the test settles by hand, remembering how it was called. */
function stubLoader() {
	const loads: { since: Date; signal: AbortSignal; onProgress(done: number, total: number): void; resolve(h: Partial<SpendHistory>): void; reject(e: unknown): void }[] = [];
	// double-waiver: B1 — loadSpendHistory reads session files from disk
	const loadHistory: UsageViewDeps["loadHistory"] = (options) =>
		new Promise<SpendHistory>((resolve, reject) => {
			loads.push({
				...options,
				resolve: (h) => resolve({ records: [], skipped: 0, aborted: false, ...h }),
				reject,
			});
		});
	return { loads, loadHistory };
}
const records = (...runs: SpendRun[]) => runs.map((r) => ({ timestamp: "2026-10-02T10:00:00.000Z", run: r }));
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));
const monthLines = (view: UsageView) => view.render(80);

function monthViewOn(runs: SpendRun[] = [], opening: "session" | "month" = "month", extra: Partial<UsageViewDeps> = {}) {
	const loader = stubLoader();
	const { calls, deps } = viewOn(runs, { loadHistory: loader.loadHistory, ...extra });
	const view = new UsageView(deps, openUsage(opening));
	return { view, calls, loader, deps };
}

test("opening on this month loads from the billing period start and shows the loading line", () => {
	const { view, loader } = monthViewOn();
	assert.equal(loader.loads.length, 1);
	assert.equal(loader.loads[0].since.toISOString(), "2026-10-01T00:00:00.000Z");
	assert.deepEqual(monthLines(view), ["This month (Oct 1 – Oct 4) · By model", "", "Reading sessions…", "", "Tab view · s cancel · Esc close"]);
});

test("progress updates the loading line and asks for a re-render", () => {
	const { view, loader, calls } = monthViewOn();
	loader.loads[0].onProgress(3, 12);
	assert.ok(monthLines(view).includes("Reading sessions… 3/12 files"));
	assert.ok(calls.renders >= 1);
});

test("a finished load shows this month with the time it finished", async () => {
	let clock = NOW;
	const { view, loader } = monthViewOn([], "month", { now: () => clock });
	clock = new Date(Date.UTC(2026, 9, 4, 14, 9));
	loader.loads[0].resolve({ records: records(run("gpt-5", 40), run("gpt-5", 10, "subagent", "Explore")), skipped: 2 });
	await settle();
	const lines = monthLines(view);
	assert.equal(lines[0], "This month (Oct 1 – Oct 4) · By model · 50.0 AI credits · as of 14:09");
	assert.ok(lines.includes("2 session files could not be read"));
	assert.equal(lines.at(-1), "Tab view · s this session · Esc close");
});

test("a rejected load shows the error and the back footer", async () => {
	const { view, loader } = monthViewOn([run("gpt-5", 20)], "month");
	loader.loads[0].reject(new Error("EACCES"));
	await settle();
	assert.ok(monthLines(view).includes("Could not load history: EACCES"));
	assert.equal(monthLines(view).at(-1), "s back · Esc close");
});

test("s after a rejected load goes back to this session without loading again", async () => {
	const { view, loader } = monthViewOn([run("gpt-5", 20)], "month");
	loader.loads[0].reject(new Error("EACCES"));
	await settle();
	view.handleInput("s");
	assert.ok(monthLines(view)[0].startsWith("This session"));
	assert.equal(loader.loads.length, 1);
});

test("s again after a rejected load retries it", async () => {
	const { view, loader } = monthViewOn([run("gpt-5", 20)], "month");
	loader.loads[0].reject(new Error("EACCES"));
	await settle();
	view.handleInput("s");
	view.handleInput("s");
	assert.equal(loader.loads.length, 2);
	assert.ok(monthLines(view).includes("Reading sessions…"));
});

test("s while loading cancels the load and shows this session", () => {
	const { view, loader } = monthViewOn([run("gpt-5", 20)], "session");
	view.handleInput("s");
	assert.equal(loader.loads.length, 1);
	assert.equal(loader.loads[0].signal.aborted, false);
	view.handleInput("s");
	assert.equal(loader.loads[0].signal.aborted, true);
	assert.ok(monthLines(view)[0].startsWith("This session"));
});

test("news from a cancelled load is ignored", async () => {
	const { view, loader } = monthViewOn([run("gpt-5", 20)], "session");
	view.handleInput("s");
	view.handleInput("s");
	loader.loads[0].onProgress(5, 6);
	loader.loads[0].resolve({ records: records(run("gpt-5", 999)), aborted: true });
	await settle();
	assert.ok(monthLines(view)[0].includes("20.0 AI credits"), "still this session");
});

test("s again after a cancelled load starts a fresh load", () => {
	const { view, loader } = monthViewOn([run("gpt-5", 20)], "session");
	view.handleInput("s");
	view.handleInput("s");
	view.handleInput("s");
	assert.equal(loader.loads.length, 2);
	assert.equal(loader.loads[1].signal.aborted, false);
});

test("a result from a cancelled load cannot replace the restarted one", async () => {
	const { view, loader } = monthViewOn([], "month");
	view.handleInput("s");
	view.handleInput("s");
	assert.equal(loader.loads.length, 2);
	loader.loads[0].resolve({ records: records(run("gpt-5", 999)) });
	await settle();
	assert.ok(monthLines(view).includes("Reading sessions…"), "the second load is still running");
	loader.loads[1].resolve({ records: records(run("gpt-5", 7)) });
	await settle();
	assert.ok(monthLines(view)[0].includes("7.00 AI credits"));
});

test("closing aborts a running load", () => {
	const { view, loader, calls } = monthViewOn();
	view.handleInput(escape);
	assert.equal(loader.loads[0].signal.aborted, true);
	assert.equal(calls.closes, 1);
});

test("disposing aborts a running load", () => {
	const { view, loader } = monthViewOn();
	view.dispose();
	assert.equal(loader.loads[0].signal.aborted, true);
});

test("closing after the load finished aborts nothing", async () => {
	const { view, loader } = monthViewOn();
	loader.loads[0].resolve({});
	await settle();
	view.handleInput(escape);
	assert.equal(loader.loads[0].signal.aborted, false);
});

test("s again after a completed load reuses it instead of reading the files again", async () => {
	const { view, loader } = monthViewOn([run("gpt-5", 20)], "session");
	view.handleInput("s");
	loader.loads[0].resolve({ records: records(run("gpt-5", 7)) });
	await settle();
	view.handleInput("s");
	assert.ok(monthLines(view)[0].startsWith("This session"));
	view.handleInput("s");
	assert.ok(monthLines(view)[0].includes("7.00 AI credits"));
	assert.equal(loader.loads.length, 1);
});

test("the view persists across scope toggles, and Tab while loading keeps the loading line", async () => {
	const { view, loader } = monthViewOn([run("gpt-5", 20, "subagent", "Explore")], "session");
	view.handleInput(tab);
	view.handleInput("s");
	view.handleInput(tab);
	view.handleInput(tab);
	assert.ok(monthLines(view)[0].includes("By agent"));
	assert.ok(monthLines(view).includes("Reading sessions…"));
	loader.loads[0].resolve({ records: records(run("gpt-5", 7, "subagent", "Explore")) });
	await settle();
	assert.ok(monthLines(view)[0].includes("By agent"));
	assert.ok(monthLines(view).some((l) => l.startsWith("Explore")));
});

test("a loader that throws synchronously is a failed load", async () => {
	const { view } = monthViewOn([], "month", {
		// double-waiver: B1 — loadSpendHistory reads session files from disk
		loadHistory: () => {
			throw new Error("boom");
		},
	});
	await settle();
	assert.ok(monthLines(view).includes("Could not load history: boom"));
});
