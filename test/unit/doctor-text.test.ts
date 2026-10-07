import assert from "node:assert/strict";
import { test } from "node:test";
import type { ModelStatus, PresetAdvice } from "../../extensions/dev-team/lib/config.ts";
import { CUSTOM_MENU_LABEL, joinWithAnd, presetFromMenuLabel, presetMenuLabel, presetTipLines, tierLine } from "../../extensions/dev-team/lib/doctor-text.ts";

const SESSION = "github-copilot/claude-opus-5.5";
const advice = (overrides: Partial<PresetAdvice>): PresetAdvice => ({
	preset: "github-copilot",
	tiersOnSessionModel: ["haiku", "sonnet"],
	action: "preset",
	changes: [
		{ tier: "haiku", model: "github-copilot/h" },
		{ tier: "sonnet", model: "github-copilot/s" },
	],
	unusable: [],
	...overrides,
});

for (const [words, text] of [
	[[], ""],
	[["haiku"], "haiku"],
	[["haiku", "sonnet"], "haiku and sonnet"],
	[["haiku", "sonnet", "opus"], "haiku, sonnet and opus"],
] as const) {
	test(`joinWithAnd: ${words.length} word(s)`, () => assert.equal(joinWithAnd(words), text));
}

test("presetTipLines: the preset action names the menu entry and every tier it sets", () => {
	assert.deepEqual(presetTipLines(advice({}), SESSION), [
		`tip: haiku and sonnet agents run on ${SESSION}, your session model.`,
		"     /dev-team models → preset: github-copilot sets haiku to github-copilot/h and sonnet to github-copilot/s.",
	]);
});

test("presetTipLines: custom steps say why and what to set", () => {
	const lines = presetTipLines(advice({ action: "custom", tiersOnSessionModel: ["sonnet"], changes: [{ tier: "sonnet", model: "github-copilot/s" }] }), SESSION);
	assert.deepEqual(lines, [
		`tip: sonnet agents run on ${SESSION}, your session model.`,
		"     You mapped other tiers yourself, so set these with /dev-team models → custom: sonnet to github-copilot/s.",
	]);
});

test("presetTipLines: unusable models are named instead of the action", () => {
	const lines = presetTipLines(advice({ unusable: [{ model: "github-copilot/h", status: "no-auth" }, { model: "github-copilot/f", status: "unknown" }] }), SESSION);
	assert.equal(lines[1], '     preset "github-copilot" needs models this session cannot use: github-copilot/h NO AUTH (/login), github-copilot/f UNKNOWN MODEL. Pick a model per tier with /dev-team models → custom.');
});

test("the menu labels the tip names are the ones /dev-team models reads back", () => {
	assert.equal(presetFromMenuLabel(presetMenuLabel("anthropic")), "anthropic");
	assert.equal(presetFromMenuLabel(CUSTOM_MENU_LABEL), undefined);
	assert.ok(CUSTOM_MENU_LABEL.startsWith("custom"), "the tip says '→ custom'");
});

const statuses: Record<string, ModelStatus> = { "p/ok": "ok", "p/noauth": "no-auth" };
const status = (m: string) => statuses[m] ?? "unknown";

for (const [title, tier, model, session, line] of [
	["inherit shows the session model", "haiku", "inherit", "p/session", "  haiku: inherit (p/session)"],
	["inherit without a session model", "haiku", "inherit", undefined, "  haiku: inherit (none)"],
	["a usable model", "sonnet", "p/ok", "p/session", "  sonnet: p/ok ok"],
	["a model without auth", "sonnet", "p/noauth", "p/session", "  sonnet: p/noauth NO AUTH (/login)"],
	["an unknown model", "opus", "p/x", "p/session", "  opus: p/x UNKNOWN MODEL"],
	["a value that is not text is unknown, not a crash", "opus", 5, "p/session", "  opus: 5 UNKNOWN MODEL"],
] as const) {
	test(`tierLine: ${title}`, () => assert.equal(tierLine(tier, model, session, status), line));
}

test("tierLine: a project's model id or tier name cannot drive the terminal", () => {
	const line = tierLine("hai\u001b[2Jku", "p/\u001b]52;c;eA==\u0007x\nFAKE", "p/s", status);
	assert.doesNotMatch(line, /[\x00-\x1f\x7f-\x9f]/);
	assert.equal(line.split("\n").length, 1);
});
