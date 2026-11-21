"""Tests for the slim code-review skill: a short core SKILL.md plus step references, and the core keeps the rules
and commands of its references.

Run: python3 -m unittest discover -s test/py
"""
import re
import unittest

from _loader import ROOT


def load_skill(skill):
    """(core SKILL.md text, {reference file name: text}) of a slim skill."""
    skill_dir = ROOT / "skills" / skill
    core = (skill_dir / "SKILL.md").read_text(encoding="utf-8")
    references = {p.name: p.read_text(encoding="utf-8") for p in sorted((skill_dir / "references").glob("*.md"))}
    return core, references


def frontmatter(text):
    """The frontmatter block of `text`, including its two `---` lines."""
    match = re.match(r"---\n.*?^---\n", text, re.S | re.M)
    if match is None:
        raise AssertionError("no frontmatter")
    return match.group(0)


def text_between(text, start_marker, end_marker):
    if start_marker not in text:
        raise AssertionError(f"not found: {start_marker!r}")
    after = text.split(start_marker, 1)[1]
    if end_marker not in after:
        raise AssertionError(f"not found after {start_marker!r}: {end_marker!r}")
    return after.split(end_marker, 1)[0]


def strip_indent(text):
    return "\n".join(line.strip() for line in text.splitlines()).strip()


def bash_blocks(text):
    return [strip_indent(block) for block in re.findall(r"```bash\n(.*?)```", text, re.S)]


def paragraph_with(text, phrase):
    """The paragraph or list item of `text` that contains `phrase` (case-insensitive)."""
    for part in re.split(r"\n(?:\n|(?=\s*- ))", text):
        if phrase.lower() in part.lower():
            return part
    raise AssertionError(f"not found: {phrase!r}")


CORE, REFERENCES = load_skill("code-review")
STEPS = CORE.split("## Steps", 1)[1]  # the core without its read-trigger table
INVOKED_SCRIPT_RE = re.compile(r'(?:python3|py\.sh")\s+"\$\{?DEV_TEAM_ROOT\}?/[\w./-]*?([\w-]+\.py)"')
# Scripts only a branch runs, and the reference that has their command; the core sends the model there.
REFERENCE_FOR_BRANCH_SCRIPT = {
    "review_context_pack.py": "04b-context-pack.md",
    "closing_pass.py": "06-findings-and-fix-loop.md",
    "finding_signature.py": "06-findings-and-fix-loop.md",
    "verify_tier.py": "06-findings-and-fix-loop.md",
}
# Scripts the core never runs because pi does that step another way.
NOT_RUN_ON_PI = {"dispatch_waves.py"}
# The core is meant to load at about a third of the full text's size; a regrowth past this means text moved back in.
CORE_SIZE_BUDGET_BYTES = 40_000
# The core's intro paragraph opens with these words.
INTRO_START = "**This file is the "
# Reference -> words its "Read it when" row must contain, for the references a step must read.
REQUIRED_READ_TRIGGERS = {
    "01-target-files.md": "documentation-only short-circuit",
    "04b-context-pack.md": "DEV_TEAM_REVIEW_CONTEXT_PACK=on",
    "04d-contract-validation-and-retry.md": "`missing` is non-empty",
    "06-findings-and-fix-loop.md": "before the first fix iteration",
}


class CodeReviewCoreRouting(unittest.TestCase):
    def test_core_names_every_reference_and_only_existing_ones(self):
        named = set(re.findall(r"(?<![\w./-])references/([\w.-]+\.md)", CORE))  # not other skills' references/
        self.assertEqual(named, set(REFERENCES))

    def test_every_reference_has_a_read_trigger_row(self):
        for name in REFERENCES:
            with self.subTest(reference=name):
                self.assertRegex(CORE, rf"\n\| `references/{re.escape(name)}` \| .+ \|\n")

    def test_required_reads_have_their_trigger(self):
        for name, trigger in REQUIRED_READ_TRIGGERS.items():
            with self.subTest(reference=name):
                row = re.search(rf"\n\| `references/{re.escape(name)}` \| (.+) \|\n", CORE)
                self.assertIsNotNone(row, f"no trigger row for {name}")
                self.assertIn("**always**", row.group(1))
                self.assertIn(trigger, row.group(1))
                step = paragraph_with(STEPS, trigger)
                self.assertIn(f"references/{name}", step, f"the step with the {name} trigger no longer points to it")
                self.assertRegex(step, r"(?i)\bread\b", f"the step with the {name} trigger no longer says to read it")

    def test_json_step_9_exception_still_matches_the_references(self):
        # The core's first exception to "follow the reference"; drop it from the core once these reference lines are fixed.
        stale = {"05-aggregate.md": "**skipped entirely under `--json`**", "06-findings-and-fix-loop.md": "where step 9 never runs at all",
                 "07-report.md": "never runs under `--json`"}
        for name, phrase in stale.items():
            with self.subTest(reference=name):
                self.assertIn(phrase, REFERENCES[name])
        intro = text_between(CORE, INTRO_START, "| Reference |")
        for name in stale:
            self.assertIn(f"references/{name}", intro)
        self.assertIn("step 9 does run under `--json`", intro)

    def test_the_lean_fix_rule_is_the_second_exception(self):
        intro = text_between(CORE, INTRO_START, "| Reference |")
        self.assertIn("Second, the lean fix rule in step 5b", intro)
        self.assertIn("| error or warning | high or medium | **Yes** — auto-apply |", REFERENCES["05-aggregate.md"])  # what it narrows

    def test_reads_are_bounded_by_the_table(self):
        self.assertIn("Read a reference only when its row below says so; do not read references otherwise.", CORE)
        rows = re.findall(r"\n\| `references/[\w.-]+` \| (.+) \|", CORE)
        self.assertEqual(len(rows), len(REFERENCES))
        for row in rows:
            for judgement in ("does not describe", "does not cover", "unclear", "need", "leaves open", "if needed", "or when"):
                with self.subTest(row=row, judgement=judgement):
                    self.assertNotIn(judgement, row, "a read trigger must be an event, not the model's judgement")

    def test_step_3_names_the_warning_codes(self):
        step = text_between(CORE, "### 3. Determine enabled agents", "### 4. Run each enabled agent")
        for code in ("unreadable-registry:", "unreadable-files-from:", "unreadable-added-from:", "skipped-non-executable:", "unnarrowed-added-only:", "bare agent name"):
            self.assertIn(code, step)

    def test_no_unconditional_reference_lines(self):
        self.assertNotRegex(CORE, r"(?m)^References?: ", "a bare Reference: line makes the model load that file on every run")

    def test_core_stays_within_its_size_budget(self):
        self.assertLess(len(CORE.encode("utf-8")), CORE_SIZE_BUDGET_BYTES)

    def test_every_invoked_script_is_in_the_core_or_its_branch_reference_is(self):
        invoked = {script for text in REFERENCES.values() for script in INVOKED_SCRIPT_RE.findall(text)}
        self.assertTrue(set(REFERENCE_FOR_BRANCH_SCRIPT) <= invoked, "a branch script is no longer invoked by any reference")
        in_core = set(INVOKED_SCRIPT_RE.findall(CORE))
        for script in invoked:
            with self.subTest(script=script):
                if script in NOT_RUN_ON_PI:
                    self.assertNotIn(script, in_core)
                elif script in REFERENCE_FOR_BRANCH_SCRIPT:
                    self.assertIn(f"references/{REFERENCE_FOR_BRANCH_SCRIPT[script]}", STEPS)
                    self.assertNotIn(script, in_core, "the core runs a branch script itself; drop it from the branch map")
                else:
                    self.assertIn(script, in_core, "the core names the script but no longer runs it")

    def test_core_commands_are_whole_reference_commands(self):
        reference_blocks = {block for text in REFERENCES.values() for block in bash_blocks(text)}
        blocks = bash_blocks(CORE)
        self.assertTrue(blocks)
        for block in blocks:
            with self.subTest(block=block.splitlines()[0]):
                self.assertIn(block, reference_blocks)

    def test_step_4_dispatches_once_and_classifies_the_saved_output(self):
        step = text_between(CORE, "### 4. Run each enabled agent", "\n### 5. Aggregate results")
        self.assertIn("one `dev_team_subagent` call with `tasks`", step)
        self.assertIn("[output: <path>]", step)  # the line subagent.ts appends to each result
        self.assertNotIn("contract-raw-", step, "the parent must not re-type reviewer output")

    def test_step_3_keeps_the_added_from_rule(self):
        step = text_between(CORE, "### 3. Determine enabled agents", "### 4. Run each enabled agent")
        self.assertIn("Always pass `--added-from` on a diff-scoped run, even when `added` is `[]`", step)

    def test_hard_rules_are_verbatim(self):
        overview = REFERENCES["00-overview.md"]
        must_confirm_dispatch_rule = re.search(r"\*\*MUST — confirm agent-dispatch capability.*", overview)
        dispatch_gate_rule = re.search(r"\*\*Dispatch-capability gate \(re-confirm here.*", REFERENCES["04a-dispatch-waves.md"])
        self.assertIsNotNone(must_confirm_dispatch_rule, "MUST dispatch-capability rule missing from 00-overview.md")
        self.assertIsNotNone(dispatch_gate_rule, "dispatch-capability gate missing from 04a-dispatch-waves.md")
        self.assertIn(must_confirm_dispatch_rule.group(0), CORE)
        self.assertIn(dispatch_gate_rule.group(0), CORE)
        self.assertIn(overview.split("## Progress tracking", 1)[1], CORE)


class CodeReviewContentGuards(unittest.TestCase):
    """Phrases the code-review core must keep: arguments, step rules, dispatch, ledger and report contracts."""

    def test_parse_arguments_documents_expand(self):
        args = text_between(CORE, "## Parse Arguments", "## Progress tracking")
        for phrase in ("`--expand <finding-id>|all`", "Tier-2", "no-op under `--json`"):
            self.assertIn(phrase, args)
        self.assertIn("--expand", frontmatter(CORE))

    def test_sliced_mode_rules(self):
        step = text_between(CORE, "### 1. Determine target files", "### 2. Pre-flight gates")
        for phrase in ("Auto-engage sliced mode", "sliced-mode.md", "--no-slice", "legacy single-pass", "Exactly at 500 files does not auto-engage"):
            self.assertIn(phrase, step)
        self.assertIn("**Non-full-repo scope** (`--path`, `--since`, auto-scoped uncommitted changes) never auto-engages", step)

    def test_tool_probe_names(self):
        probe = text_between(CORE, "**1c.**", "### 2. Pre-flight gates")
        for phrase in ("mcp__codegraph__codegraph_explore", ".codegraph/", "get_context", "get_symbol", "search_codebase", "get_risk"):
            self.assertIn(phrase, probe)

    def test_static_analysis_pre_pass(self):
        step = text_between(CORE, "### 2b. Static analysis pre-pass", "### 3. Determine enabled agents")
        for phrase in ("repo_invariants.py", "internal_double_detector.py", "test_review_mechanics.py", "**Test-review mechanical pre-phase (#2169).**"):
            self.assertIn(phrase, step)
        self.assertIn("detected by static analysis", " ".join(step.split("Test-review mechanical pre-phase", 1)[1].split()))

    def test_step_4_dispatch_marker_and_ledger(self):
        step = text_between(CORE, "### 4. Run each enabled agent", "\n### 5. Aggregate results")
        for phrase in ("Files in scope for this review: <path>, <path>, ...", "verdict_scope.py", "--lens-files", "fullySkippedLenses",
                       "Fail closed", 'outcome: "pass"', "dispatched this run", "subject_hash", "pre_pr_review.py"):
            self.assertIn(phrase, step)
        self.assertIn("report loudly", step.lower())

    def test_step_5_ledger_skips(self):
        step = text_between(CORE, "### 5. Aggregate results", "#### 5a. Apply ACCEPTED-RISKS.md")
        self.assertIn("ledgerSkipped", step)
        self.assertIn("does **not** force `overall`", step)

    def test_step_5c_condensation(self):
        step = text_between(CORE, "#### 5c. Consolidate cross-agent findings", "### 6. Present findings")
        self.assertIn("dedup", step.lower())
        self.assertIn("3 lines per finding", step)

    def test_json_runs_step_9(self):
        self.assertIn("continue to step 9", text_between(CORE, "### 7. Generate report", "Otherwise (no `--json`):"))
        self.assertIn("**Not skipped by `--json`.**", text_between(CORE, "### 9. Write pre-commit gate file", "```bash"))

    def test_dispatch_failures_are_not_scored_and_the_report_follows_its_convention(self):
        self.assertIn("They are not agent results", text_between(CORE, "### 5. Aggregate results", "#### 5a."))
        self.assertIn("Following `knowledge/report-output-location.md`", text_between(CORE, "### 7. Generate report", "### 8."))

    def test_deterministic_triage_keeps_its_escape(self):
        step = text_between(CORE, "### 6a. Review-fix loop", "### 7. Generate report")
        for phrase in ("**all three** hold", "the check cannot fully close the question"):
            self.assertIn(phrase, step)

    def test_verification_mode_contract(self):
        self.assertIn("verification-mode.md", text_between(CORE, "### 6a. Review-fix loop", "### 7. Generate report"))

    def test_step_7_json_branch_is_stdout_only(self):
        json_branch = text_between(CORE, "### 7. Generate report", "Otherwise (no `--json`):")
        for phrase in ("the JSON object is the ONLY thing printed to stdout", "non-negotiable"):
            self.assertIn(phrase, json_branch)
        self.assertNotIn("render_tiered_findings", json_branch)
        self.assertNotIn("--expand", json_branch)

    def test_step_7_prose_branch_wires_tiered_rendering(self):
        prose = text_between(CORE, "Otherwise (no `--json`):", "### 8. Save correction prompts for remaining issues")
        for phrase in ("render_tiered_findings.py", "Pass `--expand` through exactly as the caller supplied it", "finding-id not found",
                       "Scope of this wiring: the prose-mode path only.", "already read and write the full finding objects independently",
                       "neither branch calls `render_tiered_findings.py`", "**`--expand` is a no-op under `--json`**",
                       "must never call `render_tiered_findings.py`", "enforced structurally"):
            self.assertIn(phrase, prose)

    def test_step_8_untouched_by_tiered_rendering(self):
        step = text_between(CORE, "### 8. Save correction prompts for remaining issues", "### 9. Write pre-commit gate file")
        self.assertIn("Skip this entire step if `--json` was set.", step)
        self.assertNotIn("render_tiered_findings", step)
        self.assertNotIn("--expand", step)

    def test_no_retired_normalized_hash(self):
        self.assertNotIn("review_gate_normalized_hash.py", CORE)


if __name__ == "__main__":
    unittest.main()
