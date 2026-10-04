import assert from "node:assert/strict";
import { test } from "node:test";
import { formatToolCall, formatUsage, recentCallLines, renderSubagentCall, renderSubagentResult, sanitizeTerminalText } from "../../extensions/dev-team/lib/subagent-render.ts";
import type { SubagentDetails, SubagentTaskView, UsageTotals } from "../../extensions/dev-team/lib/subagent-types.ts";

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

test("sanitizeTerminalText removes escape sequences and controls, keeps tab and newline", () => {
	assert.equal(sanitizeTerminalText(HOSTILE), "xy31m\nFAKE");
	assert.equal(sanitizeTerminalText("a\tb\nc\r\nd"), "a\tb\nc\nd");
	assert.equal(sanitizeTerminalText("a\ufff9b\ufffbc"), "abc");
});

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
