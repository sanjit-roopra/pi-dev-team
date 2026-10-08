<!-- step 5 (aggregation, ACCEPTED-RISKS, health scoring, round 1 record, consolidation). Upstream text of skills/code-review/SKILL.md, unchanged; the pi core SKILL.md summarizes it. Relative links below resolve from skills/code-review/, not from references/. Everything below the marker is verbatim. -->
<!-- verbatim-below -->
### 5. Aggregate results

**Fold in dispatch failures first (issue #1752).** Before scoring or suppression, add every step 4 `dispatchFailures` entry (agents that failed dispatch, then failed their single retry) to the aggregation. They are not agent results — they carry no `issues[]` and never enter ACCEPTED-RISKS suppression or health scoring — but they are never dropped either: carry the full `dispatchFailures` list through to the report (step 7) and the `--json` object (`output-format.md`) unchanged, and remember it for step 9's gate condition.

**A non-empty `dispatchFailures` forces `overall: "fail"`, unconditionally (issue #1752).** This is not the same rule as step 9's gate-blocking condition below — it belongs here, in the aggregate itself, because step 9 (and its gate) is **skipped entirely under `--json`** (step 7), while `overall` is the one field every `--json` caller reads. `/pr --json` (the sole such caller) checks only `overall`/`status` before proceeding to open a PR; without this rule here, a lens that failed dispatch twice could sit invisibly behind an `overall: "pass"` computed only from the agents that did return, and `/pr` would open the PR anyway — the exact silent-coverage-gap failure mode #1752 exists to close, just reached through a different caller than the interactive gate. Apply this override after health scoring computes what `overall` would otherwise be, so it always wins regardless of the per-agent severity mix.

**Fold in ledger skips the same way (#2167).** Carry step 4's `verdict_scope.py` `skipped` map through to the report and the `--json` object as `ledgerSkipped` (`output-format.md`), unchanged and never dropped, even when it is every agent in the roster. Unlike `dispatchFailures`, a ledger skip does **not** force `overall` toward `fail`/`warn` — it means a lens already reached `pass` on this exact content, not that it never ran — so score `overall` from the agents that actually dispatched this round exactly as if the ledger-skipped ones were absent from the roster entirely (never absent from the *report*, only from the score). A roster that is ENTIRELY ledger-skipped therefore reports `overall: "pass"` with zero `agents[]` entries and a non-empty `ledgerSkipped` — the report and summary text must say so explicitly (see step 4's "report loudly" rule) so that state is never mistaken for an empty, broken, or unreviewed run.

#### 5a. Apply ACCEPTED-RISKS.md

If `ACCEPTED-RISKS.md` exists at the repo root, parse its `rules:` YAML frontmatter per `knowledge/accepted-risks-schema.md`. For each finding, check rules in declaration order; the first match suppresses and emits one audit entry:

```
SUPPRESSED: <file>:<line> [<rule_id>] by ACCEPTED-RISKS rule <rule.id>
```

- Expired rules become inert: stop suppressing, emit a WARN naming the rule and owner, list in an Expiry Report section.
- Rules with `broad: true` (wildcard `rule_id` or multi-file globs) emit an informational notice for auditor attention.
- Schema-invalid rules fail the run with a parse error naming the rule id.

Suppressed findings are removed from scoring, listed under "Suppressed by ACCEPTED-RISKS" in the report (grouped by rule id), and bypass the fix loop.

#### 5b. Health scoring

Read `knowledge/review-rubric.md` for the formula. Compute the overall health score; security failures auto-escalate to 🔴.

Classify each issue by actionability:

| Severity | Confidence | Actionable? |
| --- | --- | --- |
| error or warning | high or medium | **Yes** — auto-apply |
| error or warning | none | No — report only (human judgment) |
| suggestion | any | No — report only |

**Actionable issues** drive the fix loop.

#### 5b-i. Record round 1 (#1624)

The initial panel is **round 1**. Append its row to
`.claude/metrics/review-value.jsonl` now, before any fix is applied — this
stream is what makes #1623's "is this churn or value?" question answerable at
all, and a row written only on the happy path would bias every derived metric:

> **Reading this stream later.** `scripts/review_value_coverage.py` reconciles
> these rows against `agent_dispatch_ledger`'s deterministic dispatch records
> and rules on whether the sample can support a per-lens pruning decision
> (`no-data` / `unverifiable` / `undercollected` / `insufficient` / `biased` /
> `usable`). Both writers of this stream are triggered by agent instruction
> rather than by mechanism, so rows skew toward rounds that found something
> (#2019). `/harness-audit` step 4 consults it before citing any per-lens
> value; nothing in this skill needs to run it.

```bash
python3 "$CLAUDE_PLUGIN_ROOT/skills/code-review/scripts/review_round_log.py" \
  --round 1 --agents "<comma-separated agents dispatched>" \
  --findings <path-to-this-round's-findings.json> \
  --purpose discovery --outcome "<fixed|no-op|escalated>"
```

Round 1 never passes `--fix-diff`: it has no preceding fix, so its
`fix_provenance_new` is `0` by definition. The script writes counts, agent
names, and enum values only — never file paths, code, or finding text.
Full schema: `knowledge/telemetry-schema.md` § `review-value.jsonl`.

Every later round records itself the same way from step 6a — see that step's
"Record each round" item for the `--fix-diff` argument that turns
`fix_provenance_new` into the "the previous fix introduced this" signal.

#### 5c. Consolidate cross-agent findings

When multiple agents flag the same `file:line`, emit one `topFindings` entry: `severity` = the single **highest** enum for that finding, `agents` = an array of the reporting agents (e.g. `["structure-review", "correctness-review"]`). Never pack multiple values into `severity` or any agent scalar — no slash- or comma-joined strings. Every scalar field stays single-valued; multi-agent attribution lives only in the `agents: []` array. Schema: [`output-format.md`](output-format.md#aggregated-json-result---json-flag).

**Dedup across agents, not just across identical lines — prose only, never the `topFindings` array itself.** The `topFindings` JSON array keeps the existing exact `file:line` dedup key unchanged — one entry per distinct `file:line`, matching `output-format.md`'s contract and `scripts/consolidate.py`'s sliced-mode dedup key. The instruction below governs only how findings are *described in the human-facing prose summary/report*: when writing that prose, collapse any two findings — from different agents, even at slightly different lines — that describe the same underlying defect into a single description; do not restate the same defect twice in prose just because two agents (or two nearby lines) reported it.

**Condensation cap.** Condense each surviving finding to ≤ 3 lines per finding before final synthesis output — the essential defect description and fix, not each agent's full reasoning. Applies only to the human-facing summary/report; `topFindings` entries keep their full `message`/`suggestedFix` text unchanged.

