"""Tests for the bin/dev-team-run helper, which runs a `-p` prompt through pi. Run: python3 -m unittest discover -s test/py"""
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


HELPER = ROOT / "bin" / "dev-team-run"
helper = load_module("dev_team_run", HELPER)


class RunHelper(unittest.TestCase):
    def test_model_args(self):
        self.assertEqual(helper.model_args("strong"), ["--dev-team-tier", "strong"])
        self.assertEqual(helper.model_args("Max"), ["--dev-team-tier", "max"])
        self.assertEqual(helper.model_args("opus"), ["--dev-team-tier", "strong"], "old names are aliases")
        self.assertEqual(helper.model_args("fable"), ["--dev-team-tier", "max"])
        self.assertEqual(helper.model_args("claude-sonnet-4-5"), ["--dev-team-tier", "standard"])
        self.assertEqual(helper.model_args("github-copilot/gpt-5.5"), ["--model", "github-copilot/gpt-5.5"])
        self.assertEqual(helper.model_args("inherit"), [])
        self.assertEqual(helper.model_args(None), [])

    def test_trusted_here_covers_only_the_trusted_dir(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d) / "repo"
            (root / "sub").mkdir(parents=True)
            other = Path(d) / "other"
            other.mkdir()
            (root / "link").symlink_to(other)
            (Path(d) / "repo-link").symlink_to(root)
            self.assertTrue(helper.trusted_here(str(root), str(root)))
            self.assertTrue(helper.trusted_here(str(root), str(Path(d) / "repo-link")), "a link to the root is the root")
            self.assertFalse(helper.trusted_here(str(root), str(root / "sub")), "pi trusts per directory")
            self.assertFalse(helper.trusted_here(str(root), str(other)))
            self.assertFalse(helper.trusted_here(str(root), str(root / "link")), "symlink out of the root")
            self.assertFalse(helper.trusted_here("", str(root)), "session not trusted")

    def _helper_argv(self, d, cwd, extra_env):
        pi, log = self._fake_pi(d, [{"type": "message_end", "message": {"role": "assistant", "content": [{"type": "text", "text": "ok"}], "stopReason": "stop"}}])
        env = {k: v for k, v in os.environ.items() if k not in ("DEV_TEAM_PI_ARGS", "DEV_TEAM_TRUSTED_DIR")}
        env.update({"DEV_TEAM_PI_BIN": str(pi), **extra_env})
        out = subprocess.run([sys.executable, str(HELPER), "-p", "x"], capture_output=True, text=True, env=env, cwd=cwd)
        self.assertEqual(out.returncode, 0, out.stderr)
        return json.loads(log.read_text())

    def test_helper_forwards_the_session_trust_decision(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d) / "repo"
            (root / "sub").mkdir(parents=True)
            trusted = {"DEV_TEAM_PI_ARGS": "[]", "DEV_TEAM_TRUSTED_DIR": str(root)}
            self.assertIn("--approve", self._helper_argv(d, root, trusted))
            self.assertNotIn("--approve", self._helper_argv(d, root / "sub", trusted), "only the session directory")
            self.assertNotIn("--approve", self._helper_argv(d, root, {"DEV_TEAM_PI_ARGS": "[]"}), "no trusted dir, no grant")
            declined = self._helper_argv(d, root, {"DEV_TEAM_PI_ARGS": json.dumps(["--no-approve"])})
            self.assertIn("--no-approve", declined)
            self.assertNotIn("--approve", declined)

    def test_map_tools(self):
        err = io.StringIO()
        with contextlib.redirect_stderr(err):
            self.assertEqual(helper.map_tools("Read Glob Grep Skill(review-agent *) Agent Task"), ["read", "find", "ls", "grep", "skill", "dev_team_subagent"])
            self.assertEqual(helper.map_tools("Bash(npm run *),Read"), ["bash", "read"])
        self.assertEqual(err.getvalue(), "", "patterns with spaces are not dropped tools")
        for tool in ("Agent", "Task"):
            with self.subTest(tool=tool):
                self.assertEqual(helper.map_tools(tool), ["dev_team_subagent"])

    def test_helper_names_each_flag_and_tool_it_drops(self):
        with tempfile.TemporaryDirectory() as d:
            pi, _ = self._fake_pi(d, [{"type": "message_end", "message": {"role": "assistant", "content": [{"type": "text", "text": "ok"}], "stopReason": "stop"}}])
            out = subprocess.run([sys.executable, str(HELPER), "-p", "--disallowedTools", "Write", "--frobnicate",
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
            out = subprocess.run([sys.executable, str(HELPER), "-p", "--agent", "dev-team:security-review", "--model", "haiku",
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
            for expected in (["-e", "/x/ext.ts"], ["--dev-team-agent", "security-review"], ["--dev-team-tier", "small"], ["--tools", "read,grep"]):
                i = argv.index(expected[0])
                self.assertEqual(argv[i : i + 2], expected)
            self.assertEqual(argv[-1], "review this")

    def test_error_envelope(self):
        events = [{"type": "message_end", "message": {"role": "assistant", "content": [], "stopReason": "error", "errorMessage": "No API key"}}]
        with tempfile.TemporaryDirectory() as d:
            pi, _ = self._fake_pi(d, events, code=1)
            out = subprocess.run([sys.executable, str(HELPER), "-p", "--output-format", "json", "x"],
                                 capture_output=True, text=True, env={**os.environ, "DEV_TEAM_PI_BIN": str(pi)})
            self.assertEqual(out.returncode, 1)
            env_out = json.loads(out.stdout)
            self.assertTrue(env_out["is_error"])
            self.assertEqual(env_out["result"], "No API key")

    def test_unsupported_subcommand(self):
        out = subprocess.run([sys.executable, str(HELPER), "mcp", "add", "x"], capture_output=True, text=True)
        self.assertEqual(out.returncode, 1)
        self.assertIn("no pi equivalent", out.stderr)


if __name__ == "__main__":
    unittest.main()
