process.env.TZ = "UTC"; // the header's "as of" is local time; pin it so the expected strings hold everywhere
import assert from "node:assert/strict";
import { test } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { type UsageBreakdown, usageBreakdown } from "../../extensions/dev-team/lib/usage-breakdown.ts";
import { renderUsage, type UsageStyle, type UsageViewModel } from "../../extensions/dev-team/lib/usage-render.ts";
import type { UsageState } from "../../extensions/dev-team/lib/usage-state.ts";
import { mixed, NOW, run } from "../helpers/usage-fixtures.ts";

const identity = (text: string) => text;
const style: UsageStyle = { title: identity, error: identity, bar: identity, muted: identity, segment: (_label, text) => text };

const breakdown = (...runs: ReturnType<typeof run>[]): UsageBreakdown => usageBreakdown(runs);
const state = (scope: UsageState["scope"], view: UsageState["view"], load: UsageState["load"] = { kind: scope === "month" ? "ready" : "idle" }): UsageState => ({ scope, view, load });
const sessionModel = state("session", "model");
const viewModel = (s: UsageState, extra: Partial<UsageViewModel> = {}): UsageViewModel => ({
	state: s,
	session: mixed,
	month: { breakdown: mixed, unreadable: 0, loadedAt: NOW },
	now: NOW,
	...extra,
});
const render = (m: UsageViewModel, width = 80, height = 40) => renderUsage(m, { width, height, style });

test("the header names the scope, the view and the total", () => {
	assert.equal(render(viewModel(sessionModel))[0], "This session · By model · 105.0 AI credits");
});

test("the footer offers the other scope", () => {
	assert.equal(render(viewModel(sessionModel)).at(-1), "Tab view · s this month · Esc close");
});

test("a split bar shows main, subagent and overhead segments, then a legend with their credits", () => {
	const lines = render(viewModel(sessionModel));
	assert.ok(lines.some((l) => /^█+▓+░+$/.test(l.trim())), `split bar missing:\n${lines.join("\n")}`);
	assert.ok(lines.some((l) => l.includes("█ main 60.0 · ▓ subagents 40.0 · ░ overhead 5.00")));
});

test("By model ranks the models with credits and share", () => {
	const chart = render(viewModel(sessionModel)).filter((l) => /^(claude-sonnet-4\.5|gpt-5) /.test(l));
	assert.equal(chart.length, 2);
	assert.ok(chart[0].startsWith("claude-sonnet-4.5") && chart[0].includes("70.0") && chart[0].includes("66.7%"), chart[0]);
});

test("model labels drop the provider prefix", () => {
	assert.ok(!render(viewModel(sessionModel)).join("\n").includes("github-copilot/"));
});

test("By agent ranks the subagents and keeps the split bar", () => {
	const lines = render(viewModel(state("session", "agent")));
	assert.equal(lines[0], "This session · By agent · 105.0 AI credits");
	const chart = lines.filter((l) => /^(Explore|orchestrator) /.test(l));
	assert.equal(chart.length, 2);
	assert.ok(chart[0].startsWith("Explore") && chart[0].includes("75.0%"), chart[0]);
	assert.ok(lines.some((l) => l.includes("█ main 60.0")));
});

test("this month's header names the dates and the snapshot time, and the footer offers this session", () => {
	const lines = render(viewModel(state("month", "model")));
	assert.equal(lines[0], "This month (Oct 1 – Oct 4) · By model · 105.0 AI credits · as of 14:05");
	assert.equal(lines.at(-1), "Tab view · s this session · Esc close");
});

const empty = breakdown();
const mainOnly = breakdown(run("gpt-5", 20), run("gpt-5", 10, "overhead", "compaction"));

test("an empty session says so, points at this month and shows no split bar", () => {
	const lines = render(viewModel(sessionModel, { session: empty }));
	assert.deepEqual(lines, [
		"This session · By model · 0.00 AI credits",
		"",
		"No GitHub Copilot usage in this session — press s for this month",
		"",
		"Tab view · s this month · Esc close",
	]);
});

test("an empty month says so", () => {
	const lines = render(viewModel(state("month", "model"), { month: { breakdown: empty, unreadable: 0, loadedAt: NOW } }));
	assert.ok(lines.includes("No GitHub Copilot usage this month"), lines.join("\n"));
	assert.ok(!lines.join("\n").includes("press s"));
	assert.ok(!lines.some((l) => /[█▓░]/.test(l)));
});

test("By agent with main-only spend says there is no subagent usage and keeps the split bar", () => {
	const lines = render(viewModel(state("session", "agent"), { session: mainOnly }));
	assert.ok(lines.includes("No subagent usage in this session"), lines.join("\n"));
	assert.ok(lines.some((l) => l.includes("█ main 20.0 · ░ overhead 10.0")));
	const month = render(viewModel(state("month", "agent"), { month: { breakdown: mainOnly, unreadable: 0, loadedAt: NOW } }));
	assert.ok(month.includes("No subagent usage this month"), month.join("\n"));
});

test("loading shows the progress in the chart area, no total, and the cancel footer", () => {
	const lines = render(viewModel(state("month", "model", { kind: "loading", progress: { done: 3, total: 12 } })));
	assert.deepEqual(lines, [
		"This month (Oct 1 – Oct 4) · By model",
		"",
		"Reading sessions… 3/12 files",
		"",
		"Tab view · s cancel · Esc close",
	]);
});

test("loading without progress yet just says it is reading", () => {
	assert.ok(render(viewModel(state("month", "model", { kind: "loading" }))).includes("Reading sessions…"));
});

test("a failed load shows the reason and the back footer", () => {
	const lines = render(viewModel(state("month", "agent", { kind: "error", reason: "EACCES" })));
	assert.deepEqual(lines, [
		"This month (Oct 1 – Oct 4) · By agent",
		"",
		"Could not load history: EACCES",
		"",
		"s back · Esc close",
	]);
});

test("an error reason cannot smuggle control characters or extra lines", () => {
	const lines = render(viewModel(state("month", "model", { kind: "error", reason: "bad\n\x1b[31mred" })));
	assert.ok(lines.includes("Could not load history: bad red"), lines.join("\n"));
	assert.ok(lines.every((l) => !/[\u0000-\u001f]/.test(l)));
});

test("unreadable files get a footnote under this month's chart, and none under this session's", () => {
	const unreadable = (n: number) => render(viewModel(state("month", "model"), { month: { breakdown: mixed, unreadable: n, loadedAt: NOW } }));
	const lines = unreadable(2);
	assert.equal(lines.at(-3), "2 session files could not be read");
	assert.ok(unreadable(1).includes("1 session file could not be read"));
	assert.ok(!unreadable(0).join("\n").includes("could not be read"));
	assert.ok(!render(viewModel(sessionModel, { month: { breakdown: mixed, unreadable: 2, loadedAt: NOW } })).join("\n").includes("could not be read"));
});

test("a narrow header drops the snapshot time, then the dates, before the scope and view", () => {
	const full = "This month (Oct 1 – Oct 4) · By model · 105.0 AI credits · as of 14:05";
	const noClock = "This month (Oct 1 – Oct 4) · By model · 105.0 AI credits";
	const noDates = "This month · By model · 105.0 AI credits";
	const header = (width: number) => render(viewModel(state("month", "model")), width)[0];
	assert.equal(header(full.length), full);
	assert.equal(header(full.length - 1), noClock);
	assert.equal(header(noClock.length - 1), noDates);
	assert.equal(header(noDates.length), noDates);
	assert.equal(header(10), "This mont…");
});

test("a narrow footer drops the view hint, then the scope hint, and always keeps Esc close", () => {
	const full = "Tab view · s this month · Esc close";
	const noViewHint = "s this month · Esc close";
	const escOnly = "Esc close";
	const footer = (width: number) => render(viewModel(sessionModel), width).at(-1);
	assert.equal(footer(full.length), full);
	assert.equal(footer(full.length - 1), noViewHint);
	assert.equal(footer(noViewHint.length - 1), escOnly);
	assert.equal(footer(escOnly.length + 1), escOnly);
});

test("a loading footer drops the view hint, then the cancel hint", () => {
	const cancelAndEsc = "s cancel · Esc close";
	const footer = (width: number) => render(viewModel(state("month", "model", { kind: "loading" })), width).at(-1);
	assert.equal(footer(cancelAndEsc.length), cancelAndEsc);
	assert.equal(footer(cancelAndEsc.length - 1), "Esc close");
});

/** Every scope, view and load state the overlay can be in, with enough models to need folding. */
function everyViewModel(): [string, UsageViewModel][] {
	const many = breakdown(...Array.from({ length: 14 }, (_, i) => run(`model-with-a-long-name-${i}`, 100 - i, i % 3 === 0 ? "subagent" : "main", `agent-${i}`)), run("x", 3, "overhead", "compaction"));
	const readyMonth = (breakdownOf: UsageBreakdown, unreadable = 0) => ({ breakdown: breakdownOf, unreadable, loadedAt: NOW });
	const out: [string, UsageViewModel][] = [];
	for (const view of ["model", "agent"] as const) {
		out.push([`session ${view} data`, viewModel(state("session", view), { session: many })]);
		out.push([`session ${view} mixed`, viewModel(state("session", view))]);
		out.push([`session ${view} empty`, viewModel(state("session", view), { session: empty })]);
		out.push([`month ${view} data`, viewModel(state("month", view), { month: readyMonth(many, 3) })]);
		out.push([`month ${view} empty`, viewModel(state("month", view), { month: readyMonth(empty) })]);
		out.push([`month ${view} loading`, viewModel(state("month", view, { kind: "loading", progress: { done: 10, total: 120 } }))]);
		out.push([`month ${view} loading, no progress`, viewModel(state("month", view, { kind: "loading" }))]);
		out.push([`month ${view} error`, viewModel(state("month", view, { kind: "error", reason: "EACCES: permission denied, scandir '/home/someone/.pi/agent/sessions'" }))]);
	}
	return out;
}

test("no line is wider than the terminal, the panel fits the height, and header and footer stay", () => {
	for (const [name, m] of everyViewModel()) {
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
	const lines = render(viewModel(sessionModel, { session: many }), 80, 10);
	assert.equal(lines.length, 10);
	assert.ok(lines.some((l) => l.startsWith("other (")), lines.join("\n"));
	assert.ok(lines[0].startsWith("This session"));
	assert.equal(lines.at(-1), "Tab view · s this month · Esc close");
});
