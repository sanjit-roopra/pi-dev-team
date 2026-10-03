import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { type TestContext, test } from "node:test";
import { discoverDispatchAgents, projectAgentsRequested } from "../../extensions/dev-team/lib/agents.ts";
import { HookBridge } from "../../extensions/dev-team/lib/hooks.ts";
import { trustArgs } from "../../extensions/dev-team/lib/subagent.ts";
import { addPiUsage, describeWorktree, emptyPiUsage, sumPiUsage, toUsageTotals } from "../../extensions/dev-team/lib/subagent-types.ts";
import { DEFAULT_CONFIG } from "../../extensions/dev-team/lib/config.ts";

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

test("child trust flags: declined is explicit, granted only for the session's own project", () => {
	assert.deepEqual(trustArgs(false, "/repo", "/repo"), ["--no-approve"]);
	assert.deepEqual(trustArgs(true, "/repo", "/repo"), ["--approve"]);
	assert.deepEqual(trustArgs(true, "/repo", "/repo/.claude/worktrees/x"), ["--approve"]);
	assert.deepEqual(trustArgs(true, "/repo", "/tmp/other"), []);
	assert.deepEqual(trustArgs(true, "/repo", "/repo-sibling"), []);
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

test("describeWorktree", () => {
	assert.equal(describeWorktree({ path: "/r/.claude/worktrees/a", branch: "dev-team/a", kept: true, dirty: true, commits: 2 }), "kept: /r/.claude/worktrees/a on branch dev-team/a, 2 commit(s), uncommitted changes");
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
