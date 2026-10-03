#!/usr/bin/env node
/**
 * End-to-end tests: the real `pi` binary + this package + an offline scripted model provider.
 * No network, no API keys. Each scenario runs `pi -p` in a throwaway git repo with a throwaway HOME.
 *
 *   node test/e2e/run.mjs            # all scenarios
 *   node test/e2e/run.mjs subagent   # scenarios whose name contains "subagent"
 */
import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const PKG = path.resolve(import.meta.dirname, "..", "..");
const PROVIDER = path.join(PKG, "test", "fixtures", "scripted-provider.ts");
const EXTERNAL_SUBAGENT = path.join(PKG, "test", "fixtures", "external-subagent.ts");
const filter = process.argv[2] ?? "";

function script(steps) {
	return `<<script>>${JSON.stringify(steps)}<</script>>`;
}

function setupRepo() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-dev-team-e2e-"));
	const repo = path.join(root, "repo");
	const home = path.join(root, "home");
	fs.mkdirSync(repo);
	fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
	fs.writeFileSync(path.join(home, ".claude", "telemetry.json"), '{"enabled": true}');
	// a user who ran /setup: keeps the autocompact_setup_nudge advisory out of the echoed prompt
	fs.writeFileSync(path.join(home, ".claude", "settings.json"), '{"env": {"CLAUDE_AUTOCOMPACT_PCT_OVERRIDE": "40"}}');
	const git = (...args) => execFileSync("git", args, { cwd: repo, stdio: "pipe" });
	git("init", "-q", "-b", "main");
	git("config", "user.email", "t@example.com");
	git("config", "user.name", "t");
	fs.writeFileSync(path.join(repo, "README.md"), "hi\n");
	git("add", ".");
	git("commit", "-qm", "init");
	return { root, repo, home, git };
}

function pi(env, prompt, { json = false, extra = [], usePackageFlag = true } = {}) {
	const args = ["-e", PROVIDER, ...(usePackageFlag ? ["-e", PKG] : []), "--model", "scripted/s1", "--no-session", ...extra];
	if (json) args.push("--mode", "json");
	args.push("-p", prompt);
	const r = spawnSync("pi", args, {
		cwd: env.repo,
		env: { ...process.env, HOME: env.home, PI_CODING_AGENT_DIR: path.join(env.home, ".pi", "agent") },
		encoding: "utf-8",
		stdio: ["ignore", "pipe", "pipe"],
		timeout: 120_000,
	});
	return { code: r.status, out: r.stdout ?? "", err: r.stderr ?? "" };
}

function toolResults(jsonl) {
	const out = [];
	for (const line of jsonl.split("\n")) {
		try {
			const e = JSON.parse(line);
			if (e.type === "tool_execution_end") {
				out.push({ tool: e.toolName, isError: e.isError, text: (e.result?.content ?? []).map((c) => c.text ?? "").join(""), details: e.result?.details, usage: e.result?.usage });
			}
		} catch {}
	}
	return out;
}

function assert(cond, msg) {
	if (!cond) throw new Error(msg);
}

function readJsonl(file) {
	if (!fs.existsSync(file)) return [];
	return fs
		.readFileSync(file, "utf-8")
		.split("\n")
		.filter(Boolean)
		.map((l) => JSON.parse(l));
}

function assertSubagentCoexistence(env, options) {
	const child = script([
		{ tool: "bash", args: { command: 'printf "pid=%s depth=%s agent=%s\\n" "$PPID" "$DEV_TEAM_SUBAGENT_DEPTH" "$DEV_TEAM_AGENT_NAME" > child-process.txt' } },
		{ tool: "write", args: { path: ".env", content: "OFFLINE=1" } },
	]);
	const r = pi(env, script([
		{ tool: "subagent", args: { task: "collision-probe" } },
		{ tool: "dev_team_subagent", args: { subagent_type: "general-purpose", prompt: child } },
	]), { ...options, json: true });
	assert(r.code === 0, `startup/dispatch failed: ${r.err}\n${r.out.slice(-1000)}`);
	const results = toolResults(r.out);
	const external = results.find((x) => x.tool === "subagent");
	const dispatch = results.find((x) => x.tool === "dev_team_subagent");
	assert(results.length === 2 && external && dispatch, `tools did not coexist: ${JSON.stringify(results)}`);
	assert(!external.isError && external.text === "EXTERNAL_SUBAGENT:collision-probe", JSON.stringify(external));
	assert(external.details?.source === "external-subagent-fixture" && external.details.task === "collision-probe", JSON.stringify(external));
	assert(!dispatch.isError && dispatch.text.includes("[pre_tool_guard] BLOCKED"), `child guard missing: ${JSON.stringify(dispatch)}`);
	assert(!dispatch.text.includes("EXTERNAL_SUBAGENT:"), "dev-team dispatch called the external extension");
	const childResult = dispatch.details?.results?.[0];
	assert(dispatch.details?.results?.length === 1 && childResult?.ok && childResult.agent === "general-purpose", JSON.stringify(dispatch.details));
	assert(childResult.model === "scripted/s1" && childResult.usage.turns >= 3, `no scripted child run: ${JSON.stringify(childResult)}`);
	const childProcessFile = path.join(env.repo, "child-process.txt");
	assert(fs.existsSync(childProcessFile), "real child process did not run bash");
	const childProcess = fs.readFileSync(childProcessFile, "utf-8");
	const childPid = Number(childProcess.match(/pid=(\d+)/)?.[1]);
	assert(Number.isInteger(external.details.pid) && childPid > 0 && childPid !== external.details.pid, `child did not run separately: ${childProcess} parent=${external.details.pid}`);
	assert(childProcess.includes("depth=1 agent=general-purpose"), `child env missing: ${childProcess}`);
	assert(!fs.existsSync(path.join(env.repo, ".env")), "child wrote guarded .env");
}

const scenarios = {
	"command /version expands the skill"(env) {
		const r = pi(env, "/version");
		assert(r.out.includes('ECHO:<skill name="version"'), `unexpected output: ${r.out.slice(0, 300)} ${r.err}`);
	},

	"autocompact_setup_nudge reaches the model only when autocompact is unconfigured"(env) {
		fs.rmSync(path.join(env.home, ".claude", "settings.json"));
		let r = pi(env, "hello");
		assert(r.out.includes("context autocompact is not configured"), `nudge missing: ${r.out.slice(0, 300)} ${r.err}`);
		fs.mkdirSync(path.join(env.repo, ".claude"), { recursive: true });
		fs.writeFileSync(path.join(env.repo, ".claude", "settings.json"), '{"env": {"CLAUDE_AUTOCOMPACT_PCT_OVERRIDE": "40"}}');
		r = pi(env, "hello");
		assert(!r.out.includes("context autocompact"), `nudge shown when configured: ${r.out.slice(0, 300)}`);
		assert(r.out.includes("ECHO:hello"), r.out.slice(0, 300));
	},

	"command argument substitution ($0, $ARGUMENTS)"(env) {
		const r = pi(env, "/review-agent security-review --internal");
		assert(r.out.includes("Required: agent name (`security-review`"), "$0 not substituted");
		assert(!r.out.includes("`$0`"), "raw $0 left in expansion");
	},

	"bash sees plugin env, shim on PATH, non-interactive"(env) {
		const r = pi(env, script([{ tool: "bash", args: { command: 'echo "root=$CLAUDE_PLUGIN_ROOT"; command -v claude; echo "i=[$DEV_TEAM_INTERACTIVE]"; echo "sid=$CLAUDE_SESSION_ID"' } }]));
		assert(r.out.includes(`root=${PKG}`), r.out);
		assert(r.out.includes(path.join(PKG, "bin", "claude")), "shim not on PATH");
		assert(r.out.includes("i=[]"), "DEV_TEAM_INTERACTIVE should be unset in print mode");
		assert(/sid=\S+/.test(r.out), "CLAUDE_SESSION_ID unset");
	},

	"pre_tool_guard blocks writing .env"(env) {
		const r = pi(env, script([{ tool: "write", args: { path: ".env", content: "SECRET=1" } }]));
		assert(r.out.includes("[pre_tool_guard] BLOCKED"), r.out);
		assert(!fs.existsSync(path.join(env.repo, ".env")), ".env was written");
	},

	"destructive_guard blocks reset --hard on the default branch"(env) {
		const r = pi(env, script([{ tool: "bash", args: { command: "git reset --hard HEAD" } }]));
		assert(r.out.includes("[destructive_guard] BLOCKED"), r.out);
	},

	"freeze mode limits writes to allowed patterns"(env) {
		fs.mkdirSync(path.join(env.repo, ".claude", "hooks"), { recursive: true });
		fs.writeFileSync(path.join(env.repo, ".claude", "hooks", "freeze-state.json"), JSON.stringify({ active: true, allowed_patterns: ["src/**"] }));
		const r = pi(env, script([{ tools: [{ tool: "write", args: { path: "docs/x.md", content: "x" } }, { tool: "write", args: { path: "src/ok.ts", content: "export {}\n" } }] }]), { json: true });
		const results = toolResults(r.out);
		const blocked = results.find((x) => x.text.includes("docs/x.md") || x.isError);
		assert(blocked?.isError, `write outside freeze scope not blocked: ${JSON.stringify(results)}`);
		assert(fs.existsSync(path.join(env.repo, "src", "ok.ts")), "allowed write failed");
		assert(!fs.existsSync(path.join(env.repo, "docs", "x.md")), "blocked write happened");
	},

	"PostToolUse advisory reaches the model (js_fp_review)"(env) {
		const r = pi(env, script([{ tool: "write", args: { path: "src/m.js", content: "const a = [];\na.push(1);\nexport default a;\n" } }]));
		assert(r.out.includes("dev-team hook notes:") && r.out.includes("js_fp_review"), r.out.slice(0, 600));
	},

	"pre_pr_review blocks gh pr create without a passing review"(env) {
		env.git("checkout", "-qb", "feature");
		fs.writeFileSync(path.join(env.repo, "f.txt"), "x\n");
		env.git("add", ".");
		env.git("commit", "-qm", "feat");
		const r = pi(env, script([{ tool: "bash", args: { command: "gh pr create --title t --body b" } }]));
		assert(r.out.includes("[pre_pr_review]"), r.out.slice(0, 600));
	},

	"subagent: single dispatch, env and depth"(env) {
		const child = script([{ tool: "bash", args: { command: "echo depth=$DEV_TEAM_SUBAGENT_DEPTH agent=$DEV_TEAM_AGENT_NAME i=[$DEV_TEAM_INTERACTIVE]" } }]);
		const r = pi(env, script([{ tool: "dev_team_subagent", args: { agent: "Explore", task: child } }]));
		assert(r.out.includes("depth=1 agent=Explore i=[]"), r.out);
	},

	"subagent: unknown agent lists available agents"(env) {
		const r = pi(env, script([{ tool: "dev_team_subagent", args: { agent: "nope", task: "x" } }]));
		assert(r.out.includes('Unknown agent "nope"') && r.out.includes("security-review"), r.out.slice(0, 400));
	},

	"subagent: parallel review lenses feed the dispatch and verdict ledgers"(env) {
		fs.mkdirSync(path.join(env.repo, "src"), { recursive: true });
		fs.writeFileSync(path.join(env.repo, "src", "a.js"), "export const a = 1;\n");
		env.git("add", "src/a.js");
		const pass = script([{ text: JSON.stringify({ status: "pass", issues: [], summary: "clean" }) }]);
		const fail = script([{ text: JSON.stringify({ status: "fail", issues: [{ severity: "error", confidence: "high", file: "src/a.js", line: 1, message: "m", suggestedFix: "f" }], summary: "bad" }) }]);
		const r = pi(
			env,
			script([
				{
					tools: [
						{ tool: "dev_team_subagent", args: { agent: "dev-team:security-review", task: `Files in scope for this review: src/a.js\n${pass}` } },
						{ tool: "dev_team_subagent", args: { subagent_type: "test-review", prompt: `Files in scope for this review: src/a.js\n${fail}` } },
					],
				},
			]),
			{ json: true },
		);
		const results = toolResults(r.out).filter((x) => x.tool === "dev_team_subagent");
		assert(results.length === 2 && results.every((x) => !x.isError), JSON.stringify(results).slice(0, 500));
		const verdicts = readJsonl(path.join(env.repo, ".claude", "metrics", "review-verdicts.jsonl"));
		const byLens = Object.fromEntries(verdicts.map((v) => [v.lens, v.outcome]));
		assert(byLens["security-review"] === "pass" && byLens["test-review"] === "findings", JSON.stringify(verdicts));
		assert(verdicts.every((v) => v.plugin_version && v.plugin_version !== "unknown"), "plugin_version not stamped");
		const ledger = readJsonl(path.join(env.repo, ".claude", "metrics", "boundary-events.jsonl")).filter((e) => e.hook === "agent_dispatch_ledger");
		assert(ledger.length === 2 && ledger.every((e) => e.subject_hash), JSON.stringify(ledger));
	},

	"subagent: worktree isolation keeps committed work on its own branch"(env) {
		const child = script([
			{ tool: "write", args: { path: "src/b.js", content: "export const b = 2;\n" } },
			{ tool: "bash", args: { command: "git add src/b.js && git commit -qm 'slice b' && echo committed" } },
		]);
		const r = pi(env, script([{ tool: "dev_team_subagent", args: { agent: "software-engineer", task: child, isolation: "worktree" } }]));
		assert(r.out.includes("worktree kept") && r.out.includes("1 commit(s)") && !r.out.includes("uncommitted"), r.out);
		const branches = execFileSync("git", ["branch", "--list", "dev-team/*"], { cwd: env.repo, encoding: "utf-8" });
		assert(branches.includes("dev-team/software-engineer-"), branches);
		assert(!fs.existsSync(path.join(env.repo, "src", "b.js")), "worktree change leaked into main checkout");
	},

	"subagent: worktree without changes is removed"(env) {
		const r = pi(env, script([{ tool: "dev_team_subagent", args: { agent: "Explore", task: script([{ text: "nothing to do" }]), isolation: "worktree" } }]));
		assert(r.out.includes("worktree removed"), r.out);
		const list = execFileSync("git", ["worktree", "list"], { cwd: env.repo, encoding: "utf-8" });
		assert(list.trim().split("\n").length === 1, list);
	},

	"skill tool expands with args; ask_user is non-interactive in print mode"(env) {
		const r = pi(env, script([{ tools: [{ tool: "skill", args: { name: "/dev-team:review-agent", args: "test-review" } }, { tool: "ask_user", args: { question: "Proceed?", options: ["yes", "no"] } }] }]), { json: true });
		const res = toolResults(r.out);
		const skill = res.find((x) => x.tool === "skill");
		const ask = res.find((x) => x.tool === "ask_user");
		assert(skill && skill.text.includes('<skill name="review-agent"') && skill.text.includes("`test-review`"), JSON.stringify(skill).slice(0, 300));
		assert(ask && ask.text.startsWith("NON-INTERACTIVE"), JSON.stringify(ask));
	},

	"subagent usage reaches pi session totals through the tool result"(env) {
		const two = script([{ text: "a" }]);
		const r = pi(env, script([{ tools: [{ tool: "dev_team_subagent", args: { tasks: [{ agent: "Explore", task: two }, { agent: "Explore", task: two }] } }] }]), { json: true });
		const dispatch = toolResults(r.out).find((x) => x.tool === "dev_team_subagent");
		assert(dispatch && !dispatch.isError, JSON.stringify(dispatch));
		const childInput = dispatch.details.results.reduce((n, v) => n + v.usage.input, 0);
		assert(childInput > 0 && dispatch.usage?.input === childInput, `tool result usage ${JSON.stringify(dispatch.usage)} vs children ${childInput}`);
		assert(typeof dispatch.usage.cost?.total === "number" && dispatch.usage.totalTokens > 0, JSON.stringify(dispatch.usage));
		assert(dispatch.details.results.every((v) => v.status === "ok" && v.ok && v.turns >= 1), JSON.stringify(dispatch.details));
	},

	"subagent: project agents need a trust decision"(env) {
		const agentDir = path.join(env.repo, ".claude", "agents");
		fs.mkdirSync(agentDir, { recursive: true });
		fs.writeFileSync(path.join(agentDir, "local-only.md"), "---\nname: local-only\ndescription: probe\ntools: Read\n---\nLOCAL_AGENT_PROMPT\n");
		fs.writeFileSync(path.join(agentDir, "security-review.md"), "---\nname: security-review\ndescription: override\ntools: Read\n---\nPROJECT_OVERRIDE_PROMPT\n");
		const probe = script([{ inspect: "runtime" }]);
		const call = script([{ tools: [{ tool: "dev_team_subagent", args: { tasks: [{ agent: "local-only", task: probe }, { agent: "security-review", task: probe }] } }] }]);

		// untrusted (print mode, no saved decision, defaultProjectTrust "ask"): package agents only
		let r = pi(env, call, { json: true });
		let d = toolResults(r.out).find((x) => x.tool === "dev_team_subagent");
		assert(d?.details?.untrustedProjectAgents?.sort().join(",") === "local-only,security-review", JSON.stringify(d?.details));
		assert(d.text.includes('Unknown agent "local-only"') && d.text.includes("project agents not run"), d.text.slice(0, 600));
		const pkgRun = d.details.results.find((v) => v.agent === "security-review");
		assert(pkgRun?.ok && pkgRun.source === "package" && !d.text.includes("PROJECT_OVERRIDE_PROMPT"), JSON.stringify(pkgRun));

		// --approve: project agents (and the override) run
		r = pi(env, call, { json: true, extra: ["--approve"] });
		d = toolResults(r.out).find((x) => x.tool === "dev_team_subagent");
		assert(!d.details.untrustedProjectAgents && d.details.results.every((v) => v.ok && v.source === "project"), JSON.stringify(d.details));
		assert(d.text.includes("LOCAL_AGENT_PROMPT") && d.text.includes("PROJECT_OVERRIDE_PROMPT"), d.text.slice(0, 600));

		// a saved /trust decision counts too
		fs.mkdirSync(path.join(env.home, ".pi", "agent"), { recursive: true });
		fs.writeFileSync(path.join(env.home, ".pi", "agent", "trust.json"), JSON.stringify({ [fs.realpathSync(env.repo)]: true }));
		r = pi(env, call, { json: true });
		d = toolResults(r.out).find((x) => x.tool === "dev_team_subagent");
		assert(!d.details.untrustedProjectAgents, `saved trust ignored: ${JSON.stringify(d.details)} ${fs.readFileSync(path.join(env.home, ".pi", "agent", "trust.json"), "utf-8")}`);
	},

	"cost meter row includes main and subagent spend by agent type"(env) {
		pi(env, script([{ tool: "dev_team_subagent", args: { agent: "security-review", task: script([{ text: "{}" }]) } }]));
		const rows = readJsonl(path.join(env.repo, ".claude", "metrics", "cost-metering.jsonl"));
		const row = rows.at(-1);
		assert(row?.session_id && row.by_agent_type?.main && row.by_agent_type["dev-team:security-review"], JSON.stringify(row));
		assert(row.by_thread.subagent.input_tokens > 0 && row.total.messages >= 3, JSON.stringify(row.total));
	},

	"claude -p shim runs an agent through pi and returns a Claude envelope"(env) {
		const inner = script([{ text: '{"status":"pass","issues":[],"summary":"via shim"}' }]);
		const cmd = `claude -p --agent dev-team:security-review --model opus --output-format json '${inner}'`;
		const r = pi(env, script([{ tool: "bash", args: { command: cmd } }]));
		const json = JSON.parse(r.out.replace(/^ECHO:/, "").trim());
		assert(json.type === "result" && json.is_error === false && json.result.includes("via shim"), r.out);
	},

	"subagent collision: dev-team loaded before external extension"(env) {
		assertSubagentCoexistence(env, { extra: ["-e", EXTERNAL_SUBAGENT] });
	},

	"subagent collision: external extension loaded before dev-team"(env) {
		assertSubagentCoexistence(env, { usePackageFlag: false, extra: ["-e", EXTERNAL_SUBAGENT, "-e", PKG] });
	},

	"subagent: parent/child prompts and depth limits preserve the external tool"(env) {
		const agentDir = path.join(env.repo, ".pi", "agents");
		fs.mkdirSync(agentDir, { recursive: true });
		fs.writeFileSync(path.join(agentDir, "collision-probe.md"), "---\nname: collision-probe\ndescription: Offline mapping probe\ntools: Read, Agent, Task, subagent\n---\nInspect the runtime tools and prompt.\n");
		// project agents need an explicit trust decision
		const options = { extra: ["-e", EXTERNAL_SUBAGENT, "--approve"] };
		const parent = pi(env, script([{ inspect: "runtime" }]), options);
		assert(parent.code === 0, parent.err);
		const parentRuntime = JSON.parse(parent.out);
		assert(parentRuntime.tools.includes("dev_team_subagent") && parentRuntime.tools.includes("subagent"), JSON.stringify(parentRuntime.tools));
		assert(parentRuntime.systemPrompt.includes("Agent/Task(subagent_type=X, prompt=P)=dev_team_subagent(agent=X, task=P)"), "parent prompt maps dispatch to the wrong tool");
		assert(!parentRuntime.systemPrompt.includes("=subagent(agent=X, task=P)"), "parent prompt still maps dispatch to the external tool");

		const inspectChild = () => {
			const r = pi(env, script([{ tool: "dev_team_subagent", args: { agent: "collision-probe", task: script([{ inspect: "runtime" }]) } }]), { ...options, json: true });
			assert(r.code === 0, r.err);
			const dispatch = toolResults(r.out).find((x) => x.tool === "dev_team_subagent");
			assert(dispatch && !dispatch.isError && dispatch.details?.results?.[0]?.ok, JSON.stringify(dispatch));
			const runtime = JSON.parse(dispatch.text);
			assert(runtime.systemPrompt.includes("Agent/Task=dev_team_subagent."), "child prompt maps dispatch to the wrong tool");
			assert(!runtime.systemPrompt.includes("Agent/Task=subagent."), "child prompt still maps dispatch to the external tool");
			assert(runtime.tools.includes("subagent"), "external tool was removed by dev-team's depth safeguard");
			return runtime;
		};
		assert(inspectChild().tools.includes("dev_team_subagent"), "Claude Agent/Task did not enable namespaced child dispatch");
		fs.writeFileSync(path.join(env.repo, ".pi", "dev-team.json"), JSON.stringify({ maxSubagentDepth: 1 }));
		assert(!inspectChild().tools.includes("dev_team_subagent"), "namespaced dispatch remains active at the depth limit");
		const child = pi(env, script([{ tool: "dev_team_subagent", args: { agent: "collision-probe", task: script([{ tool: "subagent", args: { task: "depth-probe" } }]) } }]), { ...options, json: true });
		const dispatch = toolResults(child.out).find((x) => x.tool === "dev_team_subagent");
		assert(child.code === 0 && dispatch && !dispatch.isError && dispatch.text.includes("EXTERNAL_SUBAGENT:depth-probe"), `external tool was blocked at dev-team's depth limit: ${JSON.stringify(dispatch)} ${child.err}`);
	},

	"installed package (no -e) subagent collision keeps child hooks"(env) {
		const inst = spawnSync("pi", ["install", PKG], {
			env: { ...process.env, HOME: env.home, PI_CODING_AGENT_DIR: path.join(env.home, ".pi", "agent") },
			encoding: "utf-8",
			cwd: env.repo,
		});
		assert(inst.status === 0, `pi install failed: ${inst.stderr}`);
		assertSubagentCoexistence(env, { usePackageFlag: false, extra: ["-e", EXTERNAL_SUBAGENT] });
	},
};

let failed = 0;
let ran = 0;
for (const [name, fn] of Object.entries(scenarios)) {
	if (filter && !name.includes(filter)) continue;
	const env = setupRepo();
	const started = Date.now();
	ran++;
	try {
		await fn(env);
		console.log(`ok   ${name} (${Date.now() - started} ms)`);
		fs.rmSync(env.root, { recursive: true, force: true });
	} catch (e) {
		failed++;
		console.log(`FAIL ${name} (${Date.now() - started} ms)\n     ${String(e.message).split("\n").join("\n     ")}\n     repo kept at ${env.root}`);
	}
}
console.log(`\n${ran - failed}/${ran} scenarios passed`);
process.exit(failed ? 1 : 0);
