import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import {
	discoverAgents,
	mapTools,
	parseAgentFile,
	resolveAgentName,
	resolveModel,
	resolveThinking,
	splitToolList,
} from "../../extensions/dev-team/lib/agents.ts";
import { DEFAULT_CONFIG, isHookEnabled, mergeConfig } from "../../extensions/dev-team/lib/config.ts";
import { applyUpdatedInput, claudeToolName, HookBridge, loadHookSpecs, toClaudeInput } from "../../extensions/dev-team/lib/hooks.ts";
import { AUTOCOMPACT_KEY, autocompactSetting } from "../../extensions/dev-team/lib/metrics.ts";
import { discoverSkills, resolveSkillName, skillIndex, splitArgs, substituteArguments } from "../../extensions/dev-team/lib/skills.ts";
import { addPiUsage, buildSystemPrompt, forwardedArgs, projectAgentsRequested, sumPiUsage } from "../../extensions/dev-team/lib/subagent.ts";
import { formatUsage, renderSubagentCall, renderSubagentResult } from "../../extensions/dev-team/lib/subagent-render.ts";
import { buildTranscriptLines } from "../../extensions/dev-team/lib/transcript.ts";

const ROOT = path.resolve(import.meta.dirname, "..", "..");

test("splitToolList keeps scoped Bash grants intact", () => {
	assert.deepEqual(splitToolList("Read, Grep, Bash(npx playwright *), Glob"), ["Read", "Grep", "Bash(npx playwright *)", "Glob"]);
	assert.equal(splitToolList(undefined), undefined);
});

test("mapTools maps Claude tools to pi tools", () => {
	const m = mapTools(["Read", "Grep", "Glob", "Bash(graphify *)", "Edit", "Write", "Skill", "Agent", "WebSearch", "Frobnicate"], ["read"]);
	assert.ok(m);
	assert.deepEqual(m.tools.sort(), ["bash", "dev_team_subagent", "edit", "find", "grep", "ls", "read", "skill", "write"].sort());
	assert.deepEqual(m.scopedBash, ["graphify *"]);
	assert.deepEqual(m.unmapped, ["Frobnicate"]);
});

test("Agent and Task map only to dev-team dispatch, preserving an external subagent", () => {
	const available = ["dev_team_subagent", "subagent"];
	for (const name of ["Agent", "Task"]) {
		assert.deepEqual(mapTools([name], available)?.tools, ["dev_team_subagent"]);
	}
	assert.deepEqual(mapTools(["Agent", "Task", "subagent"], available)?.tools, available);
});

test("mapTools expands MCP patterns against registered tools, renaming Claude plugin servers", () => {
	const available = ["read", "mcp__codegraph__search", "mcp__repowise__get_context", "mcp__other__x", "codemode"];
	const m = mapTools(["Read", "mcp__codegraph__*", "mcp__plugin_repowise_repowise__get_context", "mcp__missing__*"], available);
	assert.ok(m);
	assert.deepEqual(m.tools.sort(), ["codemode", "mcp__codegraph__search", "mcp__repowise__get_context", "read"].sort());
});

test("resolveModel: tiers, inherit, explicit ids, overrides", () => {
	const tiers = { opus: "github-copilot/claude-opus-5.5", sonnet: "inherit", haiku: "github-copilot/claude-haiku-4.5" };
	assert.deepEqual(resolveModel("opus", undefined, tiers, "p/m"), { model: "github-copilot/claude-opus-5.5", tier: "opus" });
	assert.deepEqual(resolveModel("sonnet", undefined, tiers, "p/m"), { model: "p/m", tier: "sonnet" });
	assert.deepEqual(resolveModel(undefined, undefined, tiers, "p/m"), { model: "p/m", tier: "inherit" });
	assert.deepEqual(resolveModel("opus", "haiku", tiers, "p/m"), { model: "github-copilot/claude-haiku-4.5", tier: "haiku" });
	assert.deepEqual(resolveModel("opus", "openai/gpt-5.5", tiers, "p/m"), { model: "openai/gpt-5.5" });
	assert.deepEqual(resolveModel("fable", undefined, tiers, undefined), { model: undefined, tier: "fable" });
});

test("resolveThinking maps effort", () => {
	assert.equal(resolveThinking("high", undefined, DEFAULT_CONFIG.thinking, "off"), "high");
	assert.equal(resolveThinking(undefined, undefined, DEFAULT_CONFIG.thinking, "low"), "low");
	assert.equal(resolveThinking("high", "medium", DEFAULT_CONFIG.thinking, undefined), "medium");
	assert.equal(resolveThinking("max", undefined, DEFAULT_CONFIG.thinking, undefined), "max");
});

test("every upstream agent parses and maps to at least one pi tool", () => {
	const agents = discoverAgents(os.tmpdir(), ROOT);
	assert.ok(agents.size >= 48, `expected >= 48 agents, got ${agents.size}`);
	for (const def of agents.values()) {
		const m = mapTools(def.claudeTools, []);
		if (m) assert.ok(m.tools.length > 0, `${def.name} maps to no tools`);
		assert.ok(def.body.trim().length > 50, `${def.name} has an empty body`);
		assert.ok(!def.model || ["opus", "sonnet", "haiku", "fable", "inherit"].includes(def.model) || def.model.includes("/"), `${def.name} model ${def.model}`);
	}
	assert.equal(resolveAgentName(agents, "dev-team:security-review")?.name, "security-review");
	assert.equal(resolveAgentName(agents, "explore")?.name, "Explore");
});

test("agent file with blank line after frontmatter opener parses", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agt-"));
	const f = path.join(dir, "x.md");
	fs.writeFileSync(f, "---\n\nname: x\ndescription: d\ntools: Read, Grep\nmodel: haiku\neffort: low\nskills:\n  - a\n  - b\n---\nBody text here that is long enough.\n");
	const def = parseAgentFile(f, "project");
	assert.ok(def);
	assert.deepEqual(def.skills, ["a", "b"]);
	assert.equal(def.model, "haiku");
});

test("project agents override package agents", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "proj-"));
	fs.mkdirSync(path.join(dir, ".claude", "agents"), { recursive: true });
	fs.writeFileSync(path.join(dir, ".claude", "agents", "security-review.md"), "---\nname: security-review\ndescription: local\n---\nlocal body\n");
	assert.equal(discoverAgents(dir, ROOT).get("security-review")?.description, "local");
});

test("splitArgs and Claude argument substitution", () => {
	assert.deepEqual(splitArgs(`security-review --path "src/a b.ts" --x`), ["security-review", "--path", "src/a b.ts", "--x"]);
	assert.equal(substituteArguments("Args: $ARGUMENTS", "a b"), "Args: a b");
	assert.equal(substituteArguments("Agent `$0`, then $ARGUMENTS[1]", "test-review --json"), "Agent `test-review`, then --json");
	assert.equal(substituteArguments("No placeholder.", "x y"), "No placeholder.\n\nARGUMENTS: x y");
	assert.equal(substituteArguments("No placeholder.", ""), "No placeholder.");
});

test("skills: discovery, qualified names, project override, compact index", () => {
	const skills = discoverSkills(os.tmpdir(), ROOT);
	assert.ok(skills.size >= 90);
	for (const name of ["specs", "plan", "build", "pr", "code-review", "setup", "help", "version", "upgrade", "headless-run"]) {
		assert.ok(skills.has(name), `missing skill ${name}`);
	}
	for (const dropped of ["agent-eval", "agent-audit", "claude-setup-review", "session-review"]) assert.ok(!skills.has(dropped));
	assert.equal(resolveSkillName(skills, "/dev-team:plan")?.name, "plan");
	const index = skillIndex(skills, "compact", 220);
	assert.ok(index.length < 40_000, `index too large: ${index.length}`);
	assert.match(index, /- plan \(\/plan\): /);
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "proj-"));
	fs.mkdirSync(path.join(dir, ".claude", "skills", "pr"), { recursive: true });
	fs.writeFileSync(path.join(dir, ".claude", "skills", "pr", "SKILL.md"), "---\nname: pr\ndescription: project pr\n---\nx\n");
	assert.equal(discoverSkills(dir, ROOT).get("pr")?.source, "project");
});

test("every skill description fits pi's 1024 limit", () => {
	for (const s of discoverSkills(os.tmpdir(), ROOT).values()) assert.ok(s.description.length <= 1024, `${s.name}: ${s.description.length}`);
});

test("hooks.json wiring loads with matchers and every script exists", () => {
	const specs = loadHookSpecs(ROOT);
	assert.ok(specs.length >= 45, `only ${specs.length} hook registrations`);
	for (const s of specs) assert.ok(fs.existsSync(s.script), `missing ${s.script}`);
	const preBash = specs.filter((s) => s.event === "PreToolUse" && (!s.matcher || s.matcher.test("Bash"))).map((s) => s.name);
	assert.ok(preBash.includes("destructive_guard") && preBash.includes("pre_pr_review"));
	const preWrite = specs.filter((s) => s.event === "PreToolUse" && s.matcher?.test("Write")).map((s) => s.name);
	assert.ok(preWrite.includes("pre_tool_guard"));
	assert.ok(!preWrite.includes("destructive_guard"));
});

test("SessionStart matchers select hooks by source", (t) => {
	const bridge = new HookBridge(ROOT, () => DEFAULT_CONFIG);
	if (!bridge.python) return t.skip("python >= 3.10 not found");
	const names = (source: string) => bridge.select("SessionStart", source).map((s) => s.name);
	assert.ok(names("startup").includes("autocompact_setup_nudge"));
	assert.ok(names("startup").includes("repo_review_nudge"));
	assert.ok(!names("startup").includes("post_compact_state_reinject"));
	assert.ok(names("compact").includes("post_compact_state_reinject"));
	assert.ok(!names("compact").includes("autocompact_setup_nudge"));
});

test("autocompact setting follows upstream detect precedence", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dt-ac-"));
	const home = path.join(dir, "home");
	const write = (file: string, env: Record<string, unknown>) => {
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, JSON.stringify({ env }));
	};
	const env = { HOME: home } as NodeJS.ProcessEnv;
	assert.deepEqual(autocompactSetting(dir, env), {});
	write(path.join(home, ".claude", "settings.json"), { [AUTOCOMPACT_KEY]: "70" });
	assert.equal(autocompactSetting(dir, env).pct, 70);
	write(path.join(dir, ".claude", "settings.json"), { [AUTOCOMPACT_KEY]: "40" });
	assert.equal(autocompactSetting(dir, env).pct, 40);
	write(path.join(dir, ".claude", "settings.local.json"), { [AUTOCOMPACT_KEY]: "040" });
	const invalid = autocompactSetting(dir, env);
	assert.equal(invalid.pct, undefined);
	assert.equal(invalid.source, "settings.local.json");
	assert.equal(autocompactSetting(dir, { ...env, [AUTOCOMPACT_KEY]: "55" }).pct, 55);
	fs.rmSync(dir, { recursive: true, force: true });
});

test("hook enablement honours defaults, disabled and enable lists", () => {
	assert.equal(isHookEnabled(DEFAULT_CONFIG, "destructive_guard"), true);
	assert.equal(isHookEnabled(DEFAULT_CONFIG, "cost_meter"), false);
	const cfg = mergeConfig(DEFAULT_CONFIG, { hooks: { enable: ["version_check"], disabled: ["destructive_guard"] } });
	assert.equal(isHookEnabled(cfg, "version_check"), true);
	assert.equal(isHookEnabled(cfg, "destructive_guard"), false);
	assert.equal(isHookEnabled(mergeConfig(DEFAULT_CONFIG, { hooks: { enabled: false } }), "pre_tool_guard"), false);
});

test("toClaudeInput / applyUpdatedInput", () => {
	assert.equal(claudeToolName("find"), "Glob");
	assert.equal(claudeToolName("dev_team_subagent"), "Agent");
	assert.equal(claudeToolName("subagent"), "subagent");
	const w = toClaudeInput("write", { path: "a/b.ts", content: "x" }, "/repo");
	assert.equal(w.file_path, "/repo/a/b.ts");
	assert.equal(w.path, "/repo/a/b.ts");
	const e = toClaudeInput("edit", { path: "/abs/f.ts", edits: [{ oldText: "a", newText: "b" }, { oldText: "c", newText: "d" }] }, "/repo");
	assert.equal(e.old_string, "a\nc");
	assert.equal(e.new_string, "b\nd");
	assert.deepEqual(toClaudeInput("dev_team_subagent", { agent: "x", task: "t" }, "/r"), { subagent_type: "x", prompt: "t", description: "", model: undefined });
	const input: Record<string, unknown> = { command: "ls" };
	applyUpdatedInput("bash", input, { command: "ls -la" });
	assert.equal(input.command, "ls -la");
});

test("hook prompt updates apply only to namespaced dev-team dispatch", () => {
	const dispatch: Record<string, unknown> = { agent: "x", task: "original" };
	applyUpdatedInput("dev_team_subagent", dispatch, { prompt: "updated", additionalContext: "context" });
	assert.deepEqual(dispatch, { agent: "x", task: "updated\n\ncontext" });
	applyUpdatedInput("dev_team_subagent", dispatch, { additionalContext: "more context" });
	assert.equal(dispatch.task, "updated\n\ncontext\n\nmore context");

	const external = { agent: "external", task: "original", description: "external tool" };
	assert.deepEqual(toClaudeInput("subagent", external, "/r"), external);
	applyUpdatedInput("subagent", external, { prompt: "updated", additionalContext: "context" });
	assert.deepEqual(external, { agent: "external", task: "original", description: "external tool" });
});

test("synthetic transcript matches the fields the SubagentStop hooks read", () => {
	const lines = buildTranscriptLines({
		agentName: "security-review",
		agentId: "abc",
		sessionId: "s",
		cwd: "/r",
		prompt: "Files in scope for this review: a.ts",
		messages: [
			{ role: "assistant", content: [{ type: "toolCall", id: "1", name: "read", arguments: { path: "a.ts" } }], stopReason: "toolUse", usage: { input: 5 } },
			{ role: "toolResult", toolCallId: "1", content: [{ type: "text", text: "code" }] },
			{ role: "assistant", content: [{ type: "text", text: '{"status":"pass","issues":[]}' }], stopReason: "stop", model: "m" },
		],
	}).map((l) => JSON.parse(l));
	assert.equal(lines[0].type, "user");
	assert.equal(lines[0].message.content, "Files in scope for this review: a.ts");
	assert.equal(lines[1].attributionAgent, "dev-team:security-review");
	assert.equal(lines[1].message.content[0].type, "tool_use");
	assert.equal(lines[1].message.stop_reason, "tool_use");
	assert.equal(lines[1].message.usage.input_tokens, 5);
	assert.equal(lines[3].message.stop_reason, "end_turn");
	assert.ok(lines.every((l) => l.isSidechain === true));
});

test("forwardedArgs keeps resource flags and resolves local paths", () => {
	const out = forwardedArgs(["-e", "./ext.ts", "--model", "x/y", "-p", "--no-skills", "--extension", "npm:pkg"]);
	assert.deepEqual(out, ["-e", path.resolve("./ext.ts"), "--no-skills", "--extension", "npm:pkg"]);
});

test("subagent system prompt carries runtime notes and skill hints", () => {
	const agents = discoverAgents(os.tmpdir(), ROOT);
	const def = agents.get("software-engineer");
	assert.ok(def);
	const prompt = buildSystemPrompt(def, ROOT, [], ["WebSearch"]);
	assert.match(prompt, /Relevant skills for this dispatch/);
	assert.match(prompt, /test-driven-development/);
	assert.match(prompt, /Unavailable in this runtime/);
	assert.match(prompt, /Agent\/Task=dev_team_subagent\./);
	assert.doesNotMatch(prompt, /Agent\/Task=subagent\b/);
});

test("untrusted discovery drops project agents and their overrides", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dt-agents-"));
	fs.mkdirSync(path.join(dir, ".claude", "agents"), { recursive: true });
	const md = (name: string) => `---\nname: ${name}\ndescription: d\n---\nbody\n`;
	fs.writeFileSync(path.join(dir, ".claude", "agents", "security-review.md"), md("security-review"));
	fs.writeFileSync(path.join(dir, ".claude", "agents", "local-only.md"), md("local-only"));
	const all = discoverAgents(dir, ROOT);
	assert.deepEqual(projectAgentsRequested(all, ["dev-team:security-review", "local-only", "test-review"]).map((d) => d.name).sort(), ["local-only", "security-review"]);
	const pkg = discoverAgents(dir, ROOT, { includeProject: false });
	assert.equal(pkg.get("security-review")?.source, "package");
	assert.equal(pkg.has("local-only"), false);
	fs.rmSync(dir, { recursive: true, force: true });
});

test("child usage sums into one pi Usage for the tool result", () => {
	assert.equal(sumPiUsage([{}, {}]), undefined);
	const u = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
	addPiUsage(u, { input: 1000, output: 100, cacheRead: 5, cacheWrite: 1, totalTokens: 1106, cost: { input: 0.001, output: 0.0002, cacheRead: 0, cacheWrite: 0, total: 0.0012 } });
	addPiUsage(u, { input: 10, output: 1 });
	assert.equal(u.input, 1010);
	assert.equal(u.totalTokens, 1106 + 11);
	const total = sumPiUsage([{ piUsage: u }, {}, { piUsage: u }]);
	assert.equal(total?.input, 2020);
	assert.ok(Math.abs((total?.cost.total ?? 0) - 0.0024) < 1e-12);
});

test("subagent renderers draw running, finished and untrusted states", () => {
	const theme = { fg: (_c: string, t: string) => t, bold: (t: string) => t } as never;
	const lines = (c: { render(w: number): string[] }) => c.render(120).join("\n");
	assert.match(lines(renderSubagentCall({ agent: "security-review", task: "review src/a.js", isolation: "worktree" }, theme)), /dev-team security-review \[worktree\]/);
	assert.match(lines(renderSubagentCall({ tasks: [{ agent: "a", task: "x" }, { agent: "b", task: "y" }] }, theme)), /parallel \(2 agents\)/);
	const usage = { input: 1200, output: 80, cacheRead: 0, cacheWrite: 0, cost: 0.0012, turns: 2 };
	const running = { content: [], details: { results: [{ agent: "a", task: "x", status: "running", ok: false, turns: 1, tools: ["read", "grep"] }, { agent: "b", task: "y", status: "ok", ok: true, turns: 2, tools: [], output: "done", usage }] } };
	const partial = lines(renderSubagentResult(running as never, { expanded: false, isPartial: true }, theme));
	assert.match(partial, /1\/2 done, 1 running/);
	assert.match(partial, /→ grep/);
	const finished = { content: [], details: { results: [{ agent: "b", task: "y", status: "failed", ok: false, turns: 2, tools: [], error: "boom", usage }], untrustedProjectAgents: ["local-only"] } };
	const done = lines(renderSubagentResult(finished as never, { expanded: false, isPartial: false }, theme));
	assert.match(done, /✗ b/);
	assert.match(done, /Error: boom/);
	assert.match(done, /project agents skipped \(project not trusted\): local-only/);
	assert.equal(formatUsage(usage, "p/m", 1500), "2 turns ↑1.2k ↓80 $0.0012 1.5s p/m");
	const plain = lines(renderSubagentResult({ content: [{ type: "text", text: "legacy" }], details: undefined } as never, { expanded: false, isPartial: false }, theme));
	assert.match(plain, /legacy/);
});
