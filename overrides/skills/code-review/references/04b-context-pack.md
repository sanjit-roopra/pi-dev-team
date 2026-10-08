<!-- step 4 (optional shared context pack, opt-in only). Upstream text of skills/code-review/SKILL.md, unchanged; the pi core SKILL.md summarizes it. Everything below the marker is verbatim. -->
<!-- verbatim-below -->
**Optional: shared context pack (#2006, opt-in — off by default).** `scripts/review_context_pack.py` can prepare the panel's file context **once** — changed-file list, diff, and complete line-numbered file bodies — so each lens reads one prepared artifact instead of opening the same changed files itself.

**Do not use it unless the caller explicitly opts in** (`DEV_TEAM_REVIEW_CONTEXT_PACK=on`). The default dispatch path is the per-agent context payload described below, unchanged.

Why it is off by default: [ADR 0034](../../../../docs/adr/0034-do-not-build-shared-context-pre-pass-for-duplicate-full-file-reads-1611.md) declined exactly this pre-pass after measuring duplicate full-file reads at **0.38%–4.86% of a round's total input spend, median 0.8%** (#1618). A later re-measurement with the same tool (`scripts/measure_full_file_duplication.py`) put it at **0.22%**. The 4.31x figure sometimes quoted for this is a *read-volume ratio*, not a share of spend — a different denominator, and not the one this decision turns on. The pack ships full file bodies rather than the structural skeleton ADR 0034 warned would degrade line-level lenses, so it carries no known quality risk; it simply has not been shown to pay for itself. #2024 tracks measuring panels of >= 8 agents, which is the shape that could change the answer.

When opted in:

```bash
git -c core.quotePath=false diff --name-status <base> \
  | sh "$CLAUDE_PLUGIN_ROOT/hooks/py.sh" "$CLAUDE_PLUGIN_ROOT/skills/code-review/scripts/review_context_pack.py" \
      --name-status-from - --base <base>
```

Prints a manifest naming the pack path, its byte size, and `files_omitted`. Pass the pack path to each dispatched agent, and observe both rules:

- **The pack narrows repeated reads, not the review.** A lens may still open anything not in the pack — a caller in an unchanged file, a sibling module. Never instruct an agent to treat the pack as the complete world.
- **`files_omitted` is not optional to relay.** When the manifest reports omissions (a file over the per-file cap, a binary, a body that would exhaust the budget), name those paths in each agent's prompt and tell it to open them directly. The pack body says so too, but a silently skipped file is a coverage hole that reads as a clean review.

