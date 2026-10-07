import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { type TestContext, test } from "node:test";
import { discoverDispatchAgents, parseAgentFile, projectAgentsRequested } from "../../extensions/dev-team/lib/agents.ts";
import { applyChildEvent, newChildRunState, summarizeToolCall } from "../../extensions/dev-team/lib/child-run.ts";
import { HookBridge } from "../../extensions/dev-team/lib/hooks.ts";
import { DEFAULT_CONFIG } from "../../extensions/dev-team/lib/config.ts";
import { acquireSlot, Semaphore } from "../../extensions/dev-team/lib/semaphore.ts";
import { DispatchProgress, dispatchLabel, formatResultText, outputForModel, outputForView, type SubagentRunResult, viewFromResult } from "../../extensions/dev-team/lib/subagent.ts";
import { addPiUsage, creditedRuns, describeWorktree, emptyPiUsage, sumPiUsage, toUsageTotals, type UsageTotals } from "../../extensions/dev-team/lib/subagent-types.ts";
import { type ChildTrust, canonicalDir, childTrusted, childTrustOf, shimTrustEnv, trustArgs } from "../../extensions/dev-team/lib/trust.ts";

const ROOT = path.resolve(import.meta.dirname, "..", "..");

function tempDir(t: TestContext, prefix: string): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	return dir;
}

function seedProjectAgents(dir: string): void {
	const agentDir = path.join(dir, ".claude", "agents");
	fs.mkdirSync(agentDir, { recursive: true });
	const md = (name: string) => `---\nname: ${name}\ndescription: d\n---\nbody\n`;
	fs.writeFileSync(path.join(agentDir, "security-review.md"), md("security-review"));
	fs.writeFileSync(path.join(agentDir, "local-only.md"), md("local-only"));
}

test("trusted project: dispatch sees project agents and their overrides", (t) => {
	const dir = tempDir(t, "dt-agents-");
	seedProjectAgents(dir);
	const { agents, skippedProjectAgents } = discoverDispatchAgents(dir, ROOT, true, ["local-only", "security-review"]);
	assert.equal(agents.get("security-review")?.source, "project");
	assert.equal(agents.has("local-only"), true);
	assert.deepEqual(skippedProjectAgents, []);
});

test("untrusted project: package agents only, requested project agents reported", (t) => {
	const dir = tempDir(t, "dt-agents-");
	seedProjectAgents(dir);
	const { agents, skippedProjectAgents } = discoverDispatchAgents(dir, ROOT, false, ["dev-team:security-review", "local-only", "test-review", ""]);
	assert.equal(agents.get("security-review")?.source, "package");
	assert.equal(agents.has("local-only"), false);
	assert.deepEqual(skippedProjectAgents.sort(), ["local-only", "security-review"]);
});

test("projectAgentsRequested names each project agent once, however it was requested", (t) => {
	const dir = tempDir(t, "dt-agents-");
	seedProjectAgents(dir);
	const all = discoverDispatchAgents(dir, ROOT, true, []).agents;
	assert.deepEqual(projectAgentsRequested(all, ["local-only", "dev-team:local-only", "LOCAL-ONLY", "test-review"]).map((d) => d.name), ["local-only"]);
});

const trusted: ChildTrust = { projectTrusted: true, sessionDir: "/repo" };
const declined: ChildTrust = { projectTrusted: false, sessionDir: "/repo" };

test("child trust: declined is always forwarded", () => {
	assert.deepEqual(trustArgs(declined, "/repo"), ["--no-approve"]);
	assert.deepEqual(trustArgs(declined, "/elsewhere"), ["--no-approve"]);
});

test("child trust: granted covers exactly the session directory", () => {
	assert.deepEqual(trustArgs(trusted, "/repo"), ["--approve"]);
	assert.deepEqual(trustArgs(trusted, "/repo/sub"), [], "pi decides trust per directory");
	assert.deepEqual(trustArgs(trusted, "/repo-sibling"), []);
	assert.deepEqual(trustArgs(trusted, "/repo/../x"), []);
});

test("child trust: a worktree inherits only when it was made from the session directory", () => {
	assert.deepEqual(trustArgs(trusted, "/repo/.claude/worktrees/x", "/repo"), ["--approve"]);
	assert.deepEqual(trustArgs({ projectTrusted: true, sessionDir: "/repo/sub" }, "/repo/.claude/worktrees/x", "/repo"), []);
});

test("childTrusted: only the session directory or its own worktree, and only when trusted", () => {
	const cases: [ChildTrust, string, string | undefined, boolean][] = [
		[declined, "/repo", undefined, false],
		[trusted, "/repo", undefined, true],
		[trusted, "/repo/sub", undefined, false],
		[trusted, "/repo-sibling", undefined, false],
		[trusted, "/repo/.claude/worktrees/x", "/repo", true],
		[{ projectTrusted: true, sessionDir: "/repo/sub" }, "/repo/.claude/worktrees/x", "/repo", false],
	];
	for (const [trust, cwd, wt, expected] of cases) {
		const label = `${cwd} (worktree of ${wt ?? "none"}, trusted ${trust.projectTrusted})`;
		assert.equal(childTrusted(trust, cwd, wt), expected, label);
		assert.equal(trustArgs(trust, cwd, wt).includes("--approve"), expected, `trustArgs agrees: ${label}`);
	}
});

test("child trust: a symlink to another directory is that directory", (t) => {
	const dir = tempDir(t, "dt-trust-");
	const repo = path.join(dir, "repo");
	const other = path.join(dir, "other");
	fs.mkdirSync(repo);
	fs.mkdirSync(other);
	fs.symlinkSync(other, path.join(repo, "link"));
	fs.symlinkSync(repo, path.join(dir, "repo-link"));
	const session: ChildTrust = { projectTrusted: true, sessionDir: canonicalDir(repo) };
	assert.deepEqual(trustArgs(session, path.join(repo, "link")), []);
	assert.deepEqual(trustArgs(session, path.join(dir, "repo-link")), ["--approve"], "a link to the session directory is the session directory");
});

test("childTrustOf: the session's decision for its canonical directory", (t) => {
	const dir = tempDir(t, "dt-trust-");
	fs.symlinkSync(dir, `${dir}-link`);
	t.after(() => fs.rmSync(`${dir}-link`, { force: true }));
	assert.deepEqual(childTrustOf({ cwd: `${dir}-link`, isProjectTrusted: () => true }), { projectTrusted: true, sessionDir: fs.realpathSync(dir) });
	assert.equal(childTrustOf({ cwd: dir, isProjectTrusted: () => false }).projectTrusted, false);
});

test("claude shim trust env: root only when trusted, --no-approve only when declined", () => {
	assert.deepEqual(shimTrustEnv(trusted, ["-e", "x"]), { piArgs: ["-e", "x"], trustedDir: "/repo" });
	assert.deepEqual(shimTrustEnv(declined, ["-e", "x"]), { piArgs: ["-e", "x", "--no-approve"] });
});

test("agent files that are not small regular files are skipped unread", (t) => {
	const dir = tempDir(t, "dt-agentfile-");
	fs.mkdirSync(path.join(dir, "dir.md"));
	assert.equal(parseAgentFile(path.join(dir, "dir.md"), "project"), undefined);
	const big = path.join(dir, "big.md");
	fs.writeFileSync(big, `---\nname: big\ndescription: d\n---\n${"x".repeat(1024 * 1024)}`);
	assert.equal(parseAgentFile(big, "project"), undefined);
});

test("creditedRuns: own run first, then nested runs; either may be absent", () => {
	const u = { input: 1, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1 };
	const nested = [{ agent: "n", usage: u }];
	assert.deepEqual(creditedRuns({ agent: "a", model: "m", usage: u, nested }), [{ agent: "a", model: "m", usage: u }, ...nested]);
	assert.deepEqual(creditedRuns({ agent: "a", usage: u }), [{ agent: "a", model: undefined, usage: u }]);
	assert.deepEqual(creditedRuns({ agent: "a", nested }), nested);
	assert.deepEqual(creditedRuns({ agent: "a" }), []);
});

test("addPiUsage derives totalTokens when a message omits it", () => {
	const u = emptyPiUsage();
	addPiUsage(u, { input: 10, output: 1 });
	assert.equal(u.totalTokens, 11);
	assert.equal(u.cost.total, 0);
});

test("addPiUsage keeps the optional token splits", () => {
	const u = emptyPiUsage();
	addPiUsage(u, { input: 1, cacheWrite1h: 5, reasoning: 3 });
	addPiUsage(u, { input: 1, reasoning: 2 });
	assert.equal(u.cacheWrite1h, 5);
	assert.equal(u.reasoning, 5);
});

const turnUsage = { input: 100, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 110, cost: { input: 0.1, output: 0.01, cacheRead: 0, cacheWrite: 0, total: 0.11 } };

test("child events: assistant turns count as the child's own usage and progress", () => {
	const state = newChildRunState("p/m");
	const patch = applyChildEvent(state, { type: "message_end", message: { role: "assistant", content: [{ type: "toolCall", name: "read", arguments: { path: "src/a.ts" } }], usage: turnUsage, model: "m2", provider: "p" } as never });
	assert.equal(state.turns, 1);
	assert.equal(state.own.input, 100);
	assert.equal(state.total.input, 100);
	assert.deepEqual(patch?.recentCalls, [{ name: "read", args: { path: "src/a.ts" } }], "the call and its key argument");
	assert.equal(patch?.model, "p/m2");
	assert.equal(applyChildEvent(state, { type: "message_start", message: { role: "assistant" } as never }), undefined);
});

test("child events: a nested dev-team dispatch is credited to the agents it ran", () => {
	const state = newChildRunState();
	const nestedView = { agent: "Explore", task: "t", status: "ok", ok: true, turns: 1, recentCalls: [], model: "p/haiku", usage: { input: 40, output: 4, cacheRead: 0, cacheWrite: 0, cost: 0.04, turns: 1 }, nested: [{ agent: "deep", model: "p/x", usage: { input: 60, output: 6, cacheRead: 0, cacheWrite: 0, cost: 0.06, turns: 1 } }] };
	applyChildEvent(state, { type: "message_end", message: { role: "toolResult", toolName: "dev_team_subagent", usage: turnUsage, details: { results: [nestedView] } } as never });
	assert.equal(state.own.input, 0, "not the child's own spend");
	assert.equal(state.total.input, 100, "still in the total pi counts");
	assert.deepEqual(state.nested.map((n) => [n.agent, n.model, n.usage.input]), [["Explore", "p/haiku", 40], ["deep", "p/x", 60]]);
});

test("child events: a failing turn records the stop reason and error", () => {
	const state = newChildRunState();
	applyChildEvent(state, { type: "message_end", message: { role: "assistant", content: [], stopReason: "error", errorMessage: "No API key" } as never });
	assert.equal(state.stopReason, "error");
	assert.equal(state.errorMessage, "No API key");
});

test("child events: only the latest 8 tool calls are kept, nameless ones skipped", () => {
	const state = newChildRunState();
	const calls = Array.from({ length: 10 }, (_, i) => ({ type: "toolCall", name: `t${i}` }));
	applyChildEvent(state, { type: "message_end", message: { role: "assistant", content: [...calls, { type: "toolCall" }] } as never });
	assert.deepEqual(state.recentCalls.map((c) => c.name), ["t2", "t3", "t4", "t5", "t6", "t7", "t8", "t9"]);
});

test("child events: a model without a provider is shown as is", () => {
	const state = newChildRunState("p/initial");
	applyChildEvent(state, { type: "message_end", message: { role: "assistant", content: [], model: "bare" } as never });
	assert.equal(state.model, "bare");
});

test("child events: a dev-team dispatch result without agent details stays with the child", () => {
	const state = newChildRunState();
	applyChildEvent(state, { type: "message_end", message: { role: "toolResult", toolName: "dev_team_subagent", usage: turnUsage, details: {} } as never });
	assert.equal(state.own.input, 100);
	assert.deepEqual(state.nested, []);
});

test("child events: other event types change nothing", () => {
	const state = newChildRunState();
	assert.equal(applyChildEvent(state, { type: "message_update", message: { role: "assistant", usage: turnUsage } as never }), undefined);
	assert.equal(applyChildEvent(state, { type: "tool_execution_end" }), undefined);
	assert.equal(state.turns, 0);
	assert.equal(state.total.input, 0);
});

const reviewer = (agent: string, status: string, extra: Record<string, unknown> = {}) => ({ agent, task: "long task text", status, ok: status === "ok", turns: 3, recentCalls: [{ name: "ls" }, { name: "read", args: { path: "a.ts" } }], output: "big output", model: "p/m", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 3 }, ...extra });
const dispatchUpdate = (toolCallId: string, results: unknown[], toolName = "dev_team_subagent") => ({ type: "tool_execution_update", toolCallId, toolName, partialResult: { details: { results } } });
const dispatchEnd = (toolCallId: string) => ({ type: "tool_execution_end", toolCallId, toolName: "dev_team_subagent" });

test("child events: a running dev-team call streams its agents, cut down to what the view draws at every level", () => {
	const state = newChildRunState();
	const patch = applyChildEvent(state, dispatchUpdate("c1", [reviewer("security-review", "running", { subagents: [reviewer("deep", "running")] }), reviewer("naming-review", "ok")]));
	const latestOnly = [{ name: "read", args: { path: "a.ts" } }];
	assert.deepEqual(patch?.subagents, [
		{ agent: "security-review", status: "running", turns: 3, recentCalls: latestOnly, subagents: [{ agent: "deep", status: "running", turns: 3, recentCalls: latestOnly }] },
		{ agent: "naming-review", status: "ok", turns: 3, recentCalls: latestOnly },
	]);
	assert.equal(state.turns, 0, "progress is not a turn");
});

test("child events: two open dev-team calls show together; ending one leaves the other", () => {
	const state = newChildRunState();
	applyChildEvent(state, dispatchUpdate("c1", [reviewer("a", "running")]));
	applyChildEvent(state, dispatchUpdate("c2", [reviewer("b", "running")]));
	assert.deepEqual(applyChildEvent(state, dispatchUpdate("c1", [reviewer("a", "ok")]))?.subagents?.map((v) => [v.agent, v.status]), [["a", "ok"], ["b", "running"]]);
	assert.deepEqual(applyChildEvent(state, dispatchEnd("c1"))?.subagents?.map((v) => v.agent), ["b"]);
	const last = applyChildEvent(state, dispatchEnd("c2"));
	assert.ok(last && "subagents" in last && last.subagents === undefined, "cleared once no call is open");
	assert.equal(state.openDevTeamCalls.size, 0);
});

for (const [title, ev] of [
	["progress of another tool", dispatchUpdate("c1", [reviewer("a", "running")], "bash")],
	["a dev-team update without agent details", { type: "tool_execution_update", toolCallId: "c1", toolName: "dev_team_subagent", partialResult: {} }],
	["a dev-team update without a tool call id", { ...dispatchUpdate("c1", [reviewer("a", "running")]), toolCallId: undefined }],
	["the end of a dev-team call that was never open", dispatchEnd("never-opened")],
] as const) {
	test(`child events: ${title} changes nothing`, () => {
		const state = newChildRunState();
		assert.equal(applyChildEvent(state, ev as never), undefined, "no patch");
		assert.equal(state.openDevTeamCalls.size, 0, "no open call recorded");
	});
}

test("child events: malformed agent entries from a child are dropped or made safe, never thrown on", () => {
	const state = newChildRunState();
	let deep: Record<string, unknown> = reviewer("bottom", "running");
	for (let i = 0; i < 1000; i++) deep = reviewer(`level${i}`, "running", { subagents: [deep] });
	const entries = [null, 5, "x", [], { agent: 1, status: "running" }, { agent: "bad-status", status: "weird" }, reviewer("odd", "running", { turns: "\u001b]52;c;x\u0007", recentCalls: [null] }), reviewer("hostile-call", "running", { recentCalls: [{ name: "read", args: { path: { toString: 1 } } }] }), deep];
	const patch = applyChildEvent(state, dispatchUpdate("c1", entries));
	assert.deepEqual(patch?.subagents?.slice(0, 2), [
		{ agent: "odd", status: "running", turns: 0, recentCalls: [] },
		{ agent: "hostile-call", status: "running", turns: 3, recentCalls: [{ name: "read" }] },
	]);
	let levels = 0;
	for (let v = patch?.subagents?.[2]; v; v = v.subagents?.[0]) levels++;
	assert.equal(levels, 4, "deeper levels are dropped");
});

test("child events: usage on other tool results stays with the child", () => {
	const state = newChildRunState();
	applyChildEvent(state, { type: "message_end", message: { role: "toolResult", toolName: "subagent", usage: turnUsage } as never });
	assert.equal(state.own.input, 100);
	assert.equal(state.total.input, 100);
	assert.deepEqual(state.nested, []);
});

test("sumPiUsage: undefined without any usage, otherwise the sum of all children", () => {
	assert.equal(sumPiUsage([undefined, undefined]), undefined);
	const child = emptyPiUsage();
	addPiUsage(child, { input: 1000, output: 100, totalTokens: 1100, cost: { input: 0.001, output: 0.0002, cacheRead: 0, cacheWrite: 0, total: 0.0012 } });
	const total = sumPiUsage([child, undefined, child]);
	assert.equal(total?.input, 2000);
	assert.equal(total?.totalTokens, 2200);
	assert.ok(Math.abs((total?.cost.total ?? 0) - 0.0024) < 1e-12);
	assert.equal(child.input, 1000, "children are not modified");
});

test("toUsageTotals projects pi usage onto the cost-meter shape", () => {
	const u = emptyPiUsage();
	addPiUsage(u, { input: 5, output: 2, cacheRead: 3, cacheWrite: 1, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.5 } });
	assert.deepEqual(toUsageTotals(u, 4), { input: 5, output: 2, cacheRead: 3, cacheWrite: 1, cost: 0.5, turns: 4 });
});

test("describeWorktree: a kept worktree lists path, branch, commits and uncommitted changes", () => {
	assert.equal(describeWorktree({ path: "/r/.claude/worktrees/a", branch: "dev-team/a", kept: true, dirty: true, commits: 2 }), "kept: /r/.claude/worktrees/a on branch dev-team/a, 2 commit(s), uncommitted changes");
});

test("describeWorktree: a removed worktree says there were no changes", () => {
	assert.equal(describeWorktree({ path: "/p", branch: "b", kept: false, dirty: false, commits: 0 }), "removed: no changes");
});

test("SessionStart matchers are applied to the session source", (t) => {
	// Synthetic wiring, so the semantics do not depend on upstream hook names.
	const root = tempDir(t, "dt-hooks-");
	fs.mkdirSync(path.join(root, "hooks"));
	const group = (matcher: string | undefined, script: string) => ({ ...(matcher ? { matcher } : {}), hooks: [{ type: "command", command: `python3 hooks/${script}` }] });
	fs.writeFileSync(
		path.join(root, "hooks", "hooks.json"),
		JSON.stringify({ hooks: { SessionStart: [group(undefined, "always.py"), group("startup|resume|clear", "fresh.py"), group("compact", "after_compact.py")] } }),
	);
	const bridge = new HookBridge(root, () => DEFAULT_CONFIG);
	if (!bridge.python) return t.skip("python >= 3.10 not found");
	const names = (source: string) => bridge.select("SessionStart", source).map((s) => s.name).sort();
	assert.deepEqual(names("startup"), ["always", "fresh"]);
	assert.deepEqual(names("clear"), ["always", "fresh"]);
	assert.deepEqual(names("compact"), ["after_compact", "always"]);
});

test("shipped hooks.json wires the v14 SessionStart hooks to the right sources", (t) => {
	const bridge = new HookBridge(ROOT, () => DEFAULT_CONFIG);
	if (!bridge.python) return t.skip("python >= 3.10 not found");
	const names = (source: string) => bridge.select("SessionStart", source).map((s) => s.name);
	assert.ok(names("startup").includes("autocompact_setup_nudge"));
	assert.ok(!names("startup").includes("post_compact_state_reinject"));
	assert.ok(names("compact").includes("post_compact_state_reinject"));
	assert.ok(!names("compact").includes("autocompact_setup_nudge"));
});

function runResult(overrides: Partial<SubagentRunResult>): SubagentRunResult {
	return { agent: "a", task: "t", ok: true, output: "out", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1 }, nested: [], messages: [], durationMs: 5, ...overrides };
}

test("result text: one agent returns its output, or the failure", () => {
	assert.equal(formatResultText([runResult({})], []), "out");
	assert.equal(formatResultText([runResult({ ok: false, error: "boom", output: "" })], []), "Agent a failed: boom");
	const wt = { path: "/r/w", branch: "b", kept: false, dirty: false, commits: 0 };
	assert.equal(formatResultText([runResult({ worktree: wt })], []), "out\n\n[worktree removed: no changes]");
});

test("result text: several agents get a summary line and one section each", () => {
	const text = formatResultText([runResult({ agent: "a", model: "p/m", tier: "sonnet" }), runResult({ agent: "b", ok: false, error: "boom", output: "partial" })], []);
	assert.match(text, /^1\/2 agents succeeded/);
	assert.match(text, /### a — completed \(p\/m, tier sonnet\)/);
	assert.match(text, /### b — failed\n\nError: boom\n\nLast output:\npartial/);
});

test("result text: tells the model which project agents were skipped", () => {
	assert.match(formatResultText([runResult({})], ["local-only"]), /\[project agents not run \(project not trusted\): local-only\./);
});

type Emitted = { text: string; details: { results: { status: string; ok: boolean; turns: number; recentCalls: { name: string }[] }[]; skippedProjectAgents?: string[] } };

function recordedProgress(skipped: string[] = []) {
	const updates: Emitted[] = [];
	const progress = new DispatchProgress([{ agent: "a", task: "t" }, { subagent_type: "b", prompt: "u" }], skipped, (r) => updates.push({ text: r.content[0].text, details: r.details }));
	return { progress, updates };
}

test("progress: the initial state is emitted, with skipped project agents", () => {
	const { updates } = recordedProgress(["local-only"]);
	assert.equal(updates.length, 1);
	assert.equal(updates[0].text, "a: turn 0\nb: turn 0");
	assert.deepEqual(updates[0].details.skippedProjectAgents, ["local-only"]);
});

test("progress: an update streams the turn and the latest tool calls", () => {
	const { progress, updates } = recordedProgress();
	progress.update(0, { turns: 2, recentCalls: [{ name: "read" }, { name: "bash", args: { command: "npm test" } }, { name: "find" }, { name: "ls" }] });
	assert.equal(updates.at(-1)?.text, "a: turn 2 → $ npm test, find, ls\nb: turn 0");
});

test("progress: finish drops the live subagents", () => {
	const { progress, updates } = recordedProgress();
	const shown = () => updates.at(-1)?.details.results[0] as { subagents?: unknown };
	progress.update(0, { subagents: [{ agent: "x", status: "running", turns: 1, recentCalls: [] }] });
	assert.ok(shown().subagents, "live subagents are streamed while the agent runs");
	progress.finish(0, runResult({ agent: "a" }));
	assert.equal(shown().subagents, undefined, "finish drops them");
});

test("progress: finish sets status and ok from the result", () => {
	const { progress, updates } = recordedProgress();
	progress.finish(1, runResult({ agent: "b" }));
	const view = updates.at(-1)?.details.results[1];
	assert.equal(view?.status, "ok");
	assert.equal(view?.ok, true);
});

test("progress: snapshots are copies", () => {
	const { progress } = recordedProgress();
	progress.snapshot().results[0].recentCalls.push({ name: "mutated" });
	assert.ok(!progress.snapshot().results[0].recentCalls.some((c) => c.name === "mutated"));
});

test("viewFromResult: a failed run is status failed, ok false", () => {
	const view = viewFromResult(runResult({ ok: false, error: "e" }));
	assert.equal(view.status, "failed");
	assert.equal(view.ok, false);
});

test("viewFromResult: a successful run is status ok, ok true", () => {
	const view = viewFromResult(runResult({}));
	assert.equal(view.status, "ok");
	assert.equal(view.ok, true);
});

test("viewFromResult carries nested runs only when there are some", () => {
	const nested = [{ agent: "x", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1 } satisfies UsageTotals }];
	assert.deepEqual(viewFromResult(runResult({ nested })).nested, nested);
	assert.equal(viewFromResult(runResult({})).nested, undefined);
});

test("a tool call keeps only the arguments the view shows, one line and bounded", () => {
	assert.deepEqual(summarizeToolCall("write", { path: "a.ts", content: "x".repeat(10_000) }), { name: "write", args: { path: "a.ts" } });
	assert.deepEqual(summarizeToolCall("grep", { pattern: "a\nb", path: "src" }), { name: "grep", args: { pattern: "a b", path: "src" } });
	assert.equal(summarizeToolCall("bash", { command: "x".repeat(500) }).args?.command.length, 200);
	assert.deepEqual(summarizeToolCall("dev_team_subagent", { tasks: [{}, {}] }), { name: "dev_team_subagent", args: { tasks: "2" } });
	assert.deepEqual(summarizeToolCall("ask_user", null), { name: "ask_user" });
});

const OUTPUT_CAP = 50 * 1024;
const big = "y".repeat(OUTPUT_CAP + 1);

test("output at the cap is returned whole; one byte over is cut", () => {
	const atCap = "y".repeat(OUTPUT_CAP);
	assert.equal(outputForModel(atCap), atCap);
	assert.ok(outputForModel(big).startsWith("y".repeat(OUTPUT_CAP)));
	assert.ok(outputForModel(big).endsWith(`[output truncated at ${OUTPUT_CAP} bytes]`));
});

test("the model is told where the complete output is", () => {
	assert.ok(outputForModel(big, "/tmp/x.md").endsWith(`[output truncated at ${OUTPUT_CAP} bytes; the complete output is in /tmp/x.md (read it with offset/limit)]`));
});

test("the TUI names the file without the model's read instruction", () => {
	const shown = outputForView(big, "/tmp/x.md");
	assert.ok(shown.endsWith(`[output truncated at ${OUTPUT_CAP} bytes; complete output: /tmp/x.md]`));
	assert.ok(!shown.includes("offset/limit"));
});

test("multibyte output is cut by bytes, on a character boundary", () => {
	// "€" is 3 bytes and the cap is not a multiple of 3, so the byte cut lands inside a character.
	assert.notEqual(OUTPUT_CAP % 3, 0);
	const shown = outputForModel("€".repeat(20_000));
	const body = shown.slice(0, shown.lastIndexOf("\n\n[output truncated"));
	assert.equal(body, "€".repeat(Math.floor(OUTPUT_CAP / 3)));
});

test("result text and view carry the saved file for single and parallel results", () => {
	const file = "/tmp/full.md";
	const oversized = runResult({ output: big, fullOutputFile: file });
	assert.match(formatResultText([oversized], []), /complete output is in \/tmp\/full\.md/);
	assert.match(formatResultText([oversized, runResult({ agent: "b" })], []), /complete output is in \/tmp\/full\.md/);
	assert.match(formatResultText([runResult({ ok: false, error: "e", output: big, fullOutputFile: file }), runResult({ agent: "b" })], []), /Last output:[\s\S]*complete output is in \/tmp\/full\.md/);
	assert.match(viewFromResult(oversized).output ?? "", /complete output: \/tmp\/full\.md/);
});

const callMessage = (calls: { id?: string; command: string }[]) =>
	({ type: "message_end", message: { role: "assistant", content: calls.map((c) => ({ type: "toolCall", id: c.id, name: "bash", arguments: { command: c.command } })) } }) as never;
const execution = (type: "tool_execution_start" | "tool_execution_end", toolCallId: string, toolName = "bash") => ({ type, toolCallId, toolName });
const npmTest = { name: "bash", args: { command: "npm test" } };

test("child events: a message with calls starts the model's step", () => {
	const state = newChildRunState();
	assert.equal(applyChildEvent(state, callMessage([{ id: "t1", command: "npm test" }]), 1_000)?.stepStartedAt, 1_000);
});

test("child events: an executing call is marked with when it started", () => {
	const state = newChildRunState();
	applyChildEvent(state, callMessage([{ id: "t1", command: "npm test" }]), 1_000);
	const started = applyChildEvent(state, execution("tool_execution_start", "t1"), 2_000);
	assert.deepEqual(started?.recentCalls, [{ ...npmTest, runningSince: 2_000 }]);
	assert.ok(started && !("stepStartedAt" in started), "a call runs, so no model step starts");
});

test("child events: when the last call ends its mark goes and the model's step starts", () => {
	const state = newChildRunState();
	applyChildEvent(state, callMessage([{ id: "t1", command: "npm test" }]), 1_000);
	applyChildEvent(state, execution("tool_execution_start", "t1"), 2_000);
	const ended = applyChildEvent(state, execution("tool_execution_end", "t1"), 9_000);
	assert.deepEqual(ended?.recentCalls, [npmTest]);
	assert.equal(ended?.stepStartedAt, 9_000);
});

test("child events: a start seen before its message still marks the call", () => {
	const state = newChildRunState();
	applyChildEvent(state, execution("tool_execution_start", "t1"), 2_000);
	const patch = applyChildEvent(state, callMessage([{ id: "t1", command: "npm test" }, { id: "t2", command: "ls" }]), 2_500);
	assert.deepEqual(patch?.recentCalls?.map((c) => c.runningSince), [2_000, undefined]);
	assert.ok(patch && !("stepStartedAt" in patch), "a call is running");
});

test("child events: parallel calls; the step starts only when the last one ends", () => {
	const state = newChildRunState();
	applyChildEvent(state, callMessage([{ id: "t1", command: "a" }, { id: "t2", command: "b" }]), 0);
	applyChildEvent(state, execution("tool_execution_start", "t1"), 1);
	applyChildEvent(state, execution("tool_execution_start", "t2"), 2);
	const first = applyChildEvent(state, execution("tool_execution_end", "t2"), 3);
	assert.deepEqual(first?.recentCalls?.map((c) => c.runningSince), [1, undefined]);
	assert.ok(first && !("stepStartedAt" in first));
	assert.equal(applyChildEvent(state, execution("tool_execution_end", "t1"), 4)?.stepStartedAt, 4);
});

test("child events: the final message (no calls) ends the model's step", () => {
	const state = newChildRunState();
	const patch = applyChildEvent(state, { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "done" }], stopReason: "stop" } } as never, 5);
	assert.ok(patch && "stepStartedAt" in patch && patch.stepStartedAt === undefined, "cleared, so no thinking clock while the child exits");
});

test("child events: past the kept calls, finished calls go first and an executing one stays", () => {
	const state = newChildRunState();
	applyChildEvent(state, callMessage([{ id: "long", command: "npm test" }]), 0);
	applyChildEvent(state, execution("tool_execution_start", "long"), 1);
	const many = Array.from({ length: 10 }, (_, i) => ({ id: `c${i}`, command: `cmd ${i}` }));
	const patch = applyChildEvent(state, callMessage(many), 2);
	assert.equal(patch?.recentCalls?.length, 8);
	assert.deepEqual(patch?.recentCalls?.[0], { ...npmTest, runningSince: 1 }, "the executing call is kept");
	assert.equal(patch?.recentCalls?.at(-1)?.args?.command, "cmd 9");
	const ninth = applyChildEvent(state, execution("tool_execution_start", "c8"), 3);
	assert.deepEqual(ninth?.recentCalls?.filter((c) => c.runningSince !== undefined).map((c) => c.args?.command), ["npm test", "cmd 8"], "ids stay with their calls");
});

test("child events: a call without an id is never marked; unknown or missing ids change nothing", () => {
	const state = newChildRunState();
	applyChildEvent(state, callMessage([{ command: "ls" }]), 0);
	assert.equal(applyChildEvent(state, execution("tool_execution_end", "never-started"), 1), undefined);
	assert.equal(applyChildEvent(state, { type: "tool_execution_start", toolCallId: 5 as never, toolName: "bash" }, 1), undefined);
	assert.deepEqual(applyChildEvent(state, execution("tool_execution_start", "other"), 2)?.recentCalls, [{ name: "bash", args: { command: "ls" } }]);
});

test("child events: the end of a dev-team call clears both its running mark and its live agents", () => {
	const state = newChildRunState();
	applyChildEvent(state, execution("tool_execution_start", "c1", "dev_team_subagent"), 1);
	applyChildEvent(state, dispatchUpdate("c1", [reviewer("a", "running")]));
	const patch = applyChildEvent(state, dispatchEnd("c1"), 5);
	assert.ok(patch, "the end yields a patch");
	assert.ok("subagents" in patch, "with the live agents' key, so the view clears them");
	assert.equal(patch.subagents, undefined);
	assert.equal(patch.stepStartedAt, 5);
});

test("semaphore: a waiter learns its place in line when it joins", async () => {
	const slots = new Semaphore(1);
	const release = await slots.acquire();
	const b: number[] = [];
	const c: number[] = [];
	const waitB = slots.acquire((n) => b.push(n));
	const waitC = slots.acquire((n) => c.push(n));
	assert.deepEqual([b, c], [[1], [2]]);
	release();
	(await waitB)();
	(await waitC)();
});

test("semaphore: the line moves up as slots free", async () => {
	const slots = new Semaphore(2);
	const releases = [await slots.acquire(), await slots.acquire()];
	const c: number[] = [];
	const d: number[] = [];
	const waitC = slots.acquire((n) => c.push(n));
	const waitD = slots.acquire((n) => d.push(n));
	releases[0]();
	const releaseC = await waitC;
	assert.deepEqual([c, d], [[1], [2, 1]], "d moves up when c gets the slot");
	releases[1]();
	(await waitD)();
	releaseC();
});

test("semaphore: no place in line when a slot is free", async () => {
	const told: number[] = [];
	(await new Semaphore(1).acquire((n) => told.push(n)))();
	assert.deepEqual(told, []);
});

test("semaphore: a throwing position callback never keeps the next waiter waiting", async () => {
	const slots = new Semaphore(1);
	const release = await slots.acquire();
	const next = slots.acquire(() => {
		throw new Error("view is gone");
	});
	const third = slots.acquire(() => {
		throw new Error("view is gone");
	});
	release();
	const releaseNext = await next;
	releaseNext();
	(await third)();
});

test("acquireSlot: reports the place in line, then clears it and stamps the start", async () => {
	const slots = new Semaphore(1);
	const first = await slots.acquire();
	const patches: unknown[] = [];
	const waiting = acquireSlot(slots, (p) => patches.push(p), () => 42);
	assert.deepEqual(patches, [{ queuePosition: 1 }]);
	first();
	(await waiting)();
	assert.deepEqual(patches, [{ queuePosition: 1 }, { queuePosition: undefined, startedAt: 42 }]);
});

test("dispatchLabel: a parallel call's description, on one line and capped", () => {
	const tasks = [{}, {}];
	assert.equal(dispatchLabel({ tasks, description: "  code-review round 2/4 " }), "code-review round 2/4");
	assert.equal(dispatchLabel({ tasks, description: "x\n✓ fake line" }), "x ✓ fake line");
	assert.equal(dispatchLabel({ tasks, description: "   " }), undefined);
	assert.equal(dispatchLabel({ tasks }), undefined);
	assert.equal(dispatchLabel({ description: "single dispatch" }), undefined, "a single dispatch shows its agent instead");
	assert.equal(dispatchLabel({ tasks, description: "y".repeat(200) })?.length, 80);
});

test("progress: the snapshot carries the dispatch start and its label", () => {
	const progress = new DispatchProgress([{ agent: "a", task: "t" }], [], undefined, { label: "code-review round 2/4", now: 42 });
	assert.equal(progress.snapshot().startedAt, 42);
	assert.equal(progress.snapshot().label, "code-review round 2/4");
	assert.equal(new DispatchProgress([{ agent: "a", task: "t" }], [], undefined).snapshot().label, undefined);
});

test("progress: a waiting agent's status line says so, in the view's words", () => {
	const { progress, updates } = recordedProgress();
	progress.update(1, { queuePosition: 2 });
	assert.equal(updates.at(-1)?.text, "a: turn 0\nb: waiting for a free agent slot (2nd in line)");
});

test("progress: finish clears the live fields, executing marks included", () => {
	const { progress } = recordedProgress();
	progress.update(0, { queuePosition: 2, stepStartedAt: 5, recentCalls: [{ ...npmTest, runningSince: 3 }] });
	progress.finish(0, runResult({}));
	const view = progress.snapshot().results[0];
	assert.equal(view.queuePosition, undefined);
	assert.equal(view.stepStartedAt, undefined);
	assert.deepEqual(view.recentCalls, [npmTest]);
});
