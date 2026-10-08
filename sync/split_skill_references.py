#!/usr/bin/env python3
"""Split an upstream SKILL.md into verbatim reference files for a slim pi override.

Usage:
  python3 sync/split_skill_references.py code-review --upstream ../agentic-dev-team

Some upstream skills are too large to load on every run (code-review is about
25k tokens). The port replaces such a skill with a short core SKILL.md in
overrides/skills/<skill>/ and keeps the full upstream text, unchanged, in
overrides/skills/<skill>/references/, split by step. This script writes those
reference files from the upstream SKILL.md, so a re-port after an upstream
change starts from the new text.

Every chunk starts at a fixed marker line of the upstream file. When upstream
renames or removes a marker, the script stops; update SPLITS. The reference
files joined in name order, after the core's frontmatter, rebuild the upstream
file byte for byte (test/py/test_slim_skills.py checks this against the hash in
OVERRIDE_BASES). The references do not store the frontmatter, so the core's
frontmatter must stay identical to upstream's.

The script checks every marker before it touches any file, then prints the
upstream sha256. After running it: review the upstream diff, update the core
SKILL.md (frontmatter included) to match, set the printed hash in
OVERRIDE_BASES (sync/sync_upstream.py), and run the sync.
"""

from __future__ import annotations

import argparse
import hashlib
import sys
from pathlib import Path

PKG = Path(__file__).resolve().parent.parent
PLUGIN_SUBDIR = Path("plugins/dev-team")
FRONTMATTER_OPEN = "---\n"
FRONTMATTER_CLOSE = "\n---\n"
VERBATIM_MARKER = "<!-- verbatim-below -->\n"
HEADER = (
    "<!-- {title}. Upstream text of skills/{skill}/SKILL.md, unchanged; the pi core SKILL.md "
    "summarizes it. Relative links below resolve from skills/{skill}/, not from references/. "
    "Everything below the marker is verbatim. -->\n" + VERBATIM_MARKER
)

# skill -> [(reference file, title, first line of the chunk in the upstream body)]; the first chunk starts at the
# body and has no marker. File names must sort in plan order, since rebuild() joins them in name order.
SPLITS: dict[str, list[tuple[str, str, str | None]]] = {
    "code-review": [
        ("00-overview.md", "overview, orchestrator constraints, arguments, progress tracking", None),
        ("01-target-files.md", "step 1 (target files, staging, sliced mode, documentation-only short-circuit), 1b, 1c", "## Steps\n"),
        ("02-gates-and-static-analysis.md", "step 2 (pre-flight gates) and 2b (static analysis pre-pass)", "### 2. Pre-flight gates\n"),
        ("03-enabled-agents.md", "step 3 (agent eligibility and the change-shape, change-size and diff-signal gates)", "### 3. Determine enabled agents\n"),
        ("04a-dispatch-waves.md", "step 4 (dispatch-capability gate and dispatch waves)", "### 4. Run each enabled agent\n"),
        ("04b-context-pack.md", "step 4 (optional shared context pack, opt-in only)", "**Optional: shared context pack"),
        ("04c-dispatch-payload-and-ledger.md", "step 4 (file scope, verdict ledger, scope marker, context payload, model, static-analysis context, output contract)", "- **File scope**"),
        ("04d-contract-validation-and-retry.md", "step 4 (contract validation, dispatch reconcile, retry and dispatch failures)", "**Dispatch failure handling"),
        ("05-aggregate.md", "step 5 (aggregation, ACCEPTED-RISKS, health scoring, round 1 record, consolidation)", "### 5. Aggregate results\n"),
        ("06-findings-and-fix-loop.md", "step 6 (findings prompt) and 6a (review-fix loop, round ledger, closing pass, exit conditions)", "### 6. Present findings and ask for direction\n"),
        ("07-report.md", "step 7 (report: --json and prose branches, durable report, --pdf)", "### 7. Generate report\n"),
        ("08-09-corrections-and-gate.md", "step 8 (correction prompts) and 9 (pre-commit gate file)", "### 8. Save correction prompts for remaining issues\n"),
    ],
}


def base_key(skill: str) -> str:
    """The OVERRIDE_BASES key that pins a slim skill's upstream text."""
    return f"skills/{skill}/SKILL.md"


def split_frontmatter(text: str) -> tuple[str, str]:
    """(frontmatter including both --- lines, body)."""
    if not text.startswith(FRONTMATTER_OPEN):
        raise ValueError("SKILL.md has no frontmatter")
    close = text.find(FRONTMATTER_CLOSE, len(FRONTMATTER_OPEN) - 1)  # - 1: an empty frontmatter closes at once
    if close < 0:
        raise ValueError("SKILL.md frontmatter is not closed")
    end = close + len(FRONTMATTER_CLOSE)
    return text[:end], text[end:]


def plan_chunks(plan: list[tuple[str, str, str | None]], body: str) -> list[tuple[str, str, str]]:
    """(file name, title, verbatim text) per reference file, in plan order."""
    names = [name for name, _title, _marker in plan]
    if names != sorted(set(names)):
        raise ValueError("reference file names must be unique and sort in plan order; rename them in SPLITS")
    if plan[0][2] is not None:
        raise ValueError(f"{plan[0][0]}: the first chunk starts at the body and takes no marker")
    starts = [0]
    for name, _title, marker in plan[1:]:
        if marker is None:
            raise ValueError(f"{name}: only the first chunk may omit its marker")
        found = body.count(marker)
        if found != 1:
            raise ValueError(f"{name}: marker {marker!r} found {found} times in the upstream text")
        index = body.index(marker)
        if index and body[index - 1] != "\n":
            raise ValueError(f"{name}: marker {marker!r} does not start a line")
        starts.append(index)
    if starts != sorted(starts):
        raise ValueError("markers are out of order; update SPLITS")
    ends = starts[1:] + [len(body)]
    return [(name, title, body[start:end]) for (name, title, _marker), start, end in zip(plan, starts, ends)]


def reference_files(skill: str, upstream_skill_md: str) -> dict[str, str]:
    _frontmatter, body = split_frontmatter(upstream_skill_md)
    return {name: HEADER.format(title=title, skill=skill) + text for name, title, text in plan_chunks(SPLITS[skill], body)}


def rebuild(frontmatter: str, references: dict[str, str]) -> str:
    """The upstream file, from a frontmatter and the reference files (joined in name order)."""
    return frontmatter + "".join(references[name].split(VERBATIM_MARKER, 1)[1] for name in sorted(references))


def write_references(skill: str, text: str, out: Path) -> dict[str, str]:
    """Write the reference files for `text` to `out` and remove stale ones; raises before writing on a bad split."""
    files = reference_files(skill, text)
    out.mkdir(parents=True, exist_ok=True)
    for stale in out.glob("*.md"):
        if stale.name not in files:
            stale.unlink()
    for name, content in files.items():
        (out / name).write_text(content, encoding="utf-8")
    return files


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("skill", choices=sorted(SPLITS))
    ap.add_argument("--upstream", required=True, help="checkout of bdfinst/agentic-dev-team")
    args = ap.parse_args()

    source = Path(args.upstream).resolve() / PLUGIN_SUBDIR / base_key(args.skill)
    out = PKG / "overrides" / "skills" / args.skill / "references"
    try:
        text = source.read_text(encoding="utf-8")
        files = write_references(args.skill, text, out)
    except (OSError, ValueError) as err:
        print(f"error: {err}", file=sys.stderr)
        return 1
    print(f"wrote {len(files)} reference files to {out.relative_to(PKG)}")
    print(f'OVERRIDE_BASES["{base_key(args.skill)}"] = "{hashlib.sha256(text.encode("utf-8")).hexdigest()}"')
    return 0


if __name__ == "__main__":
    sys.exit(main())
