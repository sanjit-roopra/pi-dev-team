## pi port notes (read first)

- Write the title and body in the "GitHub text style" from the system prompt. The extension blocks a `gh pr create` whose title or body breaks it, once.
- If `.claude/memory/brief.json` exists and its `sessionId` is `$CLAUDE_SESSION_ID`, put its `text` right after the first sentence of the body. Then add `## Decide these`, one bullet each, for its `assuming` items when `approved` is `no answer`, and for spec Decision Log rows marked `assumed (timeout)`, `assumed (skipped)` or `assumed (no human)`. Remove the file once the PR exists.
- Body order: one sentence that says what changes and why, then `## Summary` (at most 3 bullets), then `## Test Plan`, then `## Quality Gate` with its results on one line (`Tests 42 passed · types clean · lint clean · review clean`).
- Put `## Decisions & Assumptions` and the four Evidence Bundle headers at the end, inside one `<details><summary>Decisions and evidence</summary>` block. Keep all of their content. Only the place changes.
- If the repository has `.github/PULL_REQUEST_TEMPLATE.md`, its sections come first and the same `<details>` block goes at the end.
- End the visible part with one next step for the reviewer, for example "Review: start at `src/auth.ts:42`."
- Before `gh pr create`, if `gh auth status` succeeds, file the run's `Skipped:` lines and the problems it noticed but did not fix as one issue (`gh issue create`, one bullet each with `file:line`, why and a suggested fix), then list it under **Residual risks** as `Follow-ups: #N`. Never ask. Skip this when there is nothing to file; if `gh` fails, say so in the report and go on.
