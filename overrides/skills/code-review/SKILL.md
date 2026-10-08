---
name: code-review
description: >-
  Run all enabled review agents against target files. Use this whenever the
  user asks for a code review, wants feedback on their code, says "review my
  code", "check this before I PR", "what's wrong with this", "run the
  agents", or has just finished implementing a feature. Use proactively
  before commits and pull requests.
argument-hint: >-
  [--agent <name>] [--since <ref>] [--path <dir>] [--all] [--json]
  [--expand <finding-id>|all]
  [--internal] [--force --reason "<text>"]
  [--static-analysis|--no-static-analysis] [--init-risks] [--background]
  [--pdf]
user-invocable: true
allowed-tools: >-
  Read, Write, Edit, Grep, Glob, AskUserQuestion, Agent,
  Bash(git diff *), Bash(npx *), Bash(npm run *),
  Bash(pnpm *), Bash(yarn *), Bash(tsc *), Bash(eslint *),
  Bash(git log *), Bash(gh run *), Bash(semgrep *),
  Bash(gitleaks *), Bash(lizard *), Bash(jscpd *),
  Bash(ruff *), Bash(mypy *), Skill(review-agent *)
---

# Code Review

**The review-agent panel is the primary quality gate.** Coverage and mutation scores must **never** be used to rank workflow quality; the deterministic static-analysis pre-pass is a separate, complementary axis.

Role: orchestrator. Route work to review agents; do not review code yourself. Pass each agent's `model:`/`effort:` frontmatter as declared when dispatching — the harness resolves both fields natively before dispatch, per Model/Effort Resolution in `agents/orchestrator.md` (ADR 0026).

Output templates and JSON schemas: [`output-format.md`](output-format.md). Example report: [`examples/sample-report.md`](examples/sample-report.md).

**This file is the pi core of the upstream skill.** The full upstream text, word for word, with its reasons, incidents and edge cases, is split by step into `references/` (relative links inside a reference resolve from this directory, not from `references/`). Read a reference only when its row below says so; do not read references otherwise. If the core and a reference seem to disagree, follow the reference, with one exception: `references/05-aggregate.md`, `references/06-findings-and-fix-loop.md` and `references/07-report.md` still say step 9 never runs under `--json`. That text is stale upstream; step 9 does run under `--json` (steps 7 and 9 below, and `references/08-09-corrections-and-gate.md`).

| Reference | Read it when |
| --- | --- |
| `references/00-overview.md` | `$ARGUMENTS` holds a flag the Parse Arguments table does not list |
| `references/01-target-files.md` | **always** when the documentation-only short-circuit fires (step 1) |
| `references/02-gates-and-static-analysis.md` | a step 2 gate or a step 2b script exits with an error step 2 does not describe |
| `references/03-enabled-agents.md` | a step 3 script exits non-zero, or `select_lenses.py` prints a warning code step 3 does not name |
| `references/04a-dispatch-waves.md` | `dispatch_waves.py` exits non-zero or prints no `waves` |
| `references/04b-context-pack.md` | **always** when `DEV_TEAM_REVIEW_CONTEXT_PACK=on` |
| `references/04c-dispatch-payload-and-ledger.md` | `verdict_scope.py` skips any file (how to report the skips) |
| `references/04d-contract-validation-and-retry.md` | **always** when `dispatch_reconcile.py`'s `missing` is non-empty |
| `references/05-aggregate.md` | `ACCEPTED-RISKS.md` exists at the repo root |
| `references/06-findings-and-fix-loop.md` | **always** before the first fix iteration (step 6a) |
| `references/07-report.md` | `render_tiered_findings.py` or the report write fails |
| `references/08-09-corrections-and-gate.md` | the user asks why the gate file was or was not written |

## Orchestrator constraints

**MUST — confirm agent-dispatch capability before anything else in this skill (issue #1461).** Before attempting to dispatch ANY review agent (Step 4), you MUST confirm the `Agent` (or `Task`) tool is actually present and available in your current toolset. If it is not present: **STOP.** Do not proceed with a self-applied, inline, or checklist-based review of any kind as a substitute for independent dispatch — an orchestrator applying the review agents' checklists itself is not a review, it is self-certification, and it defeats the entire purpose of this gate. Do not write `.pr-review-passed` under any circumstance in this state. Instead, report to the user/operator plainly: code review cannot run in this environment because no agent-dispatch capability (`Agent`/`Task` tool) is available; name exactly what's missing; and state that the PR gate cannot be satisfied until `/code-review` is re-run from a session that has that capability. This is a hard requirement, not a preference — "should dispatch agents" is not sufficient; a missing `Agent`/`Task` tool always halts this skill before Step 2.

1. **Do not review code yourself.** Delegate all semantic analysis to review agents.
2. **Minimize context per agent.** Pass only what each agent's `Context needs` field requires.
3. **Route to the right model.** Each agent's `model:`/`effort:` frontmatter declares its model alias and reasoning effort; the harness resolves both fields natively before dispatch, per `agents/orchestrator.md` → Model/Effort Resolution (ADR 0026). Do not override the frontmatter value.
4. **Run deterministic gates first.** Lint, type-check, secret scan are cheaper than AI. Stop if they fail.
5. **Return structured results.** Aggregate agent JSON; do not add your own findings.
6. **Be concise.** Tables and JSON, no preambles, no filler.

## Parse Arguments

Arguments: $ARGUMENTS

| Flag | Behavior |
| --- | --- |
| `--agent <name>` | Run only the named agent (delegates to `/review-agent`) |
| `--since <ref>` | Review files changed since the ref (step 1 command; keep its `-c` overrides) |
| `--path <dir>` | Review only files in this directory |
| `--all` | Force full-repository review even when uncommitted changes exist |
| `--slice <N>` / `--resume` / `--no-slice` | Sliced large-repo review: force it with N files per slice, resume it, or never engage it. See [`sliced-mode.md`](sliced-mode.md) |
| `--json` | Output aggregated JSON to **stdout** instead of prose. Contractually non-interactive (for CI): never prompts; defaults to report-only (no code modified). |
| `--expand <finding-id>|all` | Prose-mode only (step 7): render Tier-2 (full message + suggested fix) for the named finding-id, or for every finding with `all`, after the Tier-1 report. A no-op under `--json`. Only meaningful in the same run that computed the ids; it never triggers a second panel dispatch |
| `--pdf` | After the durable report is written, also render it to a sibling PDF (step 7). No-op with a message when no report file is written |
| `--internal` | Orchestrator-internal dispatch (`/build`, `/test-improve`): skip the `.dev-team-reports/code-review.md` write in step 7; the prose and fix-loop path still runs |
| `--init-risks` | Scaffold `ACCEPTED-RISKS.md` from `templates/ACCEPTED-RISKS.md.tmpl` if absent. Exits non-zero without overwriting if present |
| `--force` | Skip pre-flight gates **and the documentation-only short-circuit**. **Requires `--reason "<text>"`** — logged to `.claude/metrics/override-audit.jsonl` |
| `--reason "<text>"` | Override justification (required with `--force`) |
| `--static-analysis` / `--no-static-analysis` | Force on/off the static analysis pre-pass. Auto-enabled when tools are detected |
| `--background` | Drift review of the default branch (documentation, naming and structural drift): only doc-review, arch-review, naming-review, structure-review; skips pre-flight gates |
| (no flags) | **Auto-scope**: review uncommitted changes if any exist, otherwise full repository |

## Progress tracking

```text
- [ ] Target files determined
- [ ] Documentation-only check (short-circuit if all docs)
- [ ] Pre-flight gates passed
- [ ] Static analysis pre-pass (if enabled)
- [ ] Agents loaded and filtered
- [ ] All agents executed
- [ ] Results aggregated
- [ ] User asked: fix or report only?
- [ ] Review-fix loop (if user chose fix, up to 5 iterations)
- [ ] Report generated
- [ ] Correction prompts saved
- [ ] Pre-commit gate file written (if auto-scoped to uncommitted changes)
```

## Steps

### 1. Determine target files

Priority order:

1. `--path <dir>` — files in that directory (exclude node_modules, .git, dist, build, coverage)
2. `--since <ref>` — `git -c diff.relative=false -c core.quotePath=false diff --name-only <ref>...HEAD`
3. `--all` — all source files
4. **Auto-scope** (no flags): `git -c diff.relative=false -c core.quotePath=false diff --name-only` + `git -c diff.relative=false -c core.quotePath=false diff --cached --name-only`, combined and deduped. Non-empty → review those files; empty → review the full repository. Keep both `-c` overrides: the gate hash and step 3's file list depend on them.

- **Stage auto-scoped changes now, before anything else (#1461).** When auto-scope found files, `git add` them immediately, before gates, static analysis or any dispatch, so the staged hash stays fixed through step 9.
- **Never `Read` a directory path** to list it (it throws `EISDIR`); list files with `Glob("<dir>/**/*")`.
- **Scope validation** (full-repo paths only): ≤200 files proceed; 201–500 warn "Reviewing {N} files — consider `--path` to narrow scope." and proceed; >500 **Auto-engage sliced mode** unless `--no-slice`.
- **Sliced mode** (>500 files on a full-repo scope, or `--slice <N>`): **read** [`sliced-mode.md`](sliced-mode.md) and run it instead of steps 4–9. It is report-only. `--no-slice` forces the legacy single-pass review (steps 2–9) even past the threshold; Exactly at 500 files does not auto-engage. **Non-full-repo scope** (`--path`, `--since`, auto-scoped uncommitted changes) never auto-engages, whatever the file count.
- **Documentation-only short-circuit.** If **every** target file is documentation (`.md`, `.mdx`, `.markdown`, `.rst`, `.txt`, `.adoc`, anything under `docs/`, root `README*`, `CHANGELOG*`, `CONTRIBUTING*`, `LICENSE*`, `NOTICE*`, `AUTHORS*`, `CODE_OF_CONDUCT*`) — where any path with a `.claude/` segment or under `agents/`, `skills/`, `prompts/`, `knowledge/`, `templates/agents/`, and `CLAUDE.md`/`AGENTS.md`, is **never** documentation — then **read** the short-circuit in `references/01-target-files.md` and follow it: emit the skip message, write the gate and the `doc-only` boundary event when auto-scoped or `--since <base>`, emit `{"status": "skipped", ...}` under `--json`, and **stop**. Not with `--force`, `--agent <name>` or `--background`.

**1b.** If `REVIEW-CONTEXT.md` exists at the repo root, pass its contents to every agent in step 4, prefixed with: "Institutional context provided for this review:".

**1c.** Probe for optional tools and pass their availability to each agent, so agents use them or fall back to Glob/Grep/Read: RoslynMCP (`get_code_metrics` / `search_symbols`), CodeGraph (`.codegraph/` present / `mcp__codegraph__codegraph_explore` available), Repowise (`get_context` / `get_symbol` / `search_codebase` / `get_risk`), a documentation MCP, Semgrep (`which semgrep`). Tool selection and fallback: [`knowledge/codegraph-vs-graphify.md`](../../knowledge/codegraph-vs-graphify.md). Name the availability in the final report.

### 2. Pre-flight gates

Skip entirely with `--background`. `--force` without `--reason` halts with:

```
ERROR: --force requires --reason "<justification>".
```

`--force` with `--reason`: append an entry to `.claude/metrics/override-audit.jsonl` per [`output-format.md`](output-format.md#override-audit-log-entry-step-2---force-path), then go to step 3.

Otherwise run in sequence, stop on the first failure, and skip a gate silently when its tool is missing:

1. **Lint**: `npx eslint` (or the project lint command) on target files.
2. **Type check**: `npx tsc --noEmit` if `tsconfig.json` exists.
3. **Secret scan**: with `gitleaks` installed, run the canonical invocation from [`skills/static-analysis-integration/references/tool-configs.md`](../static-analysis-integration/references/tool-configs.md) § gitleaks; any finding on a target file fails the gate; report rule id and `file:line` only, **never echo the matched secret value**; record that gitleaks ran and do not run it again in 2b. Without gitleaks, grep with the pattern in [`knowledge/owasp-detection.md`](../../knowledge/owasp-detection.md) § Hardcoded-key pattern (the fenced block, not the table row: table cells escape `|` as `\|`, a literal pipe rather than alternation) and say in the report that the fallback ran.
4. **Semgrep SAST**: `semgrep scan --config auto --quiet --json` on target files if installed. ERROR → fail. WARNING → continue, include in report, save for security-review.
5. **Pipeline-red check**: `gh run list --branch $(git branch --show-current) --limit 1 --json conclusion -q '.[0].conclusion'`. If the last run failed, warn: "Pipeline is red. Fix CI before adding new code. Use `--force` to override."

### 2b. Static analysis pre-pass

Skip with `--no-static-analysis` or `--background`. Follow [`skills/static-analysis-integration/SKILL.md`](../static-analysis-integration/SKILL.md). It collects context for step 4; it does not gate. Reuse semgrep findings from step 2; do not run semgrep twice.

Also run, with the same `<target files>` list:

```bash
python3 "$CLAUDE_PLUGIN_ROOT/skills/code-review/scripts/repo_invariants.py" --files <target files>
```

```bash
python3 "$CLAUDE_PLUGIN_ROOT/skills/test-design/scripts/internal_double_detector.py" . --files <target files> --json
```

Both `findings` arrays merge into step 4's static-analysis context ("detected by static analysis — do not re-report, focus on semantic concerns"). Never pass `--all` to `repo_invariants.py` here.

- **Growing this registry is a rule, not a discretion (#1981).** When a review agent reports the same mechanically-checkable finding class for the second time, and a deterministic script can check it, add it as a `CHECKS` entry in `scripts/repo_invariants.py` in the same PR that fixes the finding.
- **Authoring-time ordering (#1629).** When writing fixtures or agent files, run the same `repo_invariants.py` command at edit time, before the first panel dispatches.

**Test-review mechanical pre-phase (#2169).** Only when `test-review` is in this round's lens set, run once per test file in `<target files>`:

```bash
python3 "$CLAUDE_PLUGIN_ROOT/scripts/test_review_mechanics.py" . <file>
```

Keep each result keyed by its file and give it to `test-review` as that file's Phase 0 input, with `agents/test-review.md`'s own framing ("detected by static analysis, do not re-derive"; the agent still reports it when `mechanicalFail` is true) — not the generic envelope the two pre-passes above use.

### 3. Determine enabled agents

The scripts below decide; apply what they print, in this order, and never re-add an agent an earlier gate removed. `--force` and `--agent <name>` bypass the change-shape, change-size and diff-signal gates.

- `--background`: run only `doc-review`, `arch-review`, `naming-review`, `structure-review`; skip the rest of this step.
- The roster is the **Review Agents** section of `knowledge/agent-registry.md`. Never `Read` the bare `agents/` directory; use `Glob("agents/*.md")`.
- `review-config.json` at the repo root: honor its per-agent `"enabled": false`.

**Eligibility (`select_lenses.py`).** For a diff-scoped run (auto-scope or `--since <ref>`), compute the changed-file list, keeping the `-c` overrides:

```bash
set -o pipefail  # a pipeline's status is its LAST command's without this —
                  # changed_file_list.py succeeds trivially on empty stdin, so
                  # an upstream git failure would otherwise pass silently.

# Auto-scope (uncommitted changes):
CHANGED_JSON=$({ git -c diff.relative=false -c core.quotePath=false diff --name-status; \
  git -c diff.relative=false -c core.quotePath=false diff --cached --name-status; } \
  | python3 "$CLAUDE_PLUGIN_ROOT/skills/code-review/scripts/changed_file_list.py" --name-status-from -) \
  || { echo "ERROR: failed to compute the changed-file list" >&2; exit 1; }

# --since <ref>:
CHANGED_JSON=$(git -c diff.relative=false -c core.quotePath=false diff --name-status <ref>...HEAD \
  | python3 "$CLAUDE_PLUGIN_ROOT/skills/code-review/scripts/changed_file_list.py" --name-status-from -) \
  || { echo "ERROR: failed to compute the changed-file list" >&2; exit 1; }
```

```bash
FILES_LIST=$(printf '%s' "$CHANGED_JSON" | python3 -c 'import json, sys; print("\n".join(f["path"] for f in json.load(sys.stdin)["files"]))') \
  || { echo "ERROR: failed to extract file list from CHANGED_JSON" >&2; exit 1; }
ADDED_LIST=$(printf '%s' "$CHANGED_JSON" | python3 -c 'import json, sys; print("\n".join(json.load(sys.stdin)["added"]))') \
  || { echo "ERROR: failed to extract added-file list from CHANGED_JSON" >&2; exit 1; }
```

```bash
python3 "${CLAUDE_PLUGIN_ROOT}/scripts/select_lenses.py" \
  --files-from <(printf '%s\n' "$FILES_LIST") \
  --added-from <(printf '%s\n' "$ADDED_LIST")
```

- Feed only `$FILES_LIST`/`$ADDED_LIST`, derived from the quoted `$CHANGED_JSON`; never re-interpolate individual paths as shell words (that is what closes the injection surface).
- Always pass `--added-from` on a diff-scoped run, even when `added` is `[]`. For `--path`/`--all`/full-repository, pass `--files <target files>` instead of both.
- Take its `lenses` array as the roster. **Surface every entry of its `warnings`** in the report. `unreadable-registry:<file>`, `unreadable-files-from:<path>` and `unreadable-added-from:<path>` count as a `fail` for this run; `skipped-non-executable:<name>` is informational.
- **Framework reactivity** (from the dependency manifest): `react`/`react-dom` → `react-reactivity-review`, scoped to `.jsx`/`.tsx` and React-importing `.js`/`.ts` files; `vue` → `vue-reactivity-review`, scoped to `.vue` and Vue-importing `.js`/`.ts` files; `@angular/core` → `angular-reactivity-review`, scoped to `*.component.ts`, `*.component.html`, `*.service.ts`, and general `.ts` files.

**Change-shape gate.**

```bash
python3 "$CLAUDE_PLUGIN_ROOT/skills/code-review/scripts/change_shape.py" --files <target files>
```

Drop every agent in `skipLenses` and note it in the report as gated by change shape. `isTestOnly` gates nothing; do not narrow on it.

**Change-size gate** (diff-scoped runs only; never for `--path`/`--all`/full repository):

```bash
# Auto-scope (uncommitted changes):
{ git diff --numstat; git diff --cached --numstat; } | python3 "$CLAUDE_PLUGIN_ROOT/skills/code-review/scripts/change_size.py" --numstat-from -

# --since <ref>:
git diff --numstat <ref>...HEAD | python3 "$CLAUDE_PLUGIN_ROOT/skills/code-review/scripts/change_size.py" --numstat-from -
```

When `qualifiesForFastPath` is `true`, drop every `Scope: always` agent not in `keepAgents` and note the drop (gated by change size). `Scope:`-glob agents are unaffected.

**Diff-signal gate** (third):

```bash
# Auto-scope (uncommitted changes):
{ git -c diff.relative=false diff --no-color; git -c diff.relative=false diff --cached --no-color; } \
  | python3 "$CLAUDE_PLUGIN_ROOT/skills/code-review/scripts/change_impact.py" --files <target files>

# --since <ref>:
git -c diff.relative=false diff --no-color <ref>...HEAD \
  | python3 "$CLAUDE_PLUGIN_ROOT/skills/code-review/scripts/change_impact.py" --files <target files>
```

Drop every agent in `skipLenses` and note it (gated by diff signal). Only `arch-review` and `concurrency-review` can be gated here.

### 4. Run each enabled agent

**Dispatch-capability gate (re-confirm here, not just at the top of this file — issue #1461).** Before spawning anything below, re-verify the `Agent`/`Task` tool is present in this toolset. If it is not, STOP per the Orchestrator constraints above — do not fall back to reviewing the files yourself, inline, as a stand-in for the panel; report the missing capability and halt the run before any agent is spawned.

**Waves.** Compute the split; do not guess a batch size:

```bash
sh "$CLAUDE_PLUGIN_ROOT/hooks/py.sh" "$CLAUDE_PLUGIN_ROOT/skills/code-review/scripts/dispatch_waves.py" --agents "<comma-separated eligible agent names, cheap-first order as select_lenses.py returned them, filtered by the change-shape/change-size/change-impact gates but not re-sorted>"
```

Dispatch **exactly the waves it printed, in that order**, as parallel subagents in one message per wave, and wait for each wave to return before the next one and before aggregating.

**Shared context pack: off unless the caller opts in** (`DEV_TEAM_REVIEW_CONTEXT_PACK=on`). Only then **read** `references/04b-context-pack.md` and follow it.

**For each agent:**

- **File scope**: pass only files matching the agent's declared scope. Skip the agent if no files match.
- **Ledger-scoped dispatch (#2167).** Once per run, for all agents together, before building any prompt: narrow each agent's File scope with the per-lens verdict ledger:
  ```bash
  python3 "$CLAUDE_PLUGIN_ROOT/scripts/verdict_scope.py" --root . --lens-files '<JSON: {"<agent>": [<its File-scope files from the bullet above>], ...} for every agent surviving step 3''s gates>'
  ```
  - Narrow each File scope to `toDispatch[<agent>]`. Do not dispatch an agent listed in `fullySkippedLenses`.
  - **Report loudly, never silently.** Name every ledger-skipped `(lens, file)` pair with its row's `ts`/`file_content_hash`/`plugin_version` in the report and `--json` output. When every lens is skipped, say so: "N lenses skipped via ledger evidence, 0 dispatched this run".
  - **Fail closed.** The script skips a file only on an exact `(lens, file_path, current content hash)` match whose latest row is `outcome: "pass"`; everything else dispatches.
  - The PR gate needs no change: `hooks/pre_pr_review.py` corroborates on the branch diff's `subject_hash`, independent of this per-file ledger.
- **Scope marker (#2166)**: append one structured, single-line marker to every dispatch prompt, listing the exact files passed under File scope above (as narrowed by Ledger-scoped dispatch), comma-separated: `Files in scope for this review: <path>, <path>, ...`. `hooks/review_verdict_recorder.py` parses it back out of the transcript.
- **Context payload** (the agent's `Context needs`): `diff-only` → the diff (auto-scope or `--since` only); `full-file` → complete files; `project-structure` → full files + directory tree + step 3's changed-file list (path + change type) for diff-scoped runs, never the list for `--path`/`--all`/full repository. `project-structure` agents have no Bash and must never run `git` themselves. A full-repository review (clean auto-scope, `--all`, or `--path`) always passes full files.
- **Model**: pass the agent's declared `model:`/`effort:` frontmatter.
- **Static analysis context**: if step 2b found anything, add to every prompt: "These issues were detected by static analysis. Do not re-report them. Focus on semantic concerns."
- **Per-agent output**: the contract in [`knowledge/review-agent-output-contract.md`](../../knowledge/review-agent-output-contract.md), wrapped with `agentName`/`modelTier` (shape in `output-format.md`).
- **Graph-assisted review**: pass the step 1c tool availability to every read-only review agent.

**After each wave: classify, then reconcile.** For each agent in the wave that returned something, write its raw final-turn text with the **Write tool** (never a shell heredoc, `echo` or `printf`) to `.claude/memory/contract-raw-<agent>.md`, classify it, then delete the file, also when the script errors:

```bash
sh "$CLAUDE_PLUGIN_ROOT/hooks/py.sh" "$CLAUDE_PLUGIN_ROOT/skills/code-review/scripts/validate_review_output.py" --agent "<name>" --file "<path to that agent's raw output>"
```

Exit 0 → the agent goes in `--returned`. Exit 1 → it does not (the script already logged why). Then:

```bash
sh "$CLAUDE_PLUGIN_ROOT/hooks/py.sh" "$CLAUDE_PLUGIN_ROOT/skills/code-review/scripts/dispatch_reconcile.py" --dispatched "<this wave's dispatched agent names, in the order dispatch_waves.py listed them>" --returned "<this wave's contract-valid agent names>"
```

`--dispatched` lists only the agents of this wave that actually received a prompt; leave out agents skipped for no matching files or by the ledger (their wave slot stays unused, `references/04c-dispatch-payload-and-ledger.md`). Pass `--returned ""` when no agent in the wave returned a valid result. **If `missing` is non-empty, read `references/04d-contract-validation-and-retry.md` and follow it**: retry each missing agent exactly once on its own, with the same prompt, model, context payload and file scope, and finish the retries before the next wave; validate the retry's output the same way (a recovered retry emits no event and is not a failure); on a second failure record a `dispatchFailures` entry, emit the `dispatch-failure` boundary event, and treat it as `fail` for steps 5 and 9. A missing lens is never dropped silently.

### 5. Aggregate results

- **Dispatch failures first.** Carry every step 4 `dispatchFailures` entry into the report and the `--json` object unchanged. **A non-empty `dispatchFailures` forces `overall: "fail"`, unconditionally**, applied after health scoring so it always wins.
- **Ledger skips.** Carry step 4's `verdict_scope.py` `skipped` map through as `ledgerSkipped`, never dropped. A ledger skip does **not** force `overall` toward `fail`/`warn`: score `overall` from the agents that dispatched this round. An all-skipped roster reports `overall: "pass"` with zero `agents[]` and a non-empty `ledgerSkipped`, and the report says so.

#### 5a. Apply ACCEPTED-RISKS.md

If `ACCEPTED-RISKS.md` exists, apply its `rules:` per `knowledge/accepted-risks-schema.md`; the first matching rule suppresses a finding and emits:

```
SUPPRESSED: <file>:<line> [<rule_id>] by ACCEPTED-RISKS rule <rule.id>
```

Expired rules stop suppressing and get a WARN plus an Expiry Report entry; `broad: true` rules get a notice; a schema-invalid rule fails the run. Suppressed findings leave scoring and the fix loop and are listed under "Suppressed by ACCEPTED-RISKS".

#### 5b. Health scoring

Score with `knowledge/review-rubric.md`; security failures escalate to 🔴. **Actionable** = severity error or warning with confidence high or medium. Confidence none and every suggestion are report-only. Actionable issues drive the fix loop.

#### 5b-i. Record round 1 (#1624)

The initial panel is round 1. Record it now, before any fix:

```bash
python3 "$CLAUDE_PLUGIN_ROOT/skills/code-review/scripts/review_round_log.py" \
  --round 1 --agents "<comma-separated agents dispatched>" \
  --findings <path-to-this-round's-findings.json> \
  --purpose discovery --outcome "<fixed|no-op|escalated>"
```

#### 5c. Consolidate cross-agent findings

When several agents flag the same `file:line`, emit one `topFindings` entry: `severity` = the single highest value, `agents` = an array of the reporting agents. Never pack several values into one scalar field. The `topFindings` array keeps its exact `file:line` dedup key. In the human-facing prose only, dedup across agents: describe two findings about the same underlying defect once. **Condensation cap.** Condense each surviving finding to ≤ 3 lines per finding in the prose summary; `topFindings` entries keep their full `message`/`suggestedFix`.

### 6. Present findings and ask for direction

Zero actionable issues → step 7. Otherwise present the Review Findings prompt ([`output-format.md`](output-format.md#review-findings-prompt-interactive--step-6)) and ask: **"Fix these issues automatically, or save as report only?"** "Fix" / "apply" / "yes" → 6a; "Report" / "no" / "don't fix" → step 7, no code modified.

Non-interactive: with `--json` (or `--yes`), **default to report only** and never modify code. Inside `/build`, `/pr` or `/test-improve`, go to the fix loop; the caller owns the human gate.

### 6a. Review-fix loop

**Read `references/06-findings-and-fix-loop.md` before the first fix iteration** and follow it. It holds the loop, the deterministic-first triage, verification-mode re-dispatch, the round ledger (`finding_signature.py`), per-round records (`review_round_log.py`), the closing pass (`closing_pass.py`) and the exit conditions. In short:

- Up to 5 iterations: apply fixes, run the tests (revert a fix that breaks them and mark it `[auto-fix failed — human review required]`), capture the iteration's fix diff, then re-stage with `git add` when auto-scoped.
- Deterministic-first triage: close a fix without re-dispatch only when **all three** hold — it is a pure mechanical edit, step 2b's lint/type tools and the test suite ran clean, and a targeted grep/diff can check the claim. If any fails, or the check cannot fully close the question (for example, whether prose is accurate needs semantic reading), re-dispatch.
- Re-run only the agents with open actionable issues, in verification mode (contract: [`knowledge/verification-mode.md`](../../knowledge/verification-mode.md), with the mandatory `insufficient-context` escape); carry forward the statuses of agents that passed.
- Every round goes through the round ledger, which decides `converged` or `round-cap` (a hard cap at round 4). Honor it.
- Closing pass (auto-scope only, like re-staging): after any fix iteration, run `closing_pass.py` and dispatch exactly its agents. They keep full authority: an actionable finding re-enters the loop like any iteration.
- **Escalation** (round cap, iteration limit, same issues persisting) is carried to step 7 (`--json` → `overall: "fail"`) and step 9 (no gate write). A `converged` exit is not an escalation.

### 7. Generate report

**Output paths.** All file artifacts (`./corrections/*.json`, `.claude/memory/.pr-review-passed`) are repo-relative to the target repository's working directory. Never prepend a scratchpad, sandbox, or session root, and never join two absolute paths. Read `knowledge/review-template.md` for the structure.

**If `--json`: the JSON object is the ONLY thing printed to stdout for this run — non-negotiable, not model discretion.** Emit the aggregated JSON object per the schema in [`output-format.md`](output-format.md#aggregated-json-result---json-flag) to **stdout**, write no report file, and **skip step 8 in this run, regardless of how many issues were found or whether any are actionable.** There is no fallback to prose, and no `corrections/` persistence, in `--json` mode — ever.

- **Step 9 is NOT skipped by `--json`.** After emitting the JSON, continue to step 9; whatever it writes goes to disk or stderr, never stdout.
- **When step 6a escalated, force `overall: "fail"`** in this JSON object, after the totals-based computation, like the `dispatchFailures` override.
- **A sentence describing the JSON is not the JSON.** The literal final output of the turn must be the JSON object itself.

Otherwise (no `--json`): emit the prose summary using the Code Review Summary template in [`output-format.md`](output-format.md#code-review-summary-report-step-7-prose-mode). For that template's per-finding listing, render this round's aggregated finding list (the same list already assembled for the `--json` branch above and for step 8 — not re-derived) with `render_tiered_findings.py` (#2170) instead of listing each finding's full message inline:

```bash
python3 "$CLAUDE_PLUGIN_ROOT/skills/code-review/scripts/render_tiered_findings.py" --findings <path-to-this-round's-finding-list.json> [--expand <finding-id>|all]
```

Pass `--expand` through exactly as the caller supplied it (omit the flag entirely when the caller did not pass one): Tier-1 lines plus the expansion hint by default; the matching Tier-2 block(s) appended after the Tier-1 report when `--expand` was given. An unknown `--expand` id: relay the script's non-zero exit and "finding-id not found" message to the user rather than silently rendering nothing or crashing. Append the iteration table.

**Scope of this wiring: the prose-mode path only.** `--json` (this step's branch above) and `./corrections/*.json` (step 8) already read and write the full finding objects independently of this rendering path — neither branch calls `render_tiered_findings.py`, and this change does not touch either of them. In particular, **`--expand` is a no-op under `--json`**: the `--json` branch above is unconditional ("the JSON object is the ONLY thing printed to stdout... non-negotiable") and must never call `render_tiered_findings.py`, so under `--json` there is nothing for `--expand` to act on. This is enforced structurally — by the `--json` branch never reaching the tiered-rendering code path described here — not by a check inside `render_tiered_findings.py` or inside the `--json` branch itself.

**Write the durable report (skip when `--internal`).** Write the identical prose summary to `.dev-team-reports/code-review.md` (create the directory if absent, overwrite an existing file), also when the review found nothing, and print `Report written: .dev-team-reports/code-review.md` (add ` (replaced previous run)` when a file existed). A failed write is non-fatal: report `Cannot write .dev-team-reports/code-review.md: <error>` and continue.

**`--pdf`**: only when a report file was written this run, render it per `knowledge/report-pdf-integration.md` and surface the module's `Rendering PDF via <engine>…` and result lines:

```bash
sh "$CLAUDE_PLUGIN_ROOT/hooks/py.sh" "$CLAUDE_PLUGIN_ROOT/hooks/lib/report_pdf.py" .dev-team-reports/code-review.md
```

Otherwise say `--pdf: no report file was written this run, nothing to render.` (to stderr under `--json`). It never changes the review's output or exit status; a missing engine or render error is non-fatal.

### 8. Save correction prompts for remaining issues

**Skip this entire step if `--json` was set.** For issues not auto-fixed (confidence none, failed auto-fix, suggestions), write one correction prompt per issue (schema: [`output-format.md`](output-format.md#correction-prompt-json)) to `./corrections/` in the target repository's working directory. They can be applied manually or with `/apply-fixes`.

### 9. Write pre-commit gate file

**Not skipped by `--json`.**

Write the gate only when **all** of these hold:

- the review was auto-scoped to uncommitted changes **or** scoped via `--since <base>`;
- `dispatchFailures` is empty;
- the overall status is `pass` or `warn`;
- step 6a did not exit by escalation (round cap, iteration limit, or "same issues persist"), even when only warnings remain.

```bash
HASH=$(python3 "${CLAUDE_PLUGIN_ROOT}/hooks/lib/review_gate_hash.py" --branch-diff)
mkdir -p .claude/memory && printf '%s\n' "$HASH" > .claude/memory/.pr-review-passed
```

With `--agent <name>`, also record the single-agent exemption against the same hash, at the same time:

```bash
python3 "${CLAUDE_PLUGIN_ROOT}/hooks/lib/boundary_events.py" --event single-agent --subject-hash "$HASH"
```

Do not stage other files or hash different content at this point. If the overall status is `fail`, do **not** write the gate file; `hooks/pre_pr_review.py` keeps blocking `gh pr create` until the issues are fixed and the review is re-run.
