import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, type TestContext, test } from "node:test";
import { CLOCK_TICK_MS } from "../../extensions/dev-team/lib/live-clock.ts";
import { MODEL_PRESETS } from "../../extensions/dev-team/lib/config.ts";
import { AGENT_PROMPT_FLAG, AGENT_PROMPT_FLAG_VALUE } from "../../extensions/dev-team/lib/subagent.ts";

// Runs in its own process (node --test isolates files), so the Python probe cache starts empty.
type ToolDef = { name: string; exposure?: string; annotations?: Record<string, boolean>; renderResult?: (...args: unknown[]) => unknown };
type Handler = (event: unknown, ctx: unknown) => Promise<unknown>;
type CommandDef = { description?: string; getArgumentCompletions?: (prefix: string) => { value: string }[]; handler: (args: string, ctx: unknown) => Promise<void> | void };

async function loadExtension(opts: { flags?: Record<string, unknown>; config?: Record<string, unknown> } = {}) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dt-load-"));
	const marker = path.join(dir, "probed");
	const fakePython = path.join(dir, "python");
	fs.writeFileSync(fakePython, `#!/bin/sh\ntouch "${marker}"\nexit 1\n`, { mode: 0o755 });
	const savedEnv = { DEV_TEAM_PYTHON: process.env.DEV_TEAM_PYTHON, PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR, DEV_TEAM_SUBAGENT: process.env.DEV_TEAM_SUBAGENT };
	process.env.DEV_TEAM_PYTHON = fakePython;
	// The user's own ~/.pi/agent/dev-team.json must not change what the extension does here.
	process.env.PI_CODING_AGENT_DIR = dir;
	// A run of this suite from inside a dispatched agent must still load the extension as a main session.
	delete process.env.DEV_TEAM_SUBAGENT;
	fs.writeFileSync(path.join(dir, "dev-team.json"), JSON.stringify({ githubStyle: "block", ...opts.config }));
	const tools: Record<string, ToolDef> = {};
	const handlers: Record<string, Handler[]> = {};
	const commands: Record<string, CommandDef> = {};
	// Every API the factory may call is a no-op, except registerTool, registerCommand and on, which are recorded.
	const recorders: Record<string, unknown> = {
		registerTool: (def: ToolDef) => (tools[def.name] = def),
		registerCommand: (name: string, def: CommandDef) => (commands[name] = def),
		on: (event: string, handler: Handler) => (handlers[event] ??= []).push(handler),
		getFlag: (name: string) => opts.flags?.[name],
	};
	const fakePi = new Proxy({}, { get: (_t, key) => recorders[String(key)] ?? (() => undefined) });
	const { default: devTeam } = await import("../../extensions/dev-team/index.ts");
	await devTeam(fakePi as never);
	const cleanup = () => {
		fs.rmSync(dir, { recursive: true, force: true });
		for (const [key, value] of Object.entries(savedEnv)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	};
	/** The tier models /dev-team models saved to this extension's user config file. */
	const savedModels = () => JSON.parse(fs.readFileSync(path.join(dir, "dev-team.json"), "utf-8")).models;
	return { tools, commands, handlers, probedAtLoad: fs.existsSync(marker), probed: () => fs.existsSync(marker), savedModels, cleanup };
}

const loaded = loadExtension();
after(async () => (await loaded).cleanup());

test("loading the extension starts no process (the Python probe waits for first use)", async () => {
	const { probedAtLoad } = await loaded;
	assert.equal(probedAtLoad, false);
});

test("every dev-team tool declares pi's safety hints", async () => {
	const { tools } = await loaded;
	assert.deepEqual(Object.keys(tools).sort(), ["ask_user", "dev_team_subagent", "skill", "web_fetch"]);
	for (const tool of Object.values(tools)) assert.ok(tool.annotations, `${tool.name} has annotations`);
});

test("dev_team_subagent is marked destructive and open-world", async () => {
	const { tools } = await loaded;
	assert.equal(tools.dev_team_subagent.annotations?.readOnlyHint, false);
	assert.equal(tools.dev_team_subagent.annotations?.destructiveHint, true);
	assert.equal(tools.dev_team_subagent.annotations?.openWorldHint, true);
});

test("skill and ask_user are read-only; web_fetch is read-only but open-world", async () => {
	const { tools } = await loaded;
	assert.equal(tools.skill.annotations?.readOnlyHint, true);
	assert.equal(tools.ask_user.annotations?.readOnlyHint, true);
	assert.equal(tools.web_fetch.annotations?.readOnlyHint, true);
	assert.equal(tools.web_fetch.annotations?.openWorldHint, true);
});

test("ask_user is for the model only", async () => {
	const { tools } = await loaded;
	assert.equal(tools.ask_user.exposure, "model-only");
});

test("the system prompt carries the GitHub style guide in block mode", async () => {
	const { handlers } = await loaded;
	const opts: { sections?: Record<string, string> } = {};
	await handlers.before_agent_start[0]({ systemPromptOptions: opts }, { cwd: os.tmpdir(), isProjectTrusted: () => false });
	assert.match(opts.sections?.dev_team ?? "", /GitHub text style/);
});

test("the guide keeps skills that need bash and write out of the orchestrator agent", async () => {
	const { handlers } = await loaded;
	const opts: { sections?: Record<string, string> } = {};
	await handlers.before_agent_start[0]({ systemPromptOptions: opts }, { cwd: os.tmpdir(), isProjectTrusted: () => false });
	const guide = opts.sections?.dev_team ?? "";
	assert.match(guide, /is the session the user talks to, not the orchestrator agent/);
	assert.match(guide, /In that session, run skills that run commands or write files \(\/code-review, \/build, \/pr, \/ship, \/fix/);
	assert.match(guide, /A dispatched agent does its task and reports back; it does not start \/code-review, \/build, \/pr, \/ship or \/fix unless its task or its own agent instructions say to/);
});

test("the main session's guide lists every dev-team skill", async () => {
	const { handlers } = await loaded;
	const opts: { sections?: Record<string, string> } = {};
	await handlers.before_agent_start[0]({ systemPromptOptions: opts }, { cwd: os.tmpdir(), isProjectTrusted: () => false });
	assert.match(opts.sections?.dev_team ?? "", /Dev-team skills \(load with the skill tool/);
	assert.match(opts.sections?.dev_team ?? "", /^- autoship/m);
});

test("a dispatched agent's guide leaves the full skill index out (its own prompt lists its skills)", async () => {
	const child = await loadExtension({ flags: { [AGENT_PROMPT_FLAG]: AGENT_PROMPT_FLAG_VALUE } });
	try {
		const guideFor = async (model: { provider: string; id: string }) => {
			const opts: { sections?: Record<string, string> } = {};
			await child.handlers.before_agent_start[0]({ systemPromptOptions: opts }, { cwd: os.tmpdir(), isProjectTrusted: () => false, model });
			return opts.sections?.dev_team ?? "";
		};
		const guide = await guideFor({ provider: "p", id: "m" });
		assert.match(guide, /GitHub text style/, "the rest of the guide stays");
		assert.doesNotMatch(guide, /^- autoship/m);
		assert.doesNotMatch(guide, /Agent tiers|p\/m/, "no session model in the shared agent prefix");
		assert.equal(await guideFor({ provider: "q", id: "other" }), guide, "agents on different models share one guide");
	} finally {
		child.cleanup();
	}
});

test("the main session's guide names the model each tier runs on", async () => {
	const { handlers } = await loaded;
	const opts: { sections?: Record<string, string> } = {};
	await handlers.before_agent_start[0](
		{ systemPromptOptions: opts },
		{ cwd: os.tmpdir(), isProjectTrusted: () => false, model: { provider: "p", id: "m" } },
	);
	assert.match(opts.sections?.dev_team ?? "", /^- Agent tiers .*opus = this session's model \(p\/m\)/m);
});

test("the main session's guide names the configured models pi knows, and only those", async () => {
	const ext = await loadExtension({ config: { models: { opus: "p/big", sonnet: "p/not-in-catalog" } } });
	try {
		const opts: { sections?: Record<string, string> } = {};
		const modelRegistry = { find: (provider: string, id: string) => (`${provider}/${id}` === "p/big" ? { provider, id } : undefined) };
		await ext.handlers.before_agent_start[0]({ systemPromptOptions: opts }, { cwd: os.tmpdir(), isProjectTrusted: () => false, model: { provider: "p", id: "m" }, modelRegistry });
		assert.match(opts.sections?.dev_team ?? "", /^- Agent tiers .*opus = p\/big, sonnet = \(not a model id\), haiku = this session's model \(p\/m\)/m);
	} finally {
		ext.cleanup();
	}
});

test("a models value that is not a table sets nothing, so the guide still names the default tiers", async () => {
	const ext = await loadExtension({ config: { models: null } });
	try {
		const opts: { sections?: Record<string, string> } = {};
		await ext.handlers.before_agent_start[0]({ systemPromptOptions: opts }, { cwd: os.tmpdir(), isProjectTrusted: () => false, model: { provider: "p", id: "m" } });
		assert.match(opts.sections?.dev_team ?? "", /^- Agent tiers .*fable = this session's model \(p\/m\)\.$/m);
	} finally {
		ext.cleanup();
	}
});

test("the main session's guide names the tiers even without a session model", async () => {
	const { handlers } = await loaded;
	const opts: { sections?: Record<string, string> } = {};
	await handlers.before_agent_start[0]({ systemPromptOptions: opts }, { cwd: os.tmpdir(), isProjectTrusted: () => false });
	assert.match(opts.sections?.dev_team ?? "", /^- Agent tiers .*opus = this session's model[,.]/m);
});

test("agent_settled compacts the main session once context reaches autocompactMaxTokens", async () => {
	const { handlers } = await loaded;
	const saved = process.env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE;
	process.env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE = "100"; // the user's own setting must not decide this test
	try {
		const settle = async (tokens: number) => {
			let compacted = 0;
			const ctx = {
				cwd: os.tmpdir(),
				mode: "tui",
				hasUI: false,
				isProjectTrusted: () => false,
				getContextUsage: () => ({ tokens, contextWindow: 1_000_000, percent: tokens / 10_000 }),
				compact: () => void compacted++,
			};
			await handlers.agent_settled[0]({}, ctx);
			return compacted;
		};
		assert.equal(await settle(199_999), 0, "below the ceiling");
		assert.equal(await settle(200_000), 1, "the default ceiling is 200k tokens");
	} finally {
		if (saved === undefined) delete process.env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE;
		else process.env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE = saved;
	}
});

test("tool_call blocks a breaking gh command before the guard hooks run; the same command sent again reaches them", async () => {
	const { handlers, probed } = await loaded;
	assert.equal(handlers.tool_call?.length, 1);
	const ctx = { cwd: os.tmpdir(), hasUI: false, sessionManager: { getSessionId: () => "s", getSessionFile: () => undefined } };
	const call = (id: string) =>
		handlers.tool_call[0]({ toolName: "bash", toolCallId: id, input: { command: `gh issue create --title "Crash" --body "It simply crashes — always."` } }, ctx) as Promise<
			{ block?: boolean; reason?: string } | undefined
		>;
	const first = await call("1");
	assert.equal(first?.block, true);
	assert.match(first?.reason ?? "", /GitHub style/);
	assert.equal(probed(), false, "no hook ran for the blocked call");
	const resend = await call("2");
	assert.doesNotMatch(resend?.reason ?? "", /GitHub style/);
	assert.equal(probed(), true, "the resend went on to the hooks");
});

test("/dev-team offers usage in its completions and description", async () => {
	const { commands } = await loaded;
	const devTeam = commands["dev-team"];
	assert.deepEqual(devTeam.getArgumentCompletions?.("u"), [{ value: "usage", label: "usage" }]);
	assert.ok(devTeam.getArgumentCompletions?.("").some((c) => c.value === "usage"));
	assert.ok(devTeam.description?.includes("usage"));
});

test("/dev-team usage <unknown> reports the usage line instead of opening anything", async (t) => {
	const { commands } = await loaded;
	const printed: unknown[] = [];
	t.mock.method(console, "log", (...args: unknown[]) => void printed.push(args.join(" ")));
	await commands["dev-team"].handler("usage histroy", { hasUI: false });
	assert.deepEqual(printed, ["Usage: /dev-team usage [session|month]"]);
});

test("a dispatched agent's own prompt goes after the shared guide, not in pi's appended prompt", async () => {
	const child = await loadExtension({ flags: { [AGENT_PROMPT_FLAG]: AGENT_PROMPT_FLAG_VALUE } });
	try {
		const opts: { appendSystemPrompt?: string; sections?: Record<string, string> } = { appendSystemPrompt: "AGENT BODY" };
		await child.handlers.before_agent_start[0]({ systemPromptOptions: opts }, { cwd: os.tmpdir(), isProjectTrusted: () => false });
		assert.equal(opts.appendSystemPrompt, "", "nothing left in pi's appended prompt");
		assert.deepEqual(Object.keys(opts.sections ?? {}), ["dev_team", "dev_team_agent"], "agent section after the guide");
		assert.equal(opts.sections?.dev_team_agent, "AGENT BODY");
	} finally {
		child.cleanup();
	}
});

test("a dispatched agent with an empty appended prompt gets no agent section", async () => {
	const child = await loadExtension({ flags: { [AGENT_PROMPT_FLAG]: AGENT_PROMPT_FLAG_VALUE } });
	try {
		const opts: { appendSystemPrompt?: string; sections?: Record<string, string> } = { appendSystemPrompt: "" };
		await child.handlers.before_agent_start[0]({ systemPromptOptions: opts }, { cwd: os.tmpdir(), isProjectTrusted: () => false });
		assert.deepEqual(Object.keys(opts.sections ?? {}), ["dev_team"]);
	} finally {
		child.cleanup();
	}
});

test("the main session keeps pi's appended prompt where it is", async () => {
	const { handlers } = await loaded;
	const opts: { appendSystemPrompt?: string; sections?: Record<string, string> } = { appendSystemPrompt: "USER APPEND" };
	await handlers.before_agent_start[0]({ systemPromptOptions: opts }, { cwd: os.tmpdir(), isProjectTrusted: () => false });
	assert.equal(opts.appendSystemPrompt, "USER APPEND");
	assert.equal(opts.sections?.dev_team_agent, undefined);
});

/** A fresh extension, and a read through its tool_result handler: the text the model gets, or "passthrough". */
async function readHarness(config?: Record<string, unknown>) {
	const ext = await loadExtension({ config });
	const ctx = { cwd: os.tmpdir(), hasUI: false, mode: "print", sessionManager: { getSessionId: () => "s", getSessionFile: () => undefined } };
	const text = "line\n".repeat(1000);
	const result = async (event: Record<string, unknown>) => {
		const r = (await ext.handlers.tool_result[0]({ toolName: "read", toolCallId: "x", input: { path: "big.ts" }, content: [{ type: "text", text }], isError: false, ...event }, ctx)) as
			| { content?: { text: string }[] }
			| undefined;
		return r?.content?.[0].text ?? "passthrough";
	};
	const endTurn = async () => {
		for (const h of ext.handlers.turn_end) await h({}, ctx);
	};
	const fire = async (event: string) => {
		for (const h of ext.handlers[event] ?? []) await h({}, ctx);
	};
	return { ext, result, endTurn, fire };
}

test("a repeated read in a later turn reaches the model as a note", async () => {
	const { ext, result, endTurn } = await readHarness();
	try {
		assert.equal(await result({}), "passthrough", "first read");
		await endTurn();
		assert.match(await result({}), /big\.ts is unchanged/);
	} finally {
		ext.cleanup();
	}
});

test("compaction and a branch switch forget earlier reads", async () => {
	for (const event of ["session_compact", "session_tree"]) {
		const { ext, result, endTurn, fire } = await readHarness();
		try {
			await result({});
			await endTurn();
			await fire(event);
			assert.equal(await result({}), "passthrough", event);
		} finally {
			ext.cleanup();
		}
	}
});

test("nested, failed and non-text reads, other tools and readDedup off are never noted", async () => {
	const nested = { parentToolCallId: "p" };
	// Long enough to be noted on text alone, so only the text-only rule keeps it out.
	const withImage = { content: [{ type: "text", text: "line\n".repeat(1000) }, { type: "image", data: "", mimeType: "image/png" }] };
	const cases: [string, Record<string, unknown> | undefined, Record<string, unknown>, Record<string, unknown>][] = [
		["a script repeats the model's read", undefined, {}, nested],
		["the model repeats a script's read", undefined, nested, {}],
		["failed read", undefined, { isError: true }, { isError: true }],
		["text with an image", undefined, withImage, withImage],
		["bash with the same output", undefined, { toolName: "bash" }, { toolName: "bash" }],
		["readDedup off", { readDedup: false }, {}, {}],
	];
	for (const [label, config, first, second] of cases) {
		const { ext, result, endTurn } = await readHarness(config);
		try {
			await result(first);
			await endTurn();
			assert.doesNotMatch(await result(second), /is unchanged/, label);
		} finally {
			ext.cleanup();
		}
	}
});

test("/dev-team doctor: tier rows with their status, then the tip for the session's provider", async (t) => {
	// opus is the session model and haiku is mapped elsewhere, so the advice is about sonnet. Its preset model
	// has no auth here, so the tip names it instead of the custom steps.
	const presetModels = MODEL_PRESETS["github-copilot"];
	const ext = await loadExtension({ config: { models: { haiku: "github-copilot/gpt-5-mini", sonnet: "inherit", opus: "inherit", fable: "nowhere/model" } } });
	try {
		const printed: string[] = [];
		t.mock.method(console, "log", (...args: unknown[]) => void printed.push(args.join(" ")));
		const authByModel: Record<string, boolean> = { "github-copilot/gpt-5-mini": true, [presetModels.sonnet]: false };
		const [provider, ...id] = presetModels.opus.split("/");
		const ctx = {
			hasUI: false,
			cwd: os.tmpdir(),
			isProjectTrusted: () => false,
			model: { provider, id: id.join("/") },
			modelRegistry: {
				find: (provider: string, id: string) => (`${provider}/${id}` in authByModel ? { provider, id } : undefined),
				hasConfiguredAuth: (m: { provider: string; id: string }) => authByModel[`${m.provider}/${m.id}`],
			},
		};
		await ext.commands["dev-team"].handler("doctor", ctx);
		const lines = printed.join("\n").split("\n");
		const from = lines.indexOf("model tiers:");
		assert.ok(from > 0, lines.join("\n"));
		// Rows follow DEFAULT_CONFIG's tier order.
		assert.deepEqual(lines.slice(from + 1), [
			`  opus: inherit (${presetModels.opus})`,
			`  sonnet: inherit (${presetModels.opus})`,
			"  haiku: github-copilot/gpt-5-mini ok",
			"  fable: nowhere/model UNKNOWN MODEL",
			`tip: sonnet agents run on ${presetModels.opus}, your session model.`,
			`     preset "github-copilot" needs models this session cannot use: ${presetModels.sonnet} NO AUTH (/login). Pick a model per tier with /dev-team models → custom.`,
		]);
	} finally {
		ext.cleanup();
	}
});

/** A UI that answers each select by its title's start and records what it was offered. */
function scriptedUi(answers: [titleStart: string, answer: (options: string[]) => string | undefined][]) {
	const offered: { title: string; options: string[] }[] = [];
	const select = async (title: string, options: string[]) => {
		offered.push({ title, options });
		return answers.find(([start]) => title.startsWith(start))?.[1](options);
	};
	return { offered, ui: { select, notify: () => undefined } };
}
const modelsCtx = (ui: unknown, extra: Record<string, unknown> = {}) => ({ hasUI: true, cwd: os.tmpdir(), isProjectTrusted: () => false, ui, ...extra });
const userScope = ["Save tier mapping", (o: string[]) => o.find((x) => x.startsWith("user"))] as [string, (o: string[]) => string | undefined];

test("/dev-team models: the menu lists each preset and custom", async () => {
	const ext = await loadExtension();
	try {
		const { offered, ui } = scriptedUi([userScope, ["Map dev-team agent tiers", () => undefined]]);
		await ext.commands["dev-team"].handler("models", modelsCtx(ui));
		const menu = offered.find((o) => o.title.startsWith("Map dev-team agent tiers"));
		assert.deepEqual(menu?.options, [...Object.keys(MODEL_PRESETS).map((p) => `preset: ${p}`), "custom: pick a model per tier"]);
	} finally {
		ext.cleanup();
	}
});

test("/dev-team models: a preset is saved whole", async () => {
	const ext = await loadExtension();
	try {
		const { ui } = scriptedUi([userScope, ["Map dev-team agent tiers", () => "preset: github-copilot"]]);
		await ext.commands["dev-team"].handler("models", modelsCtx(ui));
		assert.deepEqual(ext.savedModels(), MODEL_PRESETS["github-copilot"]);
	} finally {
		ext.cleanup();
	}
});

test("/dev-team models custom: each tier offers its own model first, so taking the first entry keeps it", async () => {
	const ext = await loadExtension({ config: { models: { haiku: "p/mapped" } } });
	try {
		const { offered, ui } = scriptedUi([userScope, ["Map dev-team agent tiers", () => "custom: pick a model per tier"], ["Model for tier", (o) => o[0]]]);
		const registry = { getAvailable: () => [{ provider: "p", id: "mapped" }, { provider: "p", id: "other" }] };
		await ext.commands["dev-team"].handler("models", modelsCtx(ui, { modelRegistry: registry }));
		assert.deepEqual(offered.find((o) => o.title.startsWith('Model for tier "haiku"'))?.options, ["p/mapped (in this file)", "inherit", "p/other"], "its own model first, no duplicate");
		assert.equal(offered.find((o) => o.title.startsWith('Model for tier "sonnet"'))?.options[0], "not set in this file (now inherit)");
		assert.deepEqual(ext.savedModels(), { haiku: "p/mapped" }, "kept; the tiers the file does not set stay unset");
	} finally {
		ext.cleanup();
	}
});

test("/dev-team models custom: a cancelled tier keeps the file's own value", async () => {
	const ext = await loadExtension({ config: { models: { haiku: "p/mapped" } } });
	try {
		const notes: string[] = [];
		const { offered, ui } = scriptedUi([userScope, ["Map dev-team agent tiers", () => "custom: pick a model per tier"], ["Model for tier", () => undefined]]);
		await ext.commands["dev-team"].handler("models", modelsCtx({ ...ui, notify: (text: string) => notes.push(text) }, { modelRegistry: { getAvailable: () => [] } }));
		assert.ok(offered.some((o) => o.title.startsWith('Model for tier "haiku"')), "the tier was offered");
		assert.deepEqual(notes, [`Saved to ${path.join(process.env.PI_CODING_AGENT_DIR ?? "", "dev-team.json")}:\nhaiku = p/mapped`], "saved as the file's own value");
	} finally {
		ext.cleanup();
	}
});

test("/dev-team models custom: a trusted project's own file is read, its value offered first", async (t) => {
	const ext = await loadExtension();
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "dt-project-"));
	t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
	fs.mkdirSync(path.join(cwd, ".pi"));
	fs.writeFileSync(path.join(cwd, ".pi", "dev-team.json"), JSON.stringify({ models: { haiku: "p/mapped" } }));
	try {
		const { offered, ui } = scriptedUi([projectScope, ["Map dev-team agent tiers", () => "custom: pick a model per tier"], ["Model for tier", (o) => o[0]]]);
		await ext.commands["dev-team"].handler("models", modelsCtx(ui, { cwd, isProjectTrusted: () => true, modelRegistry: { getAvailable: () => [] } }));
		assert.equal(offered.find((o) => o.title.startsWith('Model for tier "haiku"'))?.options[0], "p/mapped (in this file)");
	} finally {
		ext.cleanup();
	}
});

const projectScope = ["Save tier mapping", (o: string[]) => o.find((x) => x.startsWith("project"))] as [string, (o: string[]) => string | undefined];
const savedProjectModels = (cwd: string) => JSON.parse(fs.readFileSync(path.join(cwd, ".pi", "dev-team.json"), "utf-8")).models;

test("/dev-team models custom: a project file gets only the tiers picked for it, so the user's other mappings still apply there", async (t) => {
	// The user file maps sonnet and haiku; the project changes only opus.
	const ext = await loadExtension({ config: { models: { sonnet: "p/user", haiku: "p/user-haiku" } } });
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "dt-project-"));
	t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
	try {
		const { offered, ui } = scriptedUi([projectScope, ["Map dev-team agent tiers", () => "custom: pick a model per tier"], ['Model for tier "opus"', () => "p/big"], ["Model for tier", (o) => o[0]]]);
		const registry = { getAvailable: () => [{ provider: "p", id: "user" }, { provider: "p", id: "big" }] };
		await ext.commands["dev-team"].handler("models", modelsCtx(ui, { cwd, isProjectTrusted: () => true, modelRegistry: registry }));
		assert.equal(offered.find((o) => o.title.startsWith('Model for tier "sonnet"'))?.options[0], "not set in this file (now p/user)", "the user's mapping is shown, not offered as the project's");
		assert.deepEqual(savedProjectModels(cwd), { opus: "p/big" }, "no user mapping copied, no inherit written over it");
	} finally {
		ext.cleanup();
	}
});

/** `/dev-team models` custom in an untrusted project whose file maps haiku to an id with escapes; opus is set to a model whose id has one too. */
async function customInUntrustedProject(t: TestContext) {
	const ext = await loadExtension();
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "dt-project-"));
	t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
	fs.mkdirSync(path.join(cwd, ".pi"));
	const file = path.join(cwd, ".pi", "dev-team.json");
	fs.writeFileSync(file, JSON.stringify({ models: { haiku: "p/evil\u001b]52;c;x\u0007" } }));
	try {
		const notes: string[] = [];
		const { offered, ui } = scriptedUi([projectScope, ["Map dev-team agent tiers", () => "custom: pick a model per tier"], ['Model for tier "opus"', () => "p/odd"], ["Model for tier", (o) => o[0]]]);
		const registry = { getAvailable: () => [{ provider: "p", id: "odd\u001b[2J" }] };
		await ext.commands["dev-team"].handler("models", modelsCtx({ ...ui, notify: (text: string) => notes.push(text) }, { cwd, isProjectTrusted: () => false, modelRegistry: registry }));
		return { file, notes, offered, saved: savedProjectModels(cwd) };
	} finally {
		ext.cleanup();
	}
}

test("/dev-team models custom: the file of an untrusted project is not read, and what it sets is left as it is", async (t) => {
	const { offered, saved } = await customInUntrustedProject(t);
	assert.equal(offered.find((o) => o.title.startsWith('Model for tier "haiku"'))?.options[0], "keep what this file sets (not read: project not trusted)");
	assert.deepEqual(saved, { haiku: "p/evil\u001b]52;c;x\u0007", opus: "p/odd\u001b[2J" }, "the picked label saves the model's own id");
});

test("/dev-team models custom: what is saved is shown on one line", async (t) => {
	const { file, notes } = await customInUntrustedProject(t);
	assert.deepEqual(notes, [`Saved to ${file}:\nopus = p/odd`]);
});

/** Doctor's last line in a project whose `.pi/<fileName>` maps sonnet to inherit, on the github-copilot preset's opus. */
async function doctorTipWithProjectFile(t: TestContext, fileName: string, trusted: boolean) {
	const presetModels = MODEL_PRESETS["github-copilot"];
	const ext = await loadExtension();
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "dt-project-"));
	t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
	fs.mkdirSync(path.join(cwd, ".pi"));
	const projectFile = path.join(cwd, ".pi", fileName);
	fs.writeFileSync(projectFile, JSON.stringify({ models: { sonnet: "inherit" } }));
	try {
		const printed: string[] = [];
		t.mock.method(console, "log", (...args: unknown[]) => void printed.push(args.join(" ")));
		const [provider, ...id] = presetModels.opus.split("/");
		const ctx = {
			hasUI: false,
			cwd,
			isProjectTrusted: () => trusted,
			model: { provider, id: id.join("/") },
			modelRegistry: { find: (p: string, i: string) => ({ provider: p, id: i }), hasConfiguredAuth: () => true },
		};
		await ext.commands["dev-team"].handler("doctor", ctx);
		return { projectFile, last: printed.join("\n").split("\n").at(-1) ?? "" };
	} finally {
		ext.cleanup();
	}
}

test("/dev-team doctor: when a trusted project file sets the advised tiers, the tip names that file", async (t) => {
	const { projectFile, last } = await doctorTipWithProjectFile(t, "dev-team.json", true);
	assert.equal(last, `     ${projectFile} sets some of these tiers for this project and wins: change them in that file.`);
});

test("/dev-team doctor: a trusted project's local file is named with the edit-by-hand note", async (t) => {
	const { projectFile, last } = await doctorTipWithProjectFile(t, "dev-team.local.json", true);
	assert.equal(last, `     ${projectFile} sets some of these tiers for this project and wins: change them in that file by hand (/dev-team models does not write it).`);
});

test("/dev-team doctor: an untrusted project's file is not read, so the tip points to the preset", async (t) => {
	const { last } = await doctorTipWithProjectFile(t, "dev-team.json", false);
	assert.match(last, /^ {5}\/dev-team models → preset: github-copilot sets /);
});

test("dev_team_subagent's registered renderer gets pi's render context, so a running row redraws every second", async (t) => {
	const { tools } = await loaded;
	t.mock.timers.enable({ apis: ["setInterval", "Date"], now: 1_000 });
	let redraws = 0;
	const context = { state: {}, invalidate: () => redraws++ };
	const theme = { fg: (_c: string, text: string) => text, bold: (text: string) => text };
	const partial = { content: [], details: { results: [{ agent: "a", task: "t", status: "running", ok: false, turns: 0, recentCalls: [] }] } };
	tools.dev_team_subagent.renderResult?.(partial, { expanded: false, isPartial: true }, theme, context);
	t.mock.timers.tick(2 * CLOCK_TICK_MS);
	assert.equal(redraws, 2);
	const final = { content: [], details: { results: [{ ...partial.details.results[0], status: "ok", ok: true }] } };
	tools.dev_team_subagent.renderResult?.(final, { expanded: false, isPartial: false }, theme, context);
	t.mock.timers.tick(3 * CLOCK_TICK_MS);
	assert.equal(redraws, 2, "the final result stops it");
});

test("dev_team_subagent's execute labels a parallel dispatch's progress and stamps its start", async (t) => {
	const { tools } = await loaded;
	t.mock.timers.enable({ apis: ["Date"], now: 5_000 });
	const updates: { details?: { label?: string; dispatchStartedAt?: number } }[] = [];
	const ctx = { cwd: os.tmpdir(), isProjectTrusted: () => false };
	// Unknown agents fail before any hook or child process, so the dispatch finishes at once.
	const params = { description: "code-review round 2/4", tasks: [{ agent: "no-such-agent-a", task: "x" }, { agent: "no-such-agent-b", task: "y" }] };
	const execute = (tools.dev_team_subagent as unknown as { execute: (...args: unknown[]) => Promise<{ details: { label?: string; dispatchStartedAt?: number } }> }).execute;
	const final = await execute("call-1", params, undefined, (u: (typeof updates)[number]) => updates.push(u), ctx);
	assert.ok(updates.length > 0, "progress was streamed");
	updates.forEach((u, i) => assert.deepEqual([u.details?.label, u.details?.dispatchStartedAt], ["code-review round 2/4", 5_000], `update ${i}`));
	assert.deepEqual([final.details.label, final.details.dispatchStartedAt], ["code-review round 2/4", 5_000], "the final details the view keeps");
});
