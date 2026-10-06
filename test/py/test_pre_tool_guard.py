"""Tests for the pi port's changes to hooks/pre_tool_guard.py (see PORTING.md). Run: python3 -m unittest discover -s test/py"""
import hashlib
import importlib.machinery
import importlib.util
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
HOOK = ROOT / "hooks" / "pre_tool_guard.py"
sys.path.insert(0, str(ROOT / "hooks" / "lib"))


def load(name, path):
    loader = importlib.machinery.SourceFileLoader(name, str(path))
    spec = importlib.util.spec_from_loader(name, loader)
    mod = importlib.util.module_from_spec(spec)
    loader.exec_module(mod)
    return mod


guard = load("pre_tool_guard", HOOK)
guard.emit_boundary_event = lambda *a, **k: None
sync = load("sync_upstream_for_guard", ROOT / "sync" / "sync_upstream.py")


class GuardTestCase(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.paths = guard.GuardPaths(ROOT / "hooks" / "guards.json", self.tmp / "freeze-state.json")
        self.saved_env = os.environ.pop(guard.ALLOWED_PATHS_ENV, None)

    def tearDown(self):
        os.environ.pop(guard.ALLOWED_PATHS_ENV, None)
        if self.saved_env is not None:
            os.environ[guard.ALLOWED_PATHS_ENV] = self.saved_env

    def code(self, file_path):
        return guard.evaluate(file_path, str(self.tmp), paths=self.paths)[0]


class SensitivePaths(GuardTestCase):
    def test_still_blocks_secret_files(self):
        for path in (".env", "/repo/.env.production", "certs/server.KEY", "SECRET_STORE.json", "/repo/config/aws_credentials", "client_secret.json"):
            with self.subTest(path=path):
                self.assertEqual(self.code(path), 2)

    def test_directory_names_do_not_trip_file_name_patterns(self):
        for path in ("/Users/me/git/secrets-manager/src/app.ts", "credential-store/lib/index.py"):
            with self.subTest(path=path):
                self.assertEqual(self.code(path), 0)

    def test_markdown_reports_are_allowed_by_default(self):
        self.assertEqual(self.code("/repo/app/test-results/step-1-7/review/raw/secret-triage.md"), 0)

    def test_user_exceptions_come_from_the_env(self):
        path = "/repo/app/fixtures/fake-credentials.json"
        self.assertEqual(self.code(path), 2)
        os.environ[guard.ALLOWED_PATHS_ENV] = " app/fixtures/* ,, *.example "
        self.assertEqual(self.code(path), 0)
        self.assertEqual(self.code("/repo/secret.example"), 0)
        self.assertEqual(self.code("/repo/.env"), 2)

    def test_agents_cannot_edit_the_user_config(self):
        code, lines = guard.evaluate("/Users/me/.pi/agent/dev-team.json", str(self.tmp), paths=self.paths)
        self.assertEqual(code, 2)
        self.assertIn("only a human edits it", lines[1])
        self.assertEqual(self.code("/repo/.pi/dev-team.json"), 0)

    def test_block_message_names_pattern_and_real_config(self):
        _, lines = guard.evaluate("/repo/db-secret.yaml", str(self.tmp), paths=self.paths)
        self.assertIn("'*secret*'", lines[1])
        self.assertIn(str(ROOT / "hooks" / "guards.json"), lines[1])
        self.assertIn("Approval in chat does not lift this block", lines[2])
        self.assertIn("env.DEV_TEAM_GUARD_ALLOWED_PATHS in ~/.pi/agent/dev-team.json", lines[2])

    def test_path_patterns_match_absolute_paths(self):
        code, lines = guard.evaluate("/repo/.claude/settings.json", str(self.tmp), paths=self.paths)
        self.assertEqual(code, 0)
        self.assertTrue(lines[0].startswith("WARNING:"))


class MainEntryPoint(unittest.TestCase):
    def run_hook(self, cwd, file_path, allowed=None):
        payload = json.dumps({"cwd": str(cwd), "tool_input": {"file_path": file_path}})
        env = {k: v for k, v in os.environ.items() if k != guard.ALLOWED_PATHS_ENV}
        if allowed is not None:
            env[guard.ALLOWED_PATHS_ENV] = allowed
        return subprocess.run([sys.executable, str(HOOK)], input=payload, capture_output=True, text=True, check=False, env=env)

    def test_secret_named_report_and_user_exception_end_to_end(self):
        repo = Path(tempfile.mkdtemp())
        (repo / ".git").mkdir()
        self.assertEqual(self.run_hook(repo, str(repo / "review" / "secret-triage.md")).returncode, 0)
        target = str(repo / "fixtures" / "fake-credentials.json")
        blocked = self.run_hook(repo, target)
        self.assertEqual(blocked.returncode, 2)
        self.assertIn("'*credential*'", blocked.stdout)
        self.assertEqual(self.run_hook(repo, target, allowed="fixtures/*").returncode, 0)


class OverrideBases(unittest.TestCase):
    def test_shipped_overrides_match_the_hooks_directory(self):
        for rel in sync.OVERRIDE_BASES:
            with self.subTest(rel=rel):
                self.assertEqual((ROOT / "overrides" / rel).read_bytes(), (ROOT / rel).read_bytes())

    def test_stale_override_bases_reports_changed_and_missing_files(self):
        root = Path(tempfile.mkdtemp())
        (root / "same.txt").write_text("a")
        (root / "changed.txt").write_text("b")
        sha_a = hashlib.sha256(b"a").hexdigest()
        stale = sync.stale_override_bases(root, {"same.txt": sha_a, "changed.txt": sha_a, "gone.txt": sha_a})
        self.assertEqual(stale, ["changed.txt", "gone.txt"])


if __name__ == "__main__":
    unittest.main()
