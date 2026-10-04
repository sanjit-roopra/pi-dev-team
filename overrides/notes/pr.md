## pi port notes (read first)

- Write the title and body in the "GitHub text style" from the system prompt. The extension blocks a `gh pr create` whose title or body breaks it, once.
- Body order: one sentence that says what changes and why, then `## Summary` (at most 3 bullets), then `## Test Plan`, then `## Quality Gate` with its results on one line (`Tests 42 passed · types clean · lint clean · review clean`).
- Put `## Decisions & Assumptions` and the four Evidence Bundle headers at the end, inside one `<details><summary>Decisions and evidence</summary>` block. Keep all of their content. Only the place changes.
- If the repository has `.github/PULL_REQUEST_TEMPLATE.md`, its sections come first and the same `<details>` block goes at the end.
- End the visible part with one next step for the reviewer, for example "Review: start at `src/auth.ts:42`."
