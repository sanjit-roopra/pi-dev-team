"""Tests for devtools/changelog.py. Run: python3 -m unittest discover -s test/py"""
import contextlib
import io
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from _loader import ROOT, load_module

changelog = load_module("changelog", ROOT / "devtools" / "changelog.py")

REPO_URL = "https://github.com/acme/widget"
PR_LINK = f"([#7]({REPO_URL}/pull/7))"
# Own git identity and no signing, hooks or templates from the machine that runs the tests.
GIT_ENV = {**os.environ, "GIT_CONFIG_GLOBAL": os.devnull, "GIT_CONFIG_SYSTEM": os.devnull}


class ChangelogTest(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.root = Path(tmp.name)
        self.git("init", "-q", "-b", "main")
        self.git("config", "user.email", "t@example.com")
        self.git("config", "user.name", "t")
        self.git("config", "commit.gpgsign", "false")
        self.git("config", "tag.gpgSign", "false")
        self.write_package("0.0.0")  # for repo_url(); not committed until a test calls release()
        for attr, value in (("ROOT", self.root), ("CHANGELOG", self.root / "CHANGELOG.md")):
            patcher = mock.patch.object(changelog, attr, value)
            patcher.start()
            self.addCleanup(patcher.stop)

    def git(self, *args):
        subprocess.run(["git", *args], cwd=self.root, check=True, capture_output=True, env=GIT_ENV)

    def commit(self, subject, body=""):
        self.git("commit", "-q", "--allow-empty", "-m", subject + (f"\n\n{body}" if body else ""))

    def write_package(self, version):
        (self.root / "package.json").write_text(
            json.dumps({"version": version, "repository": {"url": f"git+{REPO_URL}.git"}})
        )

    def release(self, version):
        """What `npm version` leaves behind: a bump commit with a tag."""
        self.write_package(version)
        self.git("add", "package.json")
        self.commit(version)
        self.git("tag", f"v{version}")

    def changelog_text(self):
        return (self.root / "CHANGELOG.md").read_text()

    def headings(self):
        return [line for line in self.changelog_text().splitlines() if line.startswith("## ")]


class TestEntries(ChangelogTest):
    def test_lists_commits_since_the_given_tag_and_leaves_out_version_bumps(self):
        self.release("0.1.0")
        self.commit("Add a thing (#7)")
        self.commit("0.1.1")  # a bump commit inside the range
        self.commit("Fix a bug")
        self.assertEqual(changelog.commit_subjects("v0.1.0", "HEAD"), ["Fix a bug", "Add a thing (#7)"])

    def test_without_a_tag_lists_all_history(self):
        self.commit("First")
        self.commit("Second")
        self.assertEqual(changelog.commit_subjects(None, "HEAD"), ["Second", "First"])

    def test_merge_commit_gives_the_pull_request_title_and_hides_the_branch_commits(self):
        self.release("0.1.0")
        self.git("checkout", "-q", "-b", "feature")
        self.commit("wip on the branch")
        self.git("checkout", "-q", "main")
        self.git("merge", "-q", "--no-ff", "-m", "Merge pull request #4 from acme/feature", "-m", "Show the thing", "feature")
        self.assertEqual(changelog.commit_subjects("v0.1.0", "HEAD"), ["Show the thing (#4)"])

    def test_merge_commit_without_a_body_keeps_its_subject(self):
        self.commit("Merge pull request #4 from acme/feature")
        self.assertEqual(changelog.commit_subjects(None, "HEAD"), ["Merge pull request #4 from acme/feature (#4)"])


class TestLastTag(ChangelogTest):
    def test_is_none_without_tags(self):
        self.commit("First")
        self.assertIsNone(changelog.last_tag(excluding="v0.1.0"))

    def test_skips_tags_that_are_not_releases_and_the_excluded_tag(self):
        self.release("0.1.0")
        self.git("tag", "nightly")
        self.release("0.2.0")
        self.assertEqual(changelog.last_tag(excluding="v0.2.0"), "v0.1.0")


class TestUpsertSection(ChangelogTest):
    def test_first_release_without_tags_uses_all_history(self):
        self.commit("Add a thing (#7)")
        self.write_package("0.1.0")
        changelog.upsert_section("0.1.0", "2026-10-10")
        self.assertEqual(
            self.changelog_text(), changelog.HEADER + f"\n## [0.1.0] - 2026-10-10\n\n- Add a thing {PR_LINK}\n"
        )

    def test_lists_commits_since_the_last_tag(self):
        self.release("0.1.0")
        self.commit("Add a thing (#7)")
        changelog.upsert_section("0.2.0", "2026-10-10")
        self.assertEqual(
            self.changelog_text(), changelog.HEADER + f"\n## [0.2.0] - 2026-10-10\n\n- Add a thing {PR_LINK}\n"
        )

    def test_new_section_goes_above_older_ones_and_keeps_their_text(self):
        self.commit("First (#1)")
        changelog.upsert_section("0.2.0", "2026-10-09")
        self.release("0.2.0")
        self.commit("Second (#2)")
        changelog.upsert_section("0.3.0", "2026-10-10")
        self.assertEqual(self.headings(), ["## [0.3.0] - 2026-10-10", "## [0.2.0] - 2026-10-09"])
        self.assertEqual(self.changelog_text().count("First"), 1)
        self.assertEqual(self.changelog_text().count("Second"), 1)

    def test_running_twice_gives_the_same_file(self):
        self.commit("First (#1)")
        changelog.upsert_section("0.2.0", "2026-10-10")
        once = self.changelog_text()
        changelog.upsert_section("0.2.0", "2026-10-10")
        self.assertEqual(self.changelog_text(), once)

    def test_running_again_after_the_tag_exists_keeps_the_entries(self):
        self.commit("First (#1)")
        self.write_package("0.2.0")
        changelog.upsert_section("0.2.0", "2026-10-10")
        before = self.changelog_text()
        self.git("add", "-A")
        self.commit("0.2.0")
        self.git("tag", "v0.2.0")
        changelog.upsert_section("0.2.0", "2026-10-10")
        self.assertEqual(self.changelog_text(), before)

    def test_pre_release_version_gets_its_own_section(self):
        self.commit("First")
        changelog.upsert_section("1.0.0-rc.1", "2026-10-10")
        changelog.upsert_section("1.0.0-rc.1", "2026-10-10")
        self.assertEqual(self.headings(), ["## [1.0.0-rc.1] - 2026-10-10"])

    def test_version_bump_with_a_pre_release_is_left_out(self):
        self.commit("1.0.0-rc.1")
        self.assertEqual(changelog.commit_subjects(None, "HEAD"), [])


class TestRebuild(ChangelogTest):
    def test_writes_one_section_per_release_tag_newest_first(self):
        self.release("0.9.0")
        self.commit("Add a thing (#7)")
        self.release("0.10.0")
        self.git("tag", "v0.11.0-rc.1")
        self.git("tag", "vNext")
        changelog.rebuild()
        self.assertEqual([h.split(" - ")[0] for h in self.headings()], ["## [0.11.0-rc.1]", "## [0.10.0]", "## [0.9.0]"])
        self.assertIn(f"- Add a thing {PR_LINK}", self.changelog_text().split("## [0.9.0]")[0])
        self.assertNotIn("- 0.10.0", self.changelog_text())

    def test_dates_a_section_with_the_tagged_commit_date(self):
        self.release("0.1.0")
        changelog.rebuild()
        self.assertRegex(self.headings()[0], r"^## \[0\.1\.0\] - \d{4}-\d{2}-\d{2}$")


class TestPrintSection(ChangelogTest):
    def print_section(self, version):
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            changelog.print_section(version)
        return out.getvalue().strip()

    def test_gives_the_text_without_the_heading(self):
        self.release("0.1.0")
        self.commit("Add a thing (#7)")
        self.release("0.2.0")
        changelog.rebuild()
        self.assertEqual(self.print_section("0.2.0"), f"- Add a thing {PR_LINK}")

    def test_keeps_every_entry_when_a_hand_edit_left_no_blank_line_after_the_heading(self):
        (self.root / "CHANGELOG.md").write_text("# Changelog\n\n## [0.5.0] - 2026-10-10\n- A\n- B\n")
        self.assertEqual(self.print_section("0.5.0"), "- A\n- B")

    def test_fails_with_the_version_when_it_is_missing(self):
        self.release("0.1.0")
        changelog.rebuild()
        with self.assertRaises(SystemExit) as error:
            changelog.print_section("9.9.9")
        self.assertIn("9.9.9", str(error.exception))


class TestRenderSection(unittest.TestCase):
    def test_links_pull_request_numbers_and_says_so_when_there_are_no_commits(self):
        self.assertEqual(
            changelog.render_section("0.2.0", "2026-10-10", ["Add a thing (#7)", "Fix a bug"], REPO_URL),
            f"## [0.2.0] - 2026-10-10\n\n- Add a thing {PR_LINK}\n- Fix a bug\n",
        )
        self.assertEqual(
            changelog.render_section("0.2.0", "2026-10-10", [], REPO_URL),
            "## [0.2.0] - 2026-10-10\n\n- No notable changes.\n",
        )


class TestMain(ChangelogTest):
    def run_main(self, *argv):
        with mock.patch.object(sys, "argv", ["changelog.py", *argv]), mock.patch.object(changelog, "date") as today:
            today.today.return_value.isoformat.return_value = "2026-10-10"
            changelog.main()

    def test_without_arguments_adds_the_section_for_the_package_version(self):
        self.commit("Add a thing (#7)")
        self.write_package("0.1.0")
        self.run_main()
        self.assertEqual(self.headings(), ["## [0.1.0] - 2026-10-10"])

    def test_section_flag_wins_over_the_default_action(self):
        self.write_package("0.1.0")
        self.commit("Add a thing (#7)")
        self.run_main()
        with contextlib.redirect_stdout(io.StringIO()) as out:
            self.run_main("--section", "0.1.0")
        self.assertEqual(out.getvalue().strip(), f"- Add a thing {PR_LINK}")


if __name__ == "__main__":
    unittest.main()
