import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { formatElapsed, formatToolCall, formatUsage, recentCallLines, renderSubagentCall, renderSubagentResult } from "../../extensions/dev-team/lib/subagent-render.ts";
import type { LiveSubagentView, SubagentDetails, SubagentTaskView, UsageTotals } from "../../extensions/dev-team/lib/subagent-types.ts";

// A theme stub that returns text unchanged; the renderers only call fg() and bold().
const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text } as never;
const draw = (c: { render(width: number): string[] }) => c.render(120).join("\n");
const usage: UsageTotals = { input: 1200, output: 80, cacheRead: 0, cacheWrite: 0, cost: 0.0012, turns: 2 };

function taskView(overrides: Partial<SubagentTaskView>): SubagentTaskView {
	return { agent: "a", task: "do x", status: "ok", ok: true, turns: 1, recentCalls: [], ...overrides };
}

function result(details: SubagentDetails) {
	return { content: [], details } as never;
}

test("call: single dispatch shows agent, worktree flag and task", () => {
	const out = draw(renderSubagentCall({ agent: "security-review", task: "review src/a.js", isolation: "worktree" }, theme));
	assert.match(out, /dev-team security-review \[worktree\]/);
	assert.match(out, /review src\/a\.js/);
});

test("call: parallel dispatch lists the first agents and counts the rest", () => {
	const tasks = ["a", "b", "c", "d", "e", "f"].map((agent) => ({ subagent_type: agent, prompt: `task ${agent}` }));
	const out = draw(renderSubagentCall({ tasks }, theme));
	assert.match(out, /parallel \(6 agents\)/);
	assert.match(out, /d task d/);
	assert.match(out, /\+2 more/);
});

test("result while running: progress count and latest tool calls", () => {
	const details = { results: [taskView({ status: "running", ok: false, recentCalls: [{ name: "read" }, { name: "grep", args: { pattern: "TODO" } }] }), taskView({ agent: "b", output: "done", usage })] };
	const out = draw(renderSubagentResult(result(details), { expanded: false, isPartial: true }, theme));
	assert.match(out, /1\/2 done, 1 running/);
	assert.match(out, /→ grep \/TODO\/ in \./);
	assert.doesNotMatch(out, /Total:/);
});

function live(agent: string, status: LiveSubagentView["status"], overrides: Partial<LiveSubagentView> = {}): LiveSubagentView {
	return { agent, status, turns: 1, recentCalls: [], ...overrides };
}

function runningWith(subagents: LiveSubagentView[]) {
	return result({ results: [taskView({ agent: "orchestrator", status: "running", ok: false, recentCalls: [{ name: "dev_team_subagent", args: { tasks: String(subagents.length) } }], subagents })] });
}

const drawLines = (r: ReturnType<typeof runningWith>) => draw(renderSubagentResult(r, { expanded: false, isPartial: true }, theme)).split("\n").map((l) => l.trimEnd());

test("result while running: the subagents a running agent dispatched, live, running first", () => {
	const reviewers = [
		live("naming-review", "ok", { subagents: [live("stale-finished-child", "running")] }),
		live("security-review", "running", { turns: 4, recentCalls: [{ name: "read", args: { path: "src/auth.ts" } }], subagents: [live("deep", "running")] }),
		live("test-review", "failed"),
	];
	const lines = drawLines(runningWith(reviewers));
	const at = lines.indexOf("  subagents 2/3 done");
	assert.ok(at > 0, lines.join("\n"));
	assert.deepEqual(lines.slice(at + 1, at + 6), [
		"    ⏳ security-review turn 4 → read src/auth.ts",
		"      subagents 0/1 done",
		"        ⏳ deep turn 1",
		"    ✓ naming-review",
		"    ✗ test-review",
	], "a finished subagent does not list the agents it ran");
});

test("result while running: subagents are capped at 12 and the rest counted, the header counts all", () => {
	const SHOWN = 12;
	const many = (n: number) => Array.from({ length: n }, (_, i) => live(`r${i}`, "running"));
	const capped = drawLines(runningWith(many(SHOWN + 3)));
	assert.ok(capped.includes(`  subagents 0/${SHOWN + 3} done`), capped.join("\n"));
	assert.ok(capped.includes(`    ⏳ r${SHOWN - 1} turn 1`));
	assert.ok(!capped.some((l) => l.includes(`⏳ r${SHOWN} `)), "the 13th is not listed");
	assert.ok(capped.includes("    … +3 more"));
	assert.ok(!drawLines(runningWith(many(SHOWN))).some((l) => l.includes("more")), "exactly the cap: nothing hidden");
});

test("result while running: subagent names and calls from child output cannot drive the terminal", () => {
	const out = drawLines(runningWith([live("evil\u001b[31mred", "running", { recentCalls: [{ name: "read", args: { path: "a\u001b]52;c;x\u0007.ts" } }] })])).join("\n");
	assert.doesNotMatch(out, /\u001b|\u0007/);
	assert.match(out, /evil/);
});

test("finished agents do not list subagents", () => {
	const out = draw(renderSubagentResult(result({ results: [taskView({ output: "done", subagents: [live("stale", "running")] })] }), { expanded: false, isPartial: false }, theme));
	assert.doesNotMatch(out, /stale|subagents/);
});

test("result failed: error and the skipped project agents", () => {
	const details = { results: [taskView({ status: "failed", ok: false, error: "boom", stopReason: "error", usage })], skippedProjectAgents: ["local-only"] };
	const out = draw(renderSubagentResult(result(details), { expanded: false, isPartial: false }, theme));
	assert.match(out, /✗ a \[error\]/);
	assert.match(out, /Error: boom/);
	assert.match(out, /project agents skipped \(project not trusted\): local-only/);
});

test("result expanded, one agent: header, task, full output and worktree", () => {
	const wt = { path: "/r/.claude/worktrees/a", branch: "dev-team/a", kept: true, dirty: false, commits: 1 };
	const details = { results: [taskView({ output: "first\nsecond", usage, worktree: wt, tier: "sonnet", source: "project" })] };
	const out = draw(renderSubagentResult(result(details), { expanded: true, isPartial: false }, theme));
	assert.match(out, /✓ a \(project\) \[sonnet\]/);
	assert.match(out, /Task: do x/);
	assert.match(out, /second/);
	assert.match(out, /worktree kept: \/r\/\.claude\/worktrees\/a on branch dev-team\/a, 1 commit\(s\)/);
});

test("result total includes what the agents dispatched themselves", () => {
	const nested = [{ agent: "Explore", usage }];
	const details = { results: [taskView({ usage, nested }), taskView({ agent: "b", usage })] };
	const out = draw(renderSubagentResult(result(details), { expanded: false, isPartial: false }, theme));
	assert.match(out, /Total: 6 turns ↑3\.6k ↓240 \$0\.0036/);
});

test("result expanded, several agents: totals across them", () => {
	const details = { results: [taskView({ usage }), taskView({ agent: "b", usage })] };
	const out = draw(renderSubagentResult(result(details), { expanded: true, isPartial: false }, theme));
	assert.match(out, /2\/2 succeeded/);
	assert.match(out, /Total: 4 turns ↑2\.4k ↓160 \$0\.0024/);
});

test("result from a stored session still shows skipped agents under the earlier key", () => {
	const details = { results: [taskView({})], untrustedProjectAgents: ["old-agent"] };
	assert.match(draw(renderSubagentResult(result(details), { expanded: false, isPartial: false }, theme)), /project agents skipped \(project not trusted\): old-agent/);
});

test("result without details falls back to the text content", () => {
	const out = draw(renderSubagentResult({ content: [{ type: "text", text: "legacy" }], details: undefined } as never, { expanded: false, isPartial: false }, theme));
	assert.match(out, /legacy/);
});

test("formatUsage: turns, tokens in k, cache, cost, duration and model", () => {
	assert.equal(formatUsage(usage, { model: "p/m", durationMs: 1500 }), "2 turns ↑1.2k ↓80 $0.0012 1.5s p/m");
	assert.equal(formatUsage({ input: 25_000, output: 999, cacheRead: 12_000, cacheWrite: 1, cost: 0, turns: 1 }), "1 turn ↑25k ↓999 R12k W1");
	assert.equal(formatUsage(undefined), "");
});

test("formatUsage: AI credits follow the cost when given", () => {
	assert.equal(formatUsage(usage, { aiCredits: 0.12 }), "2 turns ↑1.2k ↓80 $0.0012 (0.12 AI credits)");
});

test("formatUsage: no AI credits segment at 0", () => {
	assert.equal(formatUsage(usage, { model: "github-copilot/x", aiCredits: 0 }), "2 turns ↑1.2k ↓80 $0.0012 github-copilot/x");
});

// $0.0012 at 1 AI credit per $0.01 (GitHub's models-and-pricing page).
const COPILOT_USAGE_LINE = "$0.0012 (0.12 AI credits)";
const COPILOT = "github-copilot/claude-opus-5.5";

test("one agent on a Copilot model: AI credits on its usage line, collapsed and expanded", () => {
	const details = { results: [taskView({ model: COPILOT, usage })] };
	for (const expanded of [false, true]) {
		const out = draw(renderSubagentResult(result(details), { expanded, isPartial: false }, theme));
		assert.ok(out.includes(`${COPILOT_USAGE_LINE} ${COPILOT}`), `expanded=${expanded}`);
	}
});

test("one agent on another provider: no AI credits", () => {
	const out = draw(renderSubagentResult(result({ results: [taskView({ model: "anthropic/claude-opus-5-5", usage })] }), { expanded: false, isPartial: false }, theme));
	assert.doesNotMatch(out, /AI credits/);
});

test("parallel total: AI credits count only the Copilot runs, nested ones included", () => {
	const copilotUsd = 0.02;
	const nestedCopilotUsd = 0.01;
	const otherUsd = 1;
	const details = {
		results: [
			taskView({ agent: "a", model: "github-copilot/gpt-5-mini", usage: { ...usage, cost: copilotUsd } }),
			taskView({
				agent: "b",
				model: "anthropic/claude-haiku-4-5",
				usage: { ...usage, cost: otherUsd },
				nested: [{ agent: "Explore", model: "github-copilot/gpt-5-mini", usage: { ...usage, cost: nestedCopilotUsd } }],
			}),
		],
	};
	// Only the Copilot runs: $0.02 + $0.01 = 3 AI credits; the $1 run on another provider adds none.
	for (const expanded of [false, true]) {
		const out = draw(renderSubagentResult(result(details), { expanded, isPartial: false }, theme));
		assert.match(out, /Total: 6 turns ↑3\.6k ↓240 \$1\.0300 \(3\.00 AI credits\)/, `expanded=${expanded}`);
	}
});

test("parallel total without Copilot runs: no AI credits", () => {
	const details = { results: [taskView({ usage }), taskView({ agent: "b", usage })] };
	assert.doesNotMatch(draw(renderSubagentResult(result(details), { expanded: false, isPartial: false }, theme)), /AI credits/);
});

// Escape and control characters that must never reach the terminal (BEL, ESC, other C0, C1, CR).
const UNSAFE = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/;
const HOSTILE = "x\x1b[31m\x1b]52;c;ZXZpbA==\x07\x1b[2J\x1b]8;;https://x\x1b\\y\x1b]8;;\x1b\\\x9b31m\rFAKE\x00";


// Where each field is drawn, so the sanitizer checks cannot pass just because a field was left out.
const SHOWN: Record<string, string[]> = {
	agent: ["collapsed", "expanded"],
	task: ["expanded"],
	recentCalls: ["collapsed", "expanded"],
	tier: ["collapsed", "expanded"],
	model: ["collapsed", "expanded"],
	stopReason: ["collapsed", "expanded"],
	error: ["collapsed", "expanded"],
	output: ["collapsed", "expanded"],
	worktree: ["collapsed", "expanded"],
};

test("every child-derived field is sanitized before it is drawn", () => {
	const fields: [string, Partial<SubagentTaskView>][] = [
		["agent", { agent: HOSTILE }],
		["task", { task: HOSTILE }],
		["recentCalls", { status: "running", ok: false, recentCalls: [{ name: "bash", args: { command: HOSTILE } }] }],
		["tier", { tier: HOSTILE }],
		["model", { model: HOSTILE, usage }],
		["stopReason", { status: "failed", ok: false, stopReason: HOSTILE, error: "e" }],
		["error", { status: "failed", ok: false, error: HOSTILE }],
		["output", { output: HOSTILE }],
		["worktree", { worktree: { path: HOSTILE, branch: HOSTILE, kept: true, dirty: false, commits: 1 } }],
	];
	for (const [field, view] of fields) {
		for (const expanded of [false, true]) {
			const out = draw(renderSubagentResult(result({ results: [taskView(view)] }), { expanded, isPartial: false }, theme));
			const label = `${field} (${expanded ? "expanded" : "collapsed"})`;
			assert.doesNotMatch(out, UNSAFE, label);
			if (SHOWN[field]?.includes(expanded ? "expanded" : "collapsed")) assert.match(out, /FAKE/, `${label}: the field is drawn, sanitized`);
		}
	}
	const skipped = draw(renderSubagentResult(result({ results: [taskView({})], skippedProjectAgents: [HOSTILE] }), { expanded: false, isPartial: false }, theme));
	assert.doesNotMatch(skipped, UNSAFE, "skipped agent names");
	const call = draw(renderSubagentCall({ agent: HOSTILE, task: HOSTILE }, theme));
	assert.doesNotMatch(call, UNSAFE, "call args");
	const fallback = draw(renderSubagentResult({ content: [{ type: "text", text: HOSTILE }], details: undefined } as never, { expanded: false, isPartial: false }, theme));
	assert.doesNotMatch(fallback, UNSAFE, "text fallback");
	const running = taskView({ status: "running", ok: false });
	const labelled = draw(renderSubagentResult(result({ results: [running, running], label: HOSTILE }), { expanded: false, isPartial: true }, theme));
	assert.doesNotMatch(labelled, UNSAFE, "parallel label");
	assert.match(labelled, /FAKE/, "parallel label: drawn, sanitized");
});

const toolCallCases: [string, Parameters<typeof formatToolCall>[0], string][] = [
	["bash shows the command", { name: "bash", args: { command: "npm test" } }, "$ npm test"],
	["read shows the path", { name: "read", args: { path: "src/a.ts" } }, "read src/a.ts"],
	["edit shows file_path", { name: "edit", args: { file_path: "b.ts" } }, "edit b.ts"],
	["web_fetch shows the url", { name: "web_fetch", args: { url: "https://x.dev" } }, "web_fetch https://x.dev"],
	["grep shows pattern and path", { name: "grep", args: { pattern: "TODO", path: "src" } }, "grep /TODO/ in src"],
	["grep without a path searches .", { name: "grep", args: { pattern: "TODO" } }, "grep /TODO/ in ."],
	["find shows pattern", { name: "find", args: { pattern: "*.ts" } }, "find *.ts in ."],
	["bash without a command is just the name", { name: "bash" }, "bash"],
	["a dispatch names the agent", { name: "dev_team_subagent", args: { subagent_type: "Explore" } }, "dev-team Explore"],
	["a parallel dispatch counts agents", { name: "dev_team_subagent", args: { tasks: "2" } }, "dev-team 2 agents"],
	["other tools show their name", { name: "ask_user" }, "ask_user"],
];
for (const [title, call, expected] of toolCallCases) {
	test(`formatToolCall: ${title}`, () => assert.equal(formatToolCall(call), expected));
}

test("formatToolCall: long calls are cut to 80 characters with an ellipsis", () => {
	const shown = formatToolCall({ name: "bash", args: { command: "x".repeat(200) } });
	assert.equal(shown.length, 80);
	assert.ok(shown.startsWith("$ xxx") && shown.endsWith("…"));
});

test("recent calls from stored sessions (plain tool names) still render", () => {
	assert.deepEqual(recentCallLines({ tools: ["read", "grep"] } as never), ["read", "grep"]);
	assert.deepEqual(recentCallLines({ recentCalls: [{ name: "read", args: { path: "a" } }] } as never), ["read a"]);
});

// Live clocks: drawn against `now` while the dispatch runs (a partial result).
const T0 = 1_000_000;
const NOW = T0 + 65_000;
const drawLive = (r: ReturnType<typeof result>) =>
	draw(renderSubagentResult(r, { expanded: false, isPartial: true }, theme, undefined, NOW))
		.split("\n")
		.map((l) => l.trimEnd())
		.join("\n");

test("formatElapsed: seconds, then minutes and seconds, then hours and minutes", () => {
	assert.equal(formatElapsed(0), "0s");
	assert.equal(formatElapsed(59_999), "59s");
	assert.equal(formatElapsed(65_000), "1m 05s");
	assert.equal(formatElapsed(3_600_000 + 2 * 60_000), "1h 02m");
	assert.equal(formatElapsed(-5), "0s", "a clock never runs backwards");
});

test("live: a running agent shows how long it has run, and an executing call how long it runs", () => {
	const view = taskView({
		status: "running",
		ok: false,
		startedAt: T0,
		recentCalls: [{ name: "read", args: { path: "src/a.ts" } }, { name: "bash", args: { command: "npm test" }, startedAt: NOW - 38_000 }],
	});
	const out = drawLive(result({ results: [view] }));
	assert.match(out, /⏳ a · 1m 05s/);
	assert.match(out, /→ read src\/a\.ts/);
	assert.match(out, /▶ \$ npm test running 38s/);
	assert.doesNotMatch(out, /thinking/, "a call is executing, so the model is not");
});

test("live: with no call executing, the time the model has spent on its current step", () => {
	const view = taskView({ status: "running", ok: false, startedAt: T0, activeSince: NOW - 14_000, recentCalls: [{ name: "read", args: { path: "a" } }] });
	assert.match(drawLive(result({ results: [view] })), /→ read a\n {2}thinking… 14s/);
	const first = taskView({ status: "running", ok: false, startedAt: NOW - 3_000, recentCalls: [] });
	const out = drawLive(result({ results: [first] }));
	assert.match(out, /thinking… 3s/, "before its first turn, counted from its start");
	assert.doesNotMatch(out, /starting/);
});

test("live: an agent waiting for a slot shows its place in line, no clock", () => {
	const waiting = (n: number) => taskView({ agent: `w${n}`, status: "running", ok: false, queuePosition: n });
	const out = drawLive(result({ results: [waiting(1), waiting(2), waiting(3), waiting(11), waiting(22)] }));
	for (const place of ["1st", "2nd", "3rd", "11th", "22nd"]) assert.match(out, new RegExp(`waiting for a free agent slot \\(${place} in line\\)`));
	assert.match(out, /◌ w1\n/, "its own icon, and no elapsed time");
	assert.doesNotMatch(out, /⏳ w1/);
});

test("live: the parallel header shows the label, waiting agents, the clock and the spend so far", () => {
	const details: SubagentDetails = {
		startedAt: T0,
		label: "code-review round 2/4",
		results: [
			taskView({ agent: "naming-review", usage }),
			taskView({ agent: "security-review", status: "running", ok: false, startedAt: T0, usage: { ...usage, cost: 0.061 } }),
			taskView({ agent: "a11y-review", status: "running", ok: false, queuePosition: 1 }),
		],
	};
	const header = drawLive(result(details)).split("\n")[0];
	assert.equal(header, "⏳ parallel code-review round 2/4 · 1/3 done, 1 running, 1 waiting · 1m 05s · $0.0622 so far");
});

test("live: no waiting segment when every agent has a slot, no spend before any is known", () => {
	const header = drawLive(result({ startedAt: T0, results: [taskView({ status: "running", ok: false }), taskView({ agent: "b", status: "running", ok: false })] })).split("\n")[0];
	assert.equal(header, "⏳ parallel 0/2 done, 2 running · 1m 05s");
});

test("live: a stored or final result draws no live clocks", () => {
	const view = taskView({ status: "running", ok: false, startedAt: T0, recentCalls: [{ name: "bash", args: { command: "npm test" }, startedAt: T0 }] });
	const out = draw(renderSubagentResult(result({ startedAt: T0, results: [view, view] }), { expanded: false, isPartial: false }, theme, undefined, NOW));
	assert.doesNotMatch(out, /1m 05s|running \d|thinking/);
	assert.match(out, /→ \$ npm test/, "the call still shows, unmarked");
});

test("clock: a running dispatch redraws every second and stops when it finishes", () => {
	mock.timers.enable({ apis: ["setInterval", "Date"], now: T0 });
	try {
		let redraws = 0;
		const context = { invalidate: () => redraws++, state: {} };
		const running = result({ results: [taskView({ status: "running", ok: false })] });
		renderSubagentResult(running, { expanded: false, isPartial: true }, theme, context);
		renderSubagentResult(running, { expanded: false, isPartial: true }, theme, context);
		mock.timers.tick(3_000);
		assert.equal(redraws, 3, "one timer, however often the row is drawn");
		renderSubagentResult(result({ results: [taskView({})] }), { expanded: false, isPartial: false }, theme, context);
		mock.timers.tick(3_000);
		assert.equal(redraws, 3, "stopped by the final result");
	} finally {
		mock.timers.reset();
	}
});

test("clock: a row with no update for two hours stops; the next update starts it again", () => {
	mock.timers.enable({ apis: ["setInterval", "Date"], now: T0 });
	try {
		let redraws = 0;
		const context = { invalidate: () => redraws++, state: {} };
		const running = () => result({ results: [taskView({ status: "running", ok: false })] });
		renderSubagentResult(running(), { expanded: false, isPartial: true }, theme, context, T0);
		mock.timers.tick(2 * 60 * 60 * 1000 + 5_000);
		const stoppedAt = redraws;
		mock.timers.tick(10_000);
		assert.equal(redraws, stoppedAt, "stopped after the idle limit");
		renderSubagentResult(running(), { expanded: false, isPartial: true }, theme, context, Date.now());
		mock.timers.tick(2_000);
		assert.equal(redraws, stoppedAt + 2, "a new update restarts it");
	} finally {
		mock.timers.reset();
	}
});
