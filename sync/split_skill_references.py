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
OVERRIDE_BASES).

After running it: review the upstream diff, update the core SKILL.md to match,
set the new hash in OVERRIDE_BASES (sync/sync_upstream.py), and run the sync.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

PKG = Path(__file__).resolve().parent.parent
PLUGIN_SUBDIR = Path("plugins/dev-team")
VERBATIM_MARKER = "<!-- verbatim-below -->\n"
HEADER = (
    "<!-- {title}. Upstream text of skills/{skill}/SKILL.md, unchanged; the pi core SKILL.md "
    "summarizes it. Everything below the marker is verbatim. -->\n" + VERBATIM_MARKER
)

# skill -> [(reference file, title, first line of the chunk in the upstream body)]; the first chunk starts at the body.
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


def split_body(text: str) -> tuple[str, str]:
    """(frontmatter including both --- lines, body)."""
    if not text.startswith("---\n"):
        raise ValueError("SKILL.md has no frontmatter")
    end = text.index("\n---\n", 4) + len("\n---\n")
    return text[:end], text[end:]


def chunks(skill: str, body: str) -> list[tuple[str, str, str]]:
    """(file name, title, verbatim text) per reference file, in order."""
    plan = SPLITS[skill]
    starts = [0]
    for name, _title, marker in plan[1:]:
        assert marker is not None
        if body.count(marker) != 1:
            raise ValueError(f"{name}: marker {marker!r} found {body.count(marker)} times in the upstream text")
        index = body.index(marker)
        if index and body[index - 1] != "\n":
            raise ValueError(f"{name}: marker {marker!r} does not start a line")
        starts.append(index)
    if starts != sorted(starts):
        raise ValueError("markers are out of order; update SPLITS")
    ends = starts[1:] + [len(body)]
    return [(name, title, body[a:b]) for (name, title, _), a, b in zip(plan, starts, ends)]


def reference_files(skill: str, upstream_skill_md: str) -> dict[str, str]:
    _frontmatter, body = split_body(upstream_skill_md)
    return {name: HEADER.format(title=title, skill=skill) + text for name, title, text in chunks(skill, body)}


def rebuild(frontmatter: str, references: dict[str, str]) -> str:
    """The upstream file, from a frontmatter and the reference files (joined in name order)."""
    return frontmatter + "".join(references[name].split(VERBATIM_MARKER, 1)[1] for name in sorted(references))


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("skill", choices=sorted(SPLITS))
    ap.add_argument("--upstream", required=True, help="checkout of bdfinst/agentic-dev-team")
    args = ap.parse_args()

    source = Path(args.upstream).resolve() / PLUGIN_SUBDIR / "skills" / args.skill / "SKILL.md"
    text = source.read_text(encoding="utf-8")
    try:
        files = reference_files(args.skill, text)
    except ValueError as err:
        print(f"error: {err}", file=sys.stderr)
        return 1
    out = PKG / "overrides" / "skills" / args.skill / "references"
    out.mkdir(parents=True, exist_ok=True)
    for stale in out.glob("*.md"):
        if stale.name not in files:
            stale.unlink()
    for name, content in files.items():
        (out / name).write_text(content, encoding="utf-8")
    assert rebuild(split_body(text)[0], files) == text
    print(f"wrote {len(files)} reference files to {out.relative_to(PKG)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
