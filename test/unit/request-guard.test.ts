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
	assert.equal(writesRequestDir("write", { path: ".pi/dev-team/memory/requests/request-x.md", content: "x" }, cwd), true);
	assert.equal(writesRequestDir("edit", { path: path.join(cwd, REQUEST_DIR, "approved-1.md") }, cwd), true);
	assert.equal(writesRequestDir("write", { file_path: "./.pi/dev-team/memory/../memory/requests/a.md" }, cwd), true);
	fs.symlinkSync(path.join(cwd, REQUEST_DIR), path.join(cwd, "link"));
	assert.equal(writesRequestDir("write", { path: "link/a.md" }, cwd), true, "a symlink into the folder");
	if (process.platform === "darwin") assert.equal(writesRequestDir("write", { path: ".pi/Dev-Team/Memory/Requests/a.md" }, cwd), true);
	assert.equal(writesRequestDir("write", { path: ".pi/dev-team/memory/plans/p.md" }, cwd), false);
	assert.equal(writesRequestDir("write", { path: "src/requests.ts" }, cwd), false);
	assert.equal(writesRequestDir("read", { path: ".pi/dev-team/memory/requests/a.md" }, cwd), false);
});

test("writesRequestDir blocks bash redirects, cp, mv, tee, ln, rm and sed -i into the saved requests", (t) => {
	const cwd = project(t);
	for (const command of [
		"echo hi > .pi/dev-team/memory/requests/request-1.md",
		"printf x >> .pi/dev-team/memory/requests/a.md",
		"cat <<'EOF' > .pi/dev-team/memory/requests/a.md\n$ greet\nHello\nEOF",
		"cp /tmp/forged.md .pi/dev-team/memory/requests/",
		"mv .pi/dev-team/memory/requests/a.md /tmp/a.md",
		"echo x | tee .pi/dev-team/memory/requests/a.md",
		"ln -s /tmp/x .pi/dev-team/memory/requests",
		"rm -rf .pi/dev-team/memory",
		"rm -rf .pi/dev-team",
		"rm -rf .pi",
		"sed -i '' 's/Hello/Hi/' .pi/dev-team/memory/requests/a.md",
		"timeout 60 touch .pi/dev-team/memory/requests/a.md",
		"echo $(echo x > .pi/dev-team/memory/requests/a.md)",
		"echo x >| .pi/dev-team/memory/requests/a.md",
	]) {
		assert.equal(bash(command, cwd), true, command);
	}
});

test("writesRequestDir blocks a computed target or a program run on a line that names the folder", (t) => {
	const cwd = project(t);
	for (const command of [
		'd=.pi/dev-team/memory/requests; echo x > "$d/a.md"',
		"python3 -c \"open('.pi/dev-team/memory/requests/a.md', 'w').write('x')\"",
		"python3 - <<'EOF'\nimport os\nopen(os.path.join('.pi', 'dev-team', 'memory', 'requests', 'a.md'), 'w')\nEOF",
		"dd if=/tmp/x of=.pi/dev-team/memory/requests/a.md",
		"git checkout -- .pi/dev-team/memory/requests",
		"cp -t .pi/dev-team/memory/requests /tmp/forged.md",
	]) {
		assert.equal(bash(command, cwd), true, command);
	}
	assert.equal(writesRequestDir("powershell", { command: "Set-Content .pi\\dev-team\\memory\\requests\\a.md x" }, cwd), true);
	assert.equal(writesRequestDir("powershell", { command: "Get-ChildItem src" }, cwd), false);
});

test("writesRequestDir lets reads of the saved requests and the example check run", (t) => {
	const cwd = project(t);
	for (const command of [
		"cat .pi/dev-team/memory/requests/*.md",
		"ls -la .pi/dev-team/memory/requests/",
		"grep -n greet .pi/dev-team/memory/requests/request-1.md | head -5",
		"python3 ${DEV_TEAM_ROOT}/scripts/example_replay.py --requests .pi/dev-team/memory/requests",
		"timeout 600 python3 /pkg/scripts/example_replay.py --requests .pi/dev-team/memory/requests > /tmp/replay.log",
		"cat .pi/dev-team/memory/requests/request-1.md > /tmp/copy.md",
		"echo x > .pi/dev-team/memory/plans/p.md",
		"npm test",
	]) {
		assert.equal(bash(command, cwd), false, command);
	}
});

test("writesRequestDir follows cd and pushd: a relative write after a cd into the folder or above it is blocked", (t) => {
	const cwd = project(t);
	for (const command of [
		"cd .pi/dev-team/memory/requests && echo hi > approved-2026-01-01T00-00-00-000Z.md",
		"cd .pi/dev-team/memory/requests; printf x >> request-x.md",
		"cd .pi/dev-team/memory && echo x > requests/a.md",
		"cd .pi && cd dev-team/memory && echo x > requests/a.md",
		"cd .pi/dev-team/memory/requests && grep x a > b.md",
		"cd .pi/dev-team && printf x > memory/requests/a.md",
		"cd .pi/dev-team/memory/requests; cat /tmp/f > approved-1.md",
		"cd .pi/dev-team/memory && cp /tmp/f requests/",
		"cd .pi/dev-team/memory && rm -rf requests",
		"cd .pi/dev-team/memory && mv requests old",
		"cd .pi/dev-team/memory && python3 -c \"open('requests/a.md', 'w')\"",
		"cd .pi/dev-team/memory && cat > req$(echo uests)/a.md",
		"pushd .pi/dev-team/memory && echo x > requests/a.md",
		'cd "$D" && echo x > memory/requests/a.md',
	]) {
		assert.equal(bash(command, cwd), true, command);
	}
	for (const command of ["cd .pi/dev-team/memory/requests && cat a.md", "cd src && npm test", "cd /tmp && echo x > a.md"]) {
		assert.equal(bash(command, cwd), false, command);
	}
});

test("writesRequestDir blocks a computed target on a line that mentions .pi, and python -c with a trailing example_replay.py", (t) => {
	const cwd = project(t);
	for (const command of [
		"cat > .pi/dev-team/memory/req$(echo uests)/a.md",
		"d=.pi/dev-team/memory/req; cp x ${d}uests/a.md",
		'echo hi > "$(printf .pi/dev-team/memory/req)uests/a.md"',
		"python3 -c \"open('.pi/dev-team/memory/requests/a.md','w').write('x')\" example_replay.py",
		"python3 -m example_replay .pi/dev-team/memory/requests example_replay.py",
	]) {
		assert.equal(bash(command, cwd), true, command);
	}
	assert.equal(bash("python3 -u scripts/example_replay.py --requests .pi/dev-team/memory/requests", cwd), false);
});

test("writesRequestDir: .pid, np.pi or x.pi.json on a line with a computed target is not the .pi folder", (t) => {
	const cwd = project(t);
	for (const command of [
		'echo x > "$(cat app.pid).log"',
		'python3 -c "import numpy as np; print(np.pi)" > "$OUT"',
		'cp config.pi.json "$DEST"',
		"cd .pi/agents && cat reviewer.md",
	]) {
		assert.equal(bash(command, cwd), false, command);
	}
	for (const command of ['d=$(pwd)/.pi/dev-team; echo x > "$d/x"', "echo x > \"$(printf '.pi')/dev-team/x\""]) {
		assert.equal(bash(command, cwd), true, command);
	}
});

test("writesRequestDir: pi config next to the state folder (.pi/dev-team.json, .pi/settings.json, .pi/agents) is not the state folder", (t) => {
	const cwd = project(t);
	for (const command of [
		'tmp=$(mktemp); jq ".autocompactPct=40" .pi/dev-team.json > "$tmp" && mv "$tmp" .pi/dev-team.json',
		'cat .pi/dev-team.local.json > "$OUT"',
		'cat .pi/settings.json > "$OUT"',
		'cd "$D" && echo x > .pi/agents/a.md',
		'echo x > "$(date).txt" # see ~/.pi/agent',
		'f=x; echo hi > "$f"; cat .pi/settings.json',
		'cp .pi/agents/a.md "$DEST"',
		'echo x > "$HOME/.pi/agent/settings.json"',
		'f=x; echo hi > "$f"; cat .pi/dev-team-reports/r.md',
	]) {
		assert.equal(bash(command, cwd), false, command);
	}
});

test("writesRequestDir: a computed target or an unknown cd on a line that names .pi/dev-team, in any spelling, is blocked", (t) => {
	const cwd = project(t);
	for (const command of [
		'git diff $BASE > .pi/dev-team/memory/reviews/diff-$SLICE.patch',
		'echo x > "$(pwd)/.pi/dev-team/x"',
		'echo x > "$(cygpath .pi\\dev-team)/x"',
		"python3 - <<'EOF' > \"$OUT\"\nimport os\nprint(os.path.join('.pi', 'dev-team'))\nEOF",
		'python3 -c \'from pathlib import Path; print(Path(".pi") / "dev-team")\' > "$OUT"',
		'echo ".pi" "dev-team" > "$OUT"',
		'cd "$D" && echo x > .pi/dev-team/notes.md',
		'popd && echo x > ../.pi/dev-team/x',
	]) {
		assert.equal(bash(command, cwd), true, command);
	}
});

test("writesRequestDir: .pi itself (the folder above the state folder) or an attached short flag counts as naming the state folder", (t) => {
	const cwd = project(t);
	for (const command of [
		'd=.pi; m=memory; echo x > "$d/dev-team/$m/requests/a"',
		'd=$(pwd)/.pi; echo x > "$d/x"',
		'x=.pi; cd "$x" && rm -rf dev-team',
		'x=.pi; cd "$x"/dev-team && cp -r /tmp/f/m* .',
		'cd "$P"/.pi && cp -r /tmp/f/* dev-team/',
		'x=".pi/"; echo x > "$x/dev-team/a"',
		'git -C.pi/dev-team log > "$out"',
		'git -C.pi log > "$out"',
		'm=memory; echo x > "${D:-.pi}/dev-team/$m/requests/a"',
		'd=.pi/./dev-team; m=memory; echo x > "$d/$m/requests/a"',
		'd=.pi/{dev-team,x}; echo x > "$d/a"',
		'cd "$D" && echo x > a.md; ls .pi/*',
		// Over-block: the scan cannot tell Swift's `.pi` from the folder.
		'cat > "src/$NAME.swift" <<EOF\nlet a: Double = .pi\nEOF',
	]) {
		assert.equal(bash(command, cwd), true, command);
	}
	for (const command of [
		'x=$(ls); cat .pi/settings.json > "$x"',
		'cat .pi/dev-team.json > "$OUT"',
		'cd "$D" && echo x > .pi/agents/a.md',
		'echo x > "$HOME/.pi/agent/settings.json"',
		'cd ~/.pi/agent && cat settings.json',
		'cp .pi/dev-team-reports/r.md "$DEST"',
		'x=$(ls); echo "$x" > np.pi.txt; cat x.pi.json > "$OUT"',
	]) {
		assert.equal(bash(command, cwd), false, command);
	}
});
