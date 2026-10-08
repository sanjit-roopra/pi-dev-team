<!-- overview, orchestrator constraints, arguments, progress tracking. Upstream text of skills/code-review/SKILL.md, unchanged; the pi core SKILL.md summarizes it. Relative links below resolve from skills/code-review/, not from references/. Everything below the marker is verbatim. -->
<!-- verbatim-below -->

# Code Review

**The review-agent panel is the primary quality gate** (Rec 5,
`docs/experiments/RECOMMENDATIONS.md`). The review-agent lens — SRP,
complexity, coupling, duplication — was the only quality axis that separated
workflow arms in the experiment line. Coverage and mutation scores saturate
near-identically across every workflow shape and must **never** be used to
rank workflow quality: the losing big-batch and split arms posted *higher*
mutation scores (0.93–0.98) than the two winners (0.80–0.86). A higher
coverage or mutation number is not evidence that code — or the workflow that
produced it — is better. (The deterministic static-analysis pre-pass below is
a different, complementary axis: mechanical findings cleared before the
semantic panel runs, not a metric competing with it.)

Role: orchestrator. Route work to review agents; do not review code yourself. Pass each agent's `model:`/`effort:` frontmatter as declared when dispatching — the harness resolves both fields natively before dispatch, per Model/Effort Resolution in `agents/orchestrator.md` (ADR 0026).

Output templates and JSON schemas: [`output-format.md`](output-format.md). Example report: [`examples/sample-report.md`](examples/sample-report.md).

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
| `--since <ref>` | Review files changed since the ref — see step 1 for the exact command (the `-c diff.relative=false -c core.quotePath=false` overrides there are load-bearing, not cosmetic) |
| `--path <dir>` | Review only files in this directory |
| `--all` | Force full-repository review even when uncommitted changes exist |
| `--slice <N>` | Engage sliced large-repo review explicitly, capping each slice at N files (module-aligned) at any repo size. `N` must be a positive integer. See [`sliced-mode.md`](sliced-mode.md). |
| `--resume` | Resume a sliced run — skip slices whose section artifact already exists on disk. See [`sliced-mode.md`](sliced-mode.md). |
| `--no-slice` | Escape hatch — force the legacy single-pass review even on a large full-repo scope that would otherwise auto-engage sliced mode. |
| `--json` | Output aggregated JSON to **stdout** instead of prose. Contractually non-interactive (for CI): never prompts; defaults to report-only (no code modified). |
| `--expand <finding-id>|all` | Prose-mode only (step 7): render Tier-2 (full message + suggested fix) for the named finding-id, or for every finding with `all`, after the Tier-1 report — see step 7. A no-op under `--json` (see step 7's `--json` branch). **Only meaningful within the SAME run that computed the ids** — pass it alongside `--since`/`--path`/etc. in one invocation once you already know a specific id, e.g. because the operating Claude session read the prior Tier-1 output and is now re-invoking this skill with the same scope plus `--expand <id>` still in the same conversation; that path never re-dispatches anything beyond what the scope would have dispatched anyway. A cold, separate `/code-review --expand <id>` run with no memory of where that id came from IS a full re-dispatch of the panel (steps 1-6 run in full, same as any other invocation) and the id is not guaranteed to still exist or mean the same finding — `render_tiered_findings.py`'s own docstring says ids are not stable across runs. `--expand` never triggers a SECOND panel dispatch on top of an already-running one; it only changes step 7's rendering of the one panel a given invocation already ran. |
| `--pdf` | After the durable report is written, also render it to a sibling PDF via `hooks/lib/report_pdf.py`. See `knowledge/report-pdf-integration.md`. No-op with a message when no report file is written (`--json` or `--internal`); under `--json`, that status goes to **stderr** so stdout stays pure JSON. Additive: never changes the review's own output or exit status. |
| `--internal` | This is an orchestrator-internal dispatch (`/build`'s Step 6 backstop review, `/test-improve`'s Phase 4/5 end-of-phase review loop) — skip the `.dev-team-reports/code-review.md` report write in step 7. Orthogonal to `--json`: `--internal` alone still runs the prose/fix-loop path; both sanctioned callers use `--internal` without `--json` specifically to keep the fix loop. `/build` and `/test-improve` are the only sanctioned callers of this flag today — see `knowledge/report-output-location.md` for `/ship`'s deliberate exception (writes the report by default, no `--internal`). |
| `--init-risks` | Scaffold `ACCEPTED-RISKS.md` from `templates/ACCEPTED-RISKS.md.tmpl` if absent. Exits non-zero without overwriting if present. Schema: `knowledge/accepted-risks-schema.md`. |
| `--force` | Skip pre-flight gates **and the documentation-only short-circuit** (forces a full review of doc-only changes). **Requires `--reason "<text>"`** — logged to `.claude/metrics/override-audit.jsonl`. |
| `--reason "<text>"` | Override justification (required with `--force`) |
| `--static-analysis` / `--no-static-analysis` | Force on/off the static analysis pre-pass (Semgrep, ESLint, TypeScript, Ruff, mypy). Auto-enabled when tools are detected. |
| `--background` | Drift review mode — review default branch for documentation, naming, and structural drift. Runs doc-review, arch-review, naming-review, structure-review only. Skips pre-flight gates. |
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

