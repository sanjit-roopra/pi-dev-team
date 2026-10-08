"""Tests for the pi port's changes to hooks/pre_tool_guard.py (see PORTING.md). Run: python3 -m unittest discover -s test/py"""
import hashlib
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from _loader import ROOT, load_module

HOOK = ROOT / "hooks" / "pre_tool_guard.py"
sys.path.insert(0, str(ROOT / "hooks" / "lib"))


guard = load_module("pre_tool_guard", HOOK)
guard.emit_boundary_event = lambda *a, **k: None
sync = load_module("sync_upstream_for_guard", ROOT / "sync" / "sync_upstream.py")


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

    def test_dot_dot_segments_cannot_dodge_a_pattern(self):
        os.environ[guard.ALLOWED_PATHS_ENV] = "fixtures/*"
        self.assertEqual(self.code("/repo/fixtures/../.env"), 2)
        self.assertEqual(self.code("/Users/me/.pi/agent/x/../dev-team.json"), 2)
        self.assertEqual(self.code("/Users/me/.PI/Agent/dev-team.json"), 2)

    def test_redundant_segments_and_symlinks_reach_the_user_config(self):
        for path in ("/Users/me/.pi/agent/./dev-team.json", "/Users/me/.pi//agent/dev-team.json"):
            with self.subTest(path=path):
                self.assertEqual(self.code(path), 2)
        config = self.tmp / ".pi" / "agent" / "dev-team.json"
        config.parent.mkdir(parents=True)
        config.write_text("{}")
        (self.tmp / "link.json").symlink_to(config)
        self.assertEqual(self.code(str(self.tmp / "link.json")), 2)

    def test_symlinks_to_sensitive_files_stay_blocked(self):
        (self.tmp / ".env").write_text("")
        (self.tmp / "notes.txt").symlink_to(self.tmp / ".env")
        (self.tmp / "report.md").symlink_to(self.tmp / ".env")
        self.assertEqual(self.code(str(self.tmp / "notes.txt")), 2)
        code, lines = guard.evaluate(str(self.tmp / "report.md"), str(self.tmp), paths=self.paths)
        self.assertEqual(code, 2)
        self.assertIn("renaming the link does not help", lines[0])

    def test_user_exception_on_a_symlinked_folder_still_applies(self):
        shared = self.tmp / "shared"
        shared.mkdir()
        (self.tmp / "fixtures").symlink_to(shared)
        os.environ[guard.ALLOWED_PATHS_ENV] = "fixtures/*"
        self.assertEqual(self.code(str(self.tmp / "fixtures" / "fake.key")), 0)

    def test_pi_coding_agent_dir_config_is_protected(self):
        saved = os.environ.get("PI_CODING_AGENT_DIR")
        os.environ["PI_CODING_AGENT_DIR"] = str(self.tmp / "pi-home")
        try:
            self.assertEqual(self.code(str(self.tmp / "pi-home" / "dev-team.json")), 2)
            dotfiles = self.tmp / "dotfiles"
            dotfiles.mkdir()
            (self.tmp / "pi-home").symlink_to(dotfiles)
            self.assertEqual(self.code(str(dotfiles / "dev-team.json")), 2)
            self.assertEqual(self.code(str(dotfiles / "other.json")), 0)
        finally:
            os.environ.pop("PI_CODING_AGENT_DIR")
            if saved is not None:
                os.environ["PI_CODING_AGENT_DIR"] = saved

    def test_secret_folders_stay_blocked_but_lookalike_folders_do_not(self):
        for path in ("/repo/k8s/secrets/db.yaml", "/repo/credentials/service-account.json", "/repo/.secrets/prod", "/repo/secret/x", "/repo/.credentials/y"):
            with self.subTest(path=path):
                self.assertEqual(self.code(path), 2)
        self.assertEqual(self.code("/repo/secrets-manager/src/app.ts"), 0)

    def test_guards_json_without_allowed_paths_falls_back_to_markdown_default(self):
        guards = self.tmp / "guards.json"
        for content in (None, "{not json", "[]", json.dumps({"blocked_paths": ["*secret*"]})):
            with self.subTest(content=content):
                if content is None:
                    guards.unlink(missing_ok=True)
                else:
                    guards.write_text(content)
                paths = guard.GuardPaths(guards, self.tmp / "freeze-state.json")
                self.assertEqual(guard.evaluate("/repo/secret-triage.md", str(self.tmp), paths=paths)[0], 0)

    def test_empty_allowed_paths_in_guards_json_removes_the_default(self):
        guards = self.tmp / "guards.json"
        guards.write_text(json.dumps({"allowed_paths": [5, ""]}))
        paths = guard.GuardPaths(guards, self.tmp / "freeze-state.json")
        self.assertEqual(guard.evaluate("/repo/secret-triage.md", str(self.tmp), paths=paths)[0], 2)

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
    def test_shipped_hook_overrides_match_the_hooks_directory(self):
        # Slim skills (skills/*) are checked by test_slim_skills.py.
        for rel in (rel for rel in sync.OVERRIDE_BASES if rel.startswith("hooks/")):
            with self.subTest(rel=rel):
                self.assertEqual((ROOT / "overrides" / rel).read_bytes(), (ROOT / rel).read_bytes())

    def test_every_hook_override_has_a_base_hash(self):
        shipped = {p.relative_to(ROOT / "overrides").as_posix() for p in (ROOT / "overrides" / "hooks").rglob("*") if p.is_file() and "__pycache__" not in p.parts}
        self.assertEqual(shipped, {rel for rel in sync.OVERRIDE_BASES if rel.startswith("hooks/")})

    def test_stale_override_bases_reports_changed_and_missing_files(self):
        root = Path(tempfile.mkdtemp())
        (root / "same.txt").write_text("a")
        (root / "changed.txt").write_text("b")
        sha_a = hashlib.sha256(b"a").hexdigest()
        stale = sync.stale_override_bases(root, {"same.txt": sha_a, "changed.txt": sha_a, "gone.txt": sha_a})
        self.assertEqual(stale, ["changed.txt", "gone.txt"])


if __name__ == "__main__":
    unittest.main()
