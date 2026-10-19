import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { type TestContext, test } from "node:test";
import {
	BRIEF_FILE,
	type Brief,
	BriefGate,
	type FeatureAnswer,
	isMutatingBash,
	lintBrief,
	MAX_GLANCE_LINES,
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
});

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

// ---------------------------------------------------------------- sizeAdvisory

const numstat = (...rows: [string, string][]) => rows.map(([a, r], i) => `${a}\t${r}\tf${i}.ts`).join("\n");

test("sizeAdvisory stays quiet at 3 files and 150 lines", () => {
	assert.equal(sizeAdvisory(""), undefined);
	assert.equal(sizeAdvisory(numstat(["50", "0"], ["50", "0"], ["25", "25"])), undefined);
});

test("sizeAdvisory speaks up at a 4th file", () => {
	const note = sizeAdvisory(numstat(["1", "0"], ["1", "0"], ["1", "0"], ["1", "0"]));
	assert.match(note ?? "", /4 files and 4 lines/);
	assert.match(note ?? "", /dev_team_brief/);
});

test("sizeAdvisory speaks up at 151 lines", () => {
	assert.match(sizeAdvisory(numstat(["100", "51"])) ?? "", /1 files and 151 lines/);
});

test("sizeAdvisory counts a binary row ('-') as a file with no lines", () => {
	assert.equal(sizeAdvisory("-\t-\timg.png\n100\t50\ta.ts"), undefined);
	assert.match(sizeAdvisory("-\t-\ta.png\n-\t-\tb.png\n-\t-\tc.png\n-\t-\td.png") ?? "", /4 files and 0 lines/);
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

// ---------------------------------------------------------------- registerBriefTool

type Result = { content: { text: string }[]; details: { kind: string; answer?: FeatureAnswer; brief?: string } };
type Execute = (id: string, params: unknown, signal: AbortSignal | undefined, onUpdate: unknown, ctx: unknown) => Promise<Result>;

function briefTool(answer: FeatureAnswer = "go") {
	const gate = new BriefGate();
	const away: { title: string; text: string }[] = [];
	const asked: string[] = [];
	let execute: Execute | undefined;
	registerBriefTool({ registerTool: (def: { execute: Execute }) => (execute = def.execute) } as never, {
		gate,
		approveFeature: async (_ctx, glance) => {
			asked.push(glance);
			return answer === "change" ? { answer, change: "smaller" } : { answer };
		},
		onAway: (title, text) => void away.push({ title, text }),
	});
	return { execute: execute as Execute, gate, away, asked };
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
	assert.equal(JSON.parse(fs.readFileSync(path.join(dir, BRIEF_FILE), "utf-8")).approved, "tiny");
});

const OUTCOMES: { answer: FeatureAnswer; open: boolean; text: RegExp }[] = [
	{ answer: "go", open: true, text: /Approved\. Run \/ship/ },
	{ answer: "away", open: true, text: /Nobody answered.*Run \/ship/s },
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
		if (open) assert.equal(JSON.parse(fs.readFileSync(path.join(dir, BRIEF_FILE), "utf-8")).approved, answer === "go" ? "user" : "no answer");
	});
}
