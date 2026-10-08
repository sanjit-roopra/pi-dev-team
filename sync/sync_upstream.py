#!/usr/bin/env python3
"""Sync upstream bdfinst/agentic-dev-team `plugins/dev-team` into this pi package.

Usage:
  python3 sync/sync_upstream.py --upstream /path/to/agentic-dev-team [--check]

What it does (idempotent, stdlib only):
  1. Replaces the managed directories (agents, skills, hooks, scripts, knowledge,
     templates, tools, docs/upstream) with fresh copies from upstream.
  2. Drops skills that only make sense inside Claude Code (DROPPED_SKILLS).
  3. Copies pi-specific replacements from overrides/ over the result. A slim
     skill's override also carries its upstream text, unchanged, split into
     references/ by sync/split_skill_references.py.
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
import hashlib
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

# Overrides that replace an upstream file, with the sha256 of the upstream
# version each one was ported from. When upstream changes one of these files,
# the override would silently discard that change, so sync fails until the
# override is re-ported and its hash updated here.
OVERRIDE_BASES: dict[str, str] = {
    "hooks/pre_tool_guard.py": "761e83e9d9bb66544ce465aaf301d0d5a52fd84b988238e6b947a0202dcdc3d5",
    "hooks/guards.json": "03916b358d3f5c5036d9517222d469f85404dc3c9cde1364dfb4d3bc7422c54b",
    # Slim core + verbatim references (sync/split_skill_references.py); re-port when upstream changes it.
    "skills/code-review/SKILL.md": "97d0b514bef1a8b9ee18c8e6d043419c0c43fffd1ab701aea3beaf5f9edb6303",
    # The simplify lens (PORTING.md section 5); the other lean-code agent edits are LEAN_PATCHES.
    "agents/refactor-opportunity-review.md": "e25b0d4ffe63dd4afd6a4dde59961145b2eb89d02e7523fadcd98e5b2d376f35",
}

# Lean production code (PORTING.md section 5): the lean fix rule, word for word as in the code-review core, and
# the agent edits that carry it. Production code only; test scope stays with the Gherkin scenarios and the mutation gate.
LEAN_FIX_RULE = (
    "**Lean fix rule (production code only).** A `warning` whose fix restructures code (extracts a function, splits a "
    "module, or introduces a type, interface, parameter object, wrapper or layer) and adds more production lines than it "
    "removes counts as a `suggestion` with confidence `none`: rewrite it so in the findings JSON before any script reads "
    "it, report it, never auto-apply it, and keep it out of the fix loop, overriding the actionability table in "
    "`knowledge/three-phase-workflow.md` § Review Loop. `error` findings are unaffected. Exempt: fixes that correct "
    "behavior (a bug, a missing check, a security or accessibility gap); a seam for a collaborator the blocker table in "
    "`knowledge/internal-collaborator-doubling.md` lets a test double (B1–B3); and test files "
    "(`knowledge/test-file-indicators.md`), fixtures and test helpers."
)
REUSE_LADDER = """- **Simplicity First (pre-write reuse ladder).** Read the code the change touches and trace the real flow first: be lazy about the solution, never about understanding the problem. Then walk this ladder and stop at the first rung that holds:
  1. Does it need to exist? Nothing asked for it and no scenario demands it → do not write it.
  2. Does the codebase already have it? Call it.
  3. Does the standard library do it?
  4. Does the platform or framework do it natively?
  5. Does an already-installed dependency do it? Never add a dependency to save a few lines.
  6. Otherwise write the minimum that works: no speculative options, no single-use abstraction (an interface with one implementation, a wrapper or factory used once, a layer that only forwards), no configurability nobody asked for.

  Fewer lines, never denser lines: clarity beats brevity. No nested ternaries, no clever one-liners, no packing several steps into one expression to save a line. Never cut input validation, error handling at a real boundary, security or accessibility to save lines.

  The ladder governs production code only. Test scope comes from the plan's Gherkin scenarios and the mutation gate, never from this rule: write every test they call for.

  A deliberate shortcut gets a `shortcut:` comment at the spot, naming what it skips and when that would need revisiting, so `grep -rn "shortcut:"` lists the debt."""
LEAN_PATCHES: list[tuple[str, str, str, str]] = [
    (
        "agents/software-engineer.md",
        re.escape("- End-of-turn: one sentence on what was implemented and what tests confirm it.\n"),
        "- End-of-turn: one sentence on what was implemented and what tests confirm it, then one `Skipped:` line naming "
        "what you deliberately left out or did not check, and the risk (`Skipped: none` when nothing was).\n",
        "lean production code: the engineer names what it skipped",
    ),
    (
        "agents/software-engineer.md",
        re.escape("- **Simplicity First (pre-write).** Before writing, choose the minimum code that solves the stated problem. "
                  "No speculative features, no single-use abstractions, no configurability nobody asked for."),
        REUSE_LADDER,
        "lean production code: the reuse ladder",
    ),
    (
        "agents/structure-review.md",
        re.escape("DRY violations:\n\n- Duplicated code blocks\n- Copy-paste patterns\n"),
        "DRY violations (rule of three):\n\n- The same block three or more times, or twice when both copies encode the same "
        "business rule (\"if the rule changes, must both change?\")\n- Two structurally similar blocks are not a finding\n",
        "lean production code: rule of three",
    ),
    (
        "agents/structure-review.md",
        re.escape("- Hardcoded dependencies (not injected)\n"),
        "- A hardcoded collaborator that the blocker table in `${CLAUDE_PLUGIN_ROOT}/knowledge/internal-collaborator-doubling.md` "
        "lets a test double (B1 out-of-process handle, B2 ambient state, B3 prohibitive cost), so a test cannot replace it. "
        "Other first-party collaborators constructed inline are not a finding\n",
        "lean production code: inject only what the blocker table allows doubling",
    ),
    (
        "agents/structure-review.md",
        re.escape("## Authoring checklist\n"),
        LEAN_FIX_RULE + "\n\nEmit such findings as `suggestion` with confidence `none` yourself. Never propose an abstraction "
        "for a single use (one implementation, one caller, one value), except a seam the blocker table allows.\n\n"
        "## Authoring checklist\n",
        "lean production code: structure-review demotes growing restructures at the source",
    ),
    (
        "agents/structure-review.md",
        re.escape('- One responsibility per function/module; split when you need "and" to describe it.\n'
                  "- Inject dependencies; don't construct collaborators inline.\n"),
        "- One responsibility per module; inside a function, prefer early returns to new helpers. Extract a helper when it gets "
        "a second caller or separates I/O from logic.\n- Inject only what the blocker table (B1–B3 in "
        "`knowledge/internal-collaborator-doubling.md`) allows doubling: out-of-process handles, ambient state (clock, RNG, "
        "env, locale), prohibitive cost. Construct other first-party collaborators directly.\n",
        "lean production code: authoring checklist without single-use helpers",
    ),
    (
        "agents/structure-review.md",
        re.escape("- Before copying a block, extract it; third repeat is a defect.\n"),
        "- Two copies are fine; extract at the third, or at the second when both encode the same business rule.\n",
        "lean production code: rule of three at write time",
    ),
    (
        "agents/structure-review.md",
        re.escape("- Are there hidden static singletons or global state that aren't injected?\n"
                  '- For every "duplicate code" finding, did you verify it\'s semantic duplication and not just structural '
                  "similarity?\n"),
        "- Are there hidden static singletons or global state wrapping a B1–B3 collaborator that aren't injected?\n"
        "- For a two-copy duplication finding, did you apply the semantic test? For three or more copies, did you confirm "
        "they are really the same block?\n",
        "lean production code: self-challenge matches the rule of three",
    ),
    (
        "agents/quality-reviewer.md",
        re.escape("| error or warning | high or medium | **Yes** — auto-apply |"),
        "| error or warning | high or medium | **Yes** — auto-apply, unless the lean fix rule below makes it a suggestion |",
        "lean production code: the fix-loop table defers to the lean fix rule",
    ),
    (
        "agents/quality-reviewer.md",
        re.escape("| suggestion | any | No — report only |\n"),
        "| suggestion | any | No — report only |\n\n" + LEAN_FIX_RULE + "\n",
        "lean production code: restructuring that grows production code is report-only",
    ),
    (
        "agents/plan-review-strategic.md",
        re.escape("4. **Root cause vs. symptom**"),
        "4. **Reuse before new code** — For each step that adds production code, does the plan name what it reuses (an "
        "existing function, the standard library, a platform feature, an installed dependency), or mark it `new:` with a "
        "reason? A step that builds what the codebase, standard library, platform or an installed dependency already "
        "provides is over-engineered. Tests are exempt: test scope comes from the Gherkin scenarios.\n"
        "5. **Root cause vs. symptom**",
        "lean production code: plans name their reuse",
    ),
    (
        "agents/plan-review-strategic.md",
        re.escape('    "minimum_viable_subset": "<which criteria/steps form the smallest useful increment>"\n  },'),
        '    "minimum_viable_subset": "<which criteria/steps form the smallest useful increment>",\n'
        '    "proposed_cut": "<at least one step, criterion, option or abstraction the plan can drop or defer, and why that '
        'is safe; none only after you looked for one>"\n  },',
        "lean production code: the strategic critic proposes a cut",
    ),
    (
        "agents/plan-review-strategic.md",
        re.escape("- Simpler alternative not considered → `warning`\n"),
        "- Simpler alternative not considered → `warning`\n- A production step builds what the codebase, standard library, "
        "platform or an installed dependency already provides → `warning`\n",
        "lean production code: reinventing is a warning",
    ),
]

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


def stale_override_bases(root: Path, bases: dict[str, str]) -> list[str]:
    """Return the overridden files whose upstream copy under `root` no longer
    matches the hash the override was ported from (or no longer exists)."""
    stale = []
    for rel, sha in bases.items():
        f = root / rel
        if not f.is_file() or hashlib.sha256(f.read_bytes()).hexdigest() != sha:
            stale.append(rel)
    return stale


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

    failures: list[str] = [
        f"{rel}: upstream changed this file, which overrides/{rel} replaces; re-port the override and update OVERRIDE_BASES"
        for rel in stale_override_bases(PKG, OVERRIDE_BASES)
    ]

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
    for pattern, regex, repl, why in PATCHES + LEAN_PATCHES:
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
        print("UPSTREAM DRIFT (review and update PATCHES / OVERRIDE_BASES):", file=sys.stderr)
        for f in failures:
            print("  - " + f, file=sys.stderr)
        return 1
    print(f"  {sum(int(p['hits']) for p in patched)} patch hits, all patches matched")
    return 0


if __name__ == "__main__":
    sys.exit(main())
