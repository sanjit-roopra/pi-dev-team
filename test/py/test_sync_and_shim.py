"""Tests for sync/sync_upstream.py helpers and the bin/claude shim. Run: python3 -m unittest discover -s test/py"""
import importlib.util
import importlib.machinery
import json
import os
import stat
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def load(name, path):
    loader = importlib.machinery.SourceFileLoader(name, str(path))
    spec = importlib.util.spec_from_loader(name, loader)
    mod = importlib.util.module_from_spec(spec)
    loader.exec_module(mod)
    return mod


sync = load("sync_upstream", ROOT / "sync" / "sync_upstream.py")
shim = load("claude_shim", ROOT / "bin" / "claude")


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
        self.assertIn("DEV_TEAM_INTERACTIVE", (ROOT / "skills" / "plan" / "SKILL.md").read_text())


class Shim(unittest.TestCase):
    def test_model_args(self):
        self.assertEqual(shim.model_args("opus"), ["--dev-team-tier", "opus"])
        self.assertEqual(shim.model_args("claude-sonnet-4-5"), ["--dev-team-tier", "sonnet"])
        self.assertEqual(shim.model_args("github-copilot/gpt-5.5"), ["--model", "github-copilot/gpt-5.5"])
        self.assertEqual(shim.model_args("inherit"), [])
        self.assertEqual(shim.model_args(None), [])

    def test_map_tools(self):
        self.assertEqual(shim.map_tools("Read Glob Grep Skill(review-agent *) Agent Task"), ["read", "find", "ls", "grep", "skill", "dev_team_subagent"])
        for tool in ("Agent", "Task"):
            with self.subTest(tool=tool):
                self.assertEqual(shim.map_tools(tool), ["dev_team_subagent"])

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
