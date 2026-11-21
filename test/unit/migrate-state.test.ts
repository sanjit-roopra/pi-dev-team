import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { type TestContext, test } from "node:test";
import { MIGRATED_ENTRIES, MIGRATED_MARKER, type MigrateFs, STAGE_SUFFIX, migrateLegacyState, migrationNotice } from "../../extensions/dev-team/lib/migrate-state.ts";
import { STATE_DIR } from "../../extensions/dev-team/lib/state-dir.ts";

/** A throwaway project, home and agent dir, removed after the test. */
function sandbox(t: TestContext) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dt-migrate-"));
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	const project = path.join(dir, "project");
	const home = path.join(dir, "home");
	const agentDir = path.join(dir, "agent");
	fs.mkdirSync(project);
	fs.mkdirSync(home);
	const write = (file: string, text = "x") => {
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, text);
	};
	const old = (...p: string[]) => path.join(project, ".claude", ...p);
	const neu = (...p: string[]) => path.join(project, STATE_DIR, ...p);
	const homeFile = (...p: string[]) => path.join(home, ".claude", ...p);
	const run = (bases = [project], extra: { fs?: MigrateFs; git?: string } = {}) => migrateLegacyState(bases, { home, agentDir, ...extra });
	return { dir, project, home, agentDir, write, old, neu, homeFile, run };
}

const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };

function gitInit(dir: string) {
	execFileSync("git", ["init", "-q"], { cwd: dir, env: GIT_ENV });
	return (...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: dir, env: GIT_ENV, stdio: "ignore" });
}

const errno = (code: string) => Object.assign(new Error(`${code}: injected`), { code });

test("migration moves every dev-team entry from .claude/ to .pi/dev-team/, writes the marker and says so once", (t) => {
	const box = sandbox(t);
	for (const { entry, kind } of MIGRATED_ENTRIES) {
		if (kind === "file") box.write(box.old(entry), `content of ${entry}`);
		else box.write(box.old(entry, "f.txt"), `content of ${entry}`);
	}
	const result = box.run();
	assert.deepEqual(result.errors, []);
	assert.equal(result.error, undefined);
	assert.deepEqual([...result.moved].sort(), MIGRATED_ENTRIES.map((e) => path.join(".claude", e.entry)).sort());
	for (const { entry, kind } of MIGRATED_ENTRIES) {
		const file = kind === "file" ? box.neu(entry) : box.neu(entry, "f.txt");
		assert.equal(fs.readFileSync(file, "utf-8"), `content of ${entry}`, entry);
		assert.equal(fs.existsSync(box.old(entry)), false, `${entry} left behind`);
		assert.equal(fs.existsSync(box.neu(entry) + STAGE_SUFFIX), false, `${entry} stage left behind`);
	}
	assert.ok(fs.existsSync(box.neu(MIGRATED_MARKER)), "marker written");
	assert.match(migrationNotice(result, box.agentDir) ?? "", /^dev-team: one-time state move: moved \.claude\/memory, .* to \.pi\/dev-team\/\.$/);
	const again = box.run();
	assert.deepEqual(again.moved, []);
	assert.equal(migrationNotice(again, box.agentDir), undefined, "nothing moved: no notice");
});

test("migration leaves settings, CLAUDE.md, skills, commands, rules, agents, worktrees and Claude Code's agent-memory in .claude/", (t) => {
	const box = sandbox(t);
	const kept = [
		"settings.json", "settings.local.json", "CLAUDE.md", "skills/s/SKILL.md", "commands/c.md", "rules/r.md", "plugins/p.json", "projects/x.json",
		"agents/a.md", "worktrees/w/file", "hooks/guards.json", "agent-memory/rev/MEMORY.md", "agent-memory-local/rev/MEMORY.md",
	];
	for (const f of kept) box.write(box.old(f));
	box.write(box.old("memory", "brief.json"));
	const result = box.run();
	assert.deepEqual(result.moved, [path.join(".claude", "memory")]);
	for (const f of kept) assert.ok(fs.existsSync(box.old(f)), f);
	assert.equal(fs.existsSync(box.neu("agent-memory")), false);
	assert.equal(fs.existsSync(box.neu("agent-memory-local")), false);
	assert.equal(fs.existsSync(path.join(box.project, ".pi", "skills")), false, "never creates .pi/skills (pi asks for trust)");
	assert.equal(fs.existsSync(path.join(box.project, ".pi", "agents")), false);
	assert.deepEqual(result.left, [path.join(".claude", "agents"), path.join(".claude", "worktrees")]);
	assert.match(migrationNotice(result, box.agentDir) ?? "", /Left \.claude\/agents and \.claude\/worktrees where they are \(project agents now load from \.pi\/agents\)\.$/);
});

test("migration keeps the PR review gate file and the ledgers in .claude/, moves the rest around them and names them", (t) => {
	const box = sandbox(t);
	box.write(box.old("memory", ".pr-review-passed"));
	box.write(box.old("memory", "build-phase.json"), "phase");
	box.write(box.old("metrics", "review-verdicts.jsonl"));
	box.write(box.old("metrics", "review-verdicts-2026.jsonl"));
	box.write(box.old("metrics", "boundary-events.jsonl"));
	box.write(box.old("metrics", "gate-bypass-audit.jsonl"));
	box.write(box.old("metrics", "cost-metering.jsonl"), "cost");
	const result = box.run();
	assert.deepEqual(result.moved, [path.join(".claude", "memory"), path.join(".claude", "metrics")]);
	assert.deepEqual(fs.readdirSync(box.old("memory")), [".pr-review-passed"]);
	assert.deepEqual(fs.readdirSync(box.neu("memory")), ["build-phase.json"]);
	assert.deepEqual(fs.readdirSync(box.old("metrics")).sort(), ["boundary-events.jsonl", "gate-bypass-audit.jsonl", "review-verdicts-2026.jsonl", "review-verdicts.jsonl"]);
	assert.deepEqual(fs.readdirSync(box.neu("metrics")), ["cost-metering.jsonl"]);
	assert.equal(fs.existsSync(box.neu("memory") + STAGE_SUFFIX), false, "the stage was renamed into place");
	const notice = migrationNotice(result, box.agentDir) ?? "";
	for (const kept of [".claude/memory/.pr-review-passed", ".claude/metrics/review-verdicts*", ".claude/metrics/boundary-events.jsonl", ".claude/metrics/gate-bypass-audit.jsonl"]) {
		assert.ok(notice.includes(kept), `${kept} not named: ${notice}`);
	}
});

test("migration skips a folder whose children are all kept and creates nothing", (t) => {
	const box = sandbox(t);
	box.write(box.old("memory", ".pr-review-passed"));
	box.write(box.old("metrics", "review-verdicts.jsonl"));
	const result = box.run();
	assert.deepEqual(result.moved, []);
	assert.deepEqual(result.errors, []);
	assert.equal(fs.existsSync(path.join(box.project, ".pi")), false, "nothing created");
	assert.equal(migrationNotice(result, box.agentDir), undefined, "nothing moved: no notice");
	assert.ok(fs.existsSync(box.old("memory", ".pr-review-passed")));
});

test("migration skips an entry of the wrong kind: a file where a folder belongs, or the reverse", (t) => {
	const box = sandbox(t);
	box.write(box.old("memory"), "a file, not a folder");
	box.write(box.old("init-state.json", "x"), "a folder, not a file");
	const result = box.run();
	assert.deepEqual(result.moved, []);
	assert.deepEqual(result.errors, []);
	assert.equal(fs.existsSync(path.join(box.project, ".pi")), false);
	assert.ok(fs.statSync(box.old("memory")).isFile());
	assert.ok(fs.statSync(box.old("init-state.json")).isDirectory());
});

test("migration skips an entry whose new path exists, or that is a symlink, or under a linked .claude", (t) => {
	const box = sandbox(t);
	box.write(box.old("memory", "old.json"));
	box.write(box.neu("memory", "new.json"));
	const outside = path.join(box.dir, "outside");
	box.write(path.join(outside, "plan.md"));
	fs.symlinkSync(outside, box.old("plans"));
	const result = box.run();
	assert.deepEqual(result.moved, []);
	assert.ok(fs.existsSync(box.old("memory", "old.json")), "the old copy stays when the new one exists");
	assert.ok(fs.lstatSync(box.old("plans")).isSymbolicLink());
	assert.equal(fs.existsSync(box.neu("plans")), false);

	const linked = sandbox(t);
	const elsewhere = path.join(linked.dir, "elsewhere");
	linked.write(path.join(elsewhere, "memory", "brief.json"));
	fs.symlinkSync(elsewhere, path.join(linked.project, ".claude"));
	assert.deepEqual(linked.run().moved, [], "a linked .claude folder is not followed");
	assert.ok(fs.existsSync(path.join(elsewhere, "memory", "brief.json")));
});

test("migration writes nothing through a linked .pi or .pi/dev-team", (t) => {
	for (const link of [".pi", STATE_DIR]) {
		const box = sandbox(t);
		box.write(box.old("memory", "brief.json"));
		const outside = path.join(box.dir, "outside");
		fs.mkdirSync(outside);
		fs.mkdirSync(path.dirname(path.join(box.project, link)), { recursive: true });
		fs.symlinkSync(outside, path.join(box.project, link));
		assert.deepEqual(box.run().moved, [], link);
		assert.deepEqual(fs.readdirSync(outside), [], link);
	}
});

test("migration never treats the user's ~/.claude as a project's, also through a linked base, and still copies the user files", (t) => {
	const box = sandbox(t);
	for (const f of ["plans/p.md", "agent-memory/a/MEMORY.md", "metrics/cost-metering.jsonl", "memory/x.json"]) box.write(box.homeFile(f));
	box.write(box.homeFile("telemetry.json"), '{"enabled":true}');
	const linkedHome = path.join(box.dir, "home-link");
	fs.symlinkSync(box.home, linkedHome);
	const result = box.run([box.home, linkedHome]);
	assert.deepEqual(result.moved, []);
	assert.deepEqual(result.copied, ["~/.claude/telemetry.json"]);
	assert.equal(fs.existsSync(path.join(box.home, ".pi")), false, "nothing created in the home folder");
	for (const f of ["plans/p.md", "agent-memory/a/MEMORY.md", "metrics/cost-metering.jsonl", "memory/x.json", "telemetry.json"]) assert.ok(fs.existsSync(box.homeFile(f)), f);
	assert.equal(fs.readFileSync(path.join(box.agentDir, "dev-team", "telemetry.json"), "utf-8"), '{"enabled":true}');
});

test("migration leaves state that git tracks: a cloned repo cannot plant it", (t) => {
	const box = sandbox(t);
	const git = gitInit(box.project);
	box.write(box.old("memory", "brief.json"), "planted");
	git("add", "-A");
	git("commit", "-q", "-m", "planted");
	box.write(box.old("plans", "mine.md"), "mine");
	const result = box.run();
	assert.deepEqual(result.moved, [path.join(".claude", "plans")]);
	assert.equal(fs.readFileSync(box.old("memory", "brief.json"), "utf-8"), "planted");
	assert.equal(fs.existsSync(box.neu("memory")), false);
});

test("migration leaves state git tracks under another letter case, as a case-insensitive filesystem resolves it", (t) => {
	const box = sandbox(t);
	const git = gitInit(box.project);
	box.write(box.old("memory", "brief.json"), "planted");
	git("add", "-A");
	git("commit", "-q", "-m", "planted");
	// The index names `.Claude/...`: on macOS and Windows that is the same folder as `.claude/`.
	execFileSync("git", ["mv", "-f", ".claude", ".Claude-tmp"], { cwd: box.project, env: GIT_ENV });
	execFileSync("git", ["mv", "-f", ".Claude-tmp", ".Claude"], { cwd: box.project, env: GIT_ENV });
	git("commit", "-q", "-m", "case");
	if (!fs.existsSync(box.old("memory", "brief.json"))) return t.skip("case-sensitive filesystem");
	const result = box.run();
	assert.deepEqual(result.moved, []);
	assert.equal(fs.existsSync(box.neu("memory")), false);
});

test("migration notes an old child the stage already holds when it resumes, so the base stays unmarked", (t) => {
	const box = sandbox(t);
	box.write(path.join(box.neu("memory") + STAGE_SUFFIX, "brief.json"), "staged");
	box.write(box.old("memory", "brief.json"), "newer");
	box.write(box.old("memory", "other.md"), "other");
	const result = box.run();
	assert.equal(fs.readFileSync(box.neu("memory", "brief.json"), "utf-8"), "staged");
	assert.equal(fs.readFileSync(box.neu("memory", "other.md"), "utf-8"), "other");
	assert.equal(fs.readFileSync(box.old("memory", "brief.json"), "utf-8"), "newer");
	assert.ok(result.notes.some((n) => n.includes("brief.json") && n.includes("merge them by hand")), JSON.stringify(result.notes));
	assert.equal(fs.existsSync(box.neu(MIGRATED_MARKER)), false, "no marker while a clash is open");
});

test("migration fails closed when git fails: a corrupt index moves nothing, and the repo's fsmonitor never runs", (t) => {
	const box = sandbox(t);
	gitInit(box.project);
	const pwned = path.join(box.dir, "PWNED");
	execFileSync("git", ["config", "core.fsmonitor", `touch ${pwned}; false`], { cwd: box.project, env: GIT_ENV });
	box.write(box.old("model-overrides.json"), "planted");
	box.write(box.old("memory", "a.json"));
	fs.writeFileSync(path.join(box.project, ".git", "index"), "garbage, not an index");
	const result = box.run();
	assert.deepEqual(result.moved, []);
	assert.ok(fs.existsSync(box.old("model-overrides.json")));
	assert.equal(fs.existsSync(path.join(box.project, ".pi")), false);
	assert.equal(fs.existsSync(pwned), false, "core.fsmonitor ran");

	fs.rmSync(path.join(box.project, ".git", "index"));
	box.run();
	assert.equal(fs.existsSync(pwned), false, "core.fsmonitor ran on a healthy repo");
});

test("migration fails closed when git is missing; outside a git repository nothing counts as tracked", (t) => {
	const box = sandbox(t);
	box.write(box.old("memory", "a.json"));
	const missing = box.run([box.project], { git: path.join(box.dir, "no-such-git") });
	assert.deepEqual(missing.moved, []);
	assert.equal(missing.notes.length, 1, missing.notes.join("\n"));
	assert.match(missing.notes[0], /^git ls-files failed \(.*ENOENT.*\); .*\.claude state left in place$/);
	assert.ok(fs.existsSync(box.old("memory", "a.json")));
	assert.equal(fs.existsSync(path.join(box.project, ".pi")), false);
	assert.deepEqual(box.run().moved, [path.join(".claude", "memory")], "real git outside a repository: untracked");
});

test("migration covers the session's cwd and its git toplevel when they differ", (t) => {
	const box = sandbox(t);
	const sub = path.join(box.project, "pkg");
	box.write(path.join(sub, ".claude", "memory", "a.json"));
	box.write(box.old("metrics", "cost-metering.jsonl"));
	const result = box.run([sub, box.project, box.project]);
	assert.deepEqual(result.moved, [path.join(".claude", "memory"), path.join(".claude", "metrics")]);
	assert.ok(fs.existsSync(path.join(sub, STATE_DIR, "memory", "a.json")));
	assert.ok(fs.existsSync(box.neu("metrics", "cost-metering.jsonl")));
	assert.ok(fs.existsSync(path.join(sub, STATE_DIR, MIGRATED_MARKER)));
	assert.ok(fs.existsSync(box.neu(MIGRATED_MARKER)));
});

test("migration skips a base with the marker, so state created later in .claude/ stays there", (t) => {
	const box = sandbox(t);
	box.write(box.old("memory", "a.json"));
	assert.deepEqual(box.run().moved, [path.join(".claude", "memory")]);
	box.write(box.old("plans", "later.md"));
	box.write(box.old("memory", "later.json"));
	const again = box.run();
	assert.deepEqual(again.moved, []);
	assert.ok(fs.existsSync(box.old("plans", "later.md")));
	assert.ok(fs.existsSync(box.old("memory", "later.json")));

	// A project dev-team already used (.pi/dev-team exists) gets the marker even when nothing moves.
	const used = sandbox(t);
	fs.mkdirSync(used.neu(), { recursive: true });
	assert.deepEqual(used.run().moved, []);
	assert.ok(fs.existsSync(used.neu(MIGRATED_MARKER)));
	// A project without .claude/ or .pi/dev-team gets nothing.
	const fresh = sandbox(t);
	fresh.run();
	assert.equal(fs.existsSync(path.join(fresh.project, ".pi")), false);
});

test("migration resumes a partial folder move: a failure leaves the stage, the next run finishes it", (t) => {
	const box = sandbox(t);
	box.write(box.old("memory", ".pr-review-passed"));
	box.write(box.old("memory", "a.json"), "a");
	box.write(box.old("memory", "b.json"), "b");
	box.write(box.old("plans", "p.md"));
	box.write(box.homeFile("telemetry.json"), "{}");
	let links = 0;
	const flaky: MigrateFs = {
		...fs,
		linkSync: ((from: fs.PathLike, to: fs.PathLike) => {
			if (++links === 2) throw errno("EACCES");
			fs.linkSync(from, to);
		}) as typeof fs.linkSync,
	};
	const first = box.run([box.project], { fs: flaky });
	assert.equal(first.errors.length, 1, first.errors.join("\n"));
	assert.match(first.error ?? "", /move \.claude\/memory: EACCES/);
	assert.deepEqual(first.moved, [path.join(".claude", "plans")], "the later entries still ran");
	assert.deepEqual(first.copied, ["~/.claude/telemetry.json"], "the user copy still ran");
	assert.equal(fs.existsSync(box.neu("memory")), false, "the folder appears only when complete");
	assert.equal(fs.readdirSync(box.neu("memory") + STAGE_SUFFIX).length, 1, "one child staged");
	assert.equal(fs.existsSync(box.neu(MIGRATED_MARKER)), false, "no marker after an error");

	const second = box.run();
	assert.deepEqual(second.errors, []);
	assert.deepEqual(second.moved, [path.join(".claude", "memory")]);
	assert.deepEqual(fs.readdirSync(box.neu("memory")).sort(), ["a.json", "b.json"]);
	assert.equal(fs.readFileSync(box.neu("memory", "b.json"), "utf-8"), "b");
	assert.deepEqual(fs.readdirSync(box.old("memory")), [".pr-review-passed"]);
	assert.equal(fs.existsSync(box.neu("memory") + STAGE_SUFFIX), false);
	assert.ok(fs.existsSync(box.neu(MIGRATED_MARKER)));
});

test("migration finishes a stage whose source is gone", (t) => {
	const box = sandbox(t);
	box.write(path.join(box.neu("memory") + STAGE_SUFFIX, "a.json"), "a");
	box.write(box.old("settings.json"));
	assert.deepEqual(box.run().moved, [path.join(".claude", "memory")]);
	assert.equal(fs.readFileSync(box.neu("memory", "a.json"), "utf-8"), "a");
});

test("migration skips an entry on another filesystem (EXDEV) with a note and creates nothing", (t) => {
	const box = sandbox(t);
	box.write(box.old("memory", "a.json"));
	box.write(box.old("metrics", "review-verdicts.jsonl"));
	box.write(box.old("metrics", "cost.jsonl"));
	box.write(box.old("init-state.json"));
	const crossDevice: MigrateFs = {
		...fs,
		renameSync: (() => {
			throw errno("EXDEV");
		}) as typeof fs.renameSync,
		linkSync: (() => {
			throw errno("EXDEV");
		}) as typeof fs.linkSync,
	};
	const result = box.run([box.project], { fs: crossDevice });
	assert.deepEqual(result.moved, []);
	assert.deepEqual(result.errors, []);
	assert.deepEqual(result.notes, [
		`${path.join(".claude", "memory")} is on another filesystem, move it by hand to ${path.join(STATE_DIR, "memory")}`,
		`${path.join(".claude", "metrics")} is on another filesystem, move it by hand to ${path.join(STATE_DIR, "metrics")}`,
		`${path.join(".claude", "init-state.json")} is on another filesystem, move it by hand to ${path.join(STATE_DIR, "init-state.json")}`,
	]);
	assert.equal(fs.existsSync(path.join(box.project, ".pi")), false, "nothing created");
	assert.ok(fs.existsSync(box.old("memory", "a.json")) && fs.existsSync(box.old("metrics", "cost.jsonl")) && fs.existsSync(box.old("init-state.json")));
	assert.match(migrationNotice(result, box.agentDir) ?? "", /Not moved: \.claude\/memory is on another filesystem, move it by hand/);
});

test("migration copies the user's telemetry consent and metrics, never over an existing file", (t) => {
	const box = sandbox(t);
	box.write(box.homeFile("telemetry.json"), '{"enabled":true}');
	box.write(box.homeFile("metrics", "telemetry.jsonl"), "row\n");
	box.write(path.join(box.agentDir, "dev-team", "metrics", "artifact-usage.json"), "newer");
	box.write(box.homeFile("metrics", "artifact-usage.json"), "older");
	const result = box.run();
	assert.deepEqual(result.copied, ["~/.claude/telemetry.json", "~/.claude/metrics/telemetry.jsonl"]);
	assert.equal(fs.readFileSync(path.join(box.agentDir, "dev-team", "telemetry.json"), "utf-8"), '{"enabled":true}');
	assert.equal(fs.readFileSync(path.join(box.agentDir, "dev-team", "metrics", "artifact-usage.json"), "utf-8"), "newer");
	assert.ok(fs.existsSync(box.homeFile("telemetry.json")), "copied, not moved");
	assert.match(migrationNotice(result, box.agentDir) ?? "", /copied ~\/\.claude\/telemetry\.json, ~\/\.claude\/metrics\/telemetry\.jsonl to .*agent\/dev-team\/\.$/);
	assert.deepEqual(box.run().copied, [], "second run copies nothing");
});

test("migration copies no user file that is a symlink or a folder", (t) => {
	const box = sandbox(t);
	const target = path.join(box.dir, "secret.json");
	box.write(target, "{}");
	fs.mkdirSync(path.join(box.home, ".claude"), { recursive: true });
	fs.symlinkSync(target, box.homeFile("telemetry.json"));
	fs.mkdirSync(box.homeFile("metrics", "telemetry.jsonl"), { recursive: true });
	assert.deepEqual(box.run().copied, []);
	assert.deepEqual(fs.readdirSync(path.join(box.agentDir, "dev-team")), [MIGRATED_MARKER], "only the marker");
});

test("migration reports each error instead of throwing, and the rest still runs", (t) => {
	const box = sandbox(t);
	box.write(box.old("memory", "a.json"));
	box.write(box.old("metrics", "m.jsonl"));
	box.write(box.homeFile("telemetry.json"), "{}");
	// A file where the state folder's parent must be: .pi/dev-team cannot be created.
	box.write(path.join(box.project, ".pi"), "a file, not a folder");
	const result = box.run();
	assert.deepEqual(result.moved, []);
	assert.equal(result.errors.length, 2, result.errors.join("\n"));
	assert.equal(result.error, result.errors[0]);
	assert.deepEqual(result.copied, ["~/.claude/telemetry.json"], "the user copy is independent of the project");
	assert.ok(fs.existsSync(box.old("memory", "a.json")), "nothing is lost");
	assert.ok(fs.existsSync(box.old("metrics", "m.jsonl")));
});

test("migration fails closed on a nested repository or submodule in .claude or .claude/<entry>: nothing there moves", (t) => {
	const box = sandbox(t);
	const parentGit = gitInit(box.project);
	box.write(path.join(box.project, "README.md"));
	parentGit("add", "-A");
	parentGit("commit", "-q", "-m", "init");
	const upstream = path.join(box.dir, "upstream");
	fs.mkdirSync(upstream);
	const upGit = gitInit(upstream);
	box.write(path.join(upstream, "settings.json"));
	upGit("add", "-A");
	upGit("commit", "-q", "-m", "init");
	parentGit("-c", "protocol.file.allow=always", "submodule", "add", "-q", upstream, ".claude");
	box.write(box.old("memory", "a.json"), "untracked in the submodule");
	fs.mkdirSync(box.neu(), { recursive: true });
	const sub = box.run();
	assert.deepEqual(sub.moved, []);
	assert.deepEqual(sub.notes, [], "counted as tracked, not as a git failure");
	assert.equal(fs.readFileSync(box.old("memory", "a.json"), "utf-8"), "untracked in the submodule");

	const nested = sandbox(t);
	gitInit(nested.project);
	nested.write(nested.old("memory", "a.json"));
	gitInit(nested.old("memory"));
	nested.write(nested.old("plans", "p.md"));
	const entry = nested.run();
	assert.deepEqual(entry.moved, [path.join(".claude", "plans")], "an entry with its own .git stays, the rest moves");
	assert.ok(fs.existsSync(nested.old("memory", "a.json")));

	const whole = sandbox(t);
	whole.write(whole.old("memory", "a.json"));
	gitInit(path.join(whole.project, ".claude"));
	assert.deepEqual(whole.run().moved, [], "a .claude that is its own repository (outside any project repo)");
	assert.ok(fs.existsSync(whole.old("memory", "a.json")));
});

test("migration: a failed git check notes it, so the marker is not written and a later run still moves", (t) => {
	const box = sandbox(t);
	fs.mkdirSync(box.neu(), { recursive: true });
	box.write(box.old("memory", "a.json"));
	box.write(box.old("init-state.json"));
	const failed = box.run([box.project], { git: path.join(box.dir, "no-such-git") });
	assert.deepEqual(failed.moved, []);
	assert.equal(failed.notes.length, 1, "one note per base, not per entry");
	assert.equal(fs.existsSync(box.neu(MIGRATED_MARKER)), false, "no marker after a failed git check");
	assert.match(migrationNotice(failed, box.agentDir) ?? "", /Not moved: git ls-files failed/);
	const later = box.run();
	assert.deepEqual(later.moved, [path.join(".claude", "memory"), path.join(".claude", "init-state.json")]);
	assert.ok(fs.existsSync(box.neu(MIGRATED_MARKER)));
});

test("migration merges a stage left by an earlier run into a folder that appeared since, then moves the rest", (t) => {
	const box = sandbox(t);
	box.write(path.join(box.neu("memory") + STAGE_SUFFIX, "a.json"), "a");
	box.write(box.neu("memory", "c.json"), "c");
	box.write(box.old("memory", "b.json"), "b");
	box.write(box.old("memory", ".pr-review-passed"));
	const result = box.run();
	assert.deepEqual(result.errors, []);
	assert.deepEqual(result.notes, []);
	assert.deepEqual(result.moved, [path.join(".claude", "memory")]);
	assert.deepEqual(fs.readdirSync(box.neu("memory")).sort(), ["a.json", "b.json", "c.json"]);
	assert.equal(fs.existsSync(box.neu("memory") + STAGE_SUFFIX), false, "the stage is removed");
	assert.deepEqual(fs.readdirSync(box.old("memory")), [".pr-review-passed"]);
	assert.ok(fs.existsSync(box.neu(MIGRATED_MARKER)));

	const clash = sandbox(t);
	clash.write(path.join(clash.neu("memory") + STAGE_SUFFIX, "c.json"), "staged");
	clash.write(clash.neu("memory", "c.json"), "newer");
	const r = clash.run();
	assert.deepEqual(r.errors, []);
	assert.deepEqual(r.notes, [`${path.join(STATE_DIR, "memory") + STAGE_SUFFIX} holds c.json, which ${path.join(STATE_DIR, "memory")} already has; merge them by hand`]);
	assert.equal(fs.readFileSync(clash.neu("memory", "c.json"), "utf-8"), "newer", "never overwritten");
	assert.equal(fs.readFileSync(path.join(clash.neu("memory") + STAGE_SUFFIX, "c.json"), "utf-8"), "staged", "the stage keeps its copy");
	assert.equal(fs.existsSync(clash.neu(MIGRATED_MARKER)), false, "no marker while the stage holds data");
});

test("migration: EXDEV during a folder move puts the staged children back, so nothing is created and the note holds", (t) => {
	const box = sandbox(t);
	box.write(box.old("memory", ".pr-review-passed"));
	box.write(box.old("memory", "a.json"), "a");
	box.write(box.old("memory", "b.json"), "b");
	let links = 0;
	const midLoop: MigrateFs = {
		...fs,
		linkSync: ((from: fs.PathLike, to: fs.PathLike) => {
			if (++links === 2) throw errno("EXDEV");
			fs.linkSync(from, to);
		}) as typeof fs.linkSync,
	};
	const result = box.run([box.project], { fs: midLoop });
	assert.deepEqual(result.errors, []);
	assert.deepEqual(result.moved, []);
	assert.deepEqual(result.notes, [`${path.join(".claude", "memory")} is on another filesystem, move it by hand to ${path.join(STATE_DIR, "memory")}`]);
	assert.deepEqual(fs.readdirSync(box.old("memory")).sort(), [".pr-review-passed", "a.json", "b.json"]);
	assert.equal(fs.readFileSync(box.old("memory", "a.json"), "utf-8"), "a");
	assert.equal(fs.existsSync(path.join(box.project, ".pi")), false, "stage and its folders removed");

	// A whole-folder move whose second rename fails: the stage is renamed back.
	const whole = sandbox(t);
	whole.write(whole.old("plans", "p.md"), "p");
	let renames = 0;
	const secondRename: MigrateFs = {
		...fs,
		renameSync: ((from: fs.PathLike, to: fs.PathLike) => {
			if (++renames === 2) throw errno("EXDEV");
			fs.renameSync(from, to);
		}) as typeof fs.renameSync,
	};
	const w = whole.run([whole.project], { fs: secondRename });
	assert.deepEqual(w.errors, []);
	assert.deepEqual(w.notes, [`${path.join(".claude", "plans")} is on another filesystem, move it by hand to ${path.join(STATE_DIR, "plans")}`]);
	assert.equal(fs.readFileSync(whole.old("plans", "p.md"), "utf-8"), "p");
	assert.equal(fs.existsSync(path.join(whole.project, ".pi")), false);
});

test("migration copies the user files once: the user marker stops a later copy", (t) => {
	const box = sandbox(t);
	box.write(box.homeFile("telemetry.json"), '{"enabled":true}');
	assert.deepEqual(box.run().copied, ["~/.claude/telemetry.json"]);
	const marker = path.join(box.agentDir, "dev-team", MIGRATED_MARKER);
	assert.ok(fs.existsSync(marker), "user marker written");
	fs.rmSync(path.join(box.agentDir, "dev-team", "telemetry.json"));
	assert.deepEqual(box.run().copied, [], "the marker stops a re-copy of a file the user removed");
	assert.equal(fs.existsSync(path.join(box.agentDir, "dev-team", "telemetry.json")), false);

	const fresh = sandbox(t);
	fresh.run();
	assert.equal(fs.existsSync(path.join(fresh.agentDir, "dev-team")), false, "no ~/.claude: nothing created");
});
