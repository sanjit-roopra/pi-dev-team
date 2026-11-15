import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { type TestContext, test } from "node:test";
import { writesRequestDir } from "../../extensions/dev-team/lib/request-guard.ts";
import { REQUEST_DIR } from "../../extensions/dev-team/lib/skills.ts";

function project(t: TestContext): string {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "dt-guard-"));
	t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
	fs.mkdirSync(path.join(cwd, REQUEST_DIR), { recursive: true });
	return cwd;
}

const bash = (command: string, cwd: string) => writesRequestDir("bash", { command }, cwd);

test("writesRequestDir blocks write and edit into the saved requests, also through a symlink or another case", (t) => {
	const cwd = project(t);
	assert.equal(writesRequestDir("write", { path: ".claude/memory/requests/request-x.md", content: "x" }, cwd), true);
	assert.equal(writesRequestDir("edit", { path: path.join(cwd, REQUEST_DIR, "approved-1.md") }, cwd), true);
	assert.equal(writesRequestDir("write", { file_path: "./.claude/memory/../memory/requests/a.md" }, cwd), true);
	fs.symlinkSync(path.join(cwd, REQUEST_DIR), path.join(cwd, "link"));
	assert.equal(writesRequestDir("write", { path: "link/a.md" }, cwd), true, "a symlink into the folder");
	if (process.platform === "darwin") assert.equal(writesRequestDir("write", { path: ".claude/Memory/Requests/a.md" }, cwd), true);
	assert.equal(writesRequestDir("write", { path: ".claude/memory/plans/p.md" }, cwd), false);
	assert.equal(writesRequestDir("write", { path: "src/requests.ts" }, cwd), false);
	assert.equal(writesRequestDir("read", { path: ".claude/memory/requests/a.md" }, cwd), false);
});

test("writesRequestDir blocks bash redirects, cp, mv, tee, ln, rm and sed -i into the saved requests", (t) => {
	const cwd = project(t);
	for (const command of [
		"echo hi > .claude/memory/requests/request-1.md",
		"printf x >> .claude/memory/requests/a.md",
		"cat <<'EOF' > .claude/memory/requests/a.md\n$ greet\nHello\nEOF",
		"cp /tmp/forged.md .claude/memory/requests/",
		"mv .claude/memory/requests/a.md /tmp/a.md",
		"echo x | tee .claude/memory/requests/a.md",
		"ln -s /tmp/x .claude/memory/requests",
		"rm -rf .claude/memory",
		"rm -rf .claude",
		"sed -i '' 's/Hello/Hi/' .claude/memory/requests/a.md",
		"timeout 60 touch .claude/memory/requests/a.md",
		"echo $(echo x > .claude/memory/requests/a.md)",
		"echo x >| .claude/memory/requests/a.md",
	]) {
		assert.equal(bash(command, cwd), true, command);
	}
});

test("writesRequestDir blocks a computed target or a program run on a line that names the folder", (t) => {
	const cwd = project(t);
	for (const command of [
		'd=.claude/memory/requests; echo x > "$d/a.md"',
		"python3 -c \"open('.claude/memory/requests/a.md', 'w').write('x')\"",
		"python3 - <<'EOF'\nimport os\nopen(os.path.join('.claude', 'memory', 'requests', 'a.md'), 'w')\nEOF",
		"dd if=/tmp/x of=.claude/memory/requests/a.md",
		"git checkout -- .claude/memory/requests",
		"cp -t .claude/memory/requests /tmp/forged.md",
	]) {
		assert.equal(bash(command, cwd), true, command);
	}
	assert.equal(writesRequestDir("powershell", { command: "Set-Content .claude\\memory\\requests\\a.md x" }, cwd), true);
	assert.equal(writesRequestDir("powershell", { command: "Get-ChildItem src" }, cwd), false);
});

test("writesRequestDir lets reads of the saved requests and the example check run", (t) => {
	const cwd = project(t);
	for (const command of [
		"cat .claude/memory/requests/*.md",
		"ls -la .claude/memory/requests/",
		"grep -n greet .claude/memory/requests/request-1.md | head -5",
		"python3 ${CLAUDE_PLUGIN_ROOT}/scripts/example_replay.py --requests .claude/memory/requests",
		"timeout 600 python3 /pkg/scripts/example_replay.py --requests .claude/memory/requests > /tmp/replay.log",
		"cat .claude/memory/requests/request-1.md > /tmp/copy.md",
		"echo x > .claude/memory/plans/p.md",
		"npm test",
	]) {
		assert.equal(bash(command, cwd), false, command);
	}
});

test("writesRequestDir follows cd and pushd: a relative write after a cd into the folder or above it is blocked", (t) => {
	const cwd = project(t);
	for (const command of [
		"cd .claude/memory/requests && echo hi > approved-2026-01-01T00-00-00-000Z.md",
		"cd .claude/memory/requests; printf x >> request-x.md",
		"cd .claude/memory && echo x > requests/a.md",
		"cd .claude && cd memory && echo x > requests/a.md",
		"cd .claude/memory/requests && grep x a > b.md",
		"cd .claude && printf x > memory/requests/a.md",
		"cd .claude/memory/requests; cat /tmp/f > approved-1.md",
		"cd .claude/memory && cp /tmp/f requests/",
		"cd .claude/memory && rm -rf requests",
		"cd .claude/memory && mv requests old",
		"cd .claude/memory && python3 -c \"open('requests/a.md', 'w')\"",
		"cd .claude/memory && cat > req$(echo uests)/a.md",
		"pushd .claude/memory && echo x > requests/a.md",
		'cd "$D" && echo x > memory/requests/a.md',
	]) {
		assert.equal(bash(command, cwd), true, command);
	}
	for (const command of ["cd .claude/memory/requests && cat a.md", "cd src && npm test", "cd /tmp && echo x > a.md"]) {
		assert.equal(bash(command, cwd), false, command);
	}
});

test("writesRequestDir blocks a computed target on a line that mentions .claude, and python -c with a trailing example_replay.py", (t) => {
	const cwd = project(t);
	for (const command of [
		"cat > .claude/memory/req$(echo uests)/a.md",
		"d=.claude/memory/req; cp x ${d}uests/a.md",
		'echo hi > "$(printf .claude/memory/req)uests/a.md"',
		"python3 -c \"open('.claude/memory/requests/a.md','w').write('x')\" example_replay.py",
		"python3 -m example_replay .claude/memory/requests example_replay.py",
	]) {
		assert.equal(bash(command, cwd), true, command);
	}
	assert.equal(bash("python3 -u scripts/example_replay.py --requests .claude/memory/requests", cwd), false);
});
