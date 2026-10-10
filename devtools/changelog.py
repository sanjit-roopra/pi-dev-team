#!/usr/bin/env python3
"""Keep CHANGELOG.md in step with the git history, one section per release.

  changelog.py                  add the section for the version in package.json (the `npm version` hook)
  changelog.py --section 0.4.0  print that section (the text of the GitHub Release)
  changelog.py --rebuild        write the whole file again from the v* tags

An entry is the subject of a commit on the main line since the last tag. Pull request merges give the
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
    "All notable changes to this package. Each entry is a pull request title, written by "
    "`devtools/changelog.py` when the version is bumped.\n"
)
BUMP_COMMIT = re.compile(r"\d+\.\d+\.\d+")
MERGE_COMMIT = re.compile(r"Merge pull request #(\d+) from \S+")
SECTION_START = re.compile(r"^## \[(\d+\.\d+\.\d+)\]", re.MULTILINE)


def git(*args):
    # Only the final newline goes: str.strip() would also eat the \x1e and \x1f separators of `entries`.
    return subprocess.run(["git", *args], cwd=ROOT, check=True, capture_output=True, text=True).stdout.rstrip("\n")


def repo_url():
    url = json.loads((ROOT / "package.json").read_text())["repository"]["url"]
    return re.sub(r"^git\+|\.git$", "", url)


def entries(since, until):
    """Commit subjects on the main line from `since` (exclusive, or None for all) to `until`."""
    span = f"{since}..{until}" if since else until
    log = git("log", "--first-parent", "--format=%s%x1f%b%x1e", span)
    found = []
    for record in filter(None, log.split("\x1e")):
        subject, body = (part.strip() for part in record.split("\x1f", 1))
        merge = MERGE_COMMIT.match(subject)
        if merge:  # a merge commit has the pull request title as the first line of its body
            title = body.splitlines()[0] if body else subject
            subject = f"{title} (#{merge.group(1)})"
        if not BUMP_COMMIT.fullmatch(subject):
            found.append(subject)
    return found


def link_pull_requests(line, url):
    return re.sub(r"\(#(\d+)\)", rf"([#\1]({url}/pull/\1))", line)


def section(version, day, subjects):
    url = repo_url()
    lines = [f"- {link_pull_requests(subject, url)}" for subject in subjects] or ["- No notable changes."]
    return f"## [{version}] - {day}\n\n" + "\n".join(lines) + "\n"


def split_sections(text):
    """The text before the first section, then each section as a (version, text) pair."""
    starts = list(SECTION_START.finditer(text))
    head = text[: starts[0].start()] if starts else text
    ends = [match.start() for match in starts[1:]] + [len(text)]
    return head, [(m.group(1), text[m.start() : end].rstrip() + "\n") for m, end in zip(starts, ends)]


def add_section(version, day):
    """Put the section for `version` at the top of CHANGELOG.md, replacing it if it is already there."""
    text = CHANGELOG.read_text() if CHANGELOG.exists() else HEADER
    head, existing = split_sections(text)
    last_tag = git("describe", "--tags", "--abbrev=0", "HEAD") if git("tag") else None
    new = section(version, day, entries(last_tag, "HEAD"))
    kept = [body for found, body in existing if found != version]
    CHANGELOG.write_text("\n".join([head.rstrip() + "\n", new, *kept]))


def rebuild():
    tags = sorted(git("tag", "--list", "v*").split(), key=lambda tag: tuple(map(int, tag[1:].split("."))))
    sections = [
        section(tag[1:], git("log", "-1", "--format=%cs", tag), entries(before, tag))
        for before, tag in zip([None, *tags], tags)
    ]
    CHANGELOG.write_text("\n".join([HEADER, *reversed(sections)]))


def print_section(version):
    _, existing = split_sections(CHANGELOG.read_text())
    for found, body in existing:
        if found == version:
            print(body.split("\n", 2)[2].strip())  # without the "## [x.y.z]" heading
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
        add_section(json.loads((ROOT / "package.json").read_text())["version"], date.today().isoformat())


if __name__ == "__main__":
    main()
