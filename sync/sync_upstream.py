#!/usr/bin/env python3
"""Sync upstream bdfinst/agentic-dev-team `plugins/dev-team` into this pi package.

Usage:
  python3 sync/sync_upstream.py --upstream /path/to/agentic-dev-team [--check]

What it does (idempotent, stdlib only):
  1. Replaces the managed directories (agents, skills, hooks, scripts, knowledge,
     templates, tools, docs/upstream) with fresh copies from upstream.
  2. Drops skills that only make sense inside Claude Code (DROPPED_SKILLS).
  3. Copies pi-specific replacements from overrides/ over the result.
  4. Normalises SKILL.md frontmatter for pi (description <= 1024 chars).
  5. Applies the small, explicit text patch set (PATCHES). Every patch must
     match at least once, so upstream drift is caught instead of silently
     skipped.
  6. Writes UPSTREAM.json (commit, version, what was dropped/overridden/patched).

Everything not listed here (extensions/, bin/, sync/, overrides/, test/,
PORTING.md, README.md, package.json) is owned by the port and never touched.
"""

from __future__ import annotations

import argparse
import json
import re
import shutil
import subprocess
import sys
from pathlib import Path

PKG = Path(__file__).resolve().parent.parent
PLUGIN_SUBDIR = Path("plugins/dev-team")

MANAGED_DIRS = ["agents", "skills", "hooks", "scripts", "knowledge", "templates", "tools"]
UPSTREAM_DOCS_DEST = Path("docs/upstream")

# Skills that test, audit or drive Claude Code itself. See PORTING.md section 4.
DROPPED_SKILLS = [
    "agent-audit",
    "agent-eval",
    "claude-setup-review",
    "harness-e2e-check",
    "long-eval",
    "orchestration-benchmark",
    "session-review",
]

IGNORE = shutil.ignore_patterns("__pycache__", "*.pyc", ".pytest_cache", ".mypy_cache", ".ruff_cache")

DESCRIPTION_LIMIT = 1024

# (glob relative to package root, regex, replacement, description)
PATCHES: list[tuple[str, str, str, str]] = [
    (
        "skills/plan/SKILL.md",
        r"or stdin is not a usable TTY \(`test -t 0` is false — the headless/CI/automation case\)",
        "or `DEV_TEAM_INTERACTIVE` is not `1` (pi sets it only when a human UI is attached; "
        "a tool shell never has a TTY, so `test -t 0` must not be used — the headless/CI/automation case)",
        "interactivity: tool shells have no TTY in pi",
    ),
    (
        "skills/build/SKILL.md",
        r"or stdin is not a usable TTY \(`test -t 0` is false — the headless/CI/automation case\)",
        "or `DEV_TEAM_INTERACTIVE` is not `1` (pi sets it only when a human UI is attached; "
        "a tool shell never has a TTY, so `test -t 0` must not be used — the headless/CI/automation case)",
        "interactivity: tool shells have no TTY in pi",
    ),
    (
        "skills/review-agent/SKILL.md",
        r"Read `\.claude/agents/<name>\.md`\. If the file doesn't exist, list available\s+review agents from `\.claude/agents/`",
        "Read `.claude/agents/<name>.md` (project override) or else `${CLAUDE_PLUGIN_ROOT}/agents/<name>.md`. "
        "If neither exists, list available\nreview agents from `${CLAUDE_PLUGIN_ROOT}/agents/`",
        "agent definitions live in the package, not the project",
    ),
    (
        "skills/help/SKILL.md",
        r"1\. Use Glob to find every `skills/\*/SKILL\.md` file\.",
        "1. Use `find` to list every `${CLAUDE_PLUGIN_ROOT}/skills/*/SKILL.md` file, plus project skills in "
        "`.pi/skills/*/SKILL.md` and `.claude/skills/*/SKILL.md`.",
        "skills live in the package root",
    ),
    (
        "skills/triage/SKILL.md",
        r'Use the Agent tool with `subagent_type: "Explore"`',
        'Use the `dev_team_subagent` tool with `agent: "Explore"`',
        "Claude's built-in Explore agent is provided by the port",
    ),
]


def run(cmd: list[str], cwd: Path) -> str:
    try:
        return subprocess.run(cmd, cwd=cwd, capture_output=True, text=True, check=False).stdout.strip()
    except OSError:
        return ""


def split_frontmatter(text: str) -> tuple[list[str], str] | None:
    if not text.startswith("---"):
        return None
    lines = text.split("\n")
    for i in range(1, len(lines)):
        if lines[i].strip() == "---":
            return lines[1:i], "\n".join(lines[i + 1 :])
    return None


def fm_blocks(fm_lines: list[str]) -> list[tuple[str | None, list[str]]]:
    """Group frontmatter into top-level key blocks (key line + indented continuation)."""
    blocks: list[tuple[str | None, list[str]]] = []
    for line in fm_lines:
        m = re.match(r"^([A-Za-z0-9_-]+):", line)
        if m and not line.startswith((" ", "\t")):
            blocks.append((m.group(1), [line]))
        elif blocks:
            blocks[-1][1].append(line)
        else:
            blocks.append((None, [line]))
    return blocks


def block_value(lines: list[str]) -> str:
    first = lines[0].split(":", 1)[1].strip()
    rest = [l.strip() for l in lines[1:]]
    if first in (">", "|", ">-", "|-", ""):
        return " ".join(r for r in rest if r)
    val = " ".join([first] + [r for r in rest if r])
    if len(val) >= 2 and val[0] == val[-1] and val[0] in "\"'":
        val = val[1:-1]
    return val


def trim_description(desc: str) -> str:
    if len(desc) <= DESCRIPTION_LIMIT:
        return desc
    cut = desc[: DESCRIPTION_LIMIT - 1]
    # prefer ending at a sentence boundary
    dot = cut.rfind(". ")
    if dot > DESCRIPTION_LIMIT * 0.6:
        cut = cut[: dot + 1]
    return cut.rstrip() + ("" if cut.endswith(".") else "…")


def normalise_skill(path: Path) -> bool:
    text = path.read_text(encoding="utf-8")
    parts = split_frontmatter(text)
    if not parts:
        return False
    fm_lines, body = parts
    changed = False
    out: list[str] = []
    for key, lines in fm_blocks(fm_lines):
        if key == "description":
            desc = block_value(lines)
            trimmed = trim_description(desc)
            if trimmed != desc:
                out.append("description: " + json.dumps(trimmed, ensure_ascii=False))
                changed = True
                continue
        out.extend(lines)
    if changed:
        path.write_text("---\n" + "\n".join(out) + "\n---\n" + body, encoding="utf-8")
    return changed


NOTE_MARKER = "<!-- pi-port-notes -->"


def insert_note(skill_md: Path, note: str) -> None:
    """Insert a pi port note block after the first H1 (or after frontmatter)."""
    text = skill_md.read_text(encoding="utf-8")
    if NOTE_MARKER in text:
        return
    block = f"\n{NOTE_MARKER}\n{note.strip()}\n{NOTE_MARKER}\n"
    m = re.search(r"^# .*$", text, flags=re.M)
    if m:
        text = text[: m.end()] + "\n" + block + text[m.end() :]
    else:
        parts = split_frontmatter(text)
        text = text + block if not parts else text.replace("\n---\n", "\n---\n" + block, 1)
    skill_md.write_text(text, encoding="utf-8")


def copy_tree(src: Path, dst: Path) -> None:
    if dst.exists():
        shutil.rmtree(dst)
    shutil.copytree(src, dst, ignore=IGNORE, symlinks=True)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--upstream", required=True, help="checkout of bdfinst/agentic-dev-team")
    args = ap.parse_args()

    upstream = Path(args.upstream).resolve()
    plugin = upstream / PLUGIN_SUBDIR
    if not (plugin / "agents").is_dir():
        print(f"error: {plugin} does not look like plugins/dev-team", file=sys.stderr)
        return 2

    for name in MANAGED_DIRS:
        src = plugin / name
        if src.is_dir():
            copy_tree(src, PKG / name)
    if (plugin / "docs").is_dir():
        copy_tree(plugin / "docs", PKG / UPSTREAM_DOCS_DEST)
    for fname, dest in (("CHANGELOG.md", "docs/upstream/CHANGELOG.md"), ("README.md", "docs/upstream/README.md")):
        if (plugin / fname).is_file():
            shutil.copy2(plugin / fname, PKG / dest)

    # hooks/lib/plugin_version.py reads <root>/.claude-plugin/plugin.json for the version stamped on metrics rows.
    if (plugin / ".claude-plugin" / "plugin.json").is_file():
        (PKG / ".claude-plugin").mkdir(exist_ok=True)
        shutil.copy2(plugin / ".claude-plugin" / "plugin.json", PKG / ".claude-plugin" / "plugin.json")

    dropped = []
    for skill in DROPPED_SKILLS:
        target = PKG / "skills" / skill
        if target.exists():
            shutil.rmtree(target)
            dropped.append(skill)

    overridden: list[str] = []
    overrides = PKG / "overrides"
    if overrides.is_dir():
        for src in sorted(overrides.rglob("*")):
            if src.is_file() and "__pycache__" not in src.parts and src.relative_to(overrides).parts[0] != "notes":
                rel = src.relative_to(overrides)
                dst = PKG / rel
                dst.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(src, dst)
                overridden.append(str(rel))

    noted: list[str] = []
    for note in sorted((overrides / "notes").glob("*.md")) if (overrides / "notes").is_dir() else []:
        skill_md = PKG / "skills" / note.stem / "SKILL.md"
        if not skill_md.is_file():
            print(f"warning: note for missing skill {note.stem}", file=sys.stderr)
            continue
        insert_note(skill_md, note.read_text(encoding="utf-8"))
        noted.append(note.stem)

    normalised = [
        str(p.relative_to(PKG)) for p in sorted((PKG / "skills").glob("*/SKILL.md")) if normalise_skill(p)
    ]

    patched: list[dict[str, object]] = []
    failures: list[str] = []
    for pattern, regex, repl, why in PATCHES:
        files = sorted(PKG.glob(pattern))
        hits = 0
        for f in files:
            text = f.read_text(encoding="utf-8")
            new, n = re.subn(regex, lambda _m: repl, text)
            if n:
                f.write_text(new, encoding="utf-8")
                hits += n
        if hits == 0:
            failures.append(f"{pattern}: /{regex[:60]}.../ ({why})")
        patched.append({"file": pattern, "reason": why, "hits": hits})

    version = ""
    manifest = plugin / ".claude-plugin" / "plugin.json"
    if manifest.is_file():
        version = json.loads(manifest.read_text(encoding="utf-8")).get("version", "")
    info = {
        "repository": "https://github.com/bdfinst/agentic-dev-team",
        "plugin": "dev-team",
        "version": version,
        "commit": run(["git", "rev-parse", "HEAD"], upstream),
        "commitDate": run(["git", "log", "-1", "--format=%cI"], upstream),
        "droppedSkills": dropped,
        "overridden": overridden,
        "notes": noted,
        "normalisedFrontmatter": normalised,
        "patches": patched,
    }
    (PKG / "UPSTREAM.json").write_text(json.dumps(info, indent=2) + "\n", encoding="utf-8")

    print(f"synced dev-team {version} ({info['commit'][:10]})")
    print(f"  dropped {len(dropped)} skills, {len(overridden)} override files, {len(normalised)} frontmatter fixes")
    if failures:
        print("PATCHES THAT NO LONGER MATCH (upstream changed; review and update PATCHES):", file=sys.stderr)
        for f in failures:
            print("  - " + f, file=sys.stderr)
        return 1
    print(f"  {sum(int(p['hits']) for p in patched)} patch hits, all patches matched")
    return 0


if __name__ == "__main__":
    sys.exit(main())
