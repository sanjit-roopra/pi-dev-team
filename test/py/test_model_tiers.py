"""Tests for the model tier names and their old aliases (hooks/lib/model_tiers.py) and the scripts that read them.
Run: python3 -m unittest discover -s test/py"""
import os
import re
import unittest
from unittest import mock

from _loader import ROOT, load_module

tiers = load_module("model_tiers", ROOT / "hooks" / "lib" / "model_tiers.py")
verify_tier = load_module("verify_tier", ROOT / "scripts" / "verify_tier.py")
select_lenses = load_module("select_lenses", ROOT / "scripts" / "select_lenses.py")
mutation = load_module("mutation_kill_shared", ROOT / "skills" / "mutation-testing" / "scripts" / "mutation_kill_shared.py")


class ModelTiers(unittest.TestCase):
    def test_old_names_map_to_new(self):
        for old, new in (("haiku", "small"), ("sonnet", "standard"), ("Opus", "strong"), (" fable ", "max")):
            self.assertEqual(tiers.normalize_tier(old), new)
        for name in tiers.TIERS:
            self.assertEqual(tiers.normalize_tier(name), name)
        for other in ("inherit", "gpt-6", "", None):
            self.assertIsNone(tiers.normalize_tier(other))

    def test_aliases_match_config_ts(self):
        src = (ROOT / "extensions" / "dev-team" / "lib" / "config.ts").read_text()
        table = re.search(r"TIER_ALIASES[^=]*=\s*\{([^}]*)\}", src).group(1)
        self.assertEqual(dict(re.findall(r'(\w+): "(\w+)"', table)), tiers.ALIASES)
        defaults = re.search(r"DEFAULT_CONFIG[^=]*=\s*\{\s*models:\s*\{([^}]*)\}", src).group(1)
        self.assertEqual(tuple(re.findall(r"(\w+):", defaults)), tiers.TIERS)

    def test_verify_tier_accepts_aliases_and_reports_new_names(self):
        text = "---\nmodel: opus\n---\nVerify-model: haiku\n"
        self.assertEqual(verify_tier.resolve(text)["model"], "small")
        self.assertEqual(verify_tier.resolve("---\nmodel: opus\n---\nbody\n")["model"], "strong")
        self.assertEqual(verify_tier.resolve("---\nmodel: strong\n---\nVerify-model: standard\n")["errors"], [])
        self.assertTrue(verify_tier.resolve("---\nmodel: strong\n---\nVerify-model: tiny\n")["errors"])

    def test_select_lenses_strong_detection(self):
        for value in ("strong", "opus", "claude-opus-5-5", '"strong"', "'opus'", "strong  # note"):
            self.assertTrue(select_lenses.parse_model_is_strong(f"model: {value}\n"), value)
        for value in ("standard", "small", "max", "inherit", '"standard"'):
            self.assertFalse(select_lenses.parse_model_is_strong(f"model: {value}\n"), value)

    def test_mutation_downgrade_ladder(self):
        with mock.patch.dict(os.environ, {"DEV_TEAM_MUTATION_FALLBACK_MODEL": ""}):
            self.assertEqual(mutation.resolve_fallback_model("strong"), "standard")
            self.assertEqual(mutation.resolve_fallback_model("opus"), "standard")
            self.assertEqual(mutation.resolve_fallback_model("sonnet"), "small")
            for floor in ("small", "haiku", "max", None):
                self.assertIsNone(mutation.resolve_fallback_model(floor))
        with mock.patch.dict(os.environ, {"DEV_TEAM_MUTATION_FALLBACK_MODEL": "fable"}):
            self.assertEqual(mutation.resolve_fallback_model("strong"), "max")


if __name__ == "__main__":
    unittest.main()
