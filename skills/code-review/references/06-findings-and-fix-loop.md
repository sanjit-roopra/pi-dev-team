<!-- step 6 (findings prompt) and 6a (review-fix loop, round ledger, closing pass, exit conditions). Upstream text of skills/code-review/SKILL.md, unchanged; the pi core SKILL.md summarizes it. Everything below the marker is verbatim. -->
<!-- verbatim-below -->
### 6. Present findings and ask for direction

If zero actionable issues, skip to step 7.

Otherwise present the Review Findings prompt (template: [`output-format.md`](output-format.md#review-findings-prompt-interactive--step-6)) and ask: **"Fix these issues automatically, or save as report only?"**

- "Fix" / "apply" / "yes" → step 6a
- "Report" / "no" / "don't fix" → step 7 (no code modified)

**Exception — non-interactive mode**: skip this prompt when the run is non-interactive.

- (a) If `--json` (or `--yes`), **default to report only** — proceed to step 7 and emit the aggregated JSON; **never modify code** without an explicit caller opt-in. `--json` is contractually non-interactive (CI-safe): it never blocks on this prompt.
- (b) If running inside `/build`, `/pr`, or `/test-improve`, proceed to the fix loop. The caller owns the human gate (the orchestrator's Phase 3 approval for `/build`; the pre-PR confirmation for `/pr`; for `/test-improve`, the Phase 3 Story-set approval gating entry to Phase 4 and the `[r]evise/[w]aive/[q]uit` prompt raised after 2 failed iterations of its own end-of-phase review loop — see `../test-improve/SKILL.md`'s Phase 4/5 "End-of-phase review loop" sections).

### 6a. Review-fix loop

```
iteration = 1
MAX_ITERATIONS = 5

while actionable_issues > 0 AND iteration ≤ MAX_ITERATIONS:
    1. Apply fixes for all actionable issues (file-by-file, top-to-bottom by line)
    2. After each iteration's fixes, run the project's test suite.
       If tests fail, revert the last fix that broke them and mark the
       issue [auto-fix failed — human review required].
    3. **When the review was auto-scoped to uncommitted changes**, stage the
       fixes just applied (`git add` the modified files) — an Edit/Write only
       touches the working tree, it does not change `git diff --cached`, so
       without this the fixes would never reach the eventual commit (#1461
       security re-review: an earlier draft's step 1 claimed a working-tree
       edit "naturally" changes the staged hash — false for
       `sha256(git diff --cached)`, and it silently dropped every fix-loop
       iteration's output from the final commit). For `--path`/`--all`
       scopes, leave the index untouched — no gate is ever written for those
       scopes, so staging here would only mutate the operator's index
       unasked, for no corroboration benefit. **`--since <base>` also writes
       a gate file (issue #1904 Bug 2b — no longer "the only scope", per step
       9's own extended condition), but has no staging concept to mirror
       here at all**: its content is already-committed history
       (`base...HEAD`), so a fix applied mid-loop would need a fresh COMMIT,
       not a `git add`, to change what the eventual `--branch-diff` hash
       covers — a disclosed gap in this loop's mechanics for that scope, not
       fixed here; the closing pass below stays scoped to the auto-scope
       staging model for the same reason.
    3b. **Deterministic-first triage (#1610) — language-agnostic, not
       Python-specific.** Before re-dispatching an agent to re-verify a fix,
       check whether the fix already qualifies for a cheaper, deterministic
       close: (a) it is a pure rename/mechanical edit (docstring correction,
       import fix, identifier rename), (b) **whichever language-appropriate
       lint/type-check tool(s) step 2b's static-analysis pre-pass already
       detected and ran for this repo** — Tier 1 in
       `skills/static-analysis-integration/references/tool-configs.md`
       (semgrep + ruff/mypy for Python, pmd for Java/Kotlin, ESLint/tsc for
       JS/TS, `dotnet format`/`dotnet build` for C#, gofmt/`go vet` for Go,
       etc. — whatever the target project's own stack is, never assume
       Python) — plus the full test suite already ran clean in step 2, and
       (c) the specific claim needing verification is itself checkable by a
       targeted `grep`/diff (e.g. "every occurrence was renamed, no
       partial/mangled identifiers", "the removed import has no remaining
       references"). When all three hold, run that deterministic check now
       and mark the issue resolved on a pass — do not spend a re-dispatch
       confirming what the language's own lint/test/grep tooling already
       proved. Escalate to the normal per-agent re-dispatch (step 4) whenever
       any condition fails to hold, or the check itself can't fully close the
       question (e.g. judging whether a restored docstring's *prose* is
       accurate needs semantic reading, not a grep). This is a triage habit,
       not a gate: it only ever *removes* work from step 4, never adds new
       issues or skips a fix that genuinely needs judgment. The same triage
       applies to ad-hoc fix-verification inside `/build`'s inline review
       checkpoints (`../build/SKILL.md` sub-steps 4/6) — one shared habit,
       not a duplicated checklist.
    4. Re-run only the agents whose remaining actionable issues were not
       already closed by step 3b's deterministic triage, **in verification
       mode** (#1628) — pass the finding, the fix diff hunks ± ~20 lines,
       and the agent's lens definition, NOT the full target file set, and
       grant the mandatory `insufficient-context` escape. Resolve each
       agent's verification tier with `python3
       "$CLAUDE_PLUGIN_ROOT/scripts/verify_tier.py" --agent <name>`. Full
       contract: [`knowledge/verification-mode.md`](../../knowledge/verification-mode.md).
       Carry forward statuses of agents that passed.
    5. Re-aggregate. Reclassify remaining issues.
    5a. **Classify the round against the ledger (#1625).** Run the round
       ledger (below). It decides new-vs-carried by finding signature and
       returns `terminate`/`reason` — honor it: `converged` and `round-cap`
       both leave this loop.
    5b. **Record this round (#1624).** Append one row per re-dispatch round
       to `.claude/metrics/review-value.jsonl`, passing THIS iteration's fix
       diff so `fix_provenance_new` can be computed (see below).
    6. iteration += 1

if iteration > MAX_ITERATIONS AND actionable_issues > 0:
    escalate to human with remaining issues
```

**Round ledger and termination rules (#1625).** The loop above has an
iteration cap but, on its own, no notion of finding *identity* across rounds
— so nothing detects "this round found only residue from the last fix" or
"we are churning". Classify every round's findings with the shared helper:

```bash
# RUN_ID identifies this changeset; the ledger is discarded if it belongs to
# a different one. Any stable digest of the target set works.
RUN_ID=$(printf '%s\n' <target files> | sort | sha256sum | cut -c1-16)
python3 "$CLAUDE_PLUGIN_ROOT/skills/code-review/scripts/finding_signature.py" \
  --round <N> --findings <this-round's-findings.json> \
  --run-id "$RUN_ID" \
  --state .claude/memory/review-round-state.json
```

It prints `{"round", "new", "carried", "actionable_new", "ledger_reset",
"terminate", "reason"}` and maintains the durable ledger at
`.claude/memory/review-round-state.json`, so `/continue` can resume a review
mid-loop and step 6a's `--carried` count for #1624 comes from the same
source rather than being re-derived from memory.

**Ledger lifecycle — the ledger must never leak across runs.** Reusing a
ledger built for a different changeset would misclassify a genuinely new
finding as "carried" (silently skipping a round that should have run) and
inflate the round counter toward the cap on unrelated history. Four reset
triggers, in precedence order, all handled by the script:

| Trigger | When |
| --- | --- |
| `--reset` | Explicit, caller-forced |
| Round 1 | The initial panel **is** the start of a new run by definition. `/code-review` always calls round 1 first, so an abandoned ledger can never leak into the next review — no caller bookkeeping needed |
| `run-id-mismatch` | The stored ledger was built for different target files. Catches a resume that legitimately starts at round ≥ 2 against a different changeset |
| `stale-state` | The run started more than 24h ago — abandoned residue |

This ledger covers rounds *within* one `/code-review` invocation only — a
caller that re-invokes `/code-review` across separate command runs is the
place that scopes those *separate* invocations to the fix-diff instead of
restarting at round 1 every time. `/pr`'s own gate-retry loop
(`../pr/SKILL.md` step 2) is that caller today.

Reported as `ledger_reset` on every call (`null` when a stored ledger was
legitimately resumed). The script fails **toward** a reset: an unreadable or
malformed state file starts fresh. Starting fresh costs at most one extra
round; reusing a wrong ledger silently skips one. A finding's signature is
`(agent, file, category, normalized message)` with the line compared at
±3 rather than hashed — see the script's own docstring for why the line is
deliberately outside the hash.

Three termination rules, evaluated at each round boundary, **first match
wins** — the helper implements all three, this text is the contract:

| Rule | Trigger | Effect |
| --- | --- | --- |
| **Hard round cap** | `round >= 4` (initial panel + 3) | Escalate to human, attaching the round ledger as evidence — which rounds found what, with fix provenance. Same posture as the existing `MAX_ITERATIONS` escalation, and step 9 treats it the same way (no gate write). Applied to #1619's case study, this alone would have surfaced the churn at round 4 instead of round 9. |
| **Severity floor** (rounds ≥ 2) | No *new-signature* finding is `error`/`warning` at `high`/`medium` confidence | Converged — leave the loop. Suggestion-tier and low-confidence findings from round ≥ 2 still go to `corrections/` and the report: **logged, never chased.** Round 1 is unaffected — its actionability is step 5b's table, not this floor. |
| **Loop-until-dry** | A round produces zero new-signature findings clearing the floor | Converged. Carried signatures that survived a fix attempt are already covered by the existing "same issues persist → escalate" exit; they are not a reason to keep going here. |

The same three rules govern `/build`'s inline checkpoint fix loops
(`../build/SKILL.md` sub-steps 4/6) — one shared statement, one shared
implementation, not a duplicated table.

**Record each round (#1624).** The initial panel was round 1 (step 5b-i);
each fix-loop iteration's re-dispatch set is one further round. Capture the
iteration's fix diff **before** re-staging (item 3) so the row can attribute
this round's new findings to the previous round's fix:

```bash
# Item 1 applied fixes; capture them as a diff, then (item 3) `git add` them.
git -c diff.relative=false diff --no-color > "$FIX_DIFF"
# …after item 5's re-aggregation:
python3 "$CLAUDE_PLUGIN_ROOT/skills/code-review/scripts/review_round_log.py" \
  --round <N> --agents "<agents re-dispatched this round>" \
  --findings <this-round's-NEW-findings.json> \
  --carried <count of findings carried over from the prior round> \
  --purpose "<discovery|verification|closing>" \
  --outcome "<fixed|no-op|escalated>" \
  --fix-diff "$FIX_DIFF"
```

`fix_provenance_new` — how many of this round's new findings land inside the
line ranges the previous round's fix touched — is the judgment-free "the fix
introduced it" signal #1623 asks for. It is interval math over the diff, not
an LLM call: a round whose new error/warning findings **all** carry
provenance is churn by construction. `--purpose` distinguishes a discovery
panel from a fix-verification re-dispatch and from the gate-closing pass, so
per-agent cost can be split by purpose rather than lumped into one dispatch
count. Derived metrics (churn ratio, per-agent discovery-vs-verification
split, gate recidivism) are computed by `/harness-audit` — see its Step 4a.

**Closing pass — re-establishing dispatch-ledger corroboration after the loop (#1461, narrowed by #1626, floor lowered to 1 by #2147; auto-scope only — same condition as item 3 above).** Step 3's `git add` changes the staged content's hash, so `agent_dispatch_ledger.py` stamps each iteration's re-dispatched agents (step 4) with that NEW hash — not step 4 (the outer, pre-loop)'s original dispatch hash, and not an earlier iteration's hash either. Step 9's gate write needs **>= 1 distinct dispatch whose `subject_hash` equals the FINAL staged content's hash** (the one actually committed). Since floor 1 is normally satisfied by construction (the loop only re-stages when it applied at least one fix, and that fixer re-dispatches against the final content in the same iteration), the closing pass below degenerates to "just the fixer(s), self-verifying" in the common case — it still exists, unconditionally, for the cases that don't already clear the floor on their own: the escape hatch (scope grew mid-loop) and a `fixed_by_agents` set that ends up empty despite a loop iteration having run.

This used to be satisfied by re-dispatching the **full** original panel, which made a one-line fix cost an 18-agent round. **Unconditionally, after any loop iteration ran** (i.e. any fix was applied and re-staged) — not only when the count looks short, since that count isn't something to reason about from memory — run a **closing pass** instead. Compose it deterministically, don't pick the set by hand:

```bash
python3 "$CLAUDE_PLUGIN_ROOT/skills/code-review/scripts/closing_pass.py" \
  --fixed-by "<agents whose findings were fixed during the loop>" \
  --roster "@<select_lenses.py output>" --panel "<the round-1 panel>" \
  --panel-files "<files the round-1 panel targeted>" \
  --fix-delta-files "<files the cumulative fix touched>"
```

It prints `{"agents", "scope", "escape_hatch", "reason", "topped_up"}`. Dispatch exactly the `agents` it returns, and record them with `dispatch_purpose: "closing"` (#1624) so the cost effect is measurable.

- **Composition**: every agent whose findings were fixed during the loop (each verifies its own fixes at the final hash), plus — only if that set has fewer than 1 distinct agent — a cheap-first top-up from the resolver's eligible roster until 1 distinct registered agent has dispatched at the final hash.
- **Why this is sound**: 1 is `pre_pr_review.py`'s `_MIN_DISTINCT_DISPATCHES` (#2147; lowered from 2), so the gate's corroboration floor is satisfied **by construction** — no hook change, no exemption event, no ledger change. The threat model #1461 closed (self-certification without dispatch) is untouched: these are genuine dispatches carrying real review authority over the only content that changed since full-panel coverage. A drift test pins the script's constant to the hook's, so raising the gate's floor can never silently under-compose this pass.
- **Scope**: the closing pass reviews the **cumulative fix delta** — the diff between what the round-1 panel reviewed and the final staged content — with the round ledger's fixed findings as context. Not the whole changeset: the panel's round-1 coverage of unchanged content is still valid; only the fix delta is unreviewed.
- **Escape hatch**: when the fix delta touches files outside the original panel's target set (scope grew mid-loop), the script returns `escape_hatch: true` and `scope: "full-changeset"` — fall back to the full re-dispatch. This is a set comparison of two file lists, not a judgment call.

**This pass is a real review, not a rubber stamp**: closing-pass agents keep full authority. If any reports an actionable issue, treat it exactly like any other iteration — re-enter this loop (subject to `MAX_ITERATIONS` and #1625's round cap) rather than proceeding to step 7. What #1626 changed is only *how many* agents re-read *how much* content; never whether their findings count. If the iteration limit or the round cap is reached with issues still outstanding, follow the existing "escalate to human" exit condition below — step 9's gate-write condition explicitly excludes this case (treat it as if overall status were `fail` for that one purpose, even if every outstanding issue is only `warning`-severity), so an escalation is never silently overridden by a passing gate write. A corroboration pass whose findings carry no consequence would be exactly the "dispatch trivial calls purely to clear the gate" abuse `pre_commit_review.py`'s own module docstring names as the residual risk this mechanism does NOT protect against.

**Exit conditions**:

| Condition | Action |
| --- | --- |
| Zero actionable issues | Exit → step 7 |
| Round ledger returns `converged` (#1625) | Exit → step 7. A clean convergence, not an escalation: no new-signature finding cleared the severity floor, so step 9's gate write proceeds normally |
| Round ledger returns `round-cap` (#1625) | Exit → escalate with the round ledger attached. Treated exactly like the iteration-limit row below for step 9's gate-write condition |
| Iteration limit (5) | Exit → escalate (#1461: step 9 treats this as `fail` for its gate-write condition, even if remaining issues are only `warning`-severity) |
| Same issues persist | Exit → escalate — not converging (same #1461 step 9 treatment as the iteration-limit row: this is also an escalation with actionable issues outstanding, not a quiet exit) |
| Tests fail after fix and revert | Mark issue human-required; continue |

The round cap (4) binds before `MAX_ITERATIONS` (5) in practice: the cap
counts total dispatch rounds including the initial panel, the iteration
limit counts fix-loop passes only. Both remain — the cap is the churn
control, the iteration limit the original backstop.

**Record the escalation state for step 7, not only step 9 (issue #1880).**
Whichever exit condition above was hit — `round-cap`, iteration limit, or
"same issues persist" — is an **escalation**; `converged` (including the
zero-actionable-issues and round-ledger-`converged` rows) is not. Carry that
boolean (escalated vs. converged) forward out of this loop: step 9 already
consults it for the `.pr-review-passed` gate-write condition, and step 7 now
also consults it — under `--json`, where step 9 never runs at all — to force
`overall: "fail"` in the emitted JSON object per the parallel rule in
[`output-format.md`](output-format.md#aggregated-json-result---json-flag).
Without carrying this state to step 7, an escalated review with only
warning-severity issues remaining would emit `overall: "warn"` in `--json`
mode and a caller like `/pr`'s internal `--json` call would never see the
escalation.

Track each iteration for the report — template in [`output-format.md`](output-format.md#review-fix-loop-iteration-log-step-6a-iv).

