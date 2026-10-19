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
	FLOW_SKILLS,
	isMutatingBash,
	lintBrief,
	MAX_GLANCE_LINES,
	NEW_WORK_SKILLS,
	parseDiff,
	registerBriefTool,
	renderBrief,
	saveBrief,
	sizeAdvisory,
} from "../../extensions/dev-team/lib/brief.ts";

// ---------------------------------------------------------------- isMutatingBash

const CWD = path.resolve("/repo");

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

// `>&2` and `2>&1` copy a stream: they write no file.
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

// A word that is only partly quoted still holds an unquoted redirect.
for (const command of ["echo x >\"out.txt\"", "cat a >\"$F\"", "echo \"x\">f", "echo x>'f'"]) {
	test(`isMutatingBash flags the unquoted redirect in the partly quoted word of ${JSON.stringify(command)}`, () => {
		assert.equal(isMutatingBash(command), true);
	});
}

for (const command of ["echo $(rm x)", 'echo "$(touch f)"', "x=$(git commit -m m)", "echo $(echo $(rm a))", "echo `touch`", "x=`touch`"]) {
	test(`isMutatingBash flags the command the shell runs inside ${JSON.stringify(command)}`, () => {
		assert.equal(isMutatingBash(command), true);
	});
}

for (const command of ["echo $(cat f)", "echo '$(rm x)'", "echo '`rm x`'", "echo $(git status)"]) {
	test(`isMutatingBash lets the read-only or quoted substitution in ${JSON.stringify(command)} pass`, () => {
		assert.equal(isMutatingBash(command), false);
	});
}

// The shell runs a backtick command whatever spaces it holds, and also inside double quotes.
for (const command of ["echo `rm x`", 'echo "`rm x`"', "x=`git commit -m m`"]) {
	test(`isMutatingBash flags the backtick command with arguments in ${JSON.stringify(command)}`, () => {
		assert.equal(isMutatingBash(command), true);
	});
}

test("isMutatingBash ignores a write inside a substitution when its target is outside the project", () => {
	assert.equal(isMutatingBash("echo $(rm /tmp/x)", CWD), false);
	assert.equal(isMutatingBash("echo $(rm src/x)", CWD), true);
});

function withHome(t: TestContext, home: string): void {
	const old = process.env.HOME;
	process.env.HOME = home;
	t.after(() => {
		if (old === undefined) delete process.env.HOME;
		else process.env.HOME = old;
	});
}

for (const command of [
	"echo x > /tmp/a",
	"echo x > $TMPDIR/a",
	"echo x > ${TMPDIR}/a",
	"echo x > ~/a",
	"echo x > /dev/null",
	"echo x > /dev/stderr",
	"mkdir /tmp/d",
	"mkdir -p /tmp/a /tmp/b",
	"touch ~/notes.txt",
	"rm -f /tmp/x",
	"cp /tmp/a /tmp/b",
]) {
	test(`isMutatingBash lets ${JSON.stringify(command)} pass: it writes outside the project`, (t) => {
		withHome(t, path.resolve("/home/u"));
		assert.equal(isMutatingBash(command, path.resolve("/home/u/repo")), false);
	});
}

for (const command of ["echo x > /home/u/repo/a", "echo x > ~/repo/a", "mkdir src/d", "rm /tmp/x src/a", "echo x > sub/../a", "cp /tmp/a b"]) {
	test(`isMutatingBash flags ${JSON.stringify(command)}: it writes inside the project`, (t) => {
		withHome(t, path.resolve("/home/u"));
		assert.equal(isMutatingBash(command, path.resolve("/home/u/repo")), true);
	});
}

test("isMutatingBash flags a ~ path when the project is the home folder itself", (t) => {
	withHome(t, path.resolve("/home/u"));
	assert.equal(isMutatingBash("echo x > ~/a", path.resolve("/home/u")), true);
});

test("isMutatingBash without a cwd still flags writes to absolute and ~ paths", () => {
	assert.equal(isMutatingBash("echo x > /tmp/a"), true);
	assert.equal(isMutatingBash("mkdir /tmp/d"), true);
	assert.equal(isMutatingBash("echo x > ~/a"), true);
	assert.equal(isMutatingBash("echo x > $TMPDIR/a"), false);
});

// The shell computes this target, so its text says nothing about where it is.
test("isMutatingBash flags a redirect whose target is computed by a substitution", () => {
	assert.equal(isMutatingBash('echo x > "$(pwd)/a"', CWD), true);
});

for (const command of ["echo x > .claude/a", "mkdir -p .dev-team-reports/r", "touch .claude/memory/x.json", `echo x > ${path.join(CWD, ".claude", "m")}`]) {
	test(`isMutatingBash lets ${JSON.stringify(command)} pass: it writes the team's own state`, () => {
		assert.equal(isMutatingBash(command, CWD), false);
	});
}

test("isMutatingBash flags a lookalike of the state folders", () => {
	assert.equal(isMutatingBash("touch .claudex", CWD), true);
	assert.equal(isMutatingBash("echo x > .dev-team-reports-old/a", CWD), true);
});

for (const command of ["echo -n>f", "echo a-b>f", "echo a=b>f", "x=1>f", "echo a=b>>f"]) {
	test(`isMutatingBash flags the redirect glued to a word with - or = in ${JSON.stringify(command)}`, () => {
		assert.equal(isMutatingBash(command), true);
	});
}

for (const command of ["echo 'a>|b'", 'echo "x >| y"', "echo x '>|' y", "echo a\\>\\|b"]) {
	test(`isMutatingBash treats the quoted >| in ${JSON.stringify(command)} as text`, () => {
		assert.equal(isMutatingBash(command), false);
	});
}

for (const command of ["ls >|out", "echo x >| f"]) {
	test(`isMutatingBash flags the clobbering redirect in ${JSON.stringify(command)}`, () => {
		assert.equal(isMutatingBash(command), true);
	});
}

const HEREDOC_ARG = "\"$(cat <<'EOF'\na > b\nEOF\n)\"";

test("isMutatingBash treats a > in a $(cat <<'EOF') body as text", () => {
	assert.equal(isMutatingBash(`git log --grep ${HEREDOC_ARG}`), false);
	assert.equal(isMutatingBash(`echo ${HEREDOC_ARG}`), false);
	assert.equal(isMutatingBash("x=$(cat <<'EOF'\na > b\nEOF\n)"), false);
});

test("isMutatingBash still flags a real redirect after a $(cat <<'EOF') argument", () => {
	assert.equal(isMutatingBash(`echo ${HEREDOC_ARG} > out.txt`), true);
	assert.equal(isMutatingBash(`gh pr create --body ${HEREDOC_ARG}`), true);
});

for (const command of [
	"git stash list",
	"git stash show",
	"git stash show -p stash@{1}",
	"git tag",
	"git tag -l",
	"git tag --list 'v*'",
	"git tag --contains HEAD",
	"git tag --points-at HEAD",
	"git worktree list",
	"git branch",
	"git branch -a",
	"git branch -r",
	"git branch -vv",
	"git branch --list 'feat*'",
	"git branch --all",
]) {
	test(`isMutatingBash lets the git list form ${JSON.stringify(command)} pass`, () => {
		assert.equal(isMutatingBash(command), false);
	});
}

for (const command of [
	"git stash",
	"git stash push -m x",
	"git stash pop",
	"git stash drop",
	"git stash apply",
	"git tag v1",
	"git tag -a v1 -m x",
	"git tag -d v1",
	"git worktree add ../x",
	"git worktree remove ../x",
	"git worktree prune",
	"git branch new",
	"git branch -d old",
	"git branch -D old",
	"git branch -m a b",
	"git branch --delete old",
	"git branch -c a b",
]) {
	test(`isMutatingBash flags the git change ${JSON.stringify(command)}`, () => {
		assert.equal(isMutatingBash(command), true);
	});
}

for (const command of ["go version", "go test ./...", "go build ./...", "go vet ./...", "go env GOPATH", "npm view x", "npm ls", "cargo build", "cargo test", "uv run pytest", "pip list", "pip3 show x", "brew list"]) {
	test(`isMutatingBash lets the read-only tool command ${JSON.stringify(command)} pass`, () => {
		assert.equal(isMutatingBash(command), false);
	});
}

for (const command of ["go get example.com/x", "go mod tidy", "go install ./cmd/x", "go generate ./...", "npm i", "pnpm add x", "yarn remove x", "bun install", "cargo add x", "uv sync", "uv add x", "pip3 install x", "gem install x", "brew install x"]) {
	test(`isMutatingBash flags the dependency change ${JSON.stringify(command)}`, () => {
		assert.equal(isMutatingBash(command), true);
	});
}

// ---------------------------------------------------------------- BriefGate

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
	assert.match(reason, /\/specs from the previous request/);
});

test("BriefGate opens for the extra skills it is given, such as user commands", () => {
	const gate = new BriefGate(new Set([...FLOW_SKILLS, "code-review", "pr"]));
	gate.noteSkill("dev-team:code-review");
	assert.equal(gate.open, true);
	assert.equal(gate.lastFlow, "code-review");
	assert.equal(new BriefGate().briefPosted("tiny"), true, "the default set still works");
	const plain = new BriefGate();
	plain.noteSkill("code-review");
	assert.equal(plain.open, false, "the default set holds only the flow skills");
});

test("NEW_WORK_SKILLS holds the commands that start new work, all of them flow skills", () => {
	assert.deepEqual([...NEW_WORK_SKILLS].sort(), ["autoship", "fix", "ship", "specs"]);
	for (const name of NEW_WORK_SKILLS) assert.ok(FLOW_SKILLS.has(name), name);
});

test("newRequest says no on a fresh gate and after a request that ran no flow", () => {
	const gate = new BriefGate();
	assert.equal(gate.newRequest(), false);
	gate.briefPosted("tiny");
	assert.equal(gate.newRequest(), false);
});

test("newRequest says yes after a request that ran a flow skill or a /command, and keeps lastFlow", () => {
	const gate = new BriefGate();
	gate.noteSkill("ship");
	assert.equal(gate.newRequest(), true);
	assert.equal(gate.lastFlow, "ship");
	gate.commandRan("/build");
	assert.equal(gate.newRequest(), true);
	assert.equal(gate.lastFlow, "build");
});

test("newRequest keeps the flow across a chain of resume briefs", () => {
	const gate = new BriefGate();
	gate.commandRan("/specs");
	for (let i = 0; i < 3; i++) {
		assert.equal(gate.newRequest(), true, `request ${i}`);
		assert.equal(gate.briefPosted("resume"), true, `resume ${i}`);
		assert.equal(gate.lastFlow, "specs");
	}
});

test("newRequest forgets lastFlow once a request neither ran nor resumed the flow", () => {
	const gate = new BriefGate();
	gate.noteSkill("ship");
	assert.equal(gate.newRequest(), true);
	gate.briefPosted("tiny");
	assert.equal(gate.newRequest(), false);
	assert.equal(gate.lastFlow, undefined);
	assert.equal(gate.briefPosted("resume"), false);
	assert.equal(gate.open, false);
	assert.doesNotMatch(gate.blockReason(), /resume/);
});

test("newRequest forgets lastFlow after a request with only a question", () => {
	const gate = new BriefGate();
	gate.noteSkill("ship");
	gate.newRequest();
	gate.briefPosted("question");
	assert.equal(gate.newRequest(), false);
	assert.equal(gate.lastFlow, undefined);
});

test("a resume brief after a tiny brief in the same request keeps the gate open and the kind tiny", () => {
	const gate = new BriefGate();
	gate.briefPosted("tiny");
	assert.equal(gate.briefPosted("resume"), true);
	assert.equal(gate.kind, "tiny");
	assert.equal(gate.newRequest(), false, "a tiny brief resumed no flow");
});

for (const later of ["question", "vague", "resume"] as const) {
	for (const first of ["tiny", "feature"] as const) {
		test(`a ${later} brief after a ${first} brief keeps the kind ${first}`, () => {
			const gate = new BriefGate();
			gate.briefPosted(first);
			assert.equal(gate.briefPosted(later), true);
			assert.equal(gate.kind, first);
		});
	}

	test(`a ${later} brief while a flow keeps the gate open sets no kind`, () => {
		const gate = new BriefGate();
		gate.noteSkill("ship");
		gate.briefPosted(later);
		assert.equal(gate.kind, undefined);
		assert.equal(gate.open, true);
	});
}

test("a tiny brief after a question replaces the kind", () => {
	const gate = new BriefGate();
	gate.briefPosted("question");
	gate.briefPosted("tiny");
	assert.equal(gate.kind, "tiny");
});

test("BriefGate.check lets bash writes to state and outside paths pass and blocks a substitution that writes", () => {
	const gate = new BriefGate();
	assert.equal(gate.check("bash", { command: "echo x > .claude/a" }, CWD), undefined);
	assert.equal(gate.check("bash", { command: "echo x > /tmp/a" }, CWD), undefined);
	assert.ok(gate.check("bash", { command: "echo $(rm src/a)" }, CWD));
});

// ---------------------------------------------------------------- sizeAdvisory

const numstat = (...rows: [string, string][]) => rows.map(([a, r], i) => `${a}\t${r}\tf${i}.ts`).join("\n");
const fromClean = (rows: string, untracked: Record<string, number> = {}) => sizeAdvisory(new Map(), parseDiff(rows, untracked));

test("parseDiff reads numstat rows and untracked files with their line counts, binary rows as 0 lines", () => {
	assert.deepEqual(
		[...parseDiff("3\t2\ta.ts\n-\t-\timg.png\n", { "new.ts": 7, "a.ts": 99 })],
		[
			["a.ts", 5],
			["img.png", 0],
			["new.ts", 7],
		],
	);
	assert.equal(parseDiff("").size, 0);
});

test("parseDiff leaves out .claude and .dev-team-reports, tracked or untracked", () => {
	const snapshot = parseDiff("1\t0\t.claude/memory/brief.json\n2\t0\t.dev-team-reports/r.md\n3\t0\tsrc/a.ts", {
		".claude/plan.md": 40,
		".dev-team-reports/x/y.md": 9,
		".claudex/a": 1,
	});
	assert.deepEqual([...snapshot], [
		["src/a.ts", 3],
		[".claudex/a", 1],
	]);
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
	const before = parseDiff("1\t0\ta.ts", { "old.txt": 5 });
	const after = parseDiff("1\t0\ta.ts", { "old.txt": 5, "n1.ts": 0, "n2.ts": 0, "n3.ts": 0, "n4.ts": 0 });
	assert.match(sizeAdvisory(before, after) ?? "", /4 files and 0 lines/);
});

test("sizeAdvisory counts the lines of one big new untracked file", () => {
	assert.equal(fromClean("", { "new.ts": 150 }), undefined);
	assert.match(fromClean("", { "new.ts": 151 }) ?? "", /1 files and 151 lines/);
});

const GIT_VARS = ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_COMMON_DIR", "GIT_CEILING_DIRECTORIES"];

/**
 * Clears the git variables a hook or worktree may set, on process.env too (diffSnapshot reads it),
 * until the test ends. `ceiling` stops git from finding a repository above it.
 */
function cleanGitEnv(t: TestContext, ceiling?: string): NodeJS.ProcessEnv {
	const saved = Object.fromEntries(GIT_VARS.map((name) => [name, process.env[name]]));
	for (const name of GIT_VARS) delete process.env[name];
	if (ceiling) process.env.GIT_CEILING_DIRECTORIES = ceiling;
	t.after(() => {
		for (const [name, value] of Object.entries(saved)) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
	});
	return { ...process.env };
}

function gitRepo(t: TestContext, commit = true): string {
	const dir = tempDir(t);
	const env = cleanGitEnv(t);
	const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, env, stdio: "ignore" });
	git("init", "-q");
	git("config", "user.email", "t@example.com");
	git("config", "user.name", "t");
	git("config", "commit.gpgsign", "false");
	fs.writeFileSync(path.join(dir, "a.txt"), "one\ntwo\n");
	fs.writeFileSync(path.join(dir, ".gitignore"), "ignored.txt\n");
	git("add", ".");
	if (commit) git("commit", "-q", "-m", "init");
	return dir;
}

test("diffSnapshot reads changed lines and untracked files with their line counts from a real git repo", (t) => {
	const dir = gitRepo(t);
	assert.equal(diffSnapshot(dir)?.size, 0);
	fs.writeFileSync(path.join(dir, "a.txt"), "one\nTWO\nthree\n");
	fs.writeFileSync(path.join(dir, "new.ts"), "x\ny\n");
	fs.writeFileSync(path.join(dir, "no-newline.ts"), "x\ny\nz");
	fs.writeFileSync(path.join(dir, "empty.ts"), "");
	fs.writeFileSync(path.join(dir, "ignored.txt"), "x\n");
	assert.deepEqual(
		[...(diffSnapshot(dir) ?? [])].sort(),
		[
			["a.txt", 3],
			["empty.ts", 0],
			["new.ts", 2],
			["no-newline.ts", 3],
		],
	);
});

test("diffSnapshot counts a new untracked file over 1 MB as one line too many for a tiny change", (t) => {
	const dir = gitRepo(t);
	fs.writeFileSync(path.join(dir, "big.txt"), "x".repeat(1_000_001));
	assert.deepEqual([...(diffSnapshot(dir) ?? [])], [["big.txt", 151]]);
});

test("diffSnapshot leaves out .claude and .dev-team-reports files, tracked or untracked", (t) => {
	const dir = gitRepo(t);
	fs.mkdirSync(path.join(dir, ".claude", "memory"), { recursive: true });
	fs.mkdirSync(path.join(dir, ".dev-team-reports"));
	fs.writeFileSync(path.join(dir, ".claude", "memory", "brief.json"), "{}\n");
	fs.writeFileSync(path.join(dir, ".dev-team-reports", "r.md"), "a\nb\n");
	fs.writeFileSync(path.join(dir, "src.ts"), "x\n");
	assert.deepEqual([...(diffSnapshot(dir) ?? [])], [["src.ts", 1]]);
	execFileSync("git", ["add", "-A"], { cwd: dir, env: cleanGitEnv(t), stdio: "ignore" });
	execFileSync("git", ["commit", "-q", "-m", "state"], { cwd: dir, env: cleanGitEnv(t), stdio: "ignore" });
	fs.writeFileSync(path.join(dir, ".claude", "memory", "brief.json"), "{\n}\n");
	assert.equal(diffSnapshot(dir)?.size, 0);
});

test("diffSnapshot works in a repo with no commit yet", (t) => {
	const dir = gitRepo(t, false);
	assert.equal(diffSnapshot(dir)?.size, 0, "staged files match the index");
	fs.writeFileSync(path.join(dir, "a.txt"), "one\ntwo\nthree\n");
	fs.writeFileSync(path.join(dir, "new.ts"), "x\n");
	assert.deepEqual(
		[...(diffSnapshot(dir) ?? [])].sort(),
		[
			["a.txt", 1],
			["new.ts", 1],
		],
	);
});

test("diffSnapshot is undefined outside a git repo", (t) => {
	const dir = tempDir(t);
	cleanGitEnv(t, path.dirname(dir));
	assert.equal(diffSnapshot(dir), undefined);
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

test("saveBrief removes its temp file when the rename fails", (t) => {
	const dir = tempDir(t);
	fs.mkdirSync(path.join(dir, BRIEF_FILE), { recursive: true });
	fs.writeFileSync(path.join(dir, BRIEF_FILE, "keep"), "x");
	assert.doesNotThrow(() => saveBrief(dir, tiny, { approved: "tiny" }));
	assert.deepEqual(fs.readdirSync(path.join(dir, ".claude", "memory")), ["brief.json"]);
	assert.deepEqual(fs.readdirSync(path.join(dir, BRIEF_FILE)), ["keep"]);
});

test("saveBrief gives each write its own temp file, so a stale one does not stop it", (t) => {
	const dir = tempDir(t);
	const memory = path.join(dir, ".claude", "memory");
	fs.mkdirSync(memory, { recursive: true });
	fs.writeFileSync(path.join(memory, "brief.json.tmp"), "stale");
	saveBrief(dir, tiny, { approved: "tiny" });
	assert.equal(JSON.parse(fs.readFileSync(path.join(dir, BRIEF_FILE), "utf-8")).approved, "tiny");
	assert.deepEqual(fs.readdirSync(memory).sort(), ["brief.json", "brief.json.tmp"]);
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
	assert.match(r.content[0].text, /Go on with \/ship\./);
});

test("dev_team_brief kind resume after a tiny brief in the same request says it already has a brief", async (t) => {
	const dir = tempDir(t);
	const { execute, gate } = briefTool();
	await execute("1", tiny, undefined, undefined, fakeCtx(dir).ctx);
	const r = await execute("2", { kind: "resume" }, undefined, undefined, fakeCtx(dir).ctx);
	assert.equal(r.content[0].text, "Go on: this request already has a brief.");
	assert.equal(gate.open, true);
	assert.equal(gate.kind, "tiny");
	assert.ok(fs.existsSync(path.join(dir, BRIEF_FILE)), "the tiny brief stays");
});

test("dev_team_brief kind resume is refused once the flow is over", async (t) => {
	const { execute, gate } = briefTool();
	gate.noteSkill("ship");
	gate.newRequest();
	gate.briefPosted("tiny");
	gate.newRequest();
	const r = await execute("1", { kind: "resume" }, undefined, undefined, fakeCtx(tempDir(t)).ctx);
	assert.equal(gate.open, false);
	assert.match(r.content[0].text, /nothing to resume/);
});

for (const kind of ["question", "vague"] as const) {
	test(`dev_team_brief kind ${kind} keeps brief.json when this request already has a tiny brief`, async (t) => {
		const dir = tempDir(t);
		const { execute, gate } = briefTool();
		await execute("1", tiny, undefined, undefined, fakeCtx(dir).ctx);
		await execute("2", { kind }, undefined, undefined, fakeCtx(dir).ctx);
		assert.ok(fs.existsSync(path.join(dir, BRIEF_FILE)));
		assert.equal(gate.kind, "tiny");
	});

	test(`dev_team_brief kind ${kind} keeps brief.json while the previous request's flow may go on`, async (t) => {
		const dir = tempDir(t);
		saveBrief(dir, tiny, { approved: "user" });
		const { execute, gate } = briefTool();
		gate.commandRan("/ship");
		assert.equal(gate.newRequest(), true);
		await execute("1", { kind }, undefined, undefined, fakeCtx(dir).ctx);
		assert.ok(fs.existsSync(path.join(dir, BRIEF_FILE)));
	});

	test(`dev_team_brief kind ${kind} keeps brief.json while a flow runs in this request`, async (t) => {
		const dir = tempDir(t);
		saveBrief(dir, tiny, { approved: "user" });
		const { execute, gate } = briefTool();
		gate.noteSkill("ship");
		await execute("1", { kind }, undefined, undefined, fakeCtx(dir).ctx);
		assert.ok(fs.existsSync(path.join(dir, BRIEF_FILE)));
	});

	test(`dev_team_brief kind ${kind} removes brief.json once the previous flow is over`, async (t) => {
		const dir = tempDir(t);
		saveBrief(dir, tiny, { approved: "user" });
		const { execute, gate } = briefTool();
		gate.commandRan("/ship");
		gate.newRequest();
		gate.newRequest();
		await execute("1", { kind }, undefined, undefined, fakeCtx(dir).ctx);
		assert.equal(fs.existsSync(path.join(dir, BRIEF_FILE)), false);
	});
}

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
