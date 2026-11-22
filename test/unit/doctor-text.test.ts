import assert from "node:assert/strict";
import { test } from "node:test";
import type { ModelStatus, PresetAdvice } from "../../extensions/dev-team/lib/config.ts";
import { CUSTOM_MENU_LABEL, joinWithAnd, oldTierNamesLines, presetFromMenuLabel, presetMenuLabel, presetTipLines, tierLine, tierMenuChoices } from "../../extensions/dev-team/lib/doctor-text.ts";

const SESSION = "github-copilot/claude-opus-5.5";
const advice = (overrides: Partial<PresetAdvice>): PresetAdvice => ({
	presetName: "github-copilot",
	tiersOnSessionModel: ["small", "standard"],
	action: "preset",
	changes: [
		{ tier: "small", model: "github-copilot/h" },
		{ tier: "standard", model: "github-copilot/s" },
	],
	unusable: [],
	...overrides,
});

for (const [words, text] of [
	[[], ""],
	[["small"], "small"],
	[["small", "standard"], "small and standard"],
	[["small", "standard", "strong"], "small, standard and strong"],
] as const) {
	test(`joinWithAnd: ${words.length} word(s)`, () => assert.equal(joinWithAnd(words), text));
}

test("presetTipLines: the preset action names the menu entry and every tier it sets", () => {
	assert.deepEqual(presetTipLines(advice({}), SESSION), [
		`tip: small and standard agents run on ${SESSION}, your session model.`,
		"     /dev-team models → preset: github-copilot sets small to github-copilot/h and standard to github-copilot/s.",
	]);
});

test("presetTipLines: custom steps say why and what to set", () => {
	const lines = presetTipLines(advice({ action: "custom", tiersOnSessionModel: ["standard"], changes: [{ tier: "standard", model: "github-copilot/s" }] }), SESSION);
	assert.deepEqual(lines, [
		`tip: standard agents run on ${SESSION}, your session model.`,
		"     You mapped other tiers yourself, so set these with /dev-team models → custom: standard to github-copilot/s. Leave the other tiers as they are.",
	]);
});

for (const [branch, shape] of [
	["preset", {}],
	["custom", { action: "custom" }],
	["unusable", { unusable: [{ model: "m", status: "unknown" }] }],
] as const) {
	test(`presetTipLines (${branch}): a project file that sets these tiers is named as the place to change them`, () => {
		const lines = presetTipLines(advice(shape as Partial<PresetAdvice>), SESSION, "/repo/.pi/dev-team.local.json");
		assert.equal(lines.at(-1), "     /repo/.pi/dev-team.local.json sets some of these tiers for this project and wins: change them in that file by hand (/dev-team models does not write it).");
		assert.equal(presetTipLines(advice(shape as Partial<PresetAdvice>), SESSION).length, 2, "no such line without one");
	});
}

test("presetTipLines: the session model cannot drive the terminal", () => {
	const [head] = presetTipLines(advice({}), "p/\u001b[2Jx\nFAKE");
	assert.equal(head, "tip: small and standard agents run on p/xFAKE, your session model.");
});

test("presetTipLines: unusable models are named instead of the action", () => {
	const lines = presetTipLines(advice({ unusable: [{ model: "github-copilot/h", status: "no-auth" }, { model: "github-copilot/f", status: "unknown" }] }), SESSION);
	assert.equal(lines[1], '     preset "github-copilot" needs models this session cannot use: github-copilot/h NO AUTH (/login), github-copilot/f UNKNOWN MODEL. Pick a model per tier with /dev-team models → custom.');
});

test("a preset's menu label reads back as the preset", () => {
	assert.equal(presetFromMenuLabel(presetMenuLabel("anthropic")), "anthropic");
});

test("the custom menu label is not read as a preset", () => {
	assert.equal(presetFromMenuLabel(CUSTOM_MENU_LABEL), undefined);
});

test("the custom tip names the custom menu entry", () => {
	assert.ok(CUSTOM_MENU_LABEL.startsWith("custom:"));
	assert.match(presetTipLines(advice({ action: "custom" }), SESSION)[1], /\/dev-team models → custom: /, "custom steps");
	assert.match(presetTipLines(advice({ unusable: [{ model: "m", status: "unknown" }] }), SESSION)[1], /\/dev-team models → custom\.$/, "unusable models");
});

const statuses: Record<string, ModelStatus> = { "p/ok": "ok", "p/noauth": "no-auth" };
const status = (m: string) => statuses[m] ?? "unknown";

for (const [title, tier, model, session, line] of [
	["inherit shows the session model", "small", "inherit", "p/session", "  small: inherit (p/session)"],
	["inherit without a session model", "small", "inherit", undefined, "  small: inherit (none)"],
	["an empty tier inherits", "small", "", "p/session", "  small: inherit (p/session)"],
	["a null tier inherits", "small", null, "p/session", "  small: inherit (p/session)"],
	["an unset tier inherits", "small", undefined, "p/session", "  small: inherit (p/session)"],
	["a usable model", "standard", "p/ok", "p/session", "  standard: p/ok ok"],
	["a model without auth", "standard", "p/noauth", "p/session", "  standard: p/noauth NO AUTH (/login)"],
	["an unknown model", "strong", "p/x", "p/session", "  strong: p/x UNKNOWN MODEL"],
	["a value that is not text is unknown, not a crash", "strong", 5, "p/session", "  strong: (not a model id) UNKNOWN MODEL"],
	["an object that cannot become text is unknown, not a crash", "strong", { toString: 1 }, "p/session", "  strong: (not a model id) UNKNOWN MODEL"],
] as const) {
	test(`tierLine: ${title}`, () => assert.equal(tierLine(tier, model, session, status), line));
}

test("tierLine: a project's model id or tier name cannot drive the terminal", () => {
	assert.equal(tierLine("sm\u001b[2Jall", "p/\u001b]52;c;eA==\u0007x\nFAKE", "p/s", status), "  small: p/xFAKE UNKNOWN MODEL");
});

test("tierMenuChoices: the file's own model first, then inherit and the available models, no duplicate", () => {
	assert.deepEqual(tierMenuChoices("p/a", "p/a", ["p/a", "p/b"]), [
		{ label: "p/a (in this file)", value: "p/a" },
		{ label: "inherit", value: "inherit" },
		{ label: "p/b", value: "p/b" },
	]);
});

for (const own of ["inherit", ""]) {
	test(`tierMenuChoices: a file set to ${JSON.stringify(own)} offers inherit first, once, and keeps it as inherit`, () => {
		assert.deepEqual(tierMenuChoices(own, undefined, ["p/b"]), [
			{ label: "inherit (in this file)", value: "inherit" },
			{ label: "p/b", value: "p/b" },
		]);
	});
}

test("tierMenuChoices: a tier the file does not set is left unset by its first entry, which names the model it runs on now", () => {
	assert.deepEqual(tierMenuChoices(undefined, "p/user", ["p/b"])[0], { label: "not set in this file (now p/user)", value: undefined });
	assert.equal(tierMenuChoices(undefined, undefined, [])[0].label, "not set in this file (now inherit)");
	assert.equal(tierMenuChoices(undefined, 5, [])[0].label, "not set in this file (now inherit)", "a value that is not a model id");
});

test("tierMenuChoices: the model a tier runs on now is shown on one line", () => {
	assert.equal(tierMenuChoices(undefined, "p/\u001b]52;c;x\u0007m\nFAKE", [])[0].label, "not set in this file (now p/mFAKE)");
});

test("tierMenuChoices: a file that was not read is left as it is by the first entry", () => {
	assert.deepEqual(tierMenuChoices(undefined, "p/user", [], false)[0], { label: "keep what this file sets (not read: project not trusted)", value: undefined });
});

test("tierMenuChoices: labels are one line and unique, so a picked label maps back to one model", () => {
	const choices = tierMenuChoices("p/x\u0000", undefined, ["p/x", "p/y\u001b[2J", "p/y"]);
	assert.deepEqual(choices, [
		{ label: "p/x (in this file)", value: "p/x\u0000" },
		{ label: "inherit", value: "inherit" },
		{ label: "p/x", value: "p/x" },
		{ label: "p/y", value: "p/y\u001b[2J" },
	], "the file's look-alike is marked, and a later look-alike is dropped");
});

test("oldTierNamesLines: one note per file naming each earlier tier name and its new name; none without one", () => {
	assert.deepEqual(oldTierNamesLines([{ file: "/u/dev-team.json", names: ["opus", "haiku"] }, { file: ".pi/dev-team.local.json", names: ["fable"] }]), [
		"note: /u/dev-team.json uses earlier tier names; they still work. Rename opus to strong and haiku to small.",
		"note: .pi/dev-team.local.json uses earlier tier names; they still work. Rename fable to max.",
	]);
	assert.deepEqual(oldTierNamesLines([]), []);
});
