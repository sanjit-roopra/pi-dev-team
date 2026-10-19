import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { type TestContext, test } from "node:test";
import {
	BRIEF_FILE,
	type Brief,
	BriefGate,
	bareSkillName,
	clearBrief,
	DEV_TEAM_BRIEF_TOOL,
	diffSnapshot,
	type FeatureAnswer,
	isMutatingBash,
	lintBrief,
	MAX_GLANCE_LINES,
	parseDiff,
	registerBriefTool,
	renderBrief,
	saveBrief,
	sizeAdvisory,
} from "../../extensions/dev-team/lib/brief.ts";

// ---------------------------------------------------------------- isMutatingBash

const READ_ONLY = [
	"ls",
	"ls -la src",
	"cat README.md",
	"git status",
	"git diff HEAD~1",
	"git log --oneline -5",
	"rg foo src",
	"npm test",
	"npm run build",
	"node --test test/unit/brief.test.ts",
	"ls 2>/dev/null",
	"sed -n 1,20p file.ts",
	"gh pr view 12",
	"cat <<EOF\nhi\nEOF",
];

const MUTATING = [
	"rm a.txt",
	"mv a b",
	"mkdir dir",
	"touch f",
	"tee f",
	"echo a | tee b",
	"echo x > f",
	"echo x>>f",
	"ls &> out",
	"ls >| out",
	"sed -i s/a/b/ f",
	"sed --in-place s/a/b/ f",
	"git commit -m x",
	"git add .",
	"git checkout -- f",
	"FOO=1 git push",
	"sudo rm a",
	"/bin/rm x",
	"npm install",
	"gh pr create --title t",
	"cat <<EOF > x\nhi\nEOF",
	"echo hi; rm x",
	"ls && touch x",
];

for (const command of READ_ONLY) {
	test(`isMutatingBash lets the read-only command ${JSON.stringify(command)} pass`, () => {
		assert.equal(isMutatingBash(command), false);
	});
}

for (const command of MUTATING) {
	test(`isMutatingBash flags ${JSON.stringify(command)} as a change`, () => {
		assert.equal(isMutatingBash(command), true);
	});
}

test("isMutatingBash counts git commit as a change whatever its quoted message holds", () => {
	assert.equal(isMutatingBash('git commit -m "a > b"'), true);
});

// Pinned bugs: see final report.
test("isMutatingBash treats a redirect to stderr (>&2) as read-only", () => {
	assert.equal(isMutatingBash("echo hi >&2"), false);
});

test("isMutatingBash treats `> /dev/null 2>&1` as read-only", () => {
	assert.equal(isMutatingBash("ls > /dev/null 2>&1"), false);
});

test("isMutatingBash ignores a > inside a quoted argument", () => {
	assert.equal(isMutatingBash('echo "a > b"'), false);
	assert.equal(isMutatingBash('git log --grep "a > b"'), false);
});

test("isMutatingBash flags perl -pi in-place edits", () => {
	assert.equal(isMutatingBash("perl -pi -e s/a/b/ f"), true);
	assert.equal(isMutatingBash("perl -i -pe 's/a/b/' f"), true);
	assert.equal(isMutatingBash("perl -ne 'print if /a/' f"), false);
});

for (const command of [
	"awk '$1 > 2' data.txt",
	"awk \"{ if (\\$1 > 2) print }\" data.txt",
	"grep -c 'a>b' f",
	"grep \"x >= 1\" src/a.ts",
	"python3 -c 'print(2>1)'",
	"python -c \"print(1 if 2>1 else 0)\"",
	"node -e 'console.log(2>1)'",
	"node -e \"process.exit(1>0 ? 0 : 1)\"",
	"echo 'a>b'",
	"echo \"a>>b\"",
	"echo a\\>b",
]) {
	test(`isMutatingBash treats the quoted > in ${JSON.stringify(command)} as text, not a change`, () => {
		assert.equal(isMutatingBash(command), false);
	});
}

test("isMutatingBash still flags an unquoted glued redirect such as echo x>f", () => {
	assert.equal(isMutatingBash("echo x>f"), true);
	assert.equal(isMutatingBash("echo x >f"), true);
	assert.equal(isMutatingBash("echo x > \"out.txt\""), true);
});

// Production bug: a word that is only partly quoted is skipped whole, so the unquoted redirect in it is missed.
for (const command of ["echo x >\"out.txt\"", "cat a >\"$F\"", "echo \"x\">f", "echo x>'f'"]) {
	test(`isMutatingBash flags the unquoted redirect in the partly quoted word of ${JSON.stringify(command)}`, () => {
		assert.equal(isMutatingBash(command), true);
	});
}

// ---------------------------------------------------------------- BriefGate

const CWD = path.resolve("/repo");

test("BriefGate starts closed and blocks write, edit and mutating bash with a reason naming dev_team_brief", () => {
	const gate = new BriefGate();
	assert.equal(gate.open, false);
	for (const [tool, input] of [
		["write", { path: "src/a.ts" }],
		["edit", { file_path: "src/a.ts" }],
		["bash", { command: "rm a" }],
	] as const) {
		const reason = gate.check(tool, input, CWD);
		assert.ok(reason, `${tool} blocked`);
		assert.match(reason, /dev_team_brief/);
	}
});

test("BriefGate blocks a powershell call before a brief", () => {
	const gate = new BriefGate();
	assert.match(gate.check("powershell", { command: "Get-ChildItem" }, CWD) ?? "", /dev_team_brief/);
	gate.briefPosted("tiny");
	assert.equal(gate.check("powershell", { command: "Set-Content a.txt x" }, CWD), undefined);
});

test("BriefGate lets read, grep and read-only bash through while closed", () => {
	const gate = new BriefGate();
	assert.equal(gate.check("read", { path: "src/a.ts" }, CWD), undefined);
	assert.equal(gate.check("grep", { pattern: "x" }, CWD), undefined);
	assert.equal(gate.check("bash", { command: "git status" }, CWD), undefined);
});

test("BriefGate lets writes to the team's .claude state through while closed", () => {
	const gate = new BriefGate();
	assert.equal(gate.check("write", { path: ".claude/memory/x.json" }, CWD), undefined);
	assert.equal(gate.check("edit", { path: path.join(CWD, ".claude", "plan.md") }, CWD), undefined);
	assert.ok(gate.check("write", { path: ".claudex/a" }, CWD), "a lookalike directory is not state");
});

for (const kind of ["tiny", "feature"] as const) {
	test(`BriefGate opens after a ${kind} brief`, () => {
		const gate = new BriefGate();
		gate.briefPosted(kind);
		assert.equal(gate.open, true);
		assert.equal(gate.kind, kind);
		assert.equal(gate.check("write", { path: "src/a.ts" }, CWD), undefined);
	});
}

for (const kind of ["question", "vague"] as const) {
	test(`BriefGate stays closed after a ${kind} brief`, () => {
		const gate = new BriefGate();
		gate.briefPosted(kind);
		assert.equal(gate.open, false);
		assert.equal(gate.kind, kind);
		assert.ok(gate.check("write", { path: "src/a.ts" }, CWD));
	});
}

for (const name of ["ship", "/ship", "dev-team:ship", "specs", "build", "fix", "autoship", "continue", "plan"]) {
	test(`BriefGate opens when the flow skill ${name} runs`, () => {
		const gate = new BriefGate();
		gate.noteSkill(name);
		assert.equal(gate.open, true);
	});
}

test("BriefGate stays closed when a skill outside the flow runs", () => {
	const gate = new BriefGate();
	gate.noteSkill("code-review");
	gate.noteSkill("/debug");
	assert.equal(gate.open, false);
});

test("BriefGate closes again on a new request and forgets kind and the size warning", () => {
	const gate = new BriefGate();
	gate.briefPosted("tiny");
	gate.noteSkill("ship");
	gate.sizeWarned = true;
	gate.newRequest();
	assert.equal(gate.open, false);
	assert.equal(gate.kind, undefined);
	assert.equal(gate.sizeWarned, false);
});

for (const [name, bare] of [
	["/dev-team:build", "build"],
	["agentic-dev-team:ship", "ship"],
	[" Build ", "build"],
	["/Ship", "ship"],
	["specs", "specs"],
] as const) {
	test(`bareSkillName reads ${JSON.stringify(name)} as ${bare}`, () => {
		assert.equal(bareSkillName(name), bare);
	});
}

test("BriefGate opens for a namespaced or padded flow skill name", () => {
	for (const name of ["/dev-team:build", "agentic-dev-team:ship", " Build "]) {
		const gate = new BriefGate();
		gate.noteSkill(name);
		assert.equal(gate.open, true, name);
		assert.equal(gate.lastFlow, bareSkillName(name));
	}
});

function sizedGate(): BriefGate {
	const gate = new BriefGate();
	gate.briefPosted("tiny");
	gate.sizeWarned = true;
	gate.baseline = new Map([["a.ts", 3]]);
	return gate;
}

test("BriefGate.commandRan opens the gate, remembers the command and forgets the size state", () => {
	const gate = sizedGate();
	gate.newRequest();
	gate.sizeWarned = true;
	gate.baseline = new Map();
	gate.commandRan("/dev-team:review");
	assert.equal(gate.open, true);
	assert.equal(gate.lastFlow, "review");
	assert.equal(gate.kind, undefined);
	assert.equal(gate.sizeWarned, false);
	assert.equal(gate.baseline, undefined);
});

test("BriefGate.noteSkill with a flow skill forgets the size state", () => {
	const gate = sizedGate();
	gate.noteSkill("ship");
	assert.equal(gate.kind, undefined);
	assert.equal(gate.sizeWarned, false);
	assert.equal(gate.baseline, undefined);
});

test("BriefGate.noteSkill with a skill outside the flow keeps the size state", () => {
	const gate = sizedGate();
	gate.noteSkill("code-review");
	assert.equal(gate.kind, "tiny");
	assert.equal(gate.sizeWarned, true);
	assert.ok(gate.baseline);
});

test("BriefGate.briefPosted says whether the gate opened", () => {
	assert.equal(new BriefGate().briefPosted("tiny"), true);
	assert.equal(new BriefGate().briefPosted("feature"), true);
	assert.equal(new BriefGate().briefPosted("question"), false);
	assert.equal(new BriefGate().briefPosted("vague"), false);
});

test("a resume brief keeps the gate closed when no flow ran in the session", () => {
	const gate = new BriefGate();
	gate.noteSkill("code-review");
	assert.equal(gate.briefPosted("resume"), false);
	assert.equal(gate.open, false);
});

test("a resume brief opens the gate on a later request once a flow ran in the session", () => {
	const gate = new BriefGate();
	gate.noteSkill("specs");
	gate.newRequest();
	assert.equal(gate.open, false);
	assert.equal(gate.briefPosted("resume"), true);
	assert.equal(gate.open, true);
	gate.newRequest();
	gate.commandRan("/build");
	gate.newRequest();
	assert.equal(gate.briefPosted("resume"), true);
	assert.equal(gate.lastFlow, "build");
});

test("blockReason mentions resume and the flow only after a flow ran", () => {
	const gate = new BriefGate();
	assert.doesNotMatch(gate.blockReason(), /resume/);
	gate.noteSkill("dev-team:specs");
	gate.newRequest();
	const reason = gate.check("write", { path: "src/a.ts" }, CWD) ?? "";
	assert.match(reason, /pick resume/);
	assert.match(reason, /\/specs/);
});

// ---------------------------------------------------------------- sizeAdvisory

const numstat = (...rows: [string, string][]) => rows.map(([a, r], i) => `${a}\t${r}\tf${i}.ts`).join("\n");
const fromClean = (rows: string, untracked = "") => sizeAdvisory(new Map(), parseDiff(rows, untracked));

test("parseDiff reads numstat rows and untracked files, binary rows as 0 lines", () => {
	assert.deepEqual(
		[...parseDiff("3\t2\ta.ts\n-\t-\timg.png\n", "new.ts\n\na.ts\n")],
		[
			["a.ts", 5],
			["img.png", 0],
			["new.ts", 0],
		],
	);
	assert.equal(parseDiff("").size, 0);
});

test("sizeAdvisory stays quiet at 3 files and 150 lines", () => {
	assert.equal(fromClean(""), undefined);
	assert.equal(fromClean(numstat(["50", "0"], ["50", "0"], ["25", "25"])), undefined);
});

test("sizeAdvisory speaks up at a 4th file", () => {
	const note = fromClean(numstat(["1", "0"], ["1", "0"], ["1", "0"], ["1", "0"]));
	assert.match(note ?? "", /4 files and 4 lines/);
	assert.match(note ?? "", /dev_team_brief/);
});

test("sizeAdvisory speaks up at 151 lines", () => {
	assert.match(fromClean(numstat(["100", "51"])) ?? "", /1 files and 151 lines/);
});

test("sizeAdvisory counts a binary row ('-') as a file with no lines", () => {
	assert.equal(fromClean("-\t-\timg.png\n100\t50\ta.ts"), undefined);
	assert.match(fromClean("-\t-\ta.png\n-\t-\tb.png\n-\t-\tc.png\n-\t-\td.png") ?? "", /4 files and 0 lines/);
});

test("sizeAdvisory ignores files already dirty before the brief", () => {
	const before = parseDiff(numstat(["100", "0"], ["100", "0"], ["100", "0"], ["100", "0"]));
	assert.equal(sizeAdvisory(before, before), undefined);
	const after = parseDiff(`${numstat(["100", "0"], ["100", "0"], ["100", "0"], ["100", "0"])}\n5\t0\tsrc/new.ts`);
	assert.equal(sizeAdvisory(before, after), undefined);
});

test("sizeAdvisory counts only the lines added since the brief to a file dirty before it", () => {
	const before = parseDiff("100\t0\ta.ts");
	assert.equal(sizeAdvisory(before, parseDiff("200\t0\ta.ts")), undefined);
	assert.match(sizeAdvisory(before, parseDiff("251\t0\ta.ts")) ?? "", /1 files and 151 lines/);
});

test("sizeAdvisory counts new untracked files since the brief", () => {
	const before = parseDiff("1\t0\ta.ts", "old.txt");
	const after = parseDiff("1\t0\ta.ts", "old.txt\nn1.ts\nn2.ts\nn3.ts\nn4.ts");
	assert.match(sizeAdvisory(before, after) ?? "", /4 files and 0 lines/);
});

function gitRepo(t: TestContext): string {
	const dir = tempDir(t);
	const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "ignore" });
	git("init", "-q");
	git("config", "user.email", "t@example.com");
	git("config", "user.name", "t");
	git("config", "commit.gpgsign", "false");
	fs.writeFileSync(path.join(dir, "a.txt"), "one\ntwo\n");
	fs.writeFileSync(path.join(dir, ".gitignore"), "ignored.txt\n");
	git("add", ".");
	git("commit", "-q", "-m", "init");
	return dir;
}

test("diffSnapshot reads changed lines and untracked files from a real git repo", (t) => {
	const dir = gitRepo(t);
	assert.equal(diffSnapshot(dir)?.size, 0);
	fs.writeFileSync(path.join(dir, "a.txt"), "one\nTWO\nthree\n");
	fs.writeFileSync(path.join(dir, "new.ts"), "x\n");
	fs.writeFileSync(path.join(dir, "ignored.txt"), "x\n");
	assert.deepEqual(
		[...(diffSnapshot(dir) ?? [])].sort(),
		[
			["a.txt", 3],
			["new.ts", 0],
		],
	);
});

test("diffSnapshot is undefined outside a git repo", (t) => {
	assert.equal(diffSnapshot(tempDir(t)), undefined);
});

// ---------------------------------------------------------------- renderBrief / lintBrief

const tiny: Brief = { kind: "tiny", building: "Add a --quiet flag", doneWhen: "the test passes" };

test("renderBrief shows a tiny brief as 3 lines with 'Assuming: nothing' when nothing is assumed", () => {
	assert.equal(renderBrief(tiny), "Building: Add a --quiet flag\nDone when: the test passes\nAssuming: nothing");
	assert.equal(renderBrief({ ...tiny, assuming: ["  ", ""] }).split("\n")[2], "Assuming: nothing");
	assert.equal(renderBrief({ ...tiny, assuming: ["a", "b"] }).split("\n")[2], "Assuming: a; b");
});

test("renderBrief shows a feature brief under 'At a glance' with bullets", () => {
	const out = renderBrief({ ...tiny, kind: "feature", assuming: ["no config"], slices: ["parse flag", " wire it "] });
	assert.deepEqual(out.split("\n"), [
		"At a glance",
		"Building: Add a --quiet flag",
		"Done when: the test passes",
		"Assuming:",
		"- no config",
		"Steps:",
		"- parse flag",
		"- wire it",
	]);
});

test("renderBrief cuts a long feature brief to MAX_GLANCE_LINES ending in an ellipsis", () => {
	const many = Array.from({ length: 10 }, (_, i) => `item ${i}`);
	const lines = renderBrief({ ...tiny, kind: "feature", assuming: many, slices: many }).split("\n");
	assert.equal(lines.length, MAX_GLANCE_LINES);
	assert.equal(lines.at(-1), "…");
});

test("lintBrief passes a plain brief", () => {
	assert.deepEqual(lintBrief(tiny), []);
});

test("lintBrief flags em-dashes and hedges", () => {
	assert.ok(lintBrief({ ...tiny, building: "Add a flag — quietly" }).some((p) => p.includes("—")));
	assert.ok(lintBrief({ ...tiny, doneWhen: "it might work" }).some((p) => p.includes("might")));
});

for (const kind of ["question", "vague", "resume"] as const) {
	test(`lintBrief has nothing to say about a ${kind} brief, which the user does not see`, () => {
		assert.deepEqual(lintBrief({ kind }), []);
		assert.deepEqual(lintBrief({ kind, building: "Add a flag — it might work" }), []);
	});
}

test("lintBrief does not flag length on a tiny brief", () => {
	const many = Array.from({ length: 10 }, (_, i) => `item ${i}`);
	assert.ok(!lintBrief({ ...tiny, slices: many, assuming: many }).some((p) => p.includes("or fewer")));
});

test("lintBrief flags a feature brief longer than MAX_GLANCE_LINES", () => {
	const many = Array.from({ length: 10 }, (_, i) => `item ${i}`);
	assert.ok(lintBrief({ ...tiny, kind: "feature", slices: many, assuming: many }).some((p) => p.includes(`${MAX_GLANCE_LINES} or fewer`)));
	assert.ok(!lintBrief({ ...tiny, slices: many, assuming: many }).some((p) => p.includes("or fewer")));
});

// ---------------------------------------------------------------- saveBrief

function tempDir(t: TestContext): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "brief-test-"));
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	return dir;
}

test("saveBrief writes .claude/memory/brief.json with the brief, extras and rendered text", (t) => {
	const dir = tempDir(t);
	saveBrief(dir, tiny, { approved: "tiny" });
	const saved = JSON.parse(fs.readFileSync(path.join(dir, BRIEF_FILE), "utf-8"));
	assert.equal(saved.building, tiny.building);
	assert.equal(saved.approved, "tiny");
	assert.equal(saved.text, renderBrief(tiny));
});

test("saveBrief never throws when it cannot write", (t) => {
	const dir = tempDir(t);
	const blocker = path.join(dir, "file");
	fs.writeFileSync(blocker, "x");
	assert.doesNotThrow(() => saveBrief(blocker, tiny, {}));
});

test("saveBrief replaces an older brief.json and leaves no temp file", (t) => {
	const dir = tempDir(t);
	saveBrief(dir, tiny, { approved: "tiny" });
	saveBrief(dir, { ...tiny, building: "Second" }, { approved: "user" });
	assert.equal(JSON.parse(fs.readFileSync(path.join(dir, BRIEF_FILE), "utf-8")).building, "Second");
	assert.deepEqual(fs.readdirSync(path.join(dir, ".claude", "memory")), ["brief.json"]);
});

function linkedBrief(t: TestContext): { dir: string; outside: string; target: string } {
	const dir = tempDir(t);
	const outside = tempDir(t);
	const target = path.join(outside, "victim.txt");
	fs.writeFileSync(target, "keep me");
	fs.mkdirSync(path.join(dir, ".claude", "memory"), { recursive: true });
	fs.symlinkSync(target, path.join(dir, BRIEF_FILE));
	return { dir, outside, target };
}

test("saveBrief refuses a brief.json that is a link and leaves its target untouched", (t) => {
	const { dir, outside, target } = linkedBrief(t);
	saveBrief(dir, tiny, { approved: "tiny" });
	assert.equal(fs.readFileSync(target, "utf-8"), "keep me");
	assert.ok(fs.lstatSync(path.join(dir, BRIEF_FILE)).isSymbolicLink());
	assert.deepEqual(fs.readdirSync(path.join(dir, ".claude", "memory")), ["brief.json"]);
	assert.deepEqual(fs.readdirSync(outside), ["victim.txt"]);
});

for (const linked of [".claude", path.join(".claude", "memory")]) {
	test(`saveBrief writes nothing through a linked ${linked} folder`, (t) => {
		const dir = tempDir(t);
		const outside = tempDir(t);
		fs.mkdirSync(path.dirname(path.join(dir, linked)), { recursive: true });
		fs.symlinkSync(outside, path.join(dir, linked));
		saveBrief(dir, tiny, { approved: "tiny" });
		assert.deepEqual(fs.readdirSync(outside), []);
	});
}

test("clearBrief removes brief.json and is quiet when there is none", (t) => {
	const dir = tempDir(t);
	saveBrief(dir, tiny, {});
	clearBrief(dir);
	assert.equal(fs.existsSync(path.join(dir, BRIEF_FILE)), false);
	assert.doesNotThrow(() => clearBrief(dir));
});

test("clearBrief leaves a linked brief.json and its target alone", (t) => {
	const { dir, target } = linkedBrief(t);
	clearBrief(dir);
	assert.ok(fs.lstatSync(path.join(dir, BRIEF_FILE)).isSymbolicLink());
	assert.equal(fs.readFileSync(target, "utf-8"), "keep me");
});

// ---------------------------------------------------------------- registerBriefTool

type Result = { content: { text: string }[]; details: { kind: string; answer?: FeatureAnswer; brief?: string } };
type Execute = (id: string, params: unknown, signal: AbortSignal | undefined, onUpdate: unknown, ctx: unknown) => Promise<Result>;

function briefTool(answer: FeatureAnswer = "go") {
	const gate = new BriefGate();
	const away: { title: string; text: string }[] = [];
	const asked: string[] = [];
	let def: { execute: Execute; annotations?: { readOnlyHint?: boolean } } | undefined;
	registerBriefTool({ registerTool: (d: typeof def) => (def = d) } as never, {
		gate,
		sessionId: () => "session-1",
		approveFeature: async (_ctx, glance) => {
			asked.push(glance);
			return answer === "change" ? { answer, change: "smaller" } : { answer };
		},
		onAway: (title, text) => void away.push({ title, text }),
	});
	if (!def) throw new Error("dev_team_brief was not registered");
	return { execute: def.execute, def, gate, away, asked };
}

function fakeCtx(cwd: string) {
	const notices: string[] = [];
	return { ctx: { cwd, hasUI: true, ui: { notify: (text: string) => void notices.push(text) } }, notices };
}

for (const kind of ["question", "vague"] as const) {
	test(`dev_team_brief kind ${kind} keeps the gate closed and returns instructions`, async (t) => {
		const dir = tempDir(t);
		const { execute, gate } = briefTool();
		const { ctx } = fakeCtx(dir);
		const r = await execute("1", { ...tiny, kind }, undefined, undefined, ctx);
		assert.equal(gate.open, false);
		assert.equal(gate.kind, kind);
		assert.match(r.content[0].text, kind === "question" ? /No brief needed/ : /Run \/specs/);
		assert.equal(fs.existsSync(path.join(dir, BRIEF_FILE)), false);
	});

	test(`dev_team_brief kind ${kind} removes an older request's brief.json`, async (t) => {
		const dir = tempDir(t);
		saveBrief(dir, tiny, { approved: "tiny" });
		const { execute } = briefTool();
		await execute("1", { kind }, undefined, undefined, fakeCtx(dir).ctx);
		assert.equal(fs.existsSync(path.join(dir, BRIEF_FILE)), false);
	});
}

test("dev_team_brief is registered as a tool that writes", () => {
	const { def } = briefTool();
	assert.equal(def.annotations?.readOnlyHint, false);
	assert.equal(DEV_TEAM_BRIEF_TOOL, "dev_team_brief");
});

test("dev_team_brief kind resume without a flow keeps the gate closed and asks for another kind", async (t) => {
	const { execute, gate } = briefTool();
	const r = await execute("1", { kind: "resume" }, undefined, undefined, fakeCtx(tempDir(t)).ctx);
	assert.equal(gate.open, false);
	assert.match(r.content[0].text, /nothing to resume/);
});

test("dev_team_brief kind resume after a /command opens the gate and names it", async (t) => {
	const { execute, gate } = briefTool();
	gate.commandRan("/ship");
	gate.newRequest();
	const r = await execute("1", { kind: "resume" }, undefined, undefined, fakeCtx(tempDir(t)).ctx);
	assert.equal(gate.open, true);
	assert.match(r.content[0].text, /Go on with \/ship/);
});

for (const kind of ["tiny", "feature"] as const) {
	for (const missing of ["building", "doneWhen"] as const) {
		test(`dev_team_brief kind ${kind} without ${missing} asks again and keeps the gate closed`, async (t) => {
			const dir = tempDir(t);
			const { execute, gate, asked } = briefTool();
			const r = await execute("1", { ...tiny, kind, [missing]: "  " }, undefined, undefined, fakeCtx(dir).ctx);
			assert.equal(gate.open, false);
			assert.equal(asked.length, 0);
			assert.match(r.content[0].text, /needs "building" and "doneWhen".*Call dev_team_brief again/);
			assert.equal(fs.existsSync(path.join(dir, BRIEF_FILE)), false);
		});
	}
}

test("dev_team_brief kind tiny opens the gate, shows the brief and saves it", async (t) => {
	const dir = tempDir(t);
	const { execute, gate, asked } = briefTool();
	const { ctx, notices } = fakeCtx(dir);
	const r = await execute("1", tiny, undefined, undefined, ctx);
	assert.equal(gate.open, true);
	assert.deepEqual(notices, [renderBrief(tiny)]);
	assert.equal(asked.length, 0, "tiny asks nothing");
	assert.match(r.content[0].text, /Go on/);
	const saved = JSON.parse(fs.readFileSync(path.join(dir, BRIEF_FILE), "utf-8"));
	assert.equal(saved.approved, "tiny");
	assert.equal(saved.sessionId, "session-1");
});

test("dev_team_brief kind tiny takes the working tree as the size baseline", async (t) => {
	const dir = gitRepo(t);
	fs.writeFileSync(path.join(dir, "a.txt"), "dirty\n");
	const { execute, gate } = briefTool();
	await execute("1", tiny, undefined, undefined, fakeCtx(dir).ctx);
	assert.deepEqual([...(gate.baseline ?? [])], [["a.txt", 3]]);
});

const OUTCOMES: { answer: FeatureAnswer; open: boolean; text: RegExp }[] = [
	{ answer: "go", open: true, text: /Approved\. Run \/ship/ },
	{ answer: "away", open: true, text: /Nobody answered.*Run \/ship/s },
	{ answer: "noHuman", open: true, text: /go on alone.*Run \/ship/s },
	{ answer: "change", open: false, text: /wants changes to the brief: smaller/ },
	{ answer: "stop", open: false, text: /stopped this/ },
];

for (const { answer, open, text } of OUTCOMES) {
	test(`dev_team_brief kind feature answered ${answer} ${open ? "opens" : "keeps closed"} the gate`, async (t) => {
		const dir = tempDir(t);
		const { execute, gate, away, asked } = briefTool(answer);
		const { ctx } = fakeCtx(dir);
		const feature = { ...tiny, kind: "feature" };
		const r = await execute("1", feature, undefined, undefined, ctx);
		assert.deepEqual(asked, [renderBrief(feature as Brief)]);
		assert.equal(gate.open, open);
		assert.match(r.content[0].text, text);
		assert.equal(away.length, answer === "away" ? 1 : 0, "onAway only when nobody answered");
		assert.equal(fs.existsSync(path.join(dir, BRIEF_FILE)), open);
		if (open) {
			const saved = JSON.parse(fs.readFileSync(path.join(dir, BRIEF_FILE), "utf-8"));
			assert.equal(saved.approved, answer === "go" ? "user" : "no answer");
			assert.equal(saved.sessionId, "session-1");
		}
	});
}
