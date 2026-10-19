import assert from "node:assert/strict";
import { test } from "node:test";
import { createPlainGate, lintQuestion, questionLayout, recommendedFirst } from "../../extensions/dev-team/lib/plain-questions.ts";

const clean = {
	header: "Rate limit",
	question: "Limit per user or per API key?",
	why: "Shared keys hit the limit faster.",
	options: [{ label: "Per API key (recommended)" }, { label: "Per user", description: "Each person gets their own limit." }],
};

test("a plain question passes the lint", () => {
	assert.deepEqual(lintQuestion(clean), []);
});

test("a header over eight words is flagged", () => {
	const problems = lintQuestion({ ...clean, header: "One two three four five six seven eight nine" });
	assert.equal(problems.length, 1);
	assert.match(problems[0], /has 9 words\. Keep at most 8/);
	assert.deepEqual(lintQuestion({ ...clean, header: "One two three four five six seven eight" }), []);
});

test("more than five options are flagged", () => {
	const options = ["A", "B", "C", "D", "E", "F"].map((label) => ({ label }));
	assert.ok(lintQuestion({ ...clean, options }).some((p) => /has 6 options\. Keep at most 5/.test(p)));
	assert.deepEqual(lintQuestion({ ...clean, options: options.slice(0, 5) }), []);
});

test("a hedge word in the question, why or an option is flagged", () => {
	assert.ok(lintQuestion({ ...clean, question: "Should we limit per user?" }).some((p) => /"should"/.test(p)));
	assert.ok(lintQuestion({ ...clean, why: "It should be faster." }).some((p) => /"should"/.test(p)));
	assert.ok(lintQuestion({ ...clean, options: [{ label: "Per key", description: "It might be faster." }] }).some((p) => /"might"/.test(p)));
});

test("an em-dash is flagged", () => {
	assert.ok(lintQuestion({ ...clean, why: "Shared keys — the common case — hit it faster." }).some((p) => /em-dash/.test(p)));
});

test("a sentence over 25 words is flagged", () => {
	const long = `${Array.from({ length: 26 }, (_, i) => `word${i}`).join(" ")}.`;
	assert.ok(lintQuestion({ ...clean, why: long }).some((p) => /Split 1 sentence/.test(p)));
});

test("recommendedFirst moves recommended options to the front and keeps the order otherwise", () => {
	const options = [{ label: "A" }, { label: "B (Recommended)" }, { label: "C" }, { label: "D (recommended)" }, { label: "E" }];
	assert.deepEqual(recommendedFirst(options).map((o) => o.label), ["B (Recommended)", "D (recommended)", "A", "C", "E"]);
	assert.deepEqual(recommendedFirst([{ label: "A" }, { label: "B" }]).map((o) => o.label), ["A", "B"]);
	assert.notEqual(recommendedFirst(options), options, "returns a new array");
});

test("questionLayout numbers the question among several and adds the why line", () => {
	assert.deepEqual(questionLayout(clean, 1, 5), {
		title: "Q2/5 · Rate limit: Limit per user or per API key?",
		body: ["Why it matters: Shared keys hit the limit faster."],
	});
});

test("questionLayout leaves out the number for a single question, and the header and why when missing", () => {
	assert.deepEqual(questionLayout(clean, 0, 1), { title: "Rate limit: Limit per user or per API key?", body: ["Why it matters: Shared keys hit the limit faster."] });
	assert.deepEqual(questionLayout({ question: "Go on?" }, 0, 1), { title: "Go on?", body: [] });
	assert.equal(questionLayout({ question: "Go on?" }, 2, 3).title, "Q3/3 · Go on?");
});

test("the plain gate blocks a rule break once and lets the same call through the second time", () => {
	const gate = createPlainGate();
	const input = { questions: [{ question: "Should we?" }] };
	const first = gate("block", "question", input, ["Replace \"should\"."]);
	assert.match(first.block ?? "", /rewrite the question/);
	assert.match(first.block ?? "", /- Replace "should"\./);
	assert.deepEqual(gate("block", "question", input, ["Replace \"should\"."]), {});
	assert.ok(gate("block", "question", { questions: [{ question: "Should I?" }] }, ["x"]).block, "a changed call is checked again");
	assert.ok(gate("block", "brief", input, ["x"]).block, "the same input under another kind is checked again");
});

test("the plain gate passes clean calls, only notes in warn mode, and does nothing when off", () => {
	const gate = createPlainGate();
	assert.deepEqual(gate("block", "question", {}, []), {});
	const warned = gate("warn", "question", { a: 1 }, ["problem"]);
	assert.equal(warned.block, undefined);
	assert.match(warned.note ?? "", /- problem/);
	assert.deepEqual(gate("off", "question", { a: 1 }, ["problem"]), {});
	assert.ok(gate("block", "question", { a: 1 }, ["problem"]).block, "warn and off did not use up the one block");
});

test("the plain gate forgets the oldest blocked call past its memory limit", () => {
	const gate = createPlainGate(2);
	for (const n of [1, 2, 3]) assert.ok(gate("block", "q", { n }, ["p"]).block);
	assert.ok(gate("block", "q", { n: 1 }, ["p"]).block, "forgotten, so blocked again");
	assert.deepEqual(gate("block", "q", { n: 3 }, ["p"]), {});
});
