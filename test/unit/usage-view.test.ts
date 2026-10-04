process.env.TZ = "UTC"; // the header's "as of" is local time; pin it so the expected strings hold everywhere
import assert from "node:assert/strict";
import { test } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { SpendRun } from "../../extensions/dev-team/lib/session-spend.ts";
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
