import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

// Its own file, so the Python probe cache starts empty and finds nothing on an empty PATH.
test("without python a headless session warns on stderr, once", async (t) => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dt-nopy-"));
	const saved = { PATH: process.env.PATH, DEV_TEAM_PYTHON: process.env.DEV_TEAM_PYTHON, PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR };
	t.after(() => {
		fs.rmSync(dir, { recursive: true, force: true });
		for (const [key, value] of Object.entries(saved)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	});
	Object.assign(process.env, { PATH: dir, DEV_TEAM_PYTHON: path.join(dir, "python"), PI_CODING_AGENT_DIR: dir });
	const handlers: Record<string, ((event: unknown, ctx: unknown) => Promise<unknown>)[]> = {};
	const recorders: Record<string, unknown> = {
		on: (event: string, handler: (event: unknown, ctx: unknown) => Promise<unknown>) => (handlers[event] ??= []).push(handler),
		getAllTools: () => [],
		getActiveTools: () => [],
	};
	const { default: devTeam } = await import("../../extensions/dev-team/index.ts");
	await devTeam(new Proxy({}, { get: (_t, key) => recorders[String(key)] ?? (() => undefined) }) as never);
	const printed: string[] = [];
	t.mock.method(console, "error", (line: string) => void printed.push(line));
	const ctx = { cwd: dir, hasUI: false, mode: "print", isProjectTrusted: () => false, sessionManager: { getSessionId: () => "s", getSessionFile: () => undefined, getEntries: () => [] } };
	for (let i = 0; i < 2; i++) for (const h of handlers.session_start) await h({ reason: "startup" }, ctx);
	assert.equal(printed.filter((l) => /python >= 3\.10 not found/.test(l)).length, 1, printed.join("\n"));
});
