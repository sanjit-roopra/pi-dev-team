"""Tests for devtools/changelog.py. Run: python3 -m unittest discover -s test/py"""
import contextlib
import io
import json
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from _loader import ROOT, load_module

changelog = load_module("changelog", ROOT / "devtools" / "changelog.py")

REPO_URL = "https://github.com/acme/widget"


class ChangelogTest(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.root = Path(tmp.name)
        self.git("init", "-q", "-b", "main")
        self.git("config", "user.email", "t@example.com")
        self.git("config", "user.name", "t")
        self.version("0.1.0")
        for attr, value in (("ROOT", self.root), ("CHANGELOG", self.root / "CHANGELOG.md")):
            patcher = mock.patch.object(changelog, attr, value)
            patcher.start()
            self.addCleanup(patcher.stop)

    def git(self, *args):
        subprocess.run(["git", *args], cwd=self.root, check=True, capture_output=True)

    def commit(self, subject, body=""):
        self.git("commit", "-q", "--allow-empty", "-m", subject + (f"\n\n{body}" if body else ""))

    def version(self, number):
        (self.root / "package.json").write_text(
            json.dumps({"version": number, "repository": {"url": f"git+{REPO_URL}.git"}})
        )
        self.git("add", "package.json")
        self.commit(number)
        self.git("tag", f"v{number}")

    def text(self):
        return (self.root / "CHANGELOG.md").read_text()

    def test_section_lists_commits_since_last_tag_and_skips_version_bumps(self):
        self.commit("Add a thing (#7)")
        self.commit("Fix a bug")
        (self.root / "package.json").write_text(
            json.dumps({"version": "0.2.0", "repository": {"url": f"git+{REPO_URL}.git"}})
        )
        changelog.add_section("0.2.0", "2026-10-10")
        self.assertEqual(
            self.text(),
            changelog.HEADER
            + "\n## [0.2.0] - 2026-10-10\n\n"
            + f"- Fix a bug\n- Add a thing ([#7]({REPO_URL}/pull/7))\n",
        )

    def test_new_section_goes_above_older_ones_and_running_twice_does_not_repeat_it(self):
        self.commit("First (#1)")
        changelog.add_section("0.2.0", "2026-10-09")
        self.version("0.2.0")
        self.commit("Second (#2)")
        changelog.add_section("0.3.0", "2026-10-10")
        changelog.add_section("0.3.0", "2026-10-10")
        self.assertEqual(
            [line for line in self.text().splitlines() if line.startswith("## ")],
            ["## [0.3.0] - 2026-10-10", "## [0.2.0] - 2026-10-09"],
        )

    def test_merge_commit_gives_the_pull_request_title(self):
        self.commit("Merge pull request #4 from acme/branch", "Show the thing")
        self.assertEqual(changelog.entries("v0.1.0", "HEAD"), ["Show the thing (#4)"])

    def test_section_with_no_commits_says_so(self):
        self.assertIn("- No notable changes.", changelog.section("0.2.0", "2026-10-10", []))

    def test_rebuild_writes_one_section_per_tag_newest_first(self):
        self.commit("Add a thing (#7)")
        self.version("0.2.0")
        changelog.rebuild()
        headings = [line.split(" - ")[0] for line in self.text().splitlines() if line.startswith("## ")]
        self.assertEqual(headings, ["## [0.2.0]", "## [0.1.0]"])
        self.assertIn(f"([#7]({REPO_URL}/pull/7))", self.text().split("## [0.1.0]")[0])

    def test_print_section_gives_the_text_without_the_heading(self):
        self.commit("Add a thing (#7)")
        self.version("0.2.0")
        changelog.rebuild()
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            changelog.print_section("0.2.0")
        self.assertEqual(out.getvalue().strip(), f"- Add a thing ([#7]({REPO_URL}/pull/7))")

    def test_print_section_fails_when_the_version_is_missing(self):
        changelog.rebuild()
        with self.assertRaises(SystemExit):
            changelog.print_section("9.9.9")


if __name__ == "__main__":
    unittest.main()
