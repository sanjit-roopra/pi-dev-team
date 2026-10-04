process.env.TZ = "UTC"; // "as of" is local time; pin it so the expected strings hold everywhere
import assert from "node:assert/strict";
import { test } from "node:test";
import { usageBreakdown } from "../../extensions/dev-team/lib/usage-breakdown.ts";
import { errorReason, loadFailedMessage, modelRows, usageSummary } from "../../extensions/dev-team/lib/usage-text.ts";
import { mixed, NOW, run } from "../helpers/usage-fixtures.ts";

test("this session: header, split line, then models and agents ranked with credits and share", () => {
	assert.equal(
		usageSummary({ scope: "session", breakdown: mixed, now: NOW }),
		[
			"This session · 105.0 AI credits",
			"main 60.0 · subagents 40.0 · overhead 5.00",
			"",
			"By model",
			"  claude-sonnet-4.5  70.0  66.7%",
			"  gpt-5              35.0  33.3%",
			"",
			"By agent",
			"  Explore       30.0  75.0%",
			"  orchestrator  10.0  25.0%",
		].join("\n"),
	);
});

test("this month names the dates and when it was read, and notes unreadable files", () => {
	const text = usageSummary({ scope: "month", breakdown: mixed, now: NOW, month: { unreadable: 2, loadedAt: NOW } });
	const lines = text.split("\n");
	assert.equal(lines[0], "This month (Oct 1 – Oct 4) · 105.0 AI credits · as of 14:05");
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
		assert.equal(text.split("\n")[0], "This month (Oct 1 – Oct 1) · 105.0 AI credits · as of 19:00");
	} finally {
		if (tz === undefined) delete process.env.TZ;
		else process.env.TZ = tz;
	}
});

test("no Copilot spend keeps the unreadable-files note, as the overlay does", () => {
	assert.equal(
		usageSummary({ scope: "month", breakdown: usageBreakdown([]), now: NOW, month: { unreadable: 3, loadedAt: NOW } }),
		"No GitHub Copilot usage this month\n\n3 session files could not be read",
	);
});

test("spend that rounds to 0.00 credits counts as none, like the status line", () => {
	assert.equal(usageSummary({ scope: "session", breakdown: usageBreakdown([run("gpt-5", 0.004)]), now: NOW }), "No GitHub Copilot usage in this session");
});

test("no Copilot spend prints just the empty-state sentence", () => {
	const none = usageBreakdown([]);
	assert.equal(usageSummary({ scope: "session", breakdown: none, now: NOW }), "No GitHub Copilot usage in this session");
	assert.equal(usageSummary({ scope: "month", breakdown: none, now: NOW, month: { unreadable: 0, loadedAt: NOW } }), "No GitHub Copilot usage this month");
});

test("main-only spend lists no agents", () => {
	const text = usageSummary({ scope: "session", breakdown: usageBreakdown([run("gpt-5", 20)]), now: NOW });
	assert.ok(text.endsWith("By agent\n  No subagent usage in this session"), text);
});

test("labels from session files cannot carry control characters", () => {
	const text = usageSummary({ scope: "session", breakdown: usageBreakdown([run("gpt-5", 20, "subagent", "bad\x1b[31m\nname")]), now: NOW });
	assert.ok(!/[\u0000-\u0009\u000b-\u001f]/.test(text));
	assert.ok(text.includes("badname"));
});

test("modelRows ranks as the breakdown does and drops the provider prefix from the labels", () => {
	assert.deepEqual(
		modelRows(mixed).map((r) => r.label),
		["claude-sonnet-4.5", "gpt-5"],
	);
});

test("a load failure message turns each run of control characters into one space", () => {
	assert.equal(loadFailedMessage("bad\n\x1b[31mred"), "Could not load history: bad red");
});

test("errorReason is an Error's message, or the text of anything else", () => {
	assert.equal(errorReason(new Error("EACCES")), "EACCES");
	assert.equal(errorReason("plain"), "plain");
});
