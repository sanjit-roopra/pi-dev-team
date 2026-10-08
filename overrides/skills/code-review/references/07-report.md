<!-- step 7 (report: --json and prose branches, durable report, --pdf). Upstream text of skills/code-review/SKILL.md, unchanged; the pi core SKILL.md summarizes it. Relative links below resolve from skills/code-review/, not from references/. Everything below the marker is verbatim. -->
<!-- verbatim-below -->
### 7. Generate report

**Output paths.** All file artifacts (`./corrections/*.json`, `.claude/memory/.pr-review-passed`) are repo-relative to the target repository's working directory (the cwd `/code-review` was invoked in). Never prepend a scratchpad, sandbox, or session root onto an already-absolute path, and never join two absolute paths. `--json` prints to **stdout** and writes no file.

Read `knowledge/review-template.md` for the structure.

**If `--json`: the JSON object is the ONLY thing printed to stdout for this run — non-negotiable, not model discretion.** Emit the aggregated JSON object per the schema in [`output-format.md`](output-format.md#aggregated-json-result---json-flag) to **stdout**, write no report file, and **skip step 8 in this run, regardless of how many issues were found or whether any are actionable.** There is no fallback to prose, and no `corrections/` persistence, in `--json` mode — ever. (`/pr`'s `--json` call already only reads this JSON object's `overall`/`status` field, so this loses nothing a caller depends on.)

**Step 9 is NOT skipped by `--json` (issue #1904 Bug 2b) — emitting `--json` output and writing the PR-time gate file are orthogonal concerns.** `/pr`'s only path to `gh pr create` (`skills/pr/SKILL.md` step 2.4) invokes `/code-review --since "$BASE" --json` — so a review that is BOTH `--json` AND scoped via `--since <base>` is exactly the shape that must reach step 9, or `.claude/memory/.pr-review-passed` is never written on the only path that actually opens a PR, leaving `PR_GATE_BYPASS_REASON` as the only way to ever open one (the "gate that cannot fail is worse than no gate" anti-pattern this repo's own root `CLAUDE.md` names explicitly). After emitting the JSON object above, continue to step 9 unconditionally — its own scope condition already narrows correctly (a no-op for `--path`/`--all`/full-repository scope, same as before). Anything step 9 itself produces (boundary events, file writes) goes to disk or stderr, never stdout — stdout must stay pure JSON.

**When step 6a ran, consult its escalation state before computing `overall` here (issue #1880).** If step 6a exited via escalation (round-cap, iteration limit, or "same issues persist" — see that step's "Record the escalation state for step 7" note), force `overall: "fail"` in this JSON object, exactly like the `dispatchFailures` override — apply it after the totals-based computation so it always wins. This is the same rule stated in [`output-format.md`](output-format.md#aggregated-json-result---json-flag); it is restated here because step 9, where this escalation previously only mattered for the `.pr-review-passed` gate, never runs under `--json`. A clean `converged` exit (or a run that never entered the fix loop at all — zero actionable issues) does not trigger this override.

**A sentence describing the JSON is not the JSON.** A completed run whose final text reads like "Aggregated JSON emitted to stdout per `--json` contract; run stops here" — with no `{...}` object actually present anywhere in that text — is a contract violation, not compliance, even though it correctly stopped rather than proceeding further. The literal final output of the turn must be the JSON object itself, not a narration of having produced it. If the next action being considered is a summary sentence announcing that the JSON was (or is about to be) emitted, that is the signal to emit the actual object instead — there is no valid end state for a `--json` run that consists of prose alone.

Otherwise (no `--json`): emit the prose summary using the Code Review Summary template in [`output-format.md`](output-format.md#code-review-summary-report-step-7-prose-mode). For that template's per-finding listing, render this round's aggregated finding list (the same list already assembled for the `--json` branch above and for step 8 — not re-derived) with `render_tiered_findings.py` (#2170) instead of listing each finding's full message inline:

```bash
python3 "$CLAUDE_PLUGIN_ROOT/skills/code-review/scripts/render_tiered_findings.py" --findings <path-to-this-round's-finding-list.json> [--expand <finding-id>|all]
```

Pass `--expand` through exactly as the caller supplied it (omit the flag entirely when the caller did not pass one): Tier-1 lines plus the expansion hint by default; the matching Tier-2 block(s) appended after the Tier-1 report when `--expand` was given. An unknown `--expand` id: relay the script's non-zero exit and "finding-id not found" message to the user rather than silently rendering nothing or crashing. Append the iteration table.

**Scope of this wiring: the prose-mode path only.** `--json` (this step's branch above) and `./corrections/*.json` (step 8) already read and write the full finding objects independently of this rendering path — neither branch calls `render_tiered_findings.py`, and this change does not touch either of them. In particular, **`--expand` is a no-op under `--json`**: the `--json` branch above is unconditional ("the JSON object is the ONLY thing printed to stdout... non-negotiable") and must never call `render_tiered_findings.py`, so under `--json` there is nothing for `--expand` to act on. This is enforced structurally — by the `--json` branch never reaching the tiered-rendering code path described here — not by a check inside `render_tiered_findings.py` or inside the `--json` branch itself.

**Write the durable report (skip when `--internal`).** See
`knowledge/report-output-location.md` for the shared write-scope convention
this step follows. When `--internal`
was **not** passed, write the identical prose summary to
`.dev-team-reports/code-review.md` in the target repository's working
directory (creating the directory if absent), overwriting any existing
file at that path — write it even when the review found zero issues. Print
one confirmation line: `Report written: .dev-team-reports/code-review.md`,
or `Report written: .dev-team-reports/code-review.md (replaced previous
run)` when a file already existed at that path. If the write fails
(permission/read-only): report `Cannot write
.dev-team-reports/code-review.md: <error>` to chat and continue unaffected —
the write failure is non-fatal. When `--internal` **was** passed, skip this
write entirely (the fix loop and every other prose-mode behavior above are
unaffected — `--internal` only suppresses this one write). Then continue to
step 8.

**`--pdf` (additive, after the write).** When `--pdf` was passed and a report
file **was** written this run, render it to a sibling PDF per
`knowledge/report-pdf-integration.md`:

```bash
sh "$CLAUDE_PLUGIN_ROOT/hooks/py.sh" "$CLAUDE_PLUGIN_ROOT/hooks/lib/report_pdf.py" .dev-team-reports/code-review.md
```

Surface the module's `Rendering PDF via <engine>…` and result lines. When no
report file was written this run (`--json` or `--internal`), `--pdf` is a
no-op: state `--pdf: no report file was written this run, nothing to render.`
and do nothing else. Under `--json`, emit that no-op line (and any render
status) to **stderr** so stdout stays valid JSON. `--pdf` never alters the
review's own output or exit status — a missing engine or render error is
non-fatal.

