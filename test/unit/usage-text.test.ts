process.env.TZ = "UTC"; // "as of" is local time; pin it so the expected strings hold everywhere
import assert from "node:assert/strict";
import { test } from "node:test";
import { usageBreakdown } from "../../extensions/dev-team/lib/usage-breakdown.ts";
import { errorReason, loadFailedMessage, splitSections, totalHeaderParts, usageSummary, viewRows, wantedColumns } from "../../extensions/dev-team/lib/usage-text.ts";
import { mixed, multiProvider, NOW, providerRun, copilotRun } from "../helpers/usage-fixtures.ts";

test("this session, Copilot only: USD and credits, the thread split (one provider draws no provider split), then models, providers and agents", () => {
	assert.equal(
		usageSummary({ scope: "session", breakdown: mixed, now: NOW }),
		[
			"This session · $1.05 · 105.0 AI credits",
			"Threads  main $0.60 57.1% · subagents $0.40 38.1% · overhead $0.05 4.8%",
			"",
			"By model",
			"  github-copilot/claude-sonnet-4.5  $0.70  70.0 cr  66.7%",
			"  github-copilot/gpt-5              $0.35  35.0 cr  33.3%",
			"",
			"By provider",
			"  github-copilot  $1.05  105.0 cr  100.0%",
			"",
			"By agent",
			"  Explore · github-copilot       $0.30  30.0 cr  75.0%",
			"  orchestrator · github-copilot  $0.10  10.0 cr  25.0%",
		].join("\n"),
	);
});

test("mixed providers: USD for all, credits only on Copilot rows, tokens when a row cost nothing", () => {
	assert.equal(
		usageSummary({ scope: "session", breakdown: multiProvider, now: NOW }),
		[
			"This session · $2.00 · 90.0 AI credits",
			"Providers  openai $1.10 55.0% · github-copilot $0.90 45.0%",
			"Threads  main $0.80 40.0% · subagents $1.20 60.0%",
			"",
			"By model",
			"  openai/gpt-5.5                    $1.10              0 tok  55.0%",
			"  github-copilot/claude-sonnet-5.5  $0.90  90.0 cr     0 tok  45.0%",
			"  ollama/qwen3                      $0.00           850k tok     0%",
			"",
			"By provider",
			"  openai          $1.10              0 tok  55.0%",
			"  github-copilot  $0.90  90.0 cr     0 tok  45.0%",
			"  ollama          $0.00           850k tok     0%",
			"",
			"By agent",
			"  software-engineer · github-copilot  $0.90  90.0 cr     0 tok  75.0%",
			"  arch-review · openai                $0.30              0 tok  25.0%",
			"  Explore · ollama                    $0.00           850k tok     0%",
		].join("\n"),
	);
});

test("no Copilot at all: the header has no credits and no row has a credits column", () => {
	const text = usageSummary({ scope: "session", breakdown: usageBreakdown([providerRun("openai/gpt-5.5", 1.5), providerRun("anthropic/claude", 0.5, "subagent", "a")]), now: NOW });
	assert.equal(text.split("\n")[0], "This session · $2.00");
	assert.ok(!/\d cr\b/.test(text) && !text.includes("AI credits"), text);
});

test("totalHeaderParts: USD first, then credits only when Copilot spend shows", () => {
	assert.deepEqual(totalHeaderParts({ usd: 2, credits: 90, tokens: 0 }), ["$2.00", "90.0 AI credits"]);
	assert.deepEqual(totalHeaderParts({ usd: 2, credits: 0, tokens: 0 }), ["$2.00"]);
});

test("splitSections: providers only when two or more have a cost; threads always, in fixed order", () => {
	assert.deepEqual(
		splitSections(multiProvider).map((s) => [s.title, s.legend, s.parts.map((p) => p.label)]),
		[
			["Providers", "share", ["openai", "github-copilot"]],
			["Threads", "usd", ["main", "subagents", "overhead"]],
		],
	);
	assert.deepEqual(splitSections(mixed).map((s) => s.title), ["Threads"]);
	assert.deepEqual(splitSections(usageBreakdown([providerRun("ollama/a", 0, "main", "main", 10)])), [], "nothing cost anything");
});

test("wantedColumns: credits when a row has some, tokens when a row cost nothing", () => {
	assert.deepEqual(wantedColumns(multiProvider.byModel), { credits: true, tokens: true });
	assert.deepEqual(wantedColumns(usageBreakdown([providerRun("openai/a", 1)]).byModel), { credits: false, tokens: false });
});

test("viewRows: models, providers or agents, as ranked in the breakdown", () => {
	assert.deepEqual(viewRows("model", multiProvider).map((r) => r.label), ["openai/gpt-5.5", "github-copilot/claude-sonnet-5.5", "ollama/qwen3"]);
	assert.deepEqual(viewRows("provider", multiProvider).map((r) => r.label), ["openai", "github-copilot", "ollama"]);
	assert.deepEqual(viewRows("agent", multiProvider).map((r) => r.label), ["software-engineer · github-copilot", "arch-review · openai", "Explore · ollama"]);
});

test("this month names the dates and when it was read, and notes unreadable files", () => {
	const text = usageSummary({ scope: "month", breakdown: mixed, now: NOW, month: { unreadable: 2, loadedAt: NOW } });
	const lines = text.split("\n");
	assert.equal(lines[0], "This month (Oct 1 – Oct 4) · $1.05 · 105.0 AI credits · as of 14:05");
	assert.equal(lines.at(-1), "2 session files could not be read");
	assert.ok(!usageSummary({ scope: "month", breakdown: mixed, now: NOW, month: { unreadable: 0, loadedAt: NOW } }).includes("could not be read"));
});

test("the month heading shows UTC dates while 'as of' shows the local clock", () => {
	const tz = process.env.TZ;
	process.env.TZ = "America/Los_Angeles";
	try {
		// 02:00 UTC on Oct 1 is still Sep 30 in Los Angeles, but the billing month has begun.
		const firstOfMonth = new Date(Date.UTC(2026, 9, 1, 2, 0));
		const text = usageSummary({ scope: "month", breakdown: mixed, now: firstOfMonth, month: { unreadable: 0, loadedAt: firstOfMonth } });
		assert.equal(text.split("\n")[0], "This month (Oct 1 – Oct 1) · $1.05 · 105.0 AI credits · as of 19:00");
	} finally {
		if (tz === undefined) delete process.env.TZ;
		else process.env.TZ = tz;
	}
});

test("no usage keeps the unreadable-files note, as the overlay does", () => {
	assert.equal(
		usageSummary({ scope: "month", breakdown: usageBreakdown([]), now: NOW, month: { unreadable: 3, loadedAt: NOW } }),
		"No usage this month\n\n3 session files could not be read",
	);
});

test("a tiny cost still counts as usage; it shows as under a cent", () => {
	const text = usageSummary({ scope: "session", breakdown: usageBreakdown([providerRun("openai/gpt-5.5", 0.004)]), now: NOW });
	assert.equal(text.split("\n")[0], "This session · <$0.01");
});

test("no usage prints just the empty-state sentence", () => {
	const none = usageBreakdown([]);
	assert.equal(usageSummary({ scope: "session", breakdown: none, now: NOW }), "No usage in this session");
	assert.equal(usageSummary({ scope: "month", breakdown: none, now: NOW, month: { unreadable: 0, loadedAt: NOW } }), "No usage this month");
});

test("main-only spend lists no agents", () => {
	const text = usageSummary({ scope: "session", breakdown: usageBreakdown([copilotRun("gpt-5", 20)]), now: NOW });
	assert.ok(text.endsWith("By agent\n  No subagent usage in this session"), text);
});

test("labels from session files cannot carry control characters", () => {
	const text = usageSummary({ scope: "session", breakdown: usageBreakdown([copilotRun("gpt-5", 20, "subagent", "bad\x1b[31m\nname")]), now: NOW });
	assert.ok(!/[\u0000-\u0009\u000b-\u001f]/.test(text));
	assert.ok(text.includes("badname"));
});

test("a load failure message turns each run of control characters into one space", () => {
	assert.equal(loadFailedMessage("bad\n\x1b[31mred"), "Could not load history: bad red");
});

test("errorReason is an Error's message, or the text of anything else", () => {
	assert.equal(errorReason(new Error("EACCES")), "EACCES");
	assert.equal(errorReason("plain"), "plain");
});
