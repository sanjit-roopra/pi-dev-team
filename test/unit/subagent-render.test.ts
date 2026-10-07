import assert from "node:assert/strict";
import { test } from "node:test";
import { CLOCK_IDLE_LIMIT_MS, CLOCK_TICK_MS } from "../../extensions/dev-team/lib/live-clock.ts";
import { applyChildEvent, newChildRunState } from "../../extensions/dev-team/lib/child-run.ts";
import { DispatchProgress } from "../../extensions/dev-team/lib/subagent.ts";
import { formatElapsed, formatToolCall, formatUsage, recentCallLines, renderSubagentCall, renderSubagentResult } from "../../extensions/dev-team/lib/subagent-render.ts";
import { isWaitingForSlot, type LiveSubagentView, type SubagentDetails, type SubagentTaskView, type UsageTotals } from "../../extensions/dev-team/lib/subagent-types.ts";

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
	const runningTask = taskView({ status: "running", ok: false });
	const labelled = draw(renderSubagentResult(result({ results: [runningTask, runningTask], label: HOSTILE }), { expanded: false, isPartial: true }, theme));
	assert.doesNotMatch(labelled, UNSAFE, "parallel label");
	assert.match(labelled, /FAKE/, "parallel label: drawn, sanitized");
});

const drawPartial = (details: SubagentDetails) =>
	draw(renderSubagentResult(result(details), { expanded: false, isPartial: true }, theme))
		.split("\n")
		.map((l) => l.trimEnd());

test("a stored label cannot draw a line of its own", () => {
	const views = [taskView({ status: "running", ok: false }), taskView({ agent: "b", status: "running", ok: false })];
	const lines = drawPartial({ results: views, label: "x\n✓ parallel 2/2 succeeded" });
	assert.equal(lines.filter((l) => l.includes("parallel")).length, 1, "one header line");
	assert.ok(lines[0].startsWith("⏳ parallel x"));
});

test("a stored label that is not text is left out, the row still draws", () => {
	const views = [taskView({ status: "running", ok: false }), taskView({ agent: "b", status: "running", ok: false })];
	assert.equal(drawPartial({ results: views, label: 5 as never })[0], "⏳ parallel 0/2 done, 2 running");
});

test("a stored place in line that is not a whole number is not taken as one", () => {
	const lines = drawPartial({ results: [taskView({ status: "running", ok: false, queuePosition: HOSTILE as never }), taskView({ agent: "b" })] });
	assert.doesNotMatch(lines.join("\n"), UNSAFE);
	assert.ok(lines.includes("⏳ a"), "drawn as a running agent");
	assert.doesNotMatch(lines.join("\n"), /waiting/);
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
const runningView = (overrides: Partial<SubagentTaskView>) => taskView({ status: "running", ok: false, ...overrides });
/** The call rows of a drawn row, by their marks. */
const callRows = (out: string) => out.split("\n").filter((l) => l.startsWith("→ ") || l.startsWith("▶ "));
const bash = (command: string, runningSince?: number) => ({ name: "bash", args: { command }, ...(runningSince === undefined ? {} : { runningSince }) });

test("formatElapsed: seconds, then minutes and seconds, then hours and minutes", () => {
	for (const [ms, shown] of [
		[0, "0s"],
		[59_999, "59s"],
		[60_000, "1m 00s"],
		[65_000, "1m 05s"],
		[3_599_999, "59m 59s"],
		[3_600_000, "1h 00m"],
		[3_600_000 + 2 * 60_000, "1h 02m"],
		[-5, "0s"],
		[Number.NaN, "0s"],
	] as const) {
		assert.equal(formatElapsed(ms), shown, String(ms));
	}
});

test("live: a running agent shows how long it has run since it got its slot", () => {
	assert.match(drawLive(result({ results: [runningView({ slotGrantedAt: T0 })] })), /^⏳ a · 1m 05s$/m);
});

test("live: an executing call is marked with how long it has run, and the model is not thinking", () => {
	const view = runningView({ slotGrantedAt: T0, stepStartedAt: T0, recentCalls: [{ name: "read", args: { path: "src/a.ts" } }, bash("npm test", NOW - 38_000)] });
	const out = drawLive(result({ results: [view] }));
	assert.deepEqual(callRows(out), ["→ read src/a.ts", "▶ $ npm test running 38s"]);
	assert.doesNotMatch(out, /thinking/);
});

for (const [title, calls, rows] of [
	["an executing call stays in view behind newer finished calls", [bash("npm test", T0), bash("b"), bash("c"), bash("d")], ["▶ $ npm test running 1m 05s", "→ $ c", "→ $ d"]],
	["executing calls keep their order among finished ones", [bash("a", T0), bash("b"), bash("c", T0), bash("d"), bash("e")], ["▶ $ a running 1m 05s", "▶ $ c running 1m 05s", "→ $ e"]],
	["with more than 3 executing, the latest 3 show", [bash("a", T0), bash("b", T0), bash("c", T0), bash("d", T0)], ["▶ $ b running 1m 05s", "▶ $ c running 1m 05s", "▶ $ d running 1m 05s"]],
	["fewer than 3 calls all show", [bash("a"), bash("b")], ["→ $ a", "→ $ b"]],
] as const) {
	test(`live: ${title}`, () => assert.deepEqual(callRows(drawLive(result({ results: [runningView({ slotGrantedAt: T0, recentCalls: calls as never })] }))), rows));
}

test("live: calls from a stored session (plain tool names) show in a running row", () => {
	assert.deepEqual(callRows(drawLive(result({ results: [runningView({ recentCalls: undefined as never, tools: ["read", "grep"] })] }))), ["→ read", "→ grep"]);
});

test("live: with no call executing, thinking counts from the step's start", () => {
	const view = runningView({ slotGrantedAt: T0, stepStartedAt: NOW - 14_000, recentCalls: [{ name: "read", args: { path: "a" } }] });
	assert.match(drawLive(result({ results: [view] })), /^→ read a\n {2}thinking… 14s$/m);
});

test("live: before its first turn, thinking counts from the agent's start", () => {
	const out = drawLive(result({ results: [runningView({ slotGrantedAt: NOW - 3_000, stepStartedAt: NOW - 3_000 })] }));
	assert.match(out, /^ {2}thinking… 3s$/m);
	assert.doesNotMatch(out, /starting/);
});

test("live: after the final message no thinking clock runs while the agent ends", () => {
	const progress = new DispatchProgress([{ agent: "a", task: "t" }], [], undefined, { now: T0 });
	progress.update(0, { slotGrantedAt: T0, stepStartedAt: T0 });
	const final = applyChildEvent(newChildRunState(), { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "done" }] } } as never, T0 + 5);
	progress.update(0, final ?? {});
	assert.doesNotMatch(drawLive(result(progress.snapshot())), /thinking/);
});

test("live: stored times that are not real times show no clock", () => {
	for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, "x"]) {
		const out = drawLive(result({ results: [runningView({ slotGrantedAt: bad as never, stepStartedAt: bad as never, recentCalls: [bash("npm test", bad as never)] })] }));
		assert.match(out, /^⏳ a$/m, String(bad));
		assert.deepEqual(callRows(out), ["→ $ npm test"], String(bad));
		assert.doesNotMatch(out, /NaN|thinking/, String(bad));
	}
});

test("live: an agent waiting for a slot shows its place in line and no clock", () => {
	const waiting = (n: number) => runningView({ agent: `w${n}`, queuePosition: n, slotGrantedAt: T0, stepStartedAt: T0 });
	const out = drawLive(result({ results: [1, 2, 3, 11, 22].map(waiting) }));
	for (const place of ["1st", "2nd", "3rd", "11th", "22nd"]) assert.match(out, new RegExp(`waiting for a free agent slot \\(${place} in line\\)`), place);
	assert.match(out, /^◌ w1$/m, "its own icon, and no elapsed time although its times are set");
	assert.doesNotMatch(out, /thinking/);
});

test("live: a nested agent waiting for a slot says so", () => {
	const view = runningView({ agent: "orchestrator", subagents: [{ agent: "naming-review", status: "running", turns: 0, recentCalls: [], queuePosition: 1 }] });
	assert.match(drawLive(result({ results: [view] })), /^ {4}◌ naming-review waiting for a free agent slot \(1st in line\)$/m);
});

const SECURITY_COST = 0.061;
const header = (details: SubagentDetails) => drawLive(result(details)).split("\n")[0];
const reviewers = () => [taskView({ agent: "naming-review", usage }), runningView({ agent: "security-review", slotGrantedAt: T0, usage: { ...usage, cost: SECURITY_COST } }), runningView({ agent: "a11y-review", queuePosition: 1 })];

test("live header: done, running and waiting counts", () => {
	assert.match(header({ results: reviewers() }), /1\/3 done, 1 running, 1 waiting/);
});

test("live header: no waiting segment when every agent has a slot", () => {
	assert.match(header({ results: [runningView({}), runningView({ agent: "b" })] }), /0\/2 done, 2 running$/);
});

test("live header: every agent waiting", () => {
	assert.match(header({ results: [runningView({ queuePosition: 1 }), runningView({ agent: "b", queuePosition: 2 })] }), /0\/2 done, 0 running, 2 waiting$/);
});

test("live header: the call's label and the elapsed time", () => {
	assert.match(header({ dispatchStartedAt: T0, label: "code-review round 2/4", results: reviewers() }), /^⏳ parallel code-review round 2\/4 · 1\/3 done.* · 1m 05s/);
});

test("live header: the spend so far, only once there is some", () => {
	assert.match(header({ results: reviewers() }), new RegExp(`· \\$${(usage.cost + SECURITY_COST).toFixed(4)} so far$`));
	assert.doesNotMatch(header({ results: [runningView({}), runningView({ agent: "b" })] }), /so far/);
});

test("live header: the spend so far shows Copilot AI credits and what running agents dispatched", () => {
	const nested = [{ agent: "deep", model: "github-copilot/claude-haiku-4.5", usage: { ...usage, cost: 0.02 } }];
	const views = [runningView({ agent: "orchestrator", model: "github-copilot/claude-opus-5.5", usage, nested }), runningView({ agent: "b" })];
	assert.match(header({ results: views }), /· \$0\.0212 \(2\.12 AI credits\) so far$/);
});

test("live header: all of it in order", () => {
	assert.equal(header({ dispatchStartedAt: T0, label: "code-review round 2/4", results: reviewers() }), "⏳ parallel code-review round 2/4 · 1/3 done, 1 running, 1 waiting · 1m 05s · $0.0622 so far");
});

test("a stored or final result draws no live clocks", () => {
	const view = runningView({ slotGrantedAt: T0, stepStartedAt: T0, recentCalls: [bash("npm test", T0)] });
	const out = draw(renderSubagentResult(result({ dispatchStartedAt: T0, results: [view, view] }), { expanded: false, isPartial: false }, theme, undefined, NOW))
		.split("\n")
		.map((l) => l.trimEnd())
		.join("\n");
	assert.equal(out.split("\n")[0], "⏳ parallel 0/2 done, 2 running");
	assert.deepEqual(callRows(out), ["→ $ npm test", "→ $ npm test"], "no running time");
	assert.doesNotMatch(out, /thinking|1m 05s/);
});

function clockContext() {
	const context = { redraws: 0, invalidate: () => context.redraws++, state: {} };
	return context;
}

test("clock: a running dispatch redraws every second and stops when it finishes", (t) => {
	t.mock.timers.enable({ apis: ["setInterval", "Date"], now: T0 });
	const context = clockContext();
	const runningResult = result({ results: [runningView({})] });
	renderSubagentResult(runningResult, { expanded: false, isPartial: true }, theme, context);
	renderSubagentResult(runningResult, { expanded: false, isPartial: true }, theme, context);
	t.mock.timers.tick(3 * CLOCK_TICK_MS);
	assert.equal(context.redraws, 3, "one timer, however often the row is drawn");
	renderSubagentResult(result({ results: [taskView({})] }), { expanded: false, isPartial: false }, theme, context);
	t.mock.timers.tick(3 * CLOCK_TICK_MS);
	assert.equal(context.redraws, 3, "stopped by the final result");
});

test("clock: a partial result with no running agent stops it", (t) => {
	t.mock.timers.enable({ apis: ["setInterval", "Date"], now: T0 });
	const context = clockContext();
	renderSubagentResult(result({ results: [runningView({})] }), { expanded: false, isPartial: true }, theme, context);
	renderSubagentResult(result({ results: [taskView({})] }), { expanded: false, isPartial: true }, theme, context);
	t.mock.timers.tick(3 * CLOCK_TICK_MS);
	assert.equal(context.redraws, 0);
});

test("clock: without an update for the idle limit it stops; the next update starts it again", (t) => {
	t.mock.timers.enable({ apis: ["setInterval", "Date"], now: T0 });
	const context = clockContext();
	const update = () => result({ results: [runningView({})] });
	renderSubagentResult(update(), { expanded: false, isPartial: true }, theme, context, T0);
	const ticksToLimit = CLOCK_IDLE_LIMIT_MS / CLOCK_TICK_MS;
	t.mock.timers.tick(CLOCK_IDLE_LIMIT_MS);
	assert.equal(context.redraws, ticksToLimit, "redraws every second up to the limit");
	t.mock.timers.tick(10 * CLOCK_TICK_MS);
	assert.equal(context.redraws, ticksToLimit, "stopped just past it");
	renderSubagentResult(update(), { expanded: false, isPartial: true }, theme, context, Date.now());
	t.mock.timers.tick(2 * CLOCK_TICK_MS);
	assert.equal(context.redraws, ticksToLimit + 2, "a new update restarts it");
});

test("clock: an update before the idle limit keeps it going", (t) => {
	t.mock.timers.enable({ apis: ["setInterval", "Date"], now: T0 });
	const context = clockContext();
	const update = () => result({ results: [runningView({})] });
	renderSubagentResult(update(), { expanded: false, isPartial: true }, theme, context, T0);
	t.mock.timers.tick(CLOCK_IDLE_LIMIT_MS - CLOCK_TICK_MS);
	renderSubagentResult(update(), { expanded: false, isPartial: true }, theme, context, Date.now());
	const before = context.redraws;
	t.mock.timers.tick(10 * CLOCK_TICK_MS);
	assert.equal(context.redraws, before + 10);
});

test("clock: a redraw that throws stops the clock", (t) => {
	t.mock.timers.enable({ apis: ["setInterval", "Date"], now: T0 });
	let calls = 0;
	const context = {
		state: {},
		invalidate: () => {
			calls++;
			throw new Error("row is gone");
		},
	};
	renderSubagentResult(result({ results: [runningView({})] }), { expanded: false, isPartial: true }, theme, context);
	t.mock.timers.tick(5 * CLOCK_TICK_MS);
	assert.equal(calls, 1);
});

test("clock: a context without usable state starts nothing and does not throw", (t) => {
	t.mock.timers.enable({ apis: ["setInterval", "Date"], now: T0 });
	for (const state of [undefined, null, 5]) {
		let redraws = 0;
		renderSubagentResult(result({ results: [runningView({})] }), { expanded: false, isPartial: true }, theme, { state: state as never, invalidate: () => redraws++ });
		t.mock.timers.tick(2 * CLOCK_TICK_MS);
		assert.equal(redraws, 0, String(state));
	}
});

for (const [view, waiting] of [
	[{ status: "running", queuePosition: 1 }, true],
	[{ status: "running", queuePosition: 0 }, false],
	[{ status: "running", queuePosition: -1 }, false],
	[{ status: "running", queuePosition: 1.5 }, false],
	[{ status: "running", queuePosition: Number.NaN }, false],
	[{ status: "running", queuePosition: "2" }, false],
	[{ status: "ok", queuePosition: 2 }, false],
	[{ status: "running" }, false],
] as const) {
	test(`isWaitingForSlot: ${JSON.stringify(view)} → ${waiting}`, () => assert.equal(isWaitingForSlot(view as never), waiting));
}
