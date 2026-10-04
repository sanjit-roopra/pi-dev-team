process.env.TZ = "UTC"; // the header's "as of" is local time; pin it so the expected strings hold everywhere
import assert from "node:assert/strict";
import { test } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { SpendRun } from "../../extensions/dev-team/lib/session-spend.ts";
import type { SpendHistory } from "../../extensions/dev-team/lib/usage-history.ts";
import { type UsageBreakdown, usageBreakdown } from "../../extensions/dev-team/lib/usage-breakdown.ts";
import { openUsage, type UsageState } from "../../extensions/dev-team/lib/usage-state.ts";
import { renderUsage, type UsageModel, UsageView, type UsageViewDeps, type UsageStyle } from "../../extensions/dev-team/lib/usage-view.ts";

const identity = (text: string) => text;
const style: UsageStyle = { title: identity, error: identity, bar: identity, muted: identity, segment: (_label, text) => text };

/** A Copilot run costing `credits` AI credits (1 credit = $0.01). */
const run = (model: string, credits: number, thread: SpendRun["thread"] = "main", agent = "main"): SpendRun => ({
	thread,
	agent: thread === "main" ? "main" : agent,
	model: `github-copilot/${model}`,
	usage: { cost: { total: credits / 100 } },
	messages: 1,
});
const breakdown = (...runs: SpendRun[]): UsageBreakdown => usageBreakdown(runs);

const NOW = new Date(Date.UTC(2026, 9, 4, 14, 5));
const state = (scope: UsageState["scope"], view: UsageState["view"], load: UsageState["load"] = { kind: scope === "month" ? "ready" : "idle" }): UsageState => ({ scope, view, load });
const sessionModel = state("session", "model");
const mixed = breakdown(run("claude-sonnet-4.5", 60), run("gpt-5", 30, "subagent", "Explore"), run("claude-sonnet-4.5", 10, "subagent", "orchestrator"), run("gpt-5", 5, "overhead", "compaction"));
const model = (s: UsageState, extra: Partial<UsageModel> = {}): UsageModel => ({
	state: s,
	session: mixed,
	month: { breakdown: mixed, skipped: 0, loadedAt: NOW },
	now: NOW,
	...extra,
});
const render = (m: UsageModel, width = 80, height = 40) => renderUsage(m, { width, height, style });

test("opening shows this session by model: header, split bar, chart and footer", () => {
	const lines = render(model(sessionModel));
	assert.equal(lines[0], "This session · By model · 105.0 AI credits");
	assert.equal(lines.at(-1), "Tab view · s this month · Esc close");
	assert.ok(lines.some((l) => /^█+▓+░+$/.test(l.trim())), `split bar missing:\n${lines.join("\n")}`);
	assert.ok(lines.some((l) => l.includes("█ main 60.0 · ▓ subagents 40.0 · ░ overhead 5.00")));
	const chart = lines.filter((l) => /^(claude-sonnet-4\.5|gpt-5) /.test(l));
	assert.equal(chart.length, 2);
	assert.ok(chart[0].startsWith("claude-sonnet-4.5") && chart[0].includes("70.0") && chart[0].includes("66.7%"), chart[0]);
	assert.ok(!lines.join("\n").includes("github-copilot/"), "model labels drop the provider prefix");
});

test("By agent ranks the subagents and keeps the split bar", () => {
	const lines = render(model(state("session", "agent")));
	assert.equal(lines[0], "This session · By agent · 105.0 AI credits");
	const chart = lines.filter((l) => /^(Explore|orchestrator) /.test(l));
	assert.equal(chart.length, 2);
	assert.ok(chart[0].startsWith("Explore") && chart[0].includes("75.0%"), chart[0]);
	assert.ok(lines.some((l) => l.includes("█ main 60.0")));
});

test("this month's header names the dates and the snapshot time, and the footer offers this session", () => {
	const lines = render(model(state("month", "model")));
	assert.equal(lines[0], "This month (Oct 1 – Oct 4) · By model · 105.0 AI credits · as of 14:05");
	assert.equal(lines.at(-1), "Tab view · s this session · Esc close");
});

const empty = breakdown();
const mainOnly = breakdown(run("gpt-5", 20), run("gpt-5", 10, "overhead", "compaction"));

test("an empty session says so, points at this month and shows no split bar", () => {
	const lines = render(model(sessionModel, { session: empty }));
	assert.deepEqual(lines, [
		"This session · By model · 0.00 AI credits",
		"",
		"No GitHub Copilot usage in this session — press s for this month",
		"",
		"Tab view · s this month · Esc close",
	]);
});

test("an empty month says so", () => {
	const lines = render(model(state("month", "model"), { month: { breakdown: empty, skipped: 0, loadedAt: NOW } }));
	assert.ok(lines.includes("No GitHub Copilot usage this month"), lines.join("\n"));
	assert.ok(!lines.join("\n").includes("press s"));
	assert.ok(!lines.some((l) => /[█▓░]/.test(l)));
});

test("By agent with main-only spend says there is no subagent usage and keeps the split bar", () => {
	const lines = render(model(state("session", "agent"), { session: mainOnly }));
	assert.ok(lines.includes("No subagent usage in this session"), lines.join("\n"));
	assert.ok(lines.some((l) => l.includes("█ main 20.0 · ░ overhead 10.0")));
	const month = render(model(state("month", "agent"), { month: { breakdown: mainOnly, skipped: 0, loadedAt: NOW } }));
	assert.ok(month.includes("No subagent usage this month"), month.join("\n"));
});

test("loading shows the progress in the chart area, no total, and the cancel footer", () => {
	const lines = render(model(state("month", "model", { kind: "loading", progress: { done: 3, total: 12 } })));
	assert.deepEqual(lines, [
		"This month (Oct 1 – Oct 4) · By model",
		"",
		"Reading sessions… 3/12 files",
		"",
		"Tab view · s cancel · Esc close",
	]);
	assert.ok(render(model(state("month", "model", { kind: "loading" }))).includes("Reading sessions…"));
});

test("a failed load shows the reason and the back footer", () => {
	const lines = render(model(state("month", "agent", { kind: "error", reason: "EACCES" })));
	assert.deepEqual(lines, [
		"This month (Oct 1 – Oct 4) · By agent",
		"",
		"Could not load history: EACCES",
		"",
		"s back · Esc close",
	]);
});

test("an error reason cannot smuggle control characters or extra lines", () => {
	const lines = render(model(state("month", "model", { kind: "error", reason: "bad\n\x1b[31mred" })));
	assert.ok(lines.includes("Could not load history: bad [31mred"), lines.join("\n"));
	assert.ok(lines.every((l) => !/[\u0000-\u001f]/.test(l)));
});

test("skipped files get a footnote under this month's chart, and none under this session's", () => {
	const skipped = (n: number) => render(model(state("month", "model"), { month: { breakdown: mixed, skipped: n, loadedAt: NOW } }));
	const lines = skipped(2);
	assert.equal(lines.at(-3), "2 session files could not be read");
	assert.ok(skipped(1).includes("1 session file could not be read"));
	assert.ok(!skipped(0).join("\n").includes("could not be read"));
	assert.ok(!render(model(sessionModel, { month: { breakdown: mixed, skipped: 2, loadedAt: NOW } })).join("\n").includes("could not be read"));
});

test("a narrow header drops the snapshot time, then the dates, before the scope and view", () => {
	const full = "This month (Oct 1 – Oct 4) · By model · 105.0 AI credits · as of 14:05";
	const noClock = "This month (Oct 1 – Oct 4) · By model · 105.0 AI credits";
	const noDates = "This month · By model · 105.0 AI credits";
	const header = (width: number) => render(model(state("month", "model")), width)[0];
	assert.equal(header(full.length), full);
	assert.equal(header(full.length - 1), noClock);
	assert.equal(header(noClock.length - 1), noDates);
	assert.equal(header(noDates.length), noDates);
	assert.equal(header(10), "This mont…");
});

test("a narrow footer drops the view hint, then the scope hint, and always keeps Esc close", () => {
	const footer = (width: number) => render(model(sessionModel), width).at(-1);
	assert.equal(footer(35), "Tab view · s this month · Esc close");
	assert.equal(footer(34), "s this month · Esc close");
	assert.equal(footer(23), "Esc close");
	assert.equal(footer(10), "Esc close");
	const loading = (width: number) => render(model(state("month", "model", { kind: "loading" })), width).at(-1);
	assert.equal(loading(20), "s cancel · Esc close");
	assert.equal(loading(19), "Esc close");
});

/** Every scope, view and load state the overlay can be in, with enough models to need folding. */
function everyModel(): [string, UsageModel][] {
	const many = breakdown(...Array.from({ length: 14 }, (_, i) => run(`model-with-a-long-name-${i}`, 100 - i, i % 3 === 0 ? "subagent" : "main", `agent-${i}`)), run("x", 3, "overhead", "compaction"));
	const readyMonth = (breakdownOf: UsageBreakdown, skipped = 0) => ({ breakdown: breakdownOf, skipped, loadedAt: NOW });
	const out: [string, UsageModel][] = [];
	for (const view of ["model", "agent"] as const) {
		out.push([`session ${view} data`, model(state("session", view), { session: many })]);
		out.push([`session ${view} mixed`, model(state("session", view))]);
		out.push([`session ${view} empty`, model(state("session", view), { session: empty })]);
		out.push([`month ${view} data`, model(state("month", view), { month: readyMonth(many, 3) })]);
		out.push([`month ${view} empty`, model(state("month", view), { month: readyMonth(empty) })]);
		out.push([`month ${view} loading`, model(state("month", view, { kind: "loading", progress: { done: 10, total: 120 } }))]);
		out.push([`month ${view} loading, no progress`, model(state("month", view, { kind: "loading" }))]);
		out.push([`month ${view} error`, model(state("month", view, { kind: "error", reason: "EACCES: permission denied, scandir '/home/someone/.pi/agent/sessions'" }))]);
	}
	return out;
}

test("no line is wider than the terminal, the panel fits the height, and header and footer stay", () => {
	for (const [name, m] of everyModel()) {
		for (const width of [10, 30, 80]) {
			for (const height of [3, 4, 5, 6, 8, 10, 12, 20, 36, 60]) {
				const lines = render(m, width, height);
				const where = `${name} @ ${width}x${height}`;
				assert.ok(lines.length <= height, `${where}: ${lines.length} lines\n${lines.join("\n")}`);
				for (const line of lines) assert.ok(visibleWidth(line) <= width, `${where}: "${line}" is ${visibleWidth(line)} wide`);
				assert.match(lines[0], /^This (sess|mont)/, where);
				assert.ok(lines.at(-1)!.includes("Esc close"), `${where}: footer "${lines.at(-1)}"`);
			}
		}
	}
});

test("rows beyond the height fold into other (N) while the header and footer stay pinned", () => {
	const many = breakdown(...Array.from({ length: 14 }, (_, i) => run(`m${i}`, 100 - i)));
	const lines = render(model(sessionModel, { session: many }), 80, 10);
	assert.equal(lines.length, 10);
	assert.ok(lines.some((l) => l.startsWith("other (")), lines.join("\n"));
	assert.ok(lines[0].startsWith("This session"));
	assert.equal(lines.at(-1), "Tab view · s this month · Esc close");
});

/** A UsageView on stub deps, recording what it asked of the host. */
function viewOn(runs: SpendRun[], extra: Partial<UsageViewDeps> = {}) {
	const calls = { renders: 0, closes: 0 };
	const deps: UsageViewDeps = {
		sessionRuns: () => runs,
		now: () => NOW,
		rows: () => 40,
		style,
		requestRender: () => void calls.renders++,
		close: () => void calls.closes++,
		loadHistory: () => Promise.reject(new Error("no loader in this test")),
		...extra,
	};
	return { view: new UsageView(deps, openUsage("session")), calls, deps };
}
const tab = "\t";
const shiftTab = "\x1b[Z";

test("the component renders this session by model and fits the overlay's 90% of the terminal height", () => {
	const manyRuns = Array.from({ length: 30 }, (_, i) => run(`model-${i}`, 50 - i));
	for (const rows of [12, 40]) {
		const { view } = viewOn(manyRuns, { rows: () => rows });
		for (const width of [10, 30, 80]) {
			const lines = view.render(width);
			assert.ok(lines.length <= Math.floor(rows * 0.9), `${width}x${rows}: ${lines.length} lines`);
			assert.ok(lines.every((l) => visibleWidth(l) <= width));
			assert.match(lines[0], /^This sess/);
			assert.ok(lines.at(-1)!.includes("Esc close"));
		}
	}
	assert.equal(viewOn(manyRuns).view.render(80)[0], "This session · By model · 1,065 AI credits");
});

test("Tab and Shift+Tab switch the view and ask for a re-render; the split bar stays", () => {
	const { view, calls } = viewOn([run("gpt-5", 30, "subagent", "Explore"), run("gpt-5", 20)]);
	view.handleInput(tab);
	assert.ok(view.render(80)[0].includes("By agent"));
	assert.ok(view.render(80).some((l) => l.includes("█ main 20.0")), "split bar still shown");
	view.handleInput(shiftTab);
	assert.ok(view.render(80)[0].includes("By model"));
	assert.equal(calls.renders, 2);
});

test("Esc, q, Q and Ctrl+C close the overlay", () => {
	for (const data of ["\x1b", "q", "Q", "\x03"]) {
		const { view, calls } = viewOn([run("gpt-5", 20)]);
		view.handleInput(data);
		assert.equal(calls.closes, 1, JSON.stringify(data));
	}
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
	assert.equal(calls.renders, 1);
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

test("a rejected load shows the error, s goes back, and s again retries", async () => {
	const { view, loader } = monthViewOn([run("gpt-5", 20)], "month");
	loader.loads[0].reject(new Error("EACCES"));
	await settle();
	assert.ok(monthLines(view).includes("Could not load history: EACCES"));
	assert.equal(monthLines(view).at(-1), "s back · Esc close");
	view.handleInput("s");
	assert.ok(monthLines(view)[0].startsWith("This session"));
	assert.equal(loader.loads.length, 1);
	view.handleInput("s");
	assert.equal(loader.loads.length, 2, "retried");
	assert.ok(monthLines(view).includes("Reading sessions…"));
});

test("s while loading cancels the load and shows this session; a late result is ignored", async () => {
	const { view, loader } = monthViewOn([run("gpt-5", 20)], "session");
	view.handleInput("s");
	assert.equal(loader.loads.length, 1);
	assert.equal(loader.loads[0].signal.aborted, false);
	view.handleInput("S");
	assert.equal(loader.loads[0].signal.aborted, true);
	assert.ok(monthLines(view)[0].startsWith("This session"));
	loader.loads[0].onProgress(5, 6);
	loader.loads[0].resolve({ records: records(run("gpt-5", 999)), aborted: true });
	await settle();
	assert.ok(monthLines(view)[0].includes("20.0 AI credits"), "still this session");
	view.handleInput("s");
	assert.equal(loader.loads.length, 2, "a cancelled load restarts");
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
	view.handleInput("q");
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
	view.handleInput("\x1b");
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
		loadHistory: () => {
			throw new Error("boom");
		},
	});
	await settle();
	assert.ok(monthLines(view).includes("Could not load history: boom"));
});
