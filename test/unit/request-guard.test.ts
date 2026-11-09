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
	assert.equal(writesRequestDir("write", { path: ".dev-team/requests/request-x.md", content: "x" }, cwd), true);
	assert.equal(writesRequestDir("edit", { path: path.join(cwd, REQUEST_DIR, "approved-1.md") }, cwd), true);
	assert.equal(writesRequestDir("write", { file_path: "./.dev-team/../.dev-team/requests/a.md" }, cwd), true);
	fs.symlinkSync(path.join(cwd, REQUEST_DIR), path.join(cwd, "link"));
	assert.equal(writesRequestDir("write", { path: "link/a.md" }, cwd), true, "a symlink into the folder");
	if (process.platform === "darwin") assert.equal(writesRequestDir("write", { path: ".Dev-Team/Requests/a.md" }, cwd), true);
	assert.equal(writesRequestDir("write", { path: ".claude/memory/plans/p.md" }, cwd), false);
	assert.equal(writesRequestDir("write", { path: "src/requests.ts" }, cwd), false);
	assert.equal(writesRequestDir("read", { path: ".dev-team/requests/a.md" }, cwd), false);
});

test("writesRequestDir blocks bash redirects, cp, mv, tee, ln, rm and sed -i into the saved requests", (t) => {
	const cwd = project(t);
	for (const command of [
		"echo hi > .dev-team/requests/request-1.md",
		"printf x >> .dev-team/requests/a.md",
		"cat <<'EOF' > .dev-team/requests/a.md\n$ greet\nHello\nEOF",
		"cp /tmp/forged.md .dev-team/requests/",
		"mv .dev-team/requests/a.md /tmp/a.md",
		"echo x | tee .dev-team/requests/a.md",
		"ln -s /tmp/x .dev-team/requests",
		"rm -rf .dev-team",
		"mv .dev-team /tmp/old",
		"sed -i '' 's/Hello/Hi/' .dev-team/requests/a.md",
		"timeout 60 touch .dev-team/requests/a.md",
		"echo $(echo x > .dev-team/requests/a.md)",
		"echo x >| .dev-team/requests/a.md",
	]) {
		assert.equal(bash(command, cwd), true, command);
	}
});

test("writesRequestDir blocks a computed target or a program run on a line that names the folder", (t) => {
	const cwd = project(t);
	for (const command of [
		'd=.dev-team/requests; echo x > "$d/a.md"',
		"python3 -c \"open('.dev-team/requests/a.md', 'w').write('x')\"",
		"python3 - <<'EOF'\nimport os\nopen(os.path.join('.dev-team', 'requests', 'a.md'), 'w')\nEOF",
		"dd if=/tmp/x of=.dev-team/requests/a.md",
		"git checkout -- .dev-team/requests",
		"cp -t .dev-team/requests /tmp/forged.md",
	]) {
		assert.equal(bash(command, cwd), true, command);
	}
	assert.equal(writesRequestDir("powershell", { command: "Set-Content .dev-team\\requests\\a.md x" }, cwd), true);
	assert.equal(writesRequestDir("powershell", { command: "Get-ChildItem src" }, cwd), false);
});

test("writesRequestDir lets reads of the saved requests and the example check run", (t) => {
	const cwd = project(t);
	for (const command of [
		"cat .dev-team/requests/*.md",
		"ls -la .dev-team/requests/",
		"grep -n greet .dev-team/requests/request-1.md | head -5",
		"python3 ${CLAUDE_PLUGIN_ROOT}/scripts/example_replay.py --requests .dev-team/requests",
		"timeout 600 python3 /pkg/scripts/example_replay.py --requests .dev-team/requests > /tmp/replay.log",
		"cat .dev-team/requests/request-1.md > /tmp/copy.md",
		"echo x > .claude/memory/plans/p.md",
		"npm test",
	]) {
		assert.equal(bash(command, cwd), false, command);
	}
});

test("writesRequestDir follows cd and pushd: a relative write after a cd into the folder or above it is blocked", (t) => {
	const cwd = project(t);
	for (const command of [
		"cd .dev-team/requests && echo hi > approved-2026-01-01T00-00-00-000Z.md",
		"cd .dev-team/requests; printf x >> request-x.md",
		"cd .dev-team && echo x > requests/a.md",
		"cd src && cd ../.dev-team && echo x > requests/a.md",
		"cd .dev-team/requests && grep x a > b.md",
		"cd .dev-team && printf x > requests/a.md",
		"cd .dev-team/requests; cat /tmp/f > approved-1.md",
		"cd .dev-team && cp /tmp/f requests/",
		"cd .dev-team && rm -rf requests",
		"cd .dev-team && mv requests old",
		"cd .dev-team && python3 -c \"open('requests/a.md', 'w')\"",
		"cd .dev-team && cat > req$(echo uests)/a.md",
		"pushd .dev-team && echo x > requests/a.md",
		'cd "$D" && echo x > memory/requests/a.md',
	]) {
		assert.equal(bash(command, cwd), true, command);
	}
	for (const command of ["cd .dev-team/requests && cat a.md", "cd src && npm test", "cd /tmp && echo x > a.md"]) {
		assert.equal(bash(command, cwd), false, command);
	}
});

test("writesRequestDir blocks a computed target on a line that may spell the folder in parts, and python -c with a trailing example_replay.py", (t) => {
	const cwd = project(t);
	for (const command of [
		"cat > .dev-team/req$(echo uests)/a.md",
		"d=.dev-team/req; cp x ${d}uests/a.md",
		'echo hi > "$(printf .dev-team/req)uests/a.md"',
		'd=.dev-team; echo x > "$d/requests/a.md"',
		"python3 -c \"open('.dev-team/requests/a.md','w').write('x')\" example_replay.py",
		"python3 -m example_replay .dev-team/requests example_replay.py",
	]) {
		assert.equal(bash(command, cwd), true, command);
	}
	assert.equal(bash("python3 -u scripts/example_replay.py --requests .dev-team/requests", cwd), false);
});

test("writesRequestDir blocks a statement that names the folder and runs anything but a known read", (t) => {
	const cwd = project(t);
	for (const command of [
		"find .dev-team/requests -name '*.md' -delete",
		"find .dev-team/requests -exec cp /tmp/f {} \\;",
		"ls .dev-team/requests | xargs rm",
		"awk '{print > \".dev-team/requests/a.md\"}' /tmp/f",
		"sed -n 'w .dev-team/requests/a.md' /tmp/f",
		"sort -o .dev-team/requests/a.md /tmp/f",
		"uniq /tmp/f .dev-team/requests/a.md",
		"mv -t .dev-team/requests /tmp/forged.md",
		"node -e \"require('fs').writeFileSync('.dev-team/requests/a.md','x')\"",
		"bash -c 'echo x > .dev-team/requests/a.md'",
		"tar -xf /tmp/f.tar -C .dev-team/requests",
		"git restore .dev-team/requests",
		"curl -o .dev-team/requests/a.md http://x",
		"uv run python -c \"open('.dev-team/requests/a.md','w')\"",
	]) {
		assert.equal(bash(command, cwd), true, command);
	}
});

test("writesRequestDir lets ordinary reads that name the folder run (v5 smoke false positives)", (t) => {
	const cwd = project(t);
	for (const command of [
		"find .dev-team/requests -type f -printf '%T@ %p\\n' | sort -n",
		"ls -la .dev-team/requests && rg -n 'Example' .dev-team/requests && git status --short",
		"git log --oneline -- .dev-team/requests",
		"git diff .dev-team/requests",
		"sed -n '1,40p' .dev-team/requests/request-1.md",
		"awk '/^```/{n++} END {print n}' .dev-team/requests/request-1.md",
		"sort .dev-team/requests/*.md | uniq -c | head",
		"cp .dev-team/requests/request-1.md /tmp/copy.md",
		"mkdir -p .dev-team && cat .dev-team/requests/request-1.md",
		"mkdir -p .dev-team",
		"cd .dev-team && cat > examples.json <<'EOF'\n{}\nEOF",
		"echo x > .dev-team/examples.json",
		"python3 scripts/example_replay.py --cases .dev-team/examples.json > \"$LOG\"",
	]) {
		assert.equal(bash(command, cwd), false, command);
	}
	assert.equal(writesRequestDir("write", { path: ".dev-team/examples.json", content: "{}" }, cwd), false);
});

test("writesRequestDir blocks forging shapes found in review: pipes into shells, xargs, loops, aliases, links, computed cd", (t) => {
	const cwd = project(t);
	for (const command of [
		"printf 'echo forged > %s\\n' .dev-team/requests/x.md | bash",
		"echo 'echo forged > .dev-team/requests/x.md' | sh",
		"cat <<'EOF' | bash\necho forged > .dev-team/requests/x.md\nEOF",
		"bash <(echo 'echo forged > .dev-team/requests/x.md')",
		"find .dev-team/requests -print0 | xargs -0 rm",
		"printf '%s\\n' .dev-team/requests/a.md | xargs -I{} touch {}",
		"ls /tmp/forged | xargs -I{} cp /tmp/forged/{} .dev-team/requests/",
		"git ls-files .dev-team/requests | xargs git rm",
		"for f in .dev-team/requests/*.md; do python3 fix.py \"$f\"; done",
		"ls .dev-team/requests | while read f; do python3 fix.py \".dev-team/requests/$f\"; done",
		"d=$(printf %s .dev-team/requests); python3 w.py \"$d\"",
		"set -- .dev-team/requests/*; python3 w.py \"$@\"",
		"w(){ python3 -c \"import sys;open(sys.argv[1],'w')\" \"$1\"; }; w .dev-team/requests/a.md",
		"ln .dev-team/requests/a.md h && echo forged > h",
		"ln -s .dev-team/requests r && echo forged > r/a.md",
		"cd \"$(pwd)/.dev-team/requests\" && python3 -c \"open('x.md','w')\"",
		"cd -- .dev-team/requests && touch a.md",
		"cd ~+/.dev-team/requests && touch a.md",
		"echo x > .dev-team/$(printf re)quests/a.md",
		"git show --output=.dev-team/requests/x.md HEAD",
		"git diff HEAD~3 -- .dev-team/requests | git apply -R",
		"sudo -u root sh -c 'echo forged > .dev-team/requests/x.md'",
		"nice python3 -c \"open('.dev-team/requests/x.md','w')\"",
		"xxd -r /tmp/x .dev-team/requests/a.md",
		"gawk -i inplace '{print \"forged\"}' .dev-team/requests/a.md",
		"awk -f p.awk .dev-team/requests/a.md",
		"sed -f s.sed .dev-team/requests/a.md",
		"sed -n 's/^/forged/gw .dev-team/requests/x.md' in.txt",
		"node <<'JS-END'\nrequire('fs').writeFileSync('.dev-team/requests/a.md','x')\nJS-END",
		"cat > /tmp/w.sh <<'EOF'\necho forged > .dev-team/requests/x.md\nEOF\nsh /tmp/w.sh",
		"echo 'echo forged > .dev-team/requests/x.md' > /tmp/w.sh && sh /tmp/w.sh",
		"rg --pre ./w.sh x .dev-team/requests",
		"alias p=python3\np -c \"open('.dev-team/requests/x.md','w')\"",
	]) {
		assert.equal(bash(command, cwd), true, command);
	}
});

test("writesRequestDir lets reads found as false positives in review run", (t) => {
	const cwd = project(t);
	for (const command of [
		"git -C . log --oneline -- .dev-team/requests",
		"git -c core.pager=cat log -- .dev-team/requests",
		"awk -F'|' '{print $2}' .dev-team/requests/a.md",
		"awk 'length > 80' .dev-team/requests/a.md",
		"pip install requests 2>&1 | tee \"$TMPDIR/pip.log\"",
		"grep -rn \"requests\" src > \"$TMPDIR/hits.txt\"",
		"ls .dev-team/requests; find src -name '*.pyc' | xargs rm -f",
		"uniq -f 1 .dev-team/requests/a.md",
		"find .dev-team/requests -name '*.md' -exec grep -n Example {} +",
		"cd src && python -m pytest",
	]) {
		assert.equal(bash(command, cwd), false, command);
	}
});


test("writesRequestDir guards the freeze file: writes, copies, moves, deletes and scripts are blocked, reads run", (t) => {
	const cwd = project(t);
	assert.equal(writesRequestDir("write", { path: ".dev-team/requests/.frozen.json", content: "{}" }, cwd), true);
	assert.equal(writesRequestDir("edit", { path: path.join(cwd, REQUEST_DIR, ".frozen.json") }, cwd), true);
	assert.equal(writesRequestDir("read", { path: ".dev-team/requests/.frozen.json" }, cwd), false);
	for (const command of [
		"echo '{}' > .dev-team/requests/.frozen.json",
		"cp /tmp/f.json .dev-team/requests/.frozen.json",
		"mv /tmp/f.json .dev-team/requests/.frozen.json",
		"rm .dev-team/requests/.frozen.json",
		"rm -f .dev-team/requests/.*.json",
		"python3 - <<'EOF'\nimport json\njson.dump({'version': 1, 'cases': {}}, open('.dev-team/requests/.frozen.json', 'w'))\nEOF",
		"jq '.cases = {}' .dev-team/requests/.frozen.json > /tmp/f && mv /tmp/f .dev-team/requests/.frozen.json",
	]) {
		assert.equal(bash(command, cwd), true, command);
	}
	for (const command of ["cat .dev-team/requests/.frozen.json", "jq .cases .dev-team/requests/.frozen.json", "ls -a .dev-team/requests"]) {
		assert.equal(bash(command, cwd), false, command);
	}
});

test("writesRequestDir: a loop in a heredoc body that does not spell the folder is program text (v6 eve cp2 false positive)", (t) => {
	const cwd = project(t);
	const eve =
		".venv/bin/python - <<'PY'\nimport bz2,csv\nfrom pathlib import Path\nfor p in Path('sde').glob('*'):\n print(p.name,p.stat().st_size)\nPY\nfind .dev-team/requests -type f -maxdepth 2 -print\n git status --short 2>/dev/null || true";
	assert.equal(bash(eve, cwd), false);
	assert.equal(bash("python3 - <<-EOF\n\tx = 1\n\tfor i in range(3): print(i)\n\tEOF\nls .dev-team/requests", cwd), false, "<<- with tab-indented delimiter");
	for (const command of [
		// The body is shell that builds the path from parts, so the line still counts as naming the folder.
		"ls .dev-team/requests; bash <<'EOF'\nd=.dev-team; for f in $d/requests/*; do rm $f; done\nEOF",
		// A loop outside the heredoc still counts.
		"cat <<'EOF' > /tmp/x\nhi\nEOF\nfor f in .dev-team/requests/*; do python3 w.py \"$f\"; done",
		// A python heredoc that names the folder is still a script that names it.
		"python3 - <<'EOF'\nfor p in __import__('pathlib').Path('.dev-team/requests').glob('*'): print(p.read_text())\nEOF",
		// A quoted `<<` opens no heredoc, so the loop after it is shell.
		"echo '<<EOF'\nfor f in .dev-team/requests/*; do python3 w.py \"$f\"; done",
	]) {
		assert.equal(bash(command, cwd), true, command);
	}
});

test("writesRequestDir: a line that names the freeze file only reads, and code fed to an interpreter may not name .dev-team (v7 review)", (t) => {
	const cwd = project(t);
	for (const command of [
		"find .dev-team -name .frozen.json -delete",
		"find . -name .frozen.json -exec rm {} +",
		"python3 - <<'EOF'\nimport pathlib\nfor p in pathlib.Path('.dev-team').rglob('.frozen.json'): p.unlink()\nEOF",
		"bash <<'EOF'\ncd .dev-team\nfor f in */.frozen.json; do rm $f; done\nEOF",
		"python3 -c \"import os; os.remove(os.path.join('.dev-team','reque'+'sts','.frozen.json'))\"",
		"rm -rf ~/.pi/agent/dev-team-frozen",
		// No `.frozen` on the line, but code that names .dev-team and builds the rest at run time.
		"python3 - <<'EOF'\nimport shutil\nshutil.rmtree('.dev-team/' + 'reque' + 'sts')\nEOF",
		"python3 -c \"import shutil; shutil.rmtree('.dev-team/'+'reque'+'sts')\"",
		"node -e \"require('fs').rmSync('.dev-team/'+'reque'+'sts', {recursive: true})\"",
	]) {
		assert.equal(bash(command, cwd), true, command);
	}
	for (const command of [
		"cat .dev-team/requests/.frozen.json",
		"find .dev-team -name .frozen.json",
		"uv sync --frozen && uv run pytest -q",
		"python3 ${CLAUDE_PLUGIN_ROOT}/scripts/example_replay.py",
		"python3 - <<'EOF'\nfor p in __import__('pathlib').Path('sde').glob('*'): print(p)\nEOF",
		"cd .dev-team && cat > examples.json <<'EOF'\n{}\nEOF",
	]) {
		assert.equal(bash(command, cwd), false, command);
	}
});
