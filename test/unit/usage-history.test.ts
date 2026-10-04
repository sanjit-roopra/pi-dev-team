import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { SUBAGENT_USAGE_ENTRY } from "../../extensions/dev-team/lib/subagent-types.ts";
import { loadSpendHistory, sessionRoot } from "../../extensions/dev-team/lib/usage-history.ts";

const SINCE = new Date("2026-10-01T00:00:00Z");
/** Every file written by withRoot is last modified here, after SINCE, so it is read unless a test says otherwise. */
const RECENT = new Date("2026-10-05T12:00:00Z");
/** Files a test cannot lock down with chmod: root reads anything, Windows has no such modes. */
const CANNOT_CHMOD = process.platform === "win32" || process.getuid?.() === 0 ? "chmod cannot deny this user access" : false;

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
			await fs.utimes(path.join(root, rel), RECENT, RECENT);
		}
		return await fn(root);
	} finally {
		await fs.rm(root, { recursive: true, force: true });
	}
}

const load = (root: string) => loadSpendHistory({ root, since: SINCE });
/** Records as "timestamp model" so ordering and attribution read at a glance. */
const shown = (h: { records: { timestamp: string; run: { model: string } }[] }) => h.records.map((r) => `${r.timestamp} ${r.run.model}`);

const totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0.1, turns: 1 };

/** A subagent dispatch entry: an orchestrator run with one nested Explore run. */
const dispatchEntry = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
	type: "custom",
	customType: SUBAGENT_USAGE_ENTRY,
	id: "d1",
	timestamp: "2026-10-03T00:00:00Z",
	data: { agent: "orchestrator", model: "p/x", ok: true, durationMs: 0, usage: totals, nested: [{ agent: "Explore", usage: totals }] },
	...overrides,
});

/** An entry spend cannot make sense of (its `nested` is not a list), so the file holding it fails whole. */
const brokenEntry = (): Record<string, unknown> =>
	dispatchEntry({ id: "x", timestamp: "2026-10-02T00:00:00Z", data: { agent: "a", usage: { cost: 0.1 }, nested: 5 } });

const modelChange = (modelId: string): Record<string, unknown> => ({ type: "model_change", timestamp: "2026-09-30T00:00:00Z", provider: "github-copilot", modelId });

/** A compaction, which is booked to the model in effect before it. */
const compaction = (id: string, timestamp: string): Record<string, unknown> => ({ type: "compaction", id, timestamp, usage: { cost: { total: 0.05 } } });

test("sessionRoot: a project's --cwd-- folder resolves to its parent, a flat session dir to itself", () => {
	assert.equal(sessionRoot("/home/u/.pi/agent/sessions/--home-u-proj--"), "/home/u/.pi/agent/sessions");
	assert.equal(sessionRoot("/home/u/.pi/agent/sessions/--home-u-proj--/"), "/home/u/.pi/agent/sessions");
	assert.equal(sessionRoot("/data/my-sessions"), "/data/my-sessions");
	assert.equal(sessionRoot("/data/----"), "/data/----");
	assert.equal(sessionRoot("/data/--"), "/data/--");
});

test("loadSpendHistory: spend comes from every top-level session file, with its timestamp: root-level files, then project folders", async () => {
	await withRoot(
		{
			"--proj-a--/1_a.jsonl": [turn("a1", "2026-10-02T10:00:00Z", 0.1, "a")],
			"--proj-b--/2_b.jsonl": [turn("b1", "2026-10-03T10:00:00Z", 0.1, "b")],
			"flat.jsonl": [turn("f1", "2026-10-04T10:00:00Z", 0.1, "f")],
		},
		async (root) => {
			const h = await load(root);
			assert.deepEqual(shown(h), ["2026-10-04T10:00:00Z github-copilot/f", "2026-10-02T10:00:00Z github-copilot/a", "2026-10-03T10:00:00Z github-copilot/b"]);
			assert.deepEqual([h.skipped, h.aborted], [0, false]);
		},
	);
});

test("loadSpendHistory: nested run files of another extension are ignored", async () => {
	await withRoot(
		{
			"--proj--/1_a.jsonl": [turn("a1", "2026-10-02T10:00:00Z", 0.1, "top")],
			"--proj--/sess/hash/run-0/session.jsonl": [turn("n1", "2026-10-02T11:00:00Z", 5, "nested")],
			"--proj--/sess/run-1/session.jsonl": [turn("n2", "2026-10-02T12:00:00Z", 5, "nested")],
		},
		async (root) => assert.deepEqual(shown(await load(root)), ["2026-10-02T10:00:00Z github-copilot/top"]),
	);
});

test("loadSpendHistory: a missing session root is no history, not an error", async () => {
	await withRoot({}, async (root) => {
		assert.deepEqual(await load(path.join(root, "does-not-exist")), { records: [], skipped: 0, aborted: false });
	});
});

test("loadSpendHistory: a session root that cannot be listed is an error, not an empty history", async () => {
	await withRoot({ "not-a-folder": "" }, async (root) => {
		await assert.rejects(load(path.join(root, "not-a-folder")), { code: "ENOTDIR" });
	});
});

test("loadSpendHistory: an entry exactly at the month start counts, one millisecond before does not", async () => {
	await withRoot(
		{ "--p--/1_a.jsonl": [turn("a", "2026-09-30T23:59:59.999Z", 0.1, "before"), turn("b", "2026-10-01T00:00:00.000Z", 0.1, "at")] },
		async (root) => assert.deepEqual(shown(await load(root)), ["2026-10-01T00:00:00.000Z github-copilot/at"]),
	);
});

test("loadSpendHistory: entries with a missing or invalid timestamp are ignored", async () => {
	const { timestamp: _omitted, ...noStamp } = turn("n", "x", 0.1, "none");
	await withRoot(
		{ "--p--/1_a.jsonl": [noStamp, turn("b", "not a date", 0.1, "bad"), { ...turn("c", "x", 0.1, "num"), timestamp: 1790000000000 }, turn("d", "2026-10-02T00:00:00Z", 0.1, "ok")] },
		async (root) => assert.deepEqual(shown(await load(root)), ["2026-10-02T00:00:00Z github-copilot/ok"]),
	);
});

test("loadSpendHistory: a dispatch entry's runs all carry that entry's timestamp", async () => {
	await withRoot(
		{ "--p--/1_a.jsonl": [turn("a", "2026-10-02T00:00:00Z", 0.1, "m1"), dispatchEntry(), turn("b", "2026-10-04T00:00:00Z", 0.1, "m2")] },
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

test("loadSpendHistory: a compaction is booked to a model switched to before the month start", async () => {
	await withRoot(
		{ "--p--/1_a.jsonl": [modelChange("late-switch"), compaction("c", "2026-10-02T00:00:00Z")] },
		async (root) => {
			const [rec] = (await load(root)).records;
			assert.deepEqual([rec.timestamp, rec.run.agent, rec.run.model], ["2026-10-02T00:00:00Z", "compaction", "github-copilot/late-switch"]);
		},
	);
});

test("loadSpendHistory: bad lines are ignored, valid entries kept", async () => {
	const good = (id: string, ts: string, model: string) => JSON.stringify(turn(id, ts, 0.1, model));
	const text = [good("a", "2026-10-02T00:00:00Z", "first"), "this is not json", "[1,2]", "null", "", good("b", "2026-10-03T00:00:00Z", "second"), '{"type":"message","id":"c","timest'].join("\n");
	await withRoot({ "--p--/1_a.jsonl": text }, async (root) => {
		const h = await load(root);
		assert.deepEqual(shown(h), ["2026-10-02T00:00:00Z github-copilot/first", "2026-10-03T00:00:00Z github-copilot/second"]);
		assert.equal(h.skipped, 0);
	});
});

test("loadSpendHistory: lines end with CRLF or LF alike", async () => {
	const text = [turn("a", "2026-10-02T00:00:00Z", 0.1, "first"), turn("b", "2026-10-03T00:00:00Z", 0.1, "second")].map((e) => JSON.stringify(e)).join("\r\n");
	await withRoot({ "--p--/1_a.jsonl": text }, async (root) => {
		assert.deepEqual(shown(await load(root)), ["2026-10-02T00:00:00Z github-copilot/first", "2026-10-03T00:00:00Z github-copilot/second"]);
	});
});

test("loadSpendHistory: a file last modified before the month start is never opened, so it is not skipped", async () => {
	await withRoot({ "--p--/old.jsonl": "{ invalid", "--p--/new.jsonl": [turn("n", "2026-10-02T00:00:00Z", 0.1, "new")] }, async (root) => {
		const long = new Date("2026-09-15T00:00:00Z");
		await fs.utimes(path.join(root, "--p--/old.jsonl"), long, long);
		const h = await load(root);
		assert.deepEqual([shown(h), h.skipped], [["2026-10-02T00:00:00Z github-copilot/new"], 0]);
	});
});

test("loadSpendHistory: an unreadable file is skipped and counted, the others are returned", { skip: CANNOT_CHMOD }, async () => {
	await withRoot({ "--p--/a.jsonl": [turn("a", "2026-10-02T00:00:00Z", 0.1, "ok")], "--p--/b.jsonl": [turn("b", "2026-10-02T00:00:00Z", 0.1, "locked")] }, async (root) => {
		await fs.chmod(path.join(root, "--p--/b.jsonl"), 0o000);
		const h = await load(root);
		assert.deepEqual([shown(h), h.skipped], [["2026-10-02T00:00:00Z github-copilot/ok"], 1]);
	});
});

test("loadSpendHistory: a project folder that cannot be listed counts as one skipped file, the other folders are returned", { skip: CANNOT_CHMOD }, async () => {
	await withRoot({ "--bad--/a.jsonl": [turn("a", "2026-10-02T00:00:00Z", 0.1, "hidden")], "--good--/b.jsonl": [turn("b", "2026-10-03T00:00:00Z", 0.1, "ok")] }, async (root) => {
		const bad = path.join(root, "--bad--");
		await fs.chmod(bad, 0o000);
		try {
			const h = await load(root);
			assert.deepEqual([shown(h), h.skipped], [["2026-10-03T00:00:00Z github-copilot/ok"], 1]);
		} finally {
			await fs.chmod(bad, 0o755);
		}
	});
});

// A folder without search permission lists fine (names and types) but its files cannot be stat-ed. Where
// a filesystem reports no entry types, listing fails instead; one skipped file either way. A file that
// vanishes between listing and stat cannot be provoked deterministically, so that branch has no test.
test("loadSpendHistory: a file that cannot be stat-ed is skipped and counted, the others are returned", { skip: CANNOT_CHMOD }, async () => {
	await withRoot({ "--bad--/a.jsonl": [turn("a", "2026-10-02T00:00:00Z", 0.1, "hidden")], "--good--/b.jsonl": [turn("b", "2026-10-03T00:00:00Z", 0.1, "ok")] }, async (root) => {
		const bad = path.join(root, "--bad--");
		await fs.chmod(bad, 0o444);
		try {
			const h = await load(root);
			assert.deepEqual([shown(h), h.skipped], [["2026-10-03T00:00:00Z github-copilot/ok"], 1]);
		} finally {
			await fs.chmod(bad, 0o755);
		}
	});
});

test("loadSpendHistory: a file that vanishes after it was listed is not counted as skipped", async () => {
	await withRoot({ "--p--/1.jsonl": [turn("a", "2026-10-02T00:00:00Z", 0.1, "kept")], "--p--/2.jsonl": [turn("b", "2026-10-03T00:00:00Z", 0.1, "gone")] }, async (root) => {
		const calls: [number, number][] = [];
		const h = await loadSpendHistory({
			root,
			since: SINCE,
			onProgress: (done, total) => {
				calls.push([done, total]);
				rmSync(path.join(root, "--p--/2.jsonl"));
			},
		});
		assert.deepEqual([shown(h), h.skipped, calls], [["2026-10-02T00:00:00Z github-copilot/kept"], 0, [[1, 2], [2, 2]]]);
	});
});

test("loadSpendHistory: a file with an entry spend cannot read is skipped whole, adding no records", async () => {
	await withRoot({ "--p--/a.jsonl": [turn("a", "2026-10-02T00:00:00Z", 0.1, "before"), brokenEntry()] }, async (root) => {
		const h = await load(root);
		assert.deepEqual([h.records, h.skipped], [[], 1]);
	});
});

test("loadSpendHistory: an empty session root has no history", async () => {
	await withRoot({}, async (root) => assert.deepEqual(await load(root), { records: [], skipped: 0, aborted: false }));
});

test("loadSpendHistory: progress is reported after each file modified this month", async () => {
	await withRoot({ "--p--/a.jsonl": [], "--p--/b.jsonl": [], "--q--/c.jsonl": [], "--q--/old.jsonl": [] }, async (root) => {
		const old = new Date("2026-08-01T00:00:00Z");
		await fs.utimes(path.join(root, "--q--/old.jsonl"), old, old);
		const calls: [number, number][] = [];
		await loadSpendHistory({ root, since: SINCE, onProgress: (done, total) => calls.push([done, total]) });
		assert.deepEqual(calls, [[1, 3], [2, 3], [3, 3]]);
	});
});

test("loadSpendHistory: progress is reported for an unreadable file too", { skip: CANNOT_CHMOD }, async () => {
	await withRoot({ "--p--/a.jsonl": [], "--p--/b.jsonl": [] }, async (root) => {
		await fs.chmod(path.join(root, "--p--/a.jsonl"), 0o000);
		const calls: [number, number][] = [];
		const h = await loadSpendHistory({ root, since: SINCE, onProgress: (done, total) => calls.push([done, total]) });
		assert.deepEqual([h.skipped, calls], [1, [[1, 2], [2, 2]]]);
	});
});

test("loadSpendHistory: a progress callback that throws does not stop the load", async () => {
	await withRoot({ "--p--/1.jsonl": [turn("a", "2026-10-02T00:00:00Z", 0.1, "first")], "--p--/2.jsonl": [turn("b", "2026-10-03T00:00:00Z", 0.1, "second")] }, async (root) => {
		const h = await loadSpendHistory({ root, since: SINCE, onProgress: () => { throw new Error("renderer broke"); } });
		assert.deepEqual([shown(h), h.skipped, h.aborted], [["2026-10-02T00:00:00Z github-copilot/first", "2026-10-03T00:00:00Z github-copilot/second"], 0, false]);
	});
});

test("loadSpendHistory: within one file, the same id with different timestamps are both returned", async () => {
	await withRoot({ "--p--/a.jsonl": [turn("same", "2026-10-02T00:00:00Z", 0.1, "x"), turn("same", "2026-10-03T00:00:00Z", 0.1, "x")] }, async (root) => {
		assert.deepEqual(shown(await load(root)), ["2026-10-02T00:00:00Z github-copilot/x", "2026-10-03T00:00:00Z github-copilot/x"]);
	});
});

test("loadSpendHistory: within one file, the same id and timestamp twice counts once, the first copy", async () => {
	await withRoot({ "--p--/a.jsonl": [turn("same", "2026-10-02T00:00:00Z", 0.1, "first"), turn("same", "2026-10-02T00:00:00Z", 0.1, "second")] }, async (root) => {
		assert.deepEqual(shown(await load(root)), ["2026-10-02T00:00:00Z github-copilot/first"]);
	});
});

test("loadSpendHistory: across two files, the same id with different timestamps are both returned", async () => {
	await withRoot({ "--p--/1.jsonl": [turn("same", "2026-10-02T00:00:00Z", 0.1, "x")], "--p--/2.jsonl": [turn("same", "2026-10-03T00:00:00Z", 0.1, "x")] }, async (root) => {
		assert.deepEqual(shown(await load(root)), ["2026-10-02T00:00:00Z github-copilot/x", "2026-10-03T00:00:00Z github-copilot/x"]);
	});
});

test("loadSpendHistory: an entry copied into a fork with the same id and timestamp counts once, in the first copy's context", async () => {
	const shared = compaction("same", "2026-10-02T00:00:00Z");
	await withRoot(
		{
			"--p--/1_orig.jsonl": [modelChange("orig"), shared, turn("o", "2026-10-03T00:00:00Z", 0.1, "orig-only")],
			"--p--/2_fork.jsonl": [modelChange("fork"), shared, turn("f", "2026-10-04T00:00:00Z", 0.1, "fork-only")],
			"--q--/3_clone.jsonl": [modelChange("clone"), shared],
		},
		async (root) => {
			assert.deepEqual(shown(await load(root)), ["2026-10-02T00:00:00Z github-copilot/orig", "2026-10-03T00:00:00Z github-copilot/orig-only", "2026-10-04T00:00:00Z github-copilot/fork-only"]);
		},
	);
});

test("loadSpendHistory: of a shared entry, the root-level copy wins over a project folder's, even one that sorts first", async () => {
	const shared = compaction("same", "2026-10-02T00:00:00Z");
	await withRoot({ "--p--/1.jsonl": [modelChange("project"), shared], "flat.jsonl": [modelChange("root"), shared] }, async (root) => {
		assert.deepEqual(shown(await load(root)), ["2026-10-02T00:00:00Z github-copilot/root"]);
	});
});

test("loadSpendHistory: of a shared entry, the copy in the first folder by name wins, then the first file by name", async () => {
	const shared = compaction("same", "2026-10-02T00:00:00Z");
	await withRoot(
		{
			"--b--/1.jsonl": [modelChange("b-1"), shared],
			"--a--/2.jsonl": [modelChange("a-2"), shared],
			"--a--/1.jsonl": [modelChange("a-1"), shared],
		},
		async (root) => assert.deepEqual(shown(await load(root)), ["2026-10-02T00:00:00Z github-copilot/a-1"]),
	);
});

test("loadSpendHistory: file and folder names are ordered by code unit, not by locale", async () => {
	const shared = compaction("same", "2026-10-02T00:00:00Z");
	// By code unit "B" < "a"; localeCompare would put "a" first.
	await withRoot({ "a.jsonl": [modelChange("lower"), shared], "B.jsonl": [modelChange("upper"), shared] }, async (root) => {
		assert.deepEqual(shown(await load(root)), ["2026-10-02T00:00:00Z github-copilot/upper"]);
	});
});

test("loadSpendHistory: entries without an id are never merged", async () => {
	const { id: _id, ...anonymous } = turn("x", "2026-10-02T00:00:00Z", 0.1, "anon");
	await withRoot({ "--p--/a.jsonl": [anonymous, anonymous], "--p--/b.jsonl": [anonymous] }, async (root) => {
		assert.deepEqual(shown(await load(root)), Array(3).fill("2026-10-02T00:00:00Z github-copilot/anon"));
	});
});

test("loadSpendHistory: a file that fails midway does not claim its entries from later copies", async () => {
	const shared = turn("same", "2026-10-02T00:00:00Z", 0.1, "shared");
	await withRoot({ "--p--/1_broken.jsonl": [shared, brokenEntry()], "--p--/2_good.jsonl": [shared] }, async (root) => {
		const h = await load(root);
		assert.deepEqual([shown(h), h.skipped], [["2026-10-02T00:00:00Z github-copilot/shared"], 1]);
	});
});

test("loadSpendHistory: an abort between files stops the load as aborted, keeping what was read", async () => {
	await withRoot({ "--p--/1.jsonl": [turn("a", "2026-10-02T00:00:00Z", 0.1, "first")], "--p--/2.jsonl": [turn("b", "2026-10-03T00:00:00Z", 0.1, "second")] }, async (root) => {
		const controller = new AbortController();
		const calls: number[] = [];
		const h = await loadSpendHistory({ root, since: SINCE, signal: controller.signal, onProgress: (done) => { calls.push(done); controller.abort(); } });
		assert.deepEqual([shown(h), h.aborted, calls], [["2026-10-02T00:00:00Z github-copilot/first"], true, [1]]);
	});
});

test("loadSpendHistory: an abort partway through a file keeps nothing of that file and does not count it skipped", async () => {
	const lines = Array.from({ length: 200 }, (_, i) => turn(`t${i}`, "2026-10-02T00:00:00Z", 0.1, `m${i}`));
	await withRoot({ "--p--/1.jsonl": lines }, async (root) => {
		// The load only reads `aborted`: it turns true on the 10th look, long before 200 lines have been read.
		let looks = 0;
		const signal = { get aborted() { return ++looks > 10; } } as AbortSignal;
		const h = await loadSpendHistory({ root, since: SINCE, signal });
		assert.deepEqual(h, { records: [], skipped: 0, aborted: true });
	});
});

test("loadSpendHistory: a signal already aborted reads nothing", async () => {
	await withRoot({ "--p--/1.jsonl": [turn("a", "2026-10-02T00:00:00Z", 0.1, "first")] }, async (root) => {
		const h = await loadSpendHistory({ root, since: SINCE, signal: AbortSignal.abort() });
		assert.deepEqual(h, { records: [], skipped: 0, aborted: true });
	});
});

test("loadSpendHistory: a load nobody aborts is not aborted", async () => {
	await withRoot({ "--p--/1.jsonl": [turn("a", "2026-10-02T00:00:00Z")] }, async (root) => {
		assert.equal((await loadSpendHistory({ root, since: SINCE, signal: new AbortController().signal })).aborted, false);
	});
});
