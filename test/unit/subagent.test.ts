import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { type TestContext, test } from "node:test";
import { discoverDispatchAgents, parseAgentFile, projectAgentsRequested } from "../../extensions/dev-team/lib/agents.ts";
import { applyChildEvent, newChildRunState } from "../../extensions/dev-team/lib/child-run.ts";
import { HookBridge } from "../../extensions/dev-team/lib/hooks.ts";
import { DEFAULT_CONFIG } from "../../extensions/dev-team/lib/config.ts";
import { DispatchProgress, formatResultText, type SubagentRunResult, viewFromResult } from "../../extensions/dev-team/lib/subagent.ts";
import { addPiUsage, creditedRuns, describeWorktree, emptyPiUsage, sumPiUsage, toUsageTotals, type UsageTotals } from "../../extensions/dev-team/lib/subagent-types.ts";
import { type ChildTrust, canonicalDir, childTrustOf, shimTrustEnv, trustArgs } from "../../extensions/dev-team/lib/trust.ts";

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
	const patch = applyChildEvent(state, { type: "message_end", message: { role: "assistant", content: [{ type: "toolCall", name: "read" }], usage: turnUsage, model: "m2", provider: "p" } as never });
	assert.equal(state.turns, 1);
	assert.equal(state.own.input, 100);
	assert.equal(state.total.input, 100);
	assert.deepEqual(patch?.tools, ["read"]);
	assert.equal(patch?.model, "p/m2");
	assert.equal(applyChildEvent(state, { type: "message_start", message: { role: "assistant" } as never }), undefined);
});

test("child events: a nested dev-team dispatch is credited to the agents it ran", () => {
	const state = newChildRunState();
	const nestedView = { agent: "Explore", task: "t", status: "ok", ok: true, turns: 1, tools: [], model: "p/haiku", usage: { input: 40, output: 4, cacheRead: 0, cacheWrite: 0, cost: 0.04, turns: 1 }, nested: [{ agent: "deep", model: "p/x", usage: { input: 60, output: 6, cacheRead: 0, cacheWrite: 0, cost: 0.06, turns: 1 } }] };
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
	assert.deepEqual(state.recentTools, ["t2", "t3", "t4", "t5", "t6", "t7", "t8", "t9"]);
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

type Emitted = { text: string; details: { results: { status: string; ok: boolean; turns: number; tools: string[] }[]; skippedProjectAgents?: string[] } };

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
	progress.update(0, { turns: 2, tools: ["read", "grep", "find", "ls"] });
	assert.equal(updates.at(-1)?.text, "a: turn 2 → grep, find, ls\nb: turn 0");
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
	progress.snapshot().results[0].tools.push("mutated");
	assert.ok(!progress.snapshot().results[0].tools.includes("mutated"));
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
