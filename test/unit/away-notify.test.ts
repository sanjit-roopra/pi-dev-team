import assert from "node:assert/strict";
import { test } from "node:test";
import { notifyUrl, sendAway } from "../../extensions/dev-team/lib/away-notify.ts";

type Call = { url: string; init: RequestInit };

/** A fetch that records its calls and answers with `status`, or throws `error`. */
function fakeFetch(status = 200, error?: Error) {
	const calls: Call[] = [];
	const impl = (async (url: string, init: RequestInit) => {
		calls.push({ url, init });
		if (error) throw error;
		return new Response("", { status });
	}) as unknown as typeof fetch;
	return { impl, calls };
}

test("notifyUrl turns an ntfy topic into an ntfy.sh URL", () => {
	assert.equal(notifyUrl("ntfy:my-team_42"), "https://ntfy.sh/my-team_42");
	assert.equal(notifyUrl("  ntfy: my-team  "), "https://ntfy.sh/my-team");
});

test("notifyUrl accepts an https URL with a path", () => {
	assert.equal(notifyUrl("ntfy:https://ntfy.example.com/alerts"), "https://ntfy.example.com/alerts");
	assert.equal(notifyUrl("ntfy:https://ntfy.example.com/"), undefined, "no topic path");
});

test("notifyUrl rejects http, bad topic characters and other schemes", () => {
	assert.equal(notifyUrl("ntfy:http://ntfy.example.com/alerts"), undefined);
	assert.equal(notifyUrl("ntfy:my topic"), undefined);
	assert.equal(notifyUrl("ntfy:a/b"), undefined);
	assert.equal(notifyUrl("ntfy:topic?x=1"), undefined);
	assert.equal(notifyUrl(`ntfy:${"a".repeat(65)}`), undefined);
	assert.equal(notifyUrl("slack:topic"), undefined);
	assert.equal(notifyUrl("my-topic"), undefined);
});

test("notifyUrl gives undefined for an empty setting", () => {
	assert.equal(notifyUrl(""), undefined);
	assert.equal(notifyUrl("ntfy:"), undefined);
});

test("sendAway POSTs the message with an ASCII-only title", async () => {
	const { impl, calls } = fakeFetch();
	assert.equal(await sendAway("ntfy:team", "dev-team ⏱ went on — alone", "Picked the recommended option.", impl), undefined);
	assert.equal(calls.length, 1);
	assert.equal(calls[0].url, "https://ntfy.sh/team");
	assert.equal(calls[0].init.method, "POST");
	assert.equal(calls[0].init.body, "Picked the recommended option.");
	assert.deepEqual(calls[0].init.headers, { Title: "dev-team  went on  alone" });
	assert.ok(calls[0].init.signal instanceof AbortSignal);
});

test("sendAway cuts a long message to 3500 characters", async () => {
	const { impl, calls } = fakeFetch();
	await sendAway("ntfy:team", "t", "x".repeat(5000), impl);
	assert.equal((calls[0].init.body as string).length, 3500);
});

test("sendAway returns an error text on an HTTP error", async () => {
	const { impl } = fakeFetch(500);
	assert.equal(await sendAway("ntfy:team", "t", "m", impl), "dev-team: notify got HTTP 500 from ntfy.sh.");
});

test("sendAway returns an error text when fetch throws, and does not throw itself", async () => {
	const { impl } = fakeFetch(200, new Error("getaddrinfo ENOTFOUND"));
	assert.equal(await sendAway("ntfy:team", "t", "m", impl), "dev-team: notify failed: getaddrinfo ENOTFOUND");
});

test("sendAway names an invalid setting and sends nothing", async () => {
	const { impl, calls } = fakeFetch();
	const error = await sendAway("ntfy:http://x.example/y", "t", "m", impl);
	assert.match(error ?? "", /"notify": "ntfy:http:\/\/x\.example\/y" is not ntfy:<topic>/);
	assert.equal(calls.length, 0);
});

test("sendAway does nothing for an empty setting", async () => {
	const { impl, calls } = fakeFetch();
	assert.equal(await sendAway("", "t", "m", impl), undefined);
	assert.equal(await sendAway("   ", "t", "m", impl), undefined);
	assert.equal(calls.length, 0);
});
