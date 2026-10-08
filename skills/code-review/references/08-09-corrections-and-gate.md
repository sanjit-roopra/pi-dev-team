<!-- step 8 (correction prompts) and 9 (pre-commit gate file). Upstream text of skills/code-review/SKILL.md, unchanged; the pi core SKILL.md summarizes it. Everything below the marker is verbatim. -->
<!-- verbatim-below -->
### 8. Save correction prompts for remaining issues

**Skip this entire step if `--json` was set.** Step 7 already skips this step for `--json` mode; corrections are never written to disk in `--json` mode. (Step 9, unlike this step, is NOT skipped by `--json` — see that step's own condition.)

For issues NOT auto-fixed (confidence: none, auto-fix failed, or suggestions), generate one correction prompt per issue using the Correction prompt schema in [`output-format.md`](output-format.md#correction-prompt-json). Save to `./corrections/` **in the target repository's working directory** (the cwd `/code-review` was invoked in). Write all output artifacts only to these repo-relative paths — never prepend a scratchpad, sandbox, or session root, and never join two absolute paths. These can be addressed manually or via `/apply-fixes`.

### 9. Write pre-commit gate file

**This step is NOT skipped by `--json` (issue #1904 Bug 2b) — see step 7's own note.** It applies whenever the scope condition below holds, `--json` or not; step 7 only skips step **8** for `--json`.

**Dispatch failures block the gate (issue #1752).** If step 5's `dispatchFailures` list is non-empty — any agent that failed dispatch and then failed its single retry — do not write `.pr-review-passed`: `.pr-review-passed` must not be written while any dispatch failure is outstanding, regardless of the overall status computed from the agents that did return. The same rationale as step 3's `unreadable-registry` treatment: a lens that never ran is a coverage gap, not a passing result, so this condition is checked **before** the status check below, not folded into it. This prose rule now has a mechanical backstop (issue #1763, carried forward to the PR-time gate by #1886): `hooks/pre_pr_review.py`'s own `_dispatch_failure_verdict` independently vetoes the gate at `gh pr create` time when a `dispatch-failure` boundary event (emitted at Step 4, above) is on record for the current branch-diff content — so a bug or a future caller that skips this step's condition, or writes `.pr-review-passed` directly, still can't silently bypass it on this path. Two disclosed limits, neither exploitable today but both worth naming rather than silently assuming away (#1763 security review):

- The backstop is inert on [`sliced-mode.md`](sliced-mode.md)'s path: sliced mode auto-engages only on a full-repo scope with nothing staged, and never writes `.pr-review-passed` at all — it replaces this step entirely, report-only — so the backstop's inertness there holds unconditionally, regardless of what `branch_diff_gate_hash()` evaluates to for that scope.
- The backstop queries only the CURRENT branch-diff hash. A dispatch failure recorded against an earlier hash — e.g. one orphaned by a later commit landing on the same branch, or by step 6a's fix loop, before that step's own condition (above) is (mis)evaluated — is not queried here. `hooks/pre_pr_review.py` has no analogue of the retired cosmetic-delta carry-forward mechanism (deliberately dropped, per that module's own docstring) to union multiple hash bindings, so a branch-diff change since a real dispatch failure silently drops that failure's veto power until a fresh review re-emits it against the new hash.

**Scope condition, extended by issue #1904 Bug 2b.** If the review was auto-scoped to uncommitted changes **OR scoped via `--since <base>`** — and the overall status is `pass` or `warn` **and step 6a did not exit with actionable issues outstanding** — whether via the iteration limit or the "not converging" exit, both of which are escalations, per that step's Exit conditions table (regardless of whether those outstanding issues are only `warning`-severity — either escalation overrides `warn` for this condition specifically, since escalating and then writing a passing gate anyway would silently defeat the escalation) — write `.pr-review-passed` to `.claude/memory/` so `hooks/pre_pr_review.py` allows the next `gh pr create` (#1886). Use the **shared gate-hash helper**, in its `--branch-diff` mode, so the writer and the pre-PR hook compute the hash identically — it hashes the branch's diff against its base (`git diff <base>...HEAD`), not the staged patch, so a commit landed on the branch after this write invalidates the gate:

**Why `--since <base>` belongs here (closing the gap Bug 2b's premise names):** `/pr`'s only path to `gh pr create` (`skills/pr/SKILL.md` step 2.4) invokes `/code-review --since "$BASE" --json` — before this fix, this condition fired ONLY for auto-scoped uncommitted changes, so `.claude/memory/.pr-review-passed` was NEVER written on the one real path that opens a PR, making `PR_GATE_BYPASS_REASON` the only way to ever open one (the "gate that cannot fail is worse than no gate" anti-pattern named in this repo's own root `CLAUDE.md`). This also resolves the hash-timing-mismatch the auto-scope path still has (see the "Known limitation" note below): `/pr`'s step 1 requires a CLEAN working tree before invoking `--since`, so the hash computed here — AFTER those commits already landed — is computed against exactly the same content `hooks/pre_pr_review.py` recomputes at `gh pr create` time; there is no "staged while uncommitted" content this write could omit.

```bash
HASH=$(python3 "${CLAUDE_PLUGIN_ROOT}/hooks/lib/review_gate_hash.py" --branch-diff)
mkdir -p .claude/memory && printf '%s\n' "$HASH" > .claude/memory/.pr-review-passed
```

Single line, unlike the retired `.review-passed`'s two-line format —
`hooks/pre_pr_review.py`'s own `_stored_gate_hash()` reads only the first
line. There is no normalization-invariant second line here: the
cosmetic-delta carry-forward mechanism that line existed for (#1627) was
deliberately dropped for this gate (per `pre_pr_review.py`'s own docstring),
since it fires once, at PR-creation time, rather than at every commit — the
friction that mechanism relieved does not arise here.

**Known limitation, narrowed by issue #1904 Bug 2b (was #1886 follow-up).**
`agent_dispatch_ledger.py` stamps a dispatch's `subject_hash` with
`review_gate_hash()` (the staged `--cached` diff) whenever something IS
staged, but falls back to `branch_diff_gate_hash(default_base_ref(cwd),
cwd)` — the SAME content domain this step writes and
`hooks/pre_pr_review.py` checks — whenever nothing is staged (see that
hook's own module docstring for the fallback's rationale). For a `--since
<base>`-scoped review, nothing is EVER staged (`/pr`'s step 1 requires a
clean working tree first), so every dispatch during that review stamps the
branch-diff hash directly — the write above and every corroborating
dispatch now agree on one content domain for this mode, closing the gap for
the shape #1886 identified it in.

The residual gap that remains is narrower: on an **auto-scoped
uncommitted-changes** review with multiple separate review-and-commit
cycles on the same branch, a dispatch's staged-diff `subject_hash` and this
step's branch-diff hash are mathematically identical only in the common
single-commit-then-PR shape (a branch cut from its base, reviewed once
while staged, committed, then a PR opened immediately) — exactly as before.
On a branch with multiple such cycles, the branch-diff hash written here
will not match an EARLIER cycle's dispatch `subject_hash`, and
`hooks/pre_pr_review.py` correctly fails closed at `gh pr create` time,
requiring a fresh `/code-review` run against the branch's current diff (or
a `--since <base>`-scoped re-review, which now closes cleanly per the
paragraph above) before opening the PR.

**If `--agent <name>` was used** (a sanctioned single-agent review — it deliberately dispatches exactly 1 agent, which now clears the dispatch-ledger gate's `>= 1` distinct-dispatch floor on its own since #2147 lowered it from 2; the explicit exemption event below is consequently no longer load-bearing for this case, but is still written for an unambiguous, explicit audit trail rather than relying on the ordinary count path to imply "this was a sanctioned single-agent review" after the fact), record that as an explicit, auditable exemption event bound to this same hash **contemporaneously** with the write above — same pattern as the doc-only short-circuit's exemption event (step 1a):

```bash
python3 "${CLAUDE_PLUGIN_ROOT}/hooks/lib/boundary_events.py" --event single-agent --subject-hash "$HASH"
```

This step only runs when the review was auto-scoped to uncommitted changes or scoped via `--since <base>` (see the gate condition above). Do not `git add` a different file set, and do not recompute `$HASH` against different content, at this point: staging or hashing something other than what this run actually reviewed would write a gate hash unrelated to the review that produced it.

If overall status is `fail`, do **not** write the gate file — `hooks/pre_pr_review.py` will keep blocking `gh pr create` until issues are resolved and the review re-run.
