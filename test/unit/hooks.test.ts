import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { type TestContext, test } from "node:test";
import { DEFAULT_CONFIG, type DevTeamConfig } from "../../extensions/dev-team/lib/config.ts";
import { HookBridge, resolvePython } from "../../extensions/dev-team/lib/hooks.ts";

const SCRIPTS: Record<string, string> = {
	ok: "print('note')",
	crash: "import sys; sys.stderr.write('Traceback\\nboom'); sys.exit(1)",
	block: "import sys; print('no'); sys.exit(2)",
	deny: "import json; print(json.dumps({'hookSpecificOutput': {'permissionDecision': 'deny', 'permissionDecisionReason': 'nope'}}))",
	slow: "import time; time.sleep(5)",
};

function hookRoot(t: TestContext): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "dt-hookrun-"));
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	fs.mkdirSync(path.join(root, "hooks"));
	for (const [name, body] of Object.entries(SCRIPTS)) fs.writeFileSync(path.join(root, "hooks", `${name}.py`), body);
	return root;
}

const withTimeout = (timeoutSec: unknown): DevTeamConfig => ({ ...DEFAULT_CONFIG, hooks: { ...DEFAULT_CONFIG.hooks, timeoutSec: timeoutSec as number } });

const CASES: { name: string; script: string; python?: string | null; timeoutSec?: unknown; block?: RegExp; advisory?: RegExp; warning?: RegExp }[] = [
	{ name: "exit 0 is an advisory", script: "ok", advisory: /\[ok\] note/ },
	{ name: "exit 1 warns with the stderr tail and does not block", script: "crash", warning: /^\[crash\] failed \(exit 1\): .*boom$/s },
	{ name: "exit 2 blocks", script: "block", block: /\[block\] no/ },
	{ name: "JSON deny blocks", script: "deny", block: /\[deny\] nope/ },
	{ name: "timeout warns and does not block", script: "slow", timeoutSec: 1, warning: /^\[slow\] failed \(timeout\)/ },
	{ name: "an unparseable timeout uses the default, not 0", script: "ok", timeoutSec: "60s", advisory: /\[ok\] note/ },
	{ name: "a python that cannot start warns", script: "ok", python: path.join(os.tmpdir(), "no-such-python"), warning: /^\[ok\] failed \(exit \?\): .*ENOENT/ },
	{ name: "no python runs nothing", script: "ok", python: null },
];

for (const c of CASES) {
	test(`hook run: ${c.name}`, async (t) => {
		const python = c.python === undefined ? resolvePython() : c.python;
		if (c.python === undefined && !python) return t.skip("python >= 3.10 not found");
		const warnings: string[] = [];
		const bridge = new HookBridge(hookRoot(t), () => withTimeout(c.timeoutSec ?? 60), () => python, (line) => warnings.push(line));
		const out = await bridge.runScript(c.script, "PreToolUse", {}, os.tmpdir());
		if (c.block) assert.match(out.block ?? "", c.block);
		else assert.equal(out.block, undefined);
		if (c.advisory) assert.match(out.advisories.join("\n"), c.advisory);
		if (c.warning) {
			assert.equal(warnings.length, 1);
			assert.match(warnings[0], c.warning);
		} else assert.deepEqual(warnings, []);
	});
}
