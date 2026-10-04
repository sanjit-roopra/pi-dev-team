import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { SUBAGENT_USAGE_ENTRY } from "../../extensions/dev-team/lib/subagent-types.ts";
import { loadUsageHistory, monthStart, sessionRoot } from "../../extensions/dev-team/lib/usage-history.ts";

const SINCE = new Date("2026-10-01T00:00:00Z");

/** An assistant turn entry costing `usd` on a Copilot model. */
const turn = (id: string, timestamp: string, usd = 0.1, model = "m"): Record<string, unknown> => ({
	type: "message",
	id,
	timestamp,
	message: { role: "assistant", provider: "github-copilot", model, usage: { cost: { total: usd } } },
});

/** Writes `files` (relative path to entries, or raw text) under a fresh temp root, which is removed after `fn`. */
async function withRoot<T>(files: Record<string, readonly Record<string, unknown>[] | string>, fn: (root: string) => Promise<T>): Promise<T> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "usage-history-"));
	try {
		for (const [rel, content] of Object.entries(files)) {
			await fs.mkdir(path.dirname(path.join(root, rel)), { recursive: true });
			const text = typeof content === "string" ? content : content.map((e) => JSON.stringify(e)).join("\n") + "\n";
			await fs.writeFile(path.join(root, rel), text);
		}
		return await fn(root);
	} finally {
		await fs.rm(root, { recursive: true, force: true });
	}
}

const load = (root: string) => loadUsageHistory({ root, since: SINCE });
/** Records as "timestamp model" so ordering and attribution read at a glance. */
const shown = (h: { records: { timestamp: string; run: { model: string } }[] }) => h.records.map((r) => `${r.timestamp} ${r.run.model}`);

test("monthStart: the 1st of the month at 00:00 UTC", () => {
	assert.equal(monthStart(new Date("2026-10-04T15:00:00Z")).toISOString(), "2026-10-01T00:00:00.000Z");
});

test("monthStart: the first day of a month does not reach back to the last one", () => {
	assert.equal(monthStart(new Date("2026-11-01T00:30:00Z")).toISOString(), "2026-11-01T00:00:00.000Z");
});

test("monthStart: the last instant of a month still belongs to it", () => {
	assert.equal(monthStart(new Date("2026-10-31T23:59:59.999Z")).toISOString(), "2026-10-01T00:00:00.000Z");
});

test("sessionRoot: a project's --cwd-- folder resolves to its parent, a flat session dir to itself", () => {
	assert.equal(sessionRoot("/home/u/.pi/agent/sessions/--home-u-proj--"), "/home/u/.pi/agent/sessions");
	assert.equal(sessionRoot("/home/u/.pi/agent/sessions/--home-u-proj--/"), "/home/u/.pi/agent/sessions");
	assert.equal(sessionRoot("/data/my-sessions"), "/data/my-sessions");
	assert.equal(sessionRoot("/data/----"), "/data/----");
	assert.equal(sessionRoot("/data/--"), "/data/--");
});

test("loadUsageHistory: spend comes from every top-level session file, with its timestamp", async () => {
	await withRoot(
		{
			"--proj-a--/1_a.jsonl": [turn("a1", "2026-10-02T10:00:00Z", 0.1, "a")],
			"--proj-b--/2_b.jsonl": [turn("b1", "2026-10-03T10:00:00Z", 0.1, "b")],
			"flat.jsonl": [turn("f1", "2026-10-04T10:00:00Z", 0.1, "f")],
		},
		async (root) => {
			const h = await load(root);
			assert.deepEqual(shown(h).sort(), ["2026-10-02T10:00:00Z github-copilot/a", "2026-10-03T10:00:00Z github-copilot/b", "2026-10-04T10:00:00Z github-copilot/f"]);
			assert.deepEqual([h.skipped, h.aborted], [0, false]);
		},
	);
});

test("loadUsageHistory: nested run files of another extension are ignored", async () => {
	await withRoot(
		{
			"--proj--/1_a.jsonl": [turn("a1", "2026-10-02T10:00:00Z", 0.1, "top")],
			"--proj--/sess/hash/run-0/session.jsonl": [turn("n1", "2026-10-02T11:00:00Z", 5, "nested")],
			"--proj--/sess/run-1/session.jsonl": [turn("n2", "2026-10-02T12:00:00Z", 5, "nested")],
		},
		async (root) => assert.deepEqual(shown(await load(root)), ["2026-10-02T10:00:00Z github-copilot/top"]),
	);
});

test("loadUsageHistory: a missing session root is no history, not an error", async () => {
	const h = await load(path.join(os.tmpdir(), "usage-history-does-not-exist"));
	assert.deepEqual(h, { records: [], skipped: 0, aborted: false });
});

test("loadUsageHistory: an entry exactly at the month start counts, one millisecond before does not", async () => {
	await withRoot(
		{ "--p--/1_a.jsonl": [turn("a", "2026-09-30T23:59:59.999Z", 0.1, "before"), turn("b", "2026-10-01T00:00:00.000Z", 0.1, "at")] },
		async (root) => assert.deepEqual(shown(await load(root)), ["2026-10-01T00:00:00.000Z github-copilot/at"]),
	);
});

test("loadUsageHistory: entries with a missing or invalid timestamp are ignored", async () => {
	const { timestamp: _omitted, ...noStamp } = turn("n", "x", 0.1, "none");
	await withRoot(
		{ "--p--/1_a.jsonl": [noStamp, turn("b", "not a date", 0.1, "bad"), { ...turn("c", "x", 0.1, "num"), timestamp: 1790000000000 }, turn("d", "2026-10-02T00:00:00Z", 0.1, "ok")] },
		async (root) => assert.deepEqual(shown(await load(root)), ["2026-10-02T00:00:00Z github-copilot/ok"]),
	);
});

test("loadUsageHistory: a dispatch entry's runs all carry that entry's timestamp", async () => {
	const totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0.1, turns: 1 };
	const dispatch = { type: "custom", customType: SUBAGENT_USAGE_ENTRY, id: "d1", timestamp: "2026-10-03T00:00:00Z", data: { agent: "orchestrator", model: "p/x", ok: true, durationMs: 0, usage: totals, nested: [{ agent: "Explore", usage: totals }] } };
	await withRoot(
		{ "--p--/1_a.jsonl": [turn("a", "2026-10-02T00:00:00Z", 0.1, "m1"), dispatch, turn("b", "2026-10-04T00:00:00Z", 0.1, "m2")] },
		async (root) => {
			const h = await load(root);
			assert.deepEqual(h.records.map((r) => [r.timestamp, r.run.agent]), [
				["2026-10-02T00:00:00Z", "main"],
				["2026-10-03T00:00:00Z", "orchestrator"],
				["2026-10-03T00:00:00Z", "Explore"],
				["2026-10-04T00:00:00Z", "main"],
			]);
		},
	);
});

test("loadUsageHistory: a compaction is booked to a model switched to before the month start", async () => {
	const switched = { type: "model_change", id: "m", timestamp: "2026-09-30T00:00:00Z", provider: "github-copilot", modelId: "late-switch" };
	const compaction = { type: "compaction", id: "c", timestamp: "2026-10-02T00:00:00Z", usage: { cost: { total: 0.05 } } };
	await withRoot(
		{ "--p--/1_a.jsonl": [switched, compaction] },
		async (root) => {
			const [rec] = (await load(root)).records;
			assert.deepEqual([rec.timestamp, rec.run.agent, rec.run.model], ["2026-10-02T00:00:00Z", "compaction", "github-copilot/late-switch"]);
		},
	);
});

test("loadUsageHistory: bad lines are ignored, valid entries kept", async () => {
	const good = (id: string, ts: string, model: string) => JSON.stringify(turn(id, ts, 0.1, model));
	const text = [good("a", "2026-10-02T00:00:00Z", "first"), "this is not json", "[1,2]", "null", "", good("b", "2026-10-03T00:00:00Z", "second"), '{"type":"message","id":"c","timest'].join("\n");
	await withRoot({ "--p--/1_a.jsonl": text }, async (root) => {
		const h = await load(root);
		assert.deepEqual(shown(h), ["2026-10-02T00:00:00Z github-copilot/first", "2026-10-03T00:00:00Z github-copilot/second"]);
		assert.equal(h.skipped, 0);
	});
});

test("loadUsageHistory: a file last modified before the month start is never opened, so it is not skipped", async () => {
	await withRoot({ "--p--/old.jsonl": "{ invalid", "--p--/new.jsonl": [turn("n", "2026-10-02T00:00:00Z", 0.1, "new")] }, async (root) => {
		const long = new Date("2026-09-15T00:00:00Z");
		await fs.utimes(path.join(root, "--p--/old.jsonl"), long, long);
		const recent = new Date("2026-10-03T00:00:00Z");
		await fs.utimes(path.join(root, "--p--/new.jsonl"), recent, recent);
		const h = await load(root);
		assert.deepEqual([shown(h), h.skipped], [["2026-10-02T00:00:00Z github-copilot/new"], 0]);
	});
});

test("loadUsageHistory: an unreadable file is skipped and counted, the others are returned", { skip: process.getuid?.() === 0 && "root reads any file" }, async () => {
	await withRoot({ "--p--/a.jsonl": [turn("a", "2026-10-02T00:00:00Z", 0.1, "ok")], "--p--/b.jsonl": [turn("b", "2026-10-02T00:00:00Z", 0.1, "locked")] }, async (root) => {
		await fs.chmod(path.join(root, "--p--/b.jsonl"), 0o000);
		const h = await load(root);
		assert.deepEqual([shown(h), h.skipped], [["2026-10-02T00:00:00Z github-copilot/ok"], 1]);
	});
});

test("loadUsageHistory: a file with an entry spend cannot read is skipped whole, adding no records", async () => {
	const broken = { type: "custom", customType: SUBAGENT_USAGE_ENTRY, id: "x", timestamp: "2026-10-02T00:00:00Z", data: { agent: "a", usage: { cost: 0.1 }, nested: 5 } };
	await withRoot({ "--p--/a.jsonl": [turn("a", "2026-10-02T00:00:00Z", 0.1, "before"), broken] }, async (root) => {
		const h = await load(root);
		assert.deepEqual([h.records, h.skipped], [[], 1]);
	});
});

test("loadUsageHistory: an empty session root has no history", async () => {
	await withRoot({}, async (root) => assert.deepEqual(await load(root), { records: [], skipped: 0, aborted: false }));
});

test("loadUsageHistory: progress is reported after each file modified this month", async () => {
	await withRoot({ "--p--/a.jsonl": [], "--p--/b.jsonl": [], "--q--/c.jsonl": [], "--q--/old.jsonl": [] }, async (root) => {
		const old = new Date("2026-08-01T00:00:00Z");
		await fs.utimes(path.join(root, "--q--/old.jsonl"), old, old);
		const calls: [number, number][] = [];
		await loadUsageHistory({ root, since: SINCE, onProgress: (done, total) => calls.push([done, total]) });
		assert.deepEqual(calls, [[1, 3], [2, 3], [3, 3]]);
	});
});

test("loadUsageHistory: the same id with different timestamps are both returned", async () => {
	await withRoot({ "--p--/a.jsonl": [turn("same", "2026-10-02T00:00:00Z", 0.1, "x"), turn("same", "2026-10-03T00:00:00Z", 0.1, "x")] }, async (root) => {
		assert.equal((await load(root)).records.length, 2);
	});
});
