"""scripts/build_phase.py writes the build phase record the readers and the tests-frozen guards accept."""
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from _loader import ROOT, load_module

sys.path.insert(0, str(ROOT / "hooks" / "lib"))
sys.path.insert(0, str(ROOT / "hooks"))  # the revert guard imports the freeze guard by module name

from build_state import RECORD_KEYS, read_active_build_state  # noqa: E402
from test_file_classify import read_build_phase  # noqa: E402

SCRIPT = ROOT / "scripts" / "build_phase.py"
freeze = load_module("bp_freeze_guard", ROOT / "hooks" / "refactor_test_freeze_guard.py")
bash_guard = load_module("bp_bash_guard", ROOT / "hooks" / "refactor_test_bash_guard.py")
revert = load_module("bp_revert_guard", ROOT / "hooks" / "refactor_test_revert_guard.py")


def git(repo, *args):
    subprocess.run(["git", *args], cwd=repo, check=True, capture_output=True)


class BuildPhase(unittest.TestCase):
    def setUp(self):
        self.repo = Path(tempfile.mkdtemp(prefix="dt-build-phase-")).resolve()
        self.addCleanup(subprocess.run, ["rm", "-rf", str(self.repo)])
        git(self.repo, "init", "-q")
        git(self.repo, "config", "user.email", "t@example.com")
        git(self.repo, "config", "user.name", "t")
        (self.repo / "plans").mkdir()
        (self.repo / "plans" / "p.md").write_text("plan\n")
        (self.repo / "tests").mkdir()
        (self.repo / "tests" / "test_a.py").write_text("def test_a():\n    assert True\n")
        (self.repo / "a.py").write_text("x = 1\n")
        git(self.repo, "add", "plans", "a.py")
        git(self.repo, "commit", "-qm", "base")
        self.state_file = self.repo / ".claude" / "memory" / "build-phase.json"

    def run_helper(self, *args, cwd=None):
        env = {k: v for k, v in os.environ.items() if k != "CLAUDE_PROJECT_DIR"}
        return subprocess.run([sys.executable, str(SCRIPT), *args], cwd=cwd or self.repo, env=env, capture_output=True, text=True)

    def record(self):
        return json.loads(self.state_file.read_text())

    def test_record_matches_the_documented_schema_and_both_readers(self):
        out = self.run_helper("implement", "1.1", "--plan", "plans/p.md")
        self.assertEqual(out.returncode, 0, out.stderr)
        self.assertEqual(tuple(self.record()), RECORD_KEYS)
        state = read_active_build_state(self.repo)
        self.assertEqual((state.phase, state.step, state.plan_path), ("implement", "1.1", "plans/p.md"))
        guard_state, error = read_build_phase(self.repo)
        self.assertIsNone(error)
        self.assertEqual(guard_state["phase"], "implement")

    def test_plan_path_carries_over_and_a_subdirectory_writes_at_the_git_root(self):
        self.run_helper("implement", "1.1", "--plan", "plans/p.md")
        out = self.run_helper("test", "1.1", cwd=self.repo / "tests")
        self.assertEqual(out.returncode, 0, out.stderr)
        self.assertEqual(self.record()["plan_path"], "plans/p.md")
        self.assertEqual(self.record()["phase"], "test")
        self.assertFalse((self.repo / "tests" / ".claude").exists())

    def test_refactor_stages_the_tests_and_the_guards_enforce_the_freeze(self):
        self.run_helper("test", "1.1", "--plan", "plans/p.md")
        out = self.run_helper("refactor", "1.1", "--stage", "tests/test_a.py")
        self.assertEqual(out.returncode, 0, out.stderr)
        self.assertEqual(self.record()["test_files_staged"], ["tests/test_a.py"])
        staged = subprocess.run(["git", "diff", "--cached", "--name-only"], cwd=self.repo, capture_output=True, text=True).stdout
        self.assertIn("tests/test_a.py", staged)
        self.assertEqual(freeze.evaluate(str(self.repo / "tests" / "test_a.py"), self.repo)[0], 2)
        self.assertEqual(freeze.evaluate(str(self.repo / "a.py"), self.repo)[0], 0)
        self.assertEqual(bash_guard.evaluate("echo x > tests/test_a.py", self.repo)[0], 2)
        (self.repo / "tests" / "test_a.py").write_text("changed during refactor\n")
        revert.evaluate(self.repo)
        self.assertIn("assert True", (self.repo / "tests" / "test_a.py").read_text())

    def test_leaving_refactor_releases_the_guards(self):
        self.run_helper("refactor", "1.1", "--plan", "plans/p.md", "--stage", "tests/test_a.py")
        out = self.run_helper("implement", "1.2")
        self.assertEqual(out.returncode, 0, out.stderr)
        self.assertEqual(self.record()["test_files_staged"], [])
        self.assertEqual(freeze.evaluate(str(self.repo / "tests" / "test_a.py"), self.repo)[0], 0)
        (self.repo / "tests" / "test_a.py").write_text("changed in the next TEST phase\n")
        revert.evaluate(self.repo)
        self.assertEqual((self.repo / "tests" / "test_a.py").read_text(), "changed in the next TEST phase\n")

    def test_failed_staging_still_writes_the_refactor_record_so_the_freeze_holds(self):
        self.run_helper("test", "1.1", "--plan", "plans/p.md")
        out = self.run_helper("refactor", "1.1", "--stage", "tests/test_a.py", "tests/missing.py")
        self.assertEqual(out.returncode, 1)
        self.assertIn("git add failed", out.stderr)
        self.assertEqual(self.record()["phase"], "refactor")
        self.assertEqual(self.record()["test_files_staged"], ["tests/test_a.py", "tests/missing.py"])
        self.assertEqual(freeze.evaluate(str(self.repo / "tests" / "test_a.py"), self.repo)[0], 2)
        self.assertEqual(bash_guard.evaluate("echo x > tests/test_a.py", self.repo)[0], 2)

    def test_the_documented_chains_pass_the_bash_guard_and_pipefail_gates_the_marker(self):
        helper = f"{sys.executable} {SCRIPT}"
        self.run_helper("refactor", "1.1", "--plan", "plans/p.md", "--stage", "tests/test_a.py")
        red = f"set -o pipefail; false | tail -1 && {helper} implement 1.2"
        green = f"set -o pipefail; true | tail -1 && {helper} implement 1.2"
        for command in (red, green):
            self.assertEqual(bash_guard.evaluate(command, self.repo)[0], 0, command)
        env = {k: v for k, v in os.environ.items() if k != "CLAUDE_PROJECT_DIR"}
        subprocess.run(["bash", "-c", red], cwd=self.repo, env=env, capture_output=True)
        self.assertEqual(self.record()["phase"], "refactor", "a red piped run must not leave REFACTOR")
        subprocess.run(["bash", "-c", green], cwd=self.repo, env=env, capture_output=True)
        self.assertEqual(self.record()["phase"], "implement")

    def test_between_steps_and_clear(self):
        self.run_helper("refactor", "1.1", "--plan", "plans/p.md", "--stage", "tests/test_a.py")
        self.run_helper("between-steps", "1.2")
        state = read_active_build_state(self.repo)
        self.assertEqual((state.phase, state.step, state.plan_path), ("between-steps", "1.2", "plans/p.md"))
        out = self.run_helper("clear")
        self.assertEqual(out.returncode, 0, out.stderr)
        self.assertFalse(self.state_file.exists())
        self.assertEqual(self.run_helper("clear").returncode, 0)

    def test_bad_arguments(self):
        self.assertEqual(self.run_helper("refactor").returncode, 2)
        self.assertEqual(self.run_helper("implement", "1.1", "--stage", "tests/test_a.py").returncode, 2)
        self.assertEqual(self.run_helper("review", "1.1").returncode, 2)
        self.assertFalse(self.state_file.exists())


if __name__ == "__main__":
    unittest.main()
