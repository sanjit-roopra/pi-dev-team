<!-- step 2 (pre-flight gates) and 2b (static analysis pre-pass). Upstream text of skills/code-review/SKILL.md, unchanged; the pi core SKILL.md summarizes it. Everything below the marker is verbatim. -->
<!-- verbatim-below -->
### 2. Pre-flight gates

Skip entirely if `--background`. If `--force` without `--reason`, halt:

```
ERROR: --force requires --reason "<justification>".
```

If `--force` with `--reason`, append an entry to `.claude/metrics/override-audit.jsonl` per the schema in [`output-format.md`](output-format.md#override-audit-log-entry-step-2---force-path), then proceed to step 3.

Otherwise run these in sequence (stop on first failure):

1. **Lint**: `npx eslint` (or project lint command) on target files.
2. **Type check**: `npx tsc --noEmit` if `tsconfig.json` exists.
3. **Secret scan** (#1977). Prefer the purpose-built scanner when it is installed, and keep the grep as the zero-dependency fallback — this gate is the one place a committed credential must hard-stop the review, and it was checking a single regex while a real secrets scanner already ran one step later in the pre-pass:
   - If `command -v gitleaks` succeeds, run it with the **canonical invocation** in [`skills/static-analysis-integration/references/tool-configs.md`](../static-analysis-integration/references/tool-configs.md) § gitleaks — one documented command, not a variant of it (`--no-verify` is what keeps it fully offline). Any finding on a target file → **fail the gate**. Report the rule id and `file:line` only; **never echo the matched secret value** into the report or transcript. Record that gitleaks ran, and **do not run it again in step 2b** — same "do not run Semgrep twice" rule.
   - Otherwise (gitleaks absent): grep target files for the runnable pattern in [`knowledge/owasp-detection.md`](../../knowledge/owasp-detection.md) § Hardcoded-key pattern (the fenced code block, not the table row — table cells escape `|` as `\|`, a literal pipe rather than alternation). Note in the report that the fallback ran, so a reader can tell "no secrets found by gitleaks" apart from "no secrets found by one regex".
4. **Semgrep SAST**: `semgrep scan --config auto --quiet --json` on target files if installed. ERROR-severity → fail. WARNING-severity → continue, include in report. Save findings for security-review context.
5. **Pipeline-red check**: `gh run list --branch $(git branch --show-current) --limit 1 --json conclusion -q '.[0].conclusion'` if `gh` is available. If the last CI run failed, warn: "Pipeline is red. Fix CI before adding new code. Use `--force` to override."

Skip any gate silently if its tool is unavailable.

### 2b. Static analysis pre-pass

Skip if `--no-static-analysis` or `--background`.

Follow the detection, execution, and deduplication procedure in [`skills/static-analysis-integration/SKILL.md`](../static-analysis-integration/SKILL.md). Output is structured findings injected into agent context in step 4. **This step does not gate execution** — it collects context only.

**Growing this registry is a rule, not a discretion (#1981).** When any review agent reports the same mechanically-checkable finding class for the **second** time, and the check is expressible as a deterministic script, it becomes a `CHECKS` entry in `scripts/repo_invariants.py` **in the same PR that fixes the finding**. Two occurrences make it a class; converting there turns an unbounded stream of re-derivations into one bounded conversion. The root `CLAUDE.md` Working Rules state the same rule — it applies to this repo's own development, and the mechanism ships for downstream projects to use the same way.

**Repo-specific invariant pre-pass (#1608).** Also run:

```bash
python3 "$CLAUDE_PLUGIN_ROOT/skills/code-review/scripts/repo_invariants.py" --files <target files>
```

It checks a small, growable list of this repo's own "every X should have
exactly one corresponding Y" invariants — mechanically checkable facts a full
agent panel would otherwise re-derive independently, once per agent, every
round. Its `findings` array merges into step 4's static-analysis context using
the same envelope and the same "detected by static analysis — do not
re-report, focus on semantic concerns" framing. Expand `CHECKS` in that script
as more rediscovered-N-times cases turn up; this step never needs to change to
pick up a new check.

**Internal-collaborator-doubling pre-pass (#2130).** Also run:

```bash
python3 "$CLAUDE_PLUGIN_ROOT/skills/test-design/scripts/internal_double_detector.py" . --files <target files> --json
```

Detects an unwaived (or malformed/invalid-blocker-waiver) double of a
project first-party collaborator, per
`${CLAUDE_PLUGIN_ROOT}/knowledge/internal-collaborator-doubling.md`. Same
`<target files>` list as the `repo_invariants.py` block above — one
scoping mechanism for both tools in this step, not two. Its `findings`
array merges into step 4's static-analysis context using the same envelope
and the same "detected by static analysis — do not re-report, focus on
semantic concerns" framing. This step does not gate on the finding — it
collects context only, exactly like every other check in this step; the
actual gate is the `hooks/internal_double_gate.py` PreToolUse hook plus
the required `"Plugin content & hooks"` CI check (#2128). `test-review` and
`test-smell-review` cite this pre-pass's finding rather than re-deriving
it when it's present (see
`${CLAUDE_PLUGIN_ROOT}/knowledge/test-review-division-of-labor.md`).

**Test-review mechanical pre-phase (#2169).** Also run, for each test file in `<target files>`:

```bash
python3 "$CLAUDE_PLUGIN_ROOT/scripts/test_review_mechanics.py" . <file>
```

Only relevant when `test-review` is in the dispatched lens set for this
round; skip entirely otherwise. Unlike the two pre-passes above, this one
runs **once per file** rather than once over the whole `<target files>`
list, because `test-review.md`'s own Phase 0 (`agents/test-review.md` →
Protocol) needs each file's own `mechanicalFail`/findings result supplied as
that file's context — the agent has no `Bash` tool and never runs this
script itself. Keep the per-file results keyed by file path when assembling
step 4's context so each file's `test-review` dispatch gets its own result,
not the whole batch's. Pass each result to `test-review` as its Phase 0
input using `agents/test-review.md`'s own framing ("detected by static
analysis, do not re-derive" — the agent still reports it as this file's own
finding when `mechanicalFail` is true, per that file's Phase 0 bullets) —
**not** the generic "detected by static analysis — do not re-report, focus
on semantic concerns" envelope the two pre-passes above use for every other
agent. That generic framing is correct for `repo_invariants.py`/
`internal_double_detector.py`'s findings, which every dispatched agent
receives as already-covered context to fold silently into a semantic
review; it would be wrong here, since `test-review` is this pre-pass's
sole intended reporter, not one of several agents absorbing someone else's
finding.

**Pass `--files` (#1629).** Several checks are scoped to the changeset,
because the conventions they enforce are "required going forward, do not
retrofit" (`evals/README.md`'s `_calibration` rule is the motivating case).
Without `--files` those checks stay silent rather than reporting the ~150
pre-existing findings the conventions explicitly do not require fixing. The
`--all` flag exists for deliberate backlog triage and must **not** be used
here.

**Authoring-time ordering (#1629).** When *writing* fixtures or agent files,
run this same command at edit time, before the first panel dispatches — same
command, earlier. Of #1619's 8 follow-up rounds, at least 4 were triggered by
defect classes these deterministic checks catch, plus factually wrong
runtime-semantics claims that `evals/README.md`'s **executable-claims
convention** requires verifying by execution at authoring time. A claim the
author has already run is a claim the panel reviews as evidence rather than
adjudicates from scratch.

If Semgrep already ran in the pre-flight gate, reuse those findings. Do not run Semgrep twice.

