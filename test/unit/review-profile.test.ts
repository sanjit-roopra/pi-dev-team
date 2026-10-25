import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { DEFAULT_CONFIG, filterProjectConfig, loadConfig, PROJECT_ENV_SETTINGS } from "../../extensions/dev-team/lib/config.ts";
import {
	applyReviewProfileEnv,
	farleyEnabled,
	insertReviewProfileNote,
	LEAN_SKILLS,
	parseReviewProfile,
	reviewProfileAgentNote,
	reviewProfileArgs,
	reviewProfileFromEnv,
	reviewProfileGuideLine,
	reviewProfileNote,
	reviewProfilePreloadedSkills,
	selectFarleyBlock,
} from "../../extensions/dev-team/lib/review-profile.ts";
import { commandText, discoverSkillPool, discoverSkills, expandSkill } from "../../extensions/dev-team/lib/skills.ts";
import { preloadedSkillText } from "../../extensions/dev-team/lib/subagent.ts";

const ROOT = path.resolve(import.meta.dirname, "..", "..");

test("parseReviewProfile: unset, empty and gate are gate; lean is lean; full is full; anything else is gate with a warning", () => {
	for (const v of ["lean", "LEAN", " lean\n"]) assert.deepEqual(parseReviewProfile(v), { profile: "lean" }, String(v));
	for (const v of ["full", "FULL", " Full "]) assert.deepEqual(parseReviewProfile(v), { profile: "full" }, v);
	for (const v of [undefined, "", "  ", "gate", "GATE", " Gate "]) assert.deepEqual(parseReviewProfile(v), { profile: "gate" }, String(v));
	for (const v of ["leaner", "off", "1", "true", "lean,full"]) {
		const r = parseReviewProfile(v);
		assert.equal(r.profile, "gate", v);
		assert.match(r.warning ?? "", /DEV_TEAM_REVIEW=.* is not gate, lean or full; using gate/, v);
	}
	assert.deepEqual(reviewProfileFromEnv({ DEV_TEAM_REVIEW: "full" }), { profile: "full" });
	assert.deepEqual(reviewProfileFromEnv({}), { profile: "gate" });
});

test("DEV_TEAM_REVIEW cannot come from a project config file", (t) => {
	assert.equal(PROJECT_ENV_SETTINGS.has("DEV_TEAM_REVIEW"), false);
	const { data, ignored } = filterProjectConfig({ env: { DEV_TEAM_REVIEW: "full" } });
	assert.deepEqual(data.env, {});
	assert.deepEqual(ignored, ["env.DEV_TEAM_REVIEW"]);

	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dt-review-"));
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	fs.mkdirSync(path.join(dir, ".pi"));
	fs.writeFileSync(path.join(dir, ".pi", "dev-team.json"), JSON.stringify({ env: { DEV_TEAM_REVIEW: "full" } }));
	const userConfigFile = path.join(dir, "user.json");
	fs.writeFileSync(userConfigFile, "{}");
	const { config } = loadConfig(dir, { includeProject: true, userConfigFile });
	assert.equal(config.env.DEV_TEAM_REVIEW, undefined);
});

test("applyReviewProfileEnv: a config file's value never outlives the process env's profile", () => {
	const fromUserConfig: NodeJS.ProcessEnv = { DEV_TEAM_REVIEW: "lean", OTHER: "1" };
	applyReviewProfileEnv(fromUserConfig, "full");
	assert.deepEqual(fromUserConfig, { DEV_TEAM_REVIEW: "full", OTHER: "1" });
	const unset: NodeJS.ProcessEnv = { DEV_TEAM_REVIEW: "full" };
	applyReviewProfileEnv(unset, "lean");
	assert.deepEqual(unset, { DEV_TEAM_REVIEW: "lean" });
	const lean: NodeJS.ProcessEnv = { DEV_TEAM_REVIEW: "bogus" };
	applyReviewProfileEnv(lean, "lean");
	assert.deepEqual(lean, { DEV_TEAM_REVIEW: "lean" });
});

test("full profile: no note, no guide line, and every package skill expands byte for byte as before", () => {
	assert.equal(reviewProfileGuideLine("full"), "");
	const skills = discoverSkills(ROOT, ROOT, { includeProject: false });
	assert.ok(skills.size > 50);
	for (const skill of skills.values()) {
		const note = reviewProfileNote(ROOT, "full", skill.name);
		assert.equal(note, undefined, skill.name);
		assert.equal(expandSkill(skill, "--yes x", note), expandSkill(skill, "--yes x"), skill.name);
		assert.equal(commandText(skill, "--yes x", note), commandText(skill, "--yes x"), skill.name);
	}
	assert.equal(insertReviewProfileNote("# T\nbody", undefined), "# T\nbody");
});

test("lean profile: plan, build, code-review and ship get their section after the port notes or the title", () => {
	assert.match(reviewProfileGuideLine("lean"), /^- Review profile: lean \(the user set DEV_TEAM_REVIEW=lean/);
	const skills = discoverSkills(ROOT, ROOT, { includeProject: false });
	for (const name of LEAN_SKILLS) {
		const skill = skills.get(name);
		assert.ok(skill, name);
		const note = reviewProfileNote(ROOT, "lean", name) ?? "";
		assert.ok(note.startsWith("## Review profile: lean (read first)"), name);
		const full = expandSkill(skill, "");
		const lean = expandSkill(skill, "", note);
		assert.equal(lean.split(note).length, 2, `${name}: note inserted once`);
		const notesEnd = lean.lastIndexOf("<!-- pi-port-notes -->");
		const at = lean.indexOf(note);
		if (notesEnd >= 0) assert.ok(at > notesEnd, `${name}: after the port notes`);
		else assert.ok(at > lean.indexOf("\n# "), `${name}: after the title`);
		const inserted = notesEnd >= 0 ? `\n${note}\n` : `\n\n${note}\n`;
		assert.equal(lean.replace(inserted, ""), full, `${name}: only the note is added`);
	}
	assert.equal(reviewProfileNote(ROOT, "lean", "pr"), undefined);
	assert.equal(reviewProfileNote(ROOT, "lean", "farley-score"), undefined);
});

test("lean sections name each agreed cut and keep the agreed gates", () => {
	const note = (name: string) => reviewProfileNote(ROOT, "lean", name) ?? "";
	const build = note("build");
	assert.match(build, /the step 7 Farley Score/);
	assert.doesNotMatch(build, /Skip step 7/);
	assert.match(build, /fix only `error` findings/);
	assert.match(build, /Do not start a second round/);
	assert.match(build, /--backstop-review=skip/);
	assert.match(build, /once per slice, not once per step/);
	assert.match(build, /run the full test suite once, after the slice's last step/);
	assert.match(build, /static self-heal pass/);
	assert.match(build, /lizard --csv <files> \| python3 \$\{CLAUDE_PLUGIN_ROOT\}\/skills\/static-analysis-integration\/adapters\/lizard-adapter\.py/);
	assert.match(build, /overrides the per-behavior cycle's "Run the full test suite" gate/);
	assert.match(build, /structure-review/);
	assert.match(build, /Core lenses until the last slice/);
	assert.match(build, /every production and test file this build changed/);
	assert.match(build, /Lenses have no shell and cannot run `git diff`/);
	assert.match(build, /Final verification, no Farley Score/);
	assert.match(build, /Do not dispatch `qa-engineer`/);
	assert.doesNotMatch(build, /Farley Score in one message|farley:/);
	const buildFarley = reviewProfileNote(ROOT, "lean", "build", true) ?? "";
	assert.match(buildFarley, /Final verification and Farley Score in one message/);
	assert.match(buildFarley, /`qa-engineer` Farley Score dispatch goes out in the same message/);
	assert.doesNotMatch(buildFarley, /no Farley Score|farley:/);
	assert.match(build, /Work one step at a time/);
	assert.match(build, /Refactor once per step/);
	assert.match(build, /Run lint, type-check and the lizard complexity check once per slice/);
	assert.match(build, /Test budget: one test per Gherkin scenario of the step/);
	assert.match(build, /Keep the test budget through review/);
	const plan = note("plan");
	assert.match(plan, /at most the `standard` reviewer set/);
	assert.match(plan, /once/);
	assert.match(plan, /\*\*Test budget\.\*\*/);
	assert.match(plan, /one test per scenario plus one per such rule/);
	const review = note("code-review");
	assert.match(review, /fix only `error` findings/);
	assert.match(review, /step 2b static-analysis pre-pass/);
});

test("lean /build gets --backstop-review=skip once; other skills and full keep their args", () => {
	assert.equal(reviewProfileArgs("lean", "build", ""), "--backstop-review=skip");
	assert.equal(reviewProfileArgs("lean", "build", " --yes "), "--yes --backstop-review=skip");
	assert.equal(reviewProfileArgs("lean", "build", "--backstop-review=skip --yes"), "--backstop-review=skip --yes");
	assert.equal(reviewProfileArgs("lean", "plan", "--yes"), "--yes");
	assert.equal(reviewProfileArgs("full", "build", "--yes"), "--yes");
	const build = discoverSkills(ROOT, ROOT, { includeProject: false }).get("build");
	assert.ok(build);
	assert.match(expandSkill(build, reviewProfileArgs("lean", "build", "--yes")), /Arguments: --yes --backstop-review=skip/);
});

test("lean adds software-engineer and test-lens overrides; full adds nothing", () => {
	const engineer = reviewProfileAgentNote("lean", "software-engineer");
	assert.match(engineer, /full test suite once/);
	assert.match(engineer, /Work one step at a time/);
	assert.match(engineer, /Test budget: one test per Gherkin scenario/);
	for (const lens of ["test-review", "test-smell-review"]) {
		const note = reviewProfileAgentNote("lean", lens);
		assert.match(note, /Test budget: one test per Gherkin scenario/, lens);
		assert.match(note, /A missing test is an `error` only when/, lens);
		assert.equal(reviewProfileAgentNote("full", lens), "", lens);
	}
	assert.equal(reviewProfileAgentNote("lean", "structure-review"), "");
	assert.equal(reviewProfileAgentNote("full", "software-engineer"), "");
});

test("lean software-engineer runs lizard, chains markers, commits once and gets its skills inlined", () => {
	const engineer = reviewProfileAgentNote("lean", "software-engineer");
	assert.match(engineer, /lizard --csv <files> \| python3 \$\{CLAUDE_PLUGIN_ROOT\}\/skills\/static-analysis-integration\/adapters\/lizard-adapter\.py/);
	assert.match(engineer, /never spend a turn on a `build_phase\.py` marker alone/);
	assert.match(engineer, /Commit once, after the final full-suite run/);
	assert.match(engineer, /inlined below; do not load or read them again/);
	assert.deepEqual(reviewProfilePreloadedSkills("lean", "software-engineer"), ["quality-gate-pipeline", "systematic-debugging"]);
	assert.deepEqual(reviewProfilePreloadedSkills("full", "software-engineer"), []);
	assert.deepEqual(reviewProfilePreloadedSkills("lean", "test-review"), []);
	const pool = discoverSkillPool(DEFAULT_CONFIG, ROOT, ROOT, false);
	const text = preloadedSkillText(pool, reviewProfilePreloadedSkills("lean", "software-engineer"));
	assert.ok(text.startsWith("## Preloaded skills\n\n"));
	assert.match(text, /<skill name="quality-gate-pipeline"/);
	assert.match(text, /<skill name="systematic-debugging"/);
	assert.equal(preloadedSkillText(pool, []), "");
	assert.equal(preloadedSkillText(pool, ["no-such-skill"]), "");
	assert.equal(preloadedSkillText(undefined, ["quality-gate-pipeline"]), "");
	const build = reviewProfileNote(ROOT, "lean", "build") ?? "";
	assert.match(build, /lizard complexity check once per slice/);
	assert.match(build, /Commit once per slice/);
	assert.match(build, /Short dispatch tasks/);
	assert.match(reviewProfileNote(ROOT, "lean", "plan") ?? "", /\*\*Short plan\.\*\*/);
});

test("DEV_TEAM_FARLEY: only on turns the lean Farley Score on; blocks select cleanly", () => {
	for (const v of ["on", "ON", " on\n"]) assert.equal(farleyEnabled({ DEV_TEAM_FARLEY: v }), true, v);
	for (const v of [undefined, "", "off", "1", "true"]) assert.equal(farleyEnabled({ DEV_TEAM_FARLEY: v }), false, String(v));
	const text = "a\n<!-- farley:on -->\nON\n<!-- /farley:on -->\n<!-- farley:off -->\nOFF\n<!-- /farley:off -->\nb\n";
	assert.equal(selectFarleyBlock(text, true), "a\nON\nb\n");
	assert.equal(selectFarleyBlock(text, false), "a\nOFF\nb\n");
	assert.equal(reviewProfileNote(ROOT, "full", "build", true), undefined);
	assert.match(reviewProfileGuideLine("lean"), /skips the Farley Score .* unless DEV_TEAM_FARLEY=on/);
});

test("gate profile: its own sections, the quality bar in the guide, lean's text untouched", () => {
	const guide = reviewProfileGuideLine("gate");
	assert.match(guide, /^- Review profile: gate \(the default; DEV_TEAM_REVIEW=lean/);
	assert.match(guide, /no plan critics/);
	assert.match(guide, /\n- Code quality bar \(gate\): .*cyclomatic complexity of at most 10.*lizard -w -C 10 -L 60 -a 5.*timeout 600/);
	assert.doesNotMatch(reviewProfileGuideLine("lean"), /Code quality bar/);
	assert.match(guide, /Where the spec is silent, follow the established standard .*the spec wins, even against the standard\./);
	const skills = discoverSkills(ROOT, ROOT, { includeProject: false });
	for (const name of LEAN_SKILLS) {
		const note = reviewProfileNote(ROOT, "gate", name) ?? "";
		assert.ok(note.startsWith("## Review profile: gate (read first)"), name);
		assert.doesNotMatch(note, /\blean (review )?(profile|section|slice|fix|line|note)/i, `${name}: no lean wording`);
		assert.notEqual(note, reviewProfileNote(ROOT, "lean", name)?.replace(/lean/g, "gate"), `${name}: differs from lean`);
		assert.ok(skills.get(name), name);
	}
	assert.match(reviewProfileNote(ROOT, "gate", "plan") ?? "", /\*\*No plan critics\.\*\*/);
	const build = reviewProfileNote(ROOT, "gate", "build") ?? "";
	assert.match(build, /dispatch only `spec-compliance-review` and `correctness-review`/);
	assert.match(build, /Do not ask an agent for a report file/);
	assert.match(build, /skip the Feedback & Learning step/);
	assert.equal(reviewProfileArgs("gate", "build", ""), "--backstop-review=skip");
	assert.deepEqual(reviewProfilePreloadedSkills("gate", "software-engineer"), reviewProfilePreloadedSkills("lean", "software-engineer"));
	const engineer = reviewProfileAgentNote("gate", "software-engineer");
	assert.ok(engineer.startsWith("## Review profile: gate (the default; DEV_TEAM_REVIEW=lean or full turns it off)"));
	assert.match(engineer, /Do not write a report file/);
	assert.match(engineer, /timeout 600/);
	assert.doesNotMatch(reviewProfileAgentNote("lean", "software-engineer"), /report file|timeout 600/);
	assert.match(reviewProfileAgentNote("gate", "test-review"), /^## Review profile: gate/);
});
