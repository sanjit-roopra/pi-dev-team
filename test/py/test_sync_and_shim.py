"""Tests for sync/sync_upstream.py helpers and the bin/claude shim. Run: python3 -m unittest discover -s test/py"""
import contextlib
import io
import json
import os
import stat
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from _loader import ROOT, load_module


sync = load_module("sync_upstream", ROOT / "sync" / "sync_upstream.py")
shim = load_module("claude_shim", ROOT / "bin" / "claude")


class SyncHelpers(unittest.TestCase):
    def test_trim_description(self):
        self.assertEqual(sync.trim_description("short."), "short.")
        long = ("Sentence one is here. " * 80).strip()
        out = sync.trim_description(long)
        self.assertLessEqual(len(out), 1024)
        self.assertTrue(out.endswith("."))

    def test_folded_description_value(self):
        blocks = sync.fm_blocks(["name: x", "description: >-", "  line one", "  line two", "user-invocable: true"])
        self.assertEqual([k for k, _ in blocks], ["name", "description", "user-invocable"])
        self.assertEqual(sync.block_value(blocks[1][1]), "line one line two")

    def test_normalise_skill_trims_long_description(self):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "SKILL.md"
            p.write_text("---\nname: x\ndescription: >-\n  " + ("word " * 400) + "\nuser-invocable: true\n---\n# X\nbody\n")
            self.assertTrue(sync.normalise_skill(p))
            text = p.read_text()
            desc_line = next(l for l in text.splitlines() if l.startswith("description:"))
            self.assertLessEqual(len(json.loads(desc_line.split(":", 1)[1])), 1024)
            self.assertIn("user-invocable: true", text)
            self.assertFalse(sync.normalise_skill(p))

    def test_insert_note_is_idempotent_and_after_h1(self):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "SKILL.md"
            p.write_text("---\nname: x\ndescription: y\n---\n\n# Title\n\nBody\n")
            sync.insert_note(p, "## note\ntext")
            sync.insert_note(p, "## note\ntext")
            text = p.read_text()
            self.assertEqual(text.count(sync.NOTE_MARKER), 2)
            self.assertLess(text.index("# Title"), text.index("## note"))

    def test_shipped_tree_reflects_sync(self):
        info = json.loads((ROOT / "UPSTREAM.json").read_text())
        self.assertTrue(all(p["hits"] > 0 for p in info["patches"]))
        for s in info["droppedSkills"]:
            self.assertFalse((ROOT / "skills" / s).exists(), s)
        self.assertIn("pi port notes", (ROOT / "skills" / "setup" / "SKILL.md").read_text())
        notes = sorted((ROOT / "overrides" / "notes").glob("*.md"))
        self.assertTrue(notes, "overrides/notes/*.md is empty; the note loop would check nothing")
        for note in notes:
            with self.subTest(note=note.name):
                self.assertIn(note.stem, info["notes"])
                self.assertIn(note.read_text().strip(), (ROOT / "skills" / note.stem / "SKILL.md").read_text())
        self.assertIn("DEV_TEAM_INTERACTIVE", (ROOT / "skills" / "plan" / "SKILL.md").read_text())
        self.assertNotIn("build_worktree_baseref.py", (ROOT / "skills" / "build" / "SKILL.md").read_text())
        compliance = (ROOT / "agents" / "spec-compliance-review.md").read_text()
        self.assertEqual(compliance.count("When the task names a source request file"), 1)
        self.assertEqual(compliance.count("A plan choice on a point the source request leaves unclear"), 1)
        self.assertLess(compliance.index("When the task names a source request file"), compliance.index("A plan choice on a point the source request leaves unclear"))
        self.assertIn("- For each criterion, locate the implementation that satisfies it\n", compliance)
        for doc in ("agents/orchestrator.md", "knowledge/three-phase-workflow.md", "knowledge/request-processing-flow.md"):
            self.assertNotIn("worktree.baseRef", (ROOT / doc).read_text(), doc)
        registry = (ROOT / "knowledge" / "skills-registry.md").read_text()
        for s in info["droppedSkills"]:
            self.assertNotIn(f"skills/{s}/SKILL.md", registry, s)
        check = subprocess.run([sys.executable, str(ROOT / "hooks" / "lib" / "build_knowledge_index.py"), "--check"], capture_output=True, text=True)
        self.assertEqual(check.returncode, 0, check.stderr[:2000])

    def test_upstream_json_lists_patches_in_the_order_sync_applies_them(self):
        info = json.loads((ROOT / "UPSTREAM.json").read_text())
        recorded = [(p["file"], p["reason"]) for p in info["patches"]]
        expected = [(pattern, why) for pattern, _regex, _repl, why in sync.PATCHES + sync.LEAN_PATCHES]
        self.assertEqual(recorded, expected)

    def test_ceremony_skills_are_not_loaded_on_every_task(self):
        for rel in ("skills/context-loading-protocol/SKILL.md", "skills/performance-metrics/SKILL.md",
                    "agents/orchestrator.md", "skills/build/SKILL.md", "knowledge/telemetry-schema.md"):
            with self.subTest(rel=rel):
                text = (ROOT / rel).read_text()
                for phrase in ("start of every task", "end of every task", "at task completion to log", "at the start of this task",
                               "`/performance-metrics` skill"):
                    self.assertNotIn(phrase, text)


class LeanCode(unittest.TestCase):
    """Lean production code: the simplify-lens override is pinned and shipped, the lean fix rule is one rule, test scope is untouched."""

    PORT_ONLY_FILES = {"agents/Explore.md", "agents/general-purpose.md", "skills/specs/references/grilling.md"}  # port-added (plus code-review references): no upstream file to pin

    def test_every_upstream_override_is_pinned_and_shipped(self):
        overrides = ROOT / "overrides"
        override_rels = {
            str(p.relative_to(overrides)) for p in overrides.rglob("*")
            if p.is_file() and "__pycache__" not in p.parts and p.relative_to(overrides).parts[0] != "notes"
        }
        port_only = self.PORT_ONLY_FILES | {r for r in override_rels if r.startswith("skills/code-review/references/")}
        self.assertEqual(override_rels - port_only, set(sync.OVERRIDE_BASES),
                         "pin each upstream override in OVERRIDE_BASES, or list a port-added file in PORT_ONLY_FILES")
        for rel in override_rels:
            with self.subTest(rel=rel):
                self.assertEqual((overrides / rel).read_bytes(), (ROOT / rel).read_bytes(), "run npm run sync")

    def test_the_lean_fix_rule_is_one_rule_everywhere_it_applies(self):
        for rel in ("agents/quality-reviewer.md", "agents/structure-review.md", "skills/code-review/SKILL.md"):
            with self.subTest(rel=rel):
                lines = [line for line in (ROOT / rel).read_text().splitlines() if line.startswith("**Lean fix rule")]
                self.assertEqual(lines, [sync.LEAN_FIX_RULE], f"{rel} must state sync.LEAN_FIX_RULE exactly once")

    def test_the_engineer_ladder_leaves_test_scope_alone(self):
        engineer = (ROOT / "agents" / "software-engineer.md").read_text()
        self.assertIn(sync.REUSE_LADDER, engineer)

    def test_the_simplify_lens_stays_on_demand_and_skips_test_only_changes(self):
        lens = (ROOT / "agents" / "refactor-opportunity-review.md").read_text()
        self.assertIn("\nScope: on-demand\n", lens, "keeps it off /code-review's per-diff panel")
        skip = lens.split("## Skip", 1)[1].split("## Detect", 1)[0]
        self.assertIn("Only test files changed", skip)


class Shim(unittest.TestCase):
    def test_model_args(self):
        self.assertEqual(shim.model_args("opus"), ["--dev-team-tier", "opus"])
        self.assertEqual(shim.model_args("claude-sonnet-4-5"), ["--dev-team-tier", "sonnet"])
        self.assertEqual(shim.model_args("github-copilot/gpt-5.5"), ["--model", "github-copilot/gpt-5.5"])
        self.assertEqual(shim.model_args("inherit"), [])
        self.assertEqual(shim.model_args(None), [])

    def test_trusted_here_covers_only_the_trusted_dir(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d) / "repo"
            (root / "sub").mkdir(parents=True)
            other = Path(d) / "other"
            other.mkdir()
            (root / "link").symlink_to(other)
            (Path(d) / "repo-link").symlink_to(root)
            self.assertTrue(shim.trusted_here(str(root), str(root)))
            self.assertTrue(shim.trusted_here(str(root), str(Path(d) / "repo-link")), "a link to the root is the root")
            self.assertFalse(shim.trusted_here(str(root), str(root / "sub")), "pi trusts per directory")
            self.assertFalse(shim.trusted_here(str(root), str(other)))
            self.assertFalse(shim.trusted_here(str(root), str(root / "link")), "symlink out of the root")
            self.assertFalse(shim.trusted_here("", str(root)), "session not trusted")

    def _shim_argv(self, d, cwd, extra_env):
        pi, log = self._fake_pi(d, [{"type": "message_end", "message": {"role": "assistant", "content": [{"type": "text", "text": "ok"}], "stopReason": "stop"}}])
        env = {k: v for k, v in os.environ.items() if k not in ("DEV_TEAM_PI_ARGS", "DEV_TEAM_TRUSTED_DIR")}
        env.update({"DEV_TEAM_PI_BIN": str(pi), **extra_env})
        out = subprocess.run([sys.executable, str(ROOT / "bin" / "claude"), "-p", "x"], capture_output=True, text=True, env=env, cwd=cwd)
        self.assertEqual(out.returncode, 0, out.stderr)
        return json.loads(log.read_text())

    def test_shim_forwards_the_session_trust_decision(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d) / "repo"
            (root / "sub").mkdir(parents=True)
            trusted = {"DEV_TEAM_PI_ARGS": "[]", "DEV_TEAM_TRUSTED_DIR": str(root)}
            self.assertIn("--approve", self._shim_argv(d, root, trusted))
            self.assertNotIn("--approve", self._shim_argv(d, root / "sub", trusted), "only the session directory")
            self.assertNotIn("--approve", self._shim_argv(d, root, {"DEV_TEAM_PI_ARGS": "[]"}), "no trusted dir, no grant")
            declined = self._shim_argv(d, root, {"DEV_TEAM_PI_ARGS": json.dumps(["--no-approve"])})
            self.assertIn("--no-approve", declined)
            self.assertNotIn("--approve", declined)

    def test_map_tools(self):
        err = io.StringIO()
        with contextlib.redirect_stderr(err):
            self.assertEqual(shim.map_tools("Read Glob Grep Skill(review-agent *) Agent Task"), ["read", "find", "ls", "grep", "skill", "dev_team_subagent"])
            self.assertEqual(shim.map_tools("Bash(npm run *),Read"), ["bash", "read"])
        self.assertEqual(err.getvalue(), "", "patterns with spaces are not dropped tools")
        for tool in ("Agent", "Task"):
            with self.subTest(tool=tool):
                self.assertEqual(shim.map_tools(tool), ["dev_team_subagent"])

    def test_shim_names_each_flag_and_tool_it_drops(self):
        with tempfile.TemporaryDirectory() as d:
            pi, _ = self._fake_pi(d, [{"type": "message_end", "message": {"role": "assistant", "content": [{"type": "text", "text": "ok"}], "stopReason": "stop"}}])
            out = subprocess.run([sys.executable, str(ROOT / "bin" / "claude"), "-p", "--disallowedTools", "Write", "--frobnicate",
                                  "--allowedTools", "Read WebSearch", "--verbose", "x"],
                                 capture_output=True, text=True, env={**os.environ, "DEV_TEAM_PI_BIN": str(pi)})
            self.assertEqual(out.returncode, 0, out.stderr)
            lines = out.stderr.splitlines()
            self.assertEqual(len(lines), 3, out.stderr)
            for word in ("--disallowedTools", "--frobnicate", "WebSearch"):
                self.assertEqual(sum(word in l for l in lines), 1, word)

    def _fake_pi(self, d, events, code=0):
        script = Path(d) / "fake-pi"
        log = Path(d) / "argv.json"
        script.write_text(
            "#!/usr/bin/env python3\nimport json,sys\n"
            f"json.dump(sys.argv[1:], open({str(log)!r},'w'))\n"
            f"for e in {events!r}: print(json.dumps(e))\n"
            f"sys.exit({code})\n"
        )
        script.chmod(script.stat().st_mode | stat.S_IEXEC)
        return script, log

    def test_end_to_end_json_envelope(self):
        events = [
            {"type": "message_end", "message": {"role": "assistant", "content": [{"type": "toolCall", "name": "read"}], "usage": {"input": 10, "output": 2, "cost": {"total": 0.5}}, "stopReason": "toolUse"}},
            {"type": "message_end", "message": {"role": "assistant", "content": [{"type": "text", "text": "final answer"}], "usage": {"input": 5, "output": 1, "cost": {"total": 0.25}}, "stopReason": "stop"}},
        ]
        with tempfile.TemporaryDirectory() as d:
            pi, log = self._fake_pi(d, events)
            env = {**os.environ, "DEV_TEAM_PI_BIN": str(pi), "DEV_TEAM_PI_ARGS": json.dumps(["-e", "/x/ext.ts"])}
            out = subprocess.run([sys.executable, str(ROOT / "bin" / "claude"), "-p", "--agent", "dev-team:security-review", "--model", "haiku",
                                  "--output-format", "json", "--dangerously-skip-permissions", "--allowedTools", "Read Grep", "review this"],
                                 capture_output=True, text=True, env=env)
            self.assertEqual(out.returncode, 0, out.stderr)
            env_out = json.loads(out.stdout)
            self.assertEqual(env_out["result"], "final answer")
            self.assertFalse(env_out["is_error"])
            self.assertEqual(env_out["num_turns"], 2)
            self.assertAlmostEqual(env_out["total_cost_usd"], 0.75)
            self.assertEqual(env_out["usage"]["input_tokens"], 15)
            argv = json.loads(log.read_text())
            self.assertEqual(argv[:4], ["--mode", "json", "-p", "--no-session"])
            for expected in (["-e", "/x/ext.ts"], ["--dev-team-agent", "security-review"], ["--dev-team-tier", "haiku"], ["--tools", "read,grep"]):
                i = argv.index(expected[0])
                self.assertEqual(argv[i : i + 2], expected)
            self.assertEqual(argv[-1], "review this")

    def test_error_envelope(self):
        events = [{"type": "message_end", "message": {"role": "assistant", "content": [], "stopReason": "error", "errorMessage": "No API key"}}]
        with tempfile.TemporaryDirectory() as d:
            pi, _ = self._fake_pi(d, events, code=1)
            out = subprocess.run([sys.executable, str(ROOT / "bin" / "claude"), "-p", "--output-format", "json", "x"],
                                 capture_output=True, text=True, env={**os.environ, "DEV_TEAM_PI_BIN": str(pi)})
            self.assertEqual(out.returncode, 1)
            env_out = json.loads(out.stdout)
            self.assertTrue(env_out["is_error"])
            self.assertEqual(env_out["result"], "No API key")

    def test_unsupported_subcommand(self):
        out = subprocess.run([sys.executable, str(ROOT / "bin" / "claude"), "mcp", "add", "x"], capture_output=True, text=True)
        self.assertEqual(out.returncode, 1)
        self.assertIn("no pi equivalent", out.stderr)


if __name__ == "__main__":
    unittest.main()
