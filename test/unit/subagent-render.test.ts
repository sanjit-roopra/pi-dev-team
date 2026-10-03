import assert from "node:assert/strict";
import { test } from "node:test";
import { formatUsage, renderSubagentCall, renderSubagentResult, sanitizeTerminalText } from "../../extensions/dev-team/lib/subagent-render.ts";
import type { SubagentDetails, SubagentTaskView, UsageTotals } from "../../extensions/dev-team/lib/subagent-types.ts";

// A theme stub that returns text unchanged; the renderers only call fg() and bold().
const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text } as never;
const draw = (c: { render(width: number): string[] }) => c.render(120).join("\n");
const usage: UsageTotals = { input: 1200, output: 80, cacheRead: 0, cacheWrite: 0, cost: 0.0012, turns: 2 };

function taskView(overrides: Partial<SubagentTaskView>): SubagentTaskView {
	return { agent: "a", task: "do x", status: "ok", ok: true, turns: 1, tools: [], ...overrides };
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
	const details = { results: [taskView({ status: "running", ok: false, tools: ["read", "grep"] }), taskView({ agent: "b", output: "done", usage })] };
	const out = draw(renderSubagentResult(result(details), { expanded: false, isPartial: true }, theme));
	assert.match(out, /1\/2 done, 1 running/);
	assert.match(out, /→ grep/);
	assert.doesNotMatch(out, /Total:/);
});

test("result failed: error and the skipped project agents", () => {
	const details = { results: [taskView({ status: "failed", ok: false, error: "boom", stopReason: "error", usage })], untrustedProjectAgents: ["local-only"] };
	const out = draw(renderSubagentResult(result(details), { expanded: false, isPartial: false }, theme));
	assert.match(out, /✗ a \[error\]/);
	assert.match(out, /Error: boom/);
	assert.match(out, /project agents skipped \(project not trusted\): local-only/);
});

test("result expanded: task, output, worktree and parallel total", () => {
	const wt = { path: "/r/.claude/worktrees/a", branch: "dev-team/a", kept: true, dirty: false, commits: 1 };
	const details = { results: [taskView({ output: "first\nsecond", usage, worktree: wt, tier: "sonnet", source: "project" }), taskView({ agent: "b", usage })] };
	const out = draw(renderSubagentResult(result(details), { expanded: true, isPartial: false }, theme));
	assert.match(out, /✓ a \(project\) \[sonnet\]/);
	assert.match(out, /Task: do x/);
	assert.match(out, /second/);
	assert.match(out, /worktree kept: \/r\/\.claude\/worktrees\/a on branch dev-team\/a, 1 commit\(s\)/);
	assert.match(out, /Total: 4 turns ↑2\.4k ↓160 \$0\.0024/);
});

test("result without details falls back to the text content", () => {
	const out = draw(renderSubagentResult({ content: [{ type: "text", text: "legacy" }], details: undefined } as never, { expanded: false, isPartial: false }, theme));
	assert.match(out, /legacy/);
});

test("formatUsage", () => {
	assert.equal(formatUsage(usage, "p/m", 1500), "2 turns ↑1.2k ↓80 $0.0012 1.5s p/m");
	assert.equal(formatUsage({ input: 25_000, output: 999, cacheRead: 12_000, cacheWrite: 1, cost: 0, turns: 1 }), "1 turn ↑25k ↓999 R12k W1");
	assert.equal(formatUsage(undefined), "");
});

test("child text cannot drive the terminal", () => {
	const hostile = "ok\x1b]52;c;ZXZpbA==\x07 \x1b[2J\x1b]8;;https://x\x1b\\link\x1b]8;;\x1b\\ \x07\x00done";
	assert.equal(sanitizeTerminalText(hostile), "ok link done");
	const details = { results: [taskView({ agent: "a\x1b[31m", output: hostile, error: undefined })] };
	const out = draw(renderSubagentResult(result(details), { expanded: true, isPartial: false }, theme));
	assert.doesNotMatch(out, /\x1b\]52|\x1b\[2J|\x07/);
	const failed = { results: [taskView({ status: "failed", ok: false, error: `stderr ${hostile}` })] };
	assert.doesNotMatch(draw(renderSubagentResult(result(failed), { expanded: false, isPartial: false }, theme)), /\x1b\]52/);
});
