"""Tree checks for the shipped package: dropped skills stay out, pi notes and inserted rules stay in place, the knowledge
index is fresh. Run: python3 -m unittest discover -s test/py"""
import os
import re
import subprocess
import sys
import unittest

from _loader import ROOT

# Skills that test, audit or drive another agent harness. They are not shipped.
DROPPED_SKILLS = (
    "agent-audit",
    "agent-eval",
    "claude-setup-review",
    "harness-e2e-check",
    "long-eval",
    "orchestration-benchmark",
    "session-review",
)

# Skills with a pi notes section between two markers. extensions/dev-team/lib/review-profile.ts inserts the review
# profile note after the last marker.
NOTES_MARKER = "<!-- pi-notes -->"
NOTES_SKILLS = (
    "autoship",
    "build",
    "continue",
    "issues-from-assessment",
    "issues-from-plan",
    "mutation-night-watch",
    "mutation-testing",
    "plan",
    "pr",
    "project-init",
    "setup",
    "ship",
    "specs",
)

DESCRIPTION_LIMIT = 1024

# Lean production code: the lean fix rule, word for word as in the code-review core, and the agent edits that carry
# it. Production code only; test scope stays with the Gherkin scenarios.
LEAN_FIX_RULE = (
    "**Lean fix rule (production code only).** A `warning` whose fix restructures code (extracts a function, splits a "
    "module, or introduces a type, interface, parameter object, wrapper or layer) and adds more production lines than it "
    "removes counts as a `suggestion` with confidence `none`: rewrite it so in the findings JSON before any script reads "
    "it, report it, never auto-apply it, and keep it out of the fix loop, overriding any actionability table that says "
    "otherwise (`/code-review` step 5b and `skills/code-review/references/05-aggregate.md`, "
    "`knowledge/three-phase-workflow.md` § Review Loop). `error` findings are unaffected. Exempt: every finding from `security-review`, `concurrency-review` or "
    "`correctness-review`; fixes that correct behavior (a bug, a race, a missing check or cleanup, a security or "
    "accessibility gap); a seam for a collaborator the blocker table in `knowledge/internal-collaborator-doubling.md` "
    "lets a test double (B1–B3); and test files (`knowledge/test-file-indicators.md`), fixtures and test helpers."
)
REUSE_LADDER = """- **Simplicity First (pre-write reuse ladder).** Read the code the change touches and trace the real flow first: be lazy about the solution, never about understanding the problem. Then walk this ladder and stop at the first rung that holds:
  1. Does it need to exist? Nothing asked for it, no scenario demands it and the design does not imply it → do not write it. The design implies synchronization, idempotency, transactions, retries and cleanup on error paths wherever state is shared, work is retried or resources are held.
  2. Does the codebase already have it? Call it.
  3. Does the standard library do it?
  4. Does the platform or framework do it natively?
  5. Does an already-installed dependency do it? Never add a dependency to save a few lines, with one exception: security primitives (cryptography, password hashing, token validation, sanitizing or escaping, parsers for untrusted input) always come from the standard library or a vetted library, never hand-rolled.
  6. Otherwise write the minimum that works: no speculative options, no single-use abstraction (an interface with one implementation, a wrapper or factory used once, a layer that only forwards) except a seam the blocker table in `knowledge/internal-collaborator-doubling.md` allows (B1–B3) or a helper that holds synchronization, a lock, atomics, idempotency, a transaction, a retry or cleanup, no configurability nobody asked for.

  Fewer lines, never denser lines: clarity beats brevity. No nested ternaries, no clever one-liners, no packing several steps into one expression to save a line. Never cut input validation, error handling at a real boundary, security, accessibility, synchronization, idempotency, transactions, retries or cleanup on error paths to save lines: they are requirements the design implies, even when no scenario names them.

  The ladder governs production code only. Test scope comes from the plan's Gherkin scenarios, never from this rule: write every test they call for.

  A deliberate shortcut gets a `shortcut:` comment at the spot, naming what it skips and when that would need revisiting, so `grep -rn "shortcut:"` lists the debt."""

# Speed-ups that skip no quality step: the build phase record is written by one helper command that shares a message
# with real work, the final verification and the Farley Score go out in one message, and review lenses and plan
# critics think at medium effort.
BUILD_PHASE_CMD = 'python3 "${DEV_TEAM_ROOT}/scripts/build_phase.py"'
BUILD_PHASE_RULE = (
    "**Write the record with one command, never in a turn of its own (pi).** `" + BUILD_PHASE_CMD + " "
    "<implement|test|refactor|between-steps> <N.M> [--plan <plan path>] [--stage <test file>...]` writes the record "
    "above (a fresh `written_at`; `plan_path` carried over from the current record when `--plan` is left out; "
    "`test_files_staged` only for `refactor`), and `build_phase.py clear` deletes it. Do not write the record with a "
    "heredoc or the Write tool, and never spend a model turn on it alone:\n\n"
    "- **IMPLEMENT, TEST, `between-steps`.** No guard reads these, so send the call in the same message as the "
    "phase's next edit or test run (a parallel tool call, or chained into that bash command).\n"
    "- **Entering REFACTOR.** Chain it onto the green test run: `set -o pipefail; <test command> && " + BUILD_PHASE_CMD
    + " refactor <N.M> --stage <the step's test files>`. `--stage` runs `git add` on those files (new and untracked "
    "ones too) and records them in `test_files_staged`, so the record always matches the index baseline.\n"
    "- **Leaving REFACTOR.** Chain the next marker onto the post-refactor green test run: `set -o pipefail; <test "
    "command> && " + BUILD_PHASE_CMD + " implement <N.M>` (or `between-steps <next N.M>`). Never chain it onto a "
    "command that runs no tests (a commit alone), and never send it as a parallel call beside edits: until it has run "
    "the record still says `refactor`, so `refactor_test_freeze_guard.py` blocks a test edit and "
    "`refactor_test_revert_guard.py` restores test files after every bash call.\n"
    "- **`set -o pipefail` is required in both chains.** `&&` sees only the exit status of a pipeline's last "
    "command, so without it a red run piped into `tail` or `head` counts as green and the marker is written anyway. "
    "With it, the marker runs only when the tests passed.\n"
)
FINAL_VERIFY_RULE = (
    "**One message for the final verification and the Farley Score (pi).** First resolve only Step 7 sub-steps "
    "1–2 (the branch base and the branch's changed test files: cheap git reads). Do not act on sub-step 3 here: its "
    "skip line and its \"continue to Step 8\" belong to Step 7, after Step 6 has run. Then send one assistant message "
    "with both calls, so they run at the same time:\n\n"
    "1. One bash call: `" + BUILD_PHASE_CMD + " clear`, then the full test suite and the lint, type-check and "
    "complexity tools the build ran (for example `ruff`, `python -m compileall`, `lizard`), each followed by its own "
    "exit code and joined with `;` so one failure does not hide the next result, for example `<suite>; echo "
    "\"SUITE_EXIT=$?\"; ruff check <files>; echo \"RUFF_EXIT=$?\"; ...`. The call's own exit status is only the last "
    "tool's, so read the tags: the suite is red when `SUITE_EXIT` is not 0, and a tool failed when its tag is not 0.\n"
    "2. When Step 7 found changed test files, the Step 7 Farley Score as a `dev_team_subagent` dispatch of "
    "`qa-engineer`: load the `farley-score` skill, score exactly those files, change no file, and return the "
    "suite-level Farley Score, rating and distribution.\n\n"
    "Step 7 sub-step 4 then presents that result instead of scoring again. Dispatch the Farley Score once more, after "
    "the fix, when the suite is red, or when Step 6 or any later fix changes or adds a test file on the branch; "
    "otherwise the first result stands.\n"
)
# The text step 7 sub-step 4 had before the shared message; it must not come back.
FARLEY_STEP7_ANCHOR = "4. Otherwise invoke the `farley-score` skill scoped to those files. "
FARLEY_STEP7_RULE = (
    "4. Otherwise present the Farley Score from Step 5's `qa-engineer` dispatch, or from its re-run when Step 5 says "
    "to dispatch it again (pi); invoke the `farley-score` skill scoped to those files here only when Step 5 did "
    "not dispatch it. "
)
ENGINEER_BUILD_PHASE_RULE = (
    "- **Build phase record.** When your task runs `/build`'s per-behavior cycle and you keep "
    "`.pi/dev-team/memory/build-phase.json` (your task says so, or you enter REFACTOR with no `refactor` record present), "
    "write it only with `" + BUILD_PHASE_CMD + "` (`skills/build/SKILL.md`, Phase-state bookkeeping), never with a "
    "heredoc and never in a turn of its own: IMPLEMENT and TEST markers go in the same message as that phase's next "
    "edit or test run; enter REFACTOR with `set -o pipefail; <test command> && " + BUILD_PHASE_CMD + " refactor <N.M> "
    "--stage <test files>`; leave it by chaining the next marker onto the post-refactor green test run the same way "
    "(`set -o pipefail; <test command> && ...`), never onto a command that runs no tests and never as a parallel call "
    "beside edits. Without `set -o pipefail`, a red run piped into `tail` or `head` still lets the marker run.\n"
)
# Review lenses and plan critics that think at medium effort. Kept at high: correctness-review,
# plan-review-acceptance, software-engineer and qa-engineer (which runs /build's Farley Score).
MEDIUM_EFFORT_AGENTS = (
    "ai-provenance-review",
    "arch-review",
    "component-architecture-review",
    "concurrency-review",
    "domain-review",
    "naming-review",
    "performance-review",
    "security-review",
    "structure-review",
    "test-review",
    "test-smell-review",
    "token-efficiency-review",
    "plan-review-design",
    "plan-review-parallelization",
    "plan-review-strategic",
    "plan-review-ux",
)


def split_frontmatter(text):
    """(frontmatter lines, body) of a markdown file, or None when it has no frontmatter."""
    if not text.startswith("---"):
        return None
    lines = text.split("\n")
    for i in range(1, len(lines)):
        if lines[i].strip() == "---":
            return lines[1:i], "\n".join(lines[i + 1 :])
    return None


def fm_blocks(fm_lines):
    """Group frontmatter into top-level key blocks (key line + indented continuation)."""
    blocks = []
    for line in fm_lines:
        m = re.match(r"^([A-Za-z0-9_-]+):", line)
        if m and not line.startswith((" ", "\t")):
            blocks.append((m.group(1), [line]))
        elif blocks:
            blocks[-1][1].append(line)
        else:
            blocks.append((None, [line]))
    return blocks


def block_value(lines):
    first = lines[0].split(":", 1)[1].strip()
    rest = [l.strip() for l in lines[1:]]
    if first in (">", "|", ">-", "|-", ""):
        return " ".join(r for r in rest if r)
    val = " ".join([first] + [r for r in rest if r])
    if len(val) >= 2 and val[0] == val[-1] and val[0] in "\"'":
        val = val[1:-1]
    return val


def read(rel):
    return (ROOT / rel).read_text(encoding="utf-8")


class ShippedTree(unittest.TestCase):
    def test_dropped_skills_are_absent_and_unlisted(self):
        registry = read("knowledge/skills-registry.md")
        for s in DROPPED_SKILLS:
            with self.subTest(skill=s):
                self.assertFalse((ROOT / "skills" / s).exists())
                self.assertNotIn(f"skills/{s}/SKILL.md", registry)

    def test_pi_notes_sit_between_two_markers_in_each_skill_that_has_them(self):
        marked = {p.parent.name for p in (ROOT / "skills").glob("*/SKILL.md") if NOTES_MARKER in p.read_text(encoding="utf-8")}
        self.assertEqual(marked, set(NOTES_SKILLS))
        for s in NOTES_SKILLS:
            with self.subTest(skill=s):
                text = read(f"skills/{s}/SKILL.md")
                self.assertEqual(text.count(NOTES_MARKER), 2)
                block = text.split(NOTES_MARKER)[1].strip()
                self.assertTrue(block.startswith("## pi notes"), block[:80])
                self.assertGreater(len(block.split("\n", 1)[-1].strip()), 0, "the notes section is empty")

    def test_every_skill_description_fits_the_limit(self):
        for path in sorted((ROOT / "skills").glob("*/SKILL.md")):
            with self.subTest(skill=path.parent.name):
                parts = split_frontmatter(path.read_text(encoding="utf-8"))
                self.assertIsNotNone(parts, "no frontmatter")
                desc = dict(fm_blocks(parts[0])).get("description")
                self.assertIsNotNone(desc, "no description")
                self.assertLessEqual(len(block_value(desc)), DESCRIPTION_LIMIT)

    def test_inserted_workflow_text(self):
        self.assertIn("DEV_TEAM_INTERACTIVE", read("skills/plan/SKILL.md"))
        self.assertNotIn("build_worktree_baseref.py", read("skills/build/SKILL.md"))
        compliance = read("agents/spec-compliance-review.md")
        self.assertEqual(compliance.count("When the task names a source request file"), 1)
        self.assertEqual(compliance.count("A plan choice on a point the source request leaves unclear"), 1)
        self.assertLess(compliance.index("When the task names a source request file"), compliance.index("A plan choice on a point the source request leaves unclear"))
        self.assertIn("- For each criterion, locate the implementation that satisfies it\n", compliance)
        for doc in ("agents/orchestrator.md", "knowledge/three-phase-workflow.md", "knowledge/request-processing-flow.md"):
            with self.subTest(doc=doc):
                self.assertNotIn("worktree.baseRef", read(doc))

    def test_helper_scripts_have_a_single_copy(self):
        names = {"build_phase.py", "example_replay.py"}
        found = []
        for dirpath, dirnames, filenames in os.walk(ROOT):
            dirnames[:] = [d for d in dirnames if d not in (".git", "node_modules", "__pycache__")]
            found += [os.path.relpath(os.path.join(dirpath, f), ROOT) for f in filenames if f in names]
        self.assertEqual(sorted(found), ["scripts/build_phase.py", "scripts/example_replay.py"])

    def test_knowledge_index_is_fresh(self):
        check = subprocess.run([sys.executable, str(ROOT / "hooks" / "lib" / "build_knowledge_index.py"), "--check"],
                               capture_output=True, text=True, cwd=ROOT)
        self.assertEqual(check.returncode, 0, "run npm run index\n" + check.stderr[:2000])

    def test_ceremony_skills_are_not_loaded_on_every_task(self):
        for rel in ("skills/context-loading-protocol/SKILL.md", "skills/performance-metrics/SKILL.md",
                    "agents/orchestrator.md", "skills/build/SKILL.md", "knowledge/telemetry-schema.md"):
            with self.subTest(rel=rel):
                text = read(rel)
                for phrase in ("start of every task", "end of every task", "at task completion to log", "at the start of this task",
                               "`/performance-metrics` skill"):
                    self.assertNotIn(phrase, text)


class LeanCode(unittest.TestCase):
    """Lean production code: the lean fix rule is one rule, the ladder leaves test scope alone, the simplify lens is on demand."""

    def test_the_lean_fix_rule_is_one_rule_everywhere_it_applies(self):
        for rel in ("agents/quality-reviewer.md", "agents/structure-review.md", "skills/code-review/SKILL.md"):
            with self.subTest(rel=rel):
                lines = [line for line in read(rel).splitlines() if line.startswith("**Lean fix rule")]
                self.assertEqual(lines, [LEAN_FIX_RULE], f"{rel} must state LEAN_FIX_RULE exactly once")

    def test_the_engineer_ladder_leaves_test_scope_alone(self):
        self.assertIn(REUSE_LADDER, read("agents/software-engineer.md"))

    def test_the_simplify_lens_stays_on_demand_and_skips_test_only_changes(self):
        lens = read("agents/refactor-opportunity-review.md")
        self.assertIn("\nScope: on-demand\n", lens, "keeps it off /code-review's per-diff panel")
        skip = lens.split("## Skip", 1)[1].split("## Detect", 1)[0]
        self.assertIn("Only test files changed", skip)


class SpeedUps(unittest.TestCase):
    """Speed-ups that skip no quality step: the phase-record helper, one message for final verification and Farley, medium-effort lenses."""

    @staticmethod
    def effort(name):
        fm = split_frontmatter(read(f"agents/{name}.md"))
        return dict(fm_blocks(fm[0])).get("effort", [""])[0].split(":", 1)[1].strip()

    def test_lenses_and_plan_critics_think_at_medium_and_the_kept_agents_do_not_drop(self):
        for name in MEDIUM_EFFORT_AGENTS + ("refactor-opportunity-review",):
            with self.subTest(name=name):
                self.assertEqual(self.effort(name), "medium")
        for name in ("correctness-review", "plan-review-acceptance", "software-engineer", "qa-engineer"):
            with self.subTest(name=name):
                self.assertEqual(self.effort(name), "high")
        self.assertEqual(self.effort("spec-compliance-review"), "medium", "neither raised nor lowered")

    def test_build_writes_the_phase_record_with_the_helper_in_a_shared_message(self):
        build = read("skills/build/SKILL.md")
        engineer = read("agents/software-engineer.md")
        self.assertTrue((ROOT / "scripts" / "build_phase.py").is_file())
        self.assertEqual(build.count(BUILD_PHASE_RULE), 1)
        self.assertLess(build.index("at **each** phase transition"), build.index(BUILD_PHASE_RULE))
        self.assertIn("refactor <N.M> --stage", BUILD_PHASE_RULE)
        self.assertIn("never send it as a parallel call beside edits", BUILD_PHASE_RULE)
        self.assertNotIn("refactor commit", BUILD_PHASE_RULE + ENGINEER_BUILD_PHASE_RULE)
        for rule in (BUILD_PHASE_RULE, ENGINEER_BUILD_PHASE_RULE):
            with self.subTest(rule=rule[:40]):
                self.assertEqual(rule.count("set -o pipefail; <test command> &&"), 2)
        self.assertEqual(engineer.count(ENGINEER_BUILD_PHASE_RULE), 1)
        # Phrases the build-state hooks rely on.
        for phrase in ("do **not** delete the file", "Clear the file only when the plan's last step completes",
                       "delete it instead when this was the plan's last step"):
            self.assertIn(phrase, build)

    def test_final_verification_and_farley_share_one_message(self):
        build = read("skills/build/SKILL.md")
        self.assertEqual(build.count(FINAL_VERIFY_RULE), 1)
        step5, step6 = build.index("### 5. Run full test suite"), build.index("### 6. Run code review")
        self.assertTrue(step5 < build.index(FINAL_VERIFY_RULE) < step6)
        self.assertIn("`qa-engineer`", FINAL_VERIFY_RULE)
        self.assertIn("when the suite is red", FINAL_VERIFY_RULE)
        self.assertIn("resolve only Step 7 sub-steps 1–2", FINAL_VERIFY_RULE)
        self.assertIn('echo "SUITE_EXIT=$?"', FINAL_VERIFY_RULE)
        step7 = build[build.index("### 7. Final test quality score"):build.index("### 7.5.")]
        self.assertIn(FARLEY_STEP7_RULE, step7)
        self.assertNotIn(FARLEY_STEP7_ANCHOR, build)


if __name__ == "__main__":
    unittest.main()
