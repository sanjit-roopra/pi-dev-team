"""Tests for the slim code-review override: nothing lost, synced, and the core keeps what upstream pins.

Run: python3 -m unittest discover -s test/py
"""
import hashlib
import importlib.machinery
import importlib.util
import re
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def load(name, path):
    loader = importlib.machinery.SourceFileLoader(name, str(path))
    spec = importlib.util.spec_from_loader(name, loader)
    assert spec is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    loader.exec_module(module)
    return module


sync = load("sync_upstream", ROOT / "sync" / "sync_upstream.py")
split = load("split_skill_references", ROOT / "sync" / "split_skill_references.py")

OVERRIDE = ROOT / "overrides" / "skills" / "code-review"
CORE = (OVERRIDE / "SKILL.md").read_text(encoding="utf-8")
REFERENCES = {p.name: p.read_text(encoding="utf-8") for p in sorted((OVERRIDE / "references").glob("*.md"))}
INVOKED_SCRIPT_RE = re.compile(r'(?:python3|py\.sh") "\$\{?CLAUDE_PLUGIN_ROOT\}?/[\w./-]*?([\w-]+\.py)"')
# Scripts only a branch runs; the core sends the model to the reference that has the command.
BRANCH_SCRIPTS = {
    "review_context_pack.py": "references/04b-context-pack.md",
    "report_pdf.py": "references/07-report.md",
    "verify_tier.py": "references/06-findings-and-fix-loop.md",
}


def section(text, start, end):
    assert start in text, f"not found: {start!r}"
    after = text.split(start, 1)[1]
    assert end in after, f"not found after {start!r}: {end!r}"
    return after.split(end, 1)[0]


class NothingLost(unittest.TestCase):
    def test_references_rebuild_the_pinned_upstream_file(self):
        frontmatter, _ = split.split_body(CORE)
        rebuilt = split.rebuild(frontmatter, REFERENCES)
        digest = hashlib.sha256(rebuilt.encode("utf-8")).hexdigest()
        self.assertEqual(digest, sync.OVERRIDE_BASES["skills/code-review/SKILL.md"])

    def test_references_match_the_splitter(self):
        frontmatter, _ = split.split_body(CORE)
        rebuilt = split.rebuild(frontmatter, REFERENCES)
        self.assertEqual(split.reference_files("code-review", rebuilt), REFERENCES)

    def test_synced_copy_matches_the_override(self):
        synced = ROOT / "skills" / "code-review"
        self.assertEqual((synced / "SKILL.md").read_text(encoding="utf-8"), CORE)
        for name, text in REFERENCES.items():
            self.assertEqual((synced / "references" / name).read_text(encoding="utf-8"), text, name)
        self.assertEqual(sorted(p.name for p in (synced / "references").glob("*.md")), sorted(REFERENCES))


class CoreRouting(unittest.TestCase):
    def test_core_names_every_reference_and_only_existing_ones(self):
        named = set(re.findall(r"(?<![\w./-])references/([\w.-]+\.md)", CORE))  # not other skills' references/
        self.assertEqual(named, set(REFERENCES))

    def test_every_invoked_script_is_in_the_core_or_its_branch_reference_is(self):
        for name, text in REFERENCES.items():
            for script in set(INVOKED_SCRIPT_RE.findall(text)):
                with self.subTest(reference=name, script=script):
                    if script in BRANCH_SCRIPTS:
                        self.assertIn(BRANCH_SCRIPTS[script], CORE)
                    else:
                        self.assertIn(script, CORE)

    def test_hard_rules_are_verbatim(self):
        overview = REFERENCES["00-overview.md"]
        must = re.search(r"\*\*MUST — confirm agent-dispatch capability.*", overview)
        gate = re.search(r"\*\*Dispatch-capability gate \(re-confirm here.*", REFERENCES["04a-dispatch-waves.md"])
        assert must and gate
        self.assertIn(must.group(0), CORE)
        self.assertIn(gate.group(0), CORE)
        self.assertIn(overview.split("## Progress tracking", 1)[1], CORE)


class UpstreamContentGuards(unittest.TestCase):
    """The strings upstream's own tests pin in this SKILL.md (tests/skills/test_code_review_*.py and others)."""

    def test_parse_arguments_documents_expand(self):
        args = section(CORE, "## Parse Arguments", "## Progress tracking")
        for phrase in ("`--expand <finding-id>|all`", "Tier-2", "no-op under `--json`"):
            self.assertIn(phrase, args)
        self.assertIn("--expand", CORE.split("---", 2)[1])

    def test_sliced_mode_rules(self):
        for phrase in ("Auto-engage sliced mode", "sliced-mode.md", "--no-slice", "legacy single-pass", "Exactly at 500 files does not auto-engage"):
            self.assertIn(phrase, CORE)
        self.assertIn("never", CORE.split("Non-full-repo scope", 1)[1][:400].lower())

    def test_tool_probe_names(self):
        for phrase in ("mcp__codegraph__codegraph_explore", ".codegraph/", "get_context", "get_symbol", "search_codebase", "get_risk"):
            self.assertIn(phrase, CORE)

    def test_static_analysis_pre_pass(self):
        step = section(CORE, "### 2b. Static analysis pre-pass", "### 3. Determine enabled agents")
        for phrase in ("repo_invariants.py", "internal_double_detector.py", "test_review_mechanics.py", "**Test-review mechanical pre-phase (#2169).**"):
            self.assertIn(phrase, step)
        self.assertIn("detected by static analysis", " ".join(step.split("Test-review mechanical pre-phase", 1)[1].split()))

    def test_step_4_dispatch_marker_and_ledger(self):
        step = section(CORE, "### 4. Run each enabled agent", "\n### 5. Aggregate results")
        for phrase in ("Files in scope for this review: <path>, <path>, ...", "verdict_scope.py", "--lens-files", "fullySkippedLenses",
                       "Fail closed", 'outcome: "pass"', "dispatched this run", "subject_hash", "pre_pr_review.py"):
            self.assertIn(phrase, step)
        self.assertIn("report loudly", step.lower())

    def test_step_5_ledger_skips(self):
        step = section(CORE, "### 5. Aggregate results", "#### 5a. Apply ACCEPTED-RISKS.md")
        self.assertIn("ledgerSkipped", step)
        self.assertIn("does **not** force `overall`", step)

    def test_step_5c_condensation(self):
        step = CORE.split("#### 5c. Consolidate cross-agent findings", 1)[1]
        self.assertIn("dedup", step.lower())
        self.assertIn("3 lines per finding", step)

    def test_verification_mode_contract(self):
        self.assertIn("verification-mode.md", CORE)

    def test_step_7_branches(self):
        step = section(CORE, "### 7. Generate report", "### 8. Save correction prompts for remaining issues")
        json_branch, prose = step.split("Otherwise (no `--json`):", 1)
        for phrase in ("the JSON object is the ONLY thing printed to stdout", "non-negotiable"):
            self.assertIn(phrase, json_branch)
        self.assertNotIn("render_tiered_findings", json_branch)
        self.assertNotIn("--expand", json_branch)
        for phrase in ("render_tiered_findings.py", "Pass `--expand` through exactly as the caller supplied it", "finding-id not found",
                       "Scope of this wiring: the prose-mode path only.", "already read and write the full finding objects independently",
                       "neither branch calls `render_tiered_findings.py`", "**`--expand` is a no-op under `--json`**",
                       "must never call `render_tiered_findings.py`", "enforced structurally"):
            self.assertIn(phrase, prose)

    def test_step_8_untouched_by_tiered_rendering(self):
        step = section(CORE, "### 8. Save correction prompts for remaining issues", "### 9. Write pre-commit gate file")
        self.assertIn("Skip this entire step if `--json` was set.", step)
        self.assertNotIn("render_tiered_findings", step)
        self.assertNotIn("--expand", step)

    def test_no_retired_normalized_hash(self):
        self.assertNotIn("review_gate_normalized_hash.py", CORE)


if __name__ == "__main__":
    unittest.main()
