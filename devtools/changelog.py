#!/usr/bin/env python3
"""Keep CHANGELOG.md in step with the git history, one section per release.

  changelog.py                  put the section for the version in package.json on top (the `npm version` hook)
  changelog.py --section 0.4.0  print that section (the text of the GitHub Release)
  changelog.py --rebuild        write the whole file again from the v* tags; hand edits are lost

An entry is the subject of a commit on the main line since the last tag. A pull request merge gives the
pull request title. The version bump commits ("0.4.0") are left out.
"""
import argparse
import json
import re
import subprocess
import sys
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CHANGELOG = ROOT / "CHANGELOG.md"
HEADER = (
    "# Changelog\n\n"
    "All notable changes to this package. Each entry is the subject of a commit on the main line, written by "
    "`devtools/changelog.py` when the version is bumped. A pull request shows as its title with a link.\n"
)
VERSION = r"\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?"  # 0.4.0, 1.0.0-rc.1
BUMP_COMMIT = re.compile(VERSION)
SECTION_START = re.compile(rf"^## \[({VERSION})\]", re.MULTILINE)
MERGE_COMMIT = re.compile(r"Merge pull request #(\d+) from \S+")
RELEASE_TAG = re.compile(r"v(\d+)\.(\d+)\.(\d+)(-.*)?")
FIELD, RECORD = "\x1f", "\x1e"  # between a commit's subject and body, and between commits


def git(*args):
    # Only the final newline goes: str.strip() would also eat the FIELD and RECORD separators.
    return subprocess.run(["git", *args], cwd=ROOT, check=True, capture_output=True, text=True).stdout.rstrip("\n")


def package():
    return json.loads((ROOT / "package.json").read_text())


def repo_url():
    return re.sub(r"^git\+|\.git$", "", package()["repository"]["url"])


def last_tag(excluding):
    """The newest v* tag reachable from HEAD, other than `excluding`; None when there is none."""
    try:
        return git("describe", "--tags", "--abbrev=0", "--match", "v*", "--exclude", excluding, "HEAD")
    except subprocess.CalledProcessError:
        return None


def commit_subjects(since, until):
    """Subjects on the main line from `since` (exclusive, or None for all) to `until`."""
    span = f"{since}..{until}" if since else until
    log = git("log", "--first-parent", f"--format=%s{FIELD}%b{RECORD}", span)
    subjects = []
    for record in filter(None, log.split(RECORD)):
        subject, body = (part.strip() for part in record.split(FIELD, 1))
        merge = MERGE_COMMIT.match(subject)
        if merge:  # a merge commit has the pull request title as the first line of its body
            title = body.splitlines()[0] if body else subject
            subject = f"{title} (#{merge.group(1)})"
        if not BUMP_COMMIT.fullmatch(subject):
            subjects.append(subject)
    return subjects


def link_pull_requests(subject, url):
    return re.sub(r"\(#(\d+)\)", rf"([#\1]({url}/pull/\1))", subject)


def render_section(version, release_date, subjects, url):
    lines = [f"- {link_pull_requests(subject, url)}" for subject in subjects]
    return f"## [{version}] - {release_date}\n\n" + "\n".join(lines or ["- No notable changes."]) + "\n"


def split_sections(text):
    """The text before the first section, then each section as a (version, text) pair."""
    starts = list(SECTION_START.finditer(text))
    head = text[: starts[0].start()] if starts else text
    ends = [match.start() for match in starts[1:]] + [len(text)]
    return head, [(m.group(1), text[m.start() : end].rstrip() + "\n") for m, end in zip(starts, ends)]


def upsert_section(version, release_date):
    """Put the section for `version` at the top of CHANGELOG.md, replacing it if it is already there."""
    head, existing = split_sections(CHANGELOG.read_text() if CHANGELOG.exists() else HEADER)
    subjects = commit_subjects(last_tag(excluding=f"v{version}"), "HEAD")
    new_section = render_section(version, release_date, subjects, repo_url())
    older = [text for found, text in existing if found != version]
    CHANGELOG.write_text("\n".join([head.rstrip() + "\n", new_section, *older]))


def release_tags():
    """The v* tags that are versions, oldest first. Other v* tags are not releases and are skipped."""
    parsed = {tag: RELEASE_TAG.fullmatch(tag) for tag in git("tag", "--list", "v*").split()}

    def order(tag):  # a pre-release sorts before its release: 1.0.0-rc.1 < 1.0.0
        major, minor, patch, suffix = parsed[tag].groups()
        return int(major), int(minor), int(patch), suffix is None, suffix or ""

    return sorted((tag for tag, match in parsed.items() if match), key=order)


def rebuild():
    tags, url = release_tags(), repo_url()
    sections = [
        render_section(tag[1:], git("log", "-1", "--format=%cs", tag), commit_subjects(previous, tag), url)
        for previous, tag in zip([None, *tags], tags)
    ]
    CHANGELOG.write_text("\n".join([HEADER, *reversed(sections)]))


def print_section(version):
    _, existing = split_sections(CHANGELOG.read_text())
    for found, text in existing:
        if found == version:
            print(text.partition("\n")[2].strip())  # without the "## [x.y.z]" heading line
            return
    sys.exit(f"CHANGELOG.md has no section for {version}")


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--section", metavar="VERSION")
    parser.add_argument("--rebuild", action="store_true")
    args = parser.parse_args()
    if args.section:
        print_section(args.section)
    elif args.rebuild:
        rebuild()
    else:
        upsert_section(package()["version"], date.today().isoformat())


if __name__ == "__main__":
    main()
