<!-- step 1 (target files, staging, sliced mode, documentation-only short-circuit), 1b, 1c. Upstream text of skills/code-review/SKILL.md, unchanged; the pi core SKILL.md summarizes it. Everything below the marker is verbatim. -->
<!-- verbatim-below -->
## Steps

### 1. Determine target files

Priority order:

1. `--path <dir>` — files in that directory (exclude node_modules, .git, dist, build, coverage)
2. `--since <ref>` — `git -c diff.relative=false -c core.quotePath=false diff --name-only <ref>...HEAD`
3. `--all` — all source files
4. **Auto-scope** (no flags): run `git -c diff.relative=false -c core.quotePath=false diff --name-only` + `git -c diff.relative=false -c core.quotePath=false diff --cached --name-only`, combine and dedupe. If non-empty, review those files. If empty, review the full repository. The explicit `-c diff.relative=false` matters here (#1461 fourth security re-review): a repo/global `diff.relative=true` config would otherwise silently scope this listing to the invocation's cwd, and `review_gate_hash()`/`_staged_names()` (which pin the same override) would then hash/gate a broader staged patch than what was actually reviewed. `-c core.quotePath=false` (#1733) keeps this listing byte-identical to step 3's `changed_file_list.py` input for the same ref/scope — without it, a non-ASCII path would arrive C-quoted here but raw there, and `select_lenses.py`'s `--added` membership test (an exact string comparison) would silently fail to match it.

**Stage auto-scoped changes now, before anything else (#1461).** When the auto-scope path found a non-empty file set, `git add` those files immediately — before pre-flight gates, static analysis, or any agent dispatch — so the staged content's hash is fixed from this point through step 9's gate write. This is not cosmetic: `agent_dispatch_ledger.py` stamps each review-agent dispatch's `subject_hash` with `review_gate_hash()` at **dispatch time** (step 4). If staging happened only at step 9 (after dispatch) as previously documented, the dispatch-time hash and the gate-write-time hash would differ whenever the auto-scope target was unstaged — the common case — and every genuine dispatch would silently fail to corroborate the gate, forcing a hard block on a fully legitimate review. Staging here, before dispatch, is what makes step 9's hash and the dispatch ledger's `subject_hash` the same value. An unstaged working-tree edit after this point does **not** by itself change the staged hash (`review_gate_hash()` hashes `git diff --cached`, not the working tree) — step 6a's fix loop explicitly re-stages (`git add`) each iteration's fixes for exactly this reason; see that step for how corroboration is re-established after a fix loop runs.

**Never `Read` a directory path directly to enumerate its contents** — `Read` on a directory throws `EISDIR` (the same hazard step 3 avoids for agent-roster enumeration). This applies to `--path <dir>`, `--all`, and the full-repository fallback alike: always list files with `Glob` (e.g. `Glob("<dir>/**/*")`), never a bare `Read` on the directory itself. See `${CLAUDE_PLUGIN_ROOT}/knowledge/directory-enumeration.md` for the shared rule.

**Scope validation** (full-repo paths only):

| File count | Action |
| --- | --- |
| ≤200 | Proceed |
| 201–500 | Warn: "Reviewing {N} files — consider `--path` to narrow scope." Proceed. |
| >500 | **Auto-engage sliced mode** (large-repo review) unless `--no-slice`. |

**Sliced large-repo review.** On a full-repo scope exceeding the >500 tier (or
whenever `--slice <N>` is passed), **auto-engage sliced mode**: run the sliced
path in [`sliced-mode.md`](sliced-mode.md) instead of steps 4–9 below. That file
owns the full activation precedence (via `scripts/activation.py`), partitioning,
per-slice panels, persist-and-drop, `--resume`, and cross-slice consolidation —
not restated here. `--no-slice` forces the legacy single-pass review (steps 2–9)
even past the threshold; Exactly at 500 files does not auto-engage.
**Non-full-repo scope** (`--path`, `--since`, auto-scoped uncommitted changes)
**never** auto-engages, regardless of file count — the review proceeds exactly
as before this feature. Sliced mode is **report-only** (no interactive fix loop).

**Documentation-only short-circuit.** After the target set is known, classify each file. A file is **documentation** when it matches a doc type or path:

- extension `.md`, `.mdx`, `.markdown`, `.rst`, `.txt`, `.adoc`
- any path under a `docs/` directory
- a root doc: `README*`, `CHANGELOG*`, `CONTRIBUTING*`, `LICENSE*`, `NOTICE*`, `AUTHORS*`, `CODE_OF_CONDUCT*`

…**except functional Claude-config markdown, which is never documentation** (it drives agent/skill/command behavior and must be reviewed): any path containing a `.claude/` segment, or under `agents/`, `skills/`, `prompts/`, `knowledge/`, or `templates/agents/`. Treat `CLAUDE.md` and `AGENTS.md` as functional config too, not documentation.

If **every** target file is documentation, short-circuit:

1. Emit: `Documentation-only changeset ({N} files) — skipping code review. Re-run with --force --reason "<text>" to review anyway.`
2. If the review was auto-scoped to uncommitted changes or scoped via `--since <base>` (issue #1904 Bug 2b — same extension as step 9's own gate condition, and for the same reason: `/pr`'s only path to `gh pr create` reviews via `--since <base>`), write the `.pr-review-passed` gate file (per step 9) so `hooks/pre_pr_review.py` allows the next `gh pr create`. **Contemporaneously** (before or immediately after that write), record the doc-only exemption as an explicit, auditable boundary event — the `.pr-review-passed` gate's dispatch-ledger corroboration (#1461, #1886) reads this event, bound to the gate's own hash, to let the doc-only path stay exempt from agent-dispatch evidence without being a silent, unaccountable code-path skip:
   ```bash
   HASH=$(python3 "${CLAUDE_PLUGIN_ROOT}/hooks/lib/review_gate_hash.py" --branch-diff)
   mkdir -p .claude/memory && echo "$HASH" > .claude/memory/.pr-review-passed
   python3 "${CLAUDE_PLUGIN_ROOT}/hooks/lib/boundary_events.py" --event doc-only --subject-hash "$HASH"
   ```
3. In `--json` mode, emit `{"status": "skipped", "reason": "documentation-only", "files": [<list>]}` instead.
4. **Stop.** Do not run pre-flight gates, static analysis, or any agent.

**Bypass:** the short-circuit does **not** apply with `--force` (with `--reason`), `--agent <name>`, or `--background` (drift review always inspects docs).

### 1b. Check for institutional context

If `REVIEW-CONTEXT.md` exists at the repo root, read it and pass its contents to every agent in step 4, prefixed with: "Institutional context provided for this review:". This file is optional.

### 1c. Probe for optional MCP tools

| Tool | Check | Use |
| --- | --- | --- |
| RoslynMCP | `get_code_metrics` / `search_symbols` available | C# metrics, compiler diagnostics |
| CodeGraph | `.codegraph/` present / `mcp__codegraph__codegraph_explore` available | Verified structural skeletons, resolved callers/callees/impact |
| Repowise | `get_context` / `get_symbol` / `search_codebase` / `get_risk` available | Verified file/symbol context + modification-risk lookups |
| Documentation MCP | wiki/docs search available | Architecture docs |
| Semgrep | `which semgrep` | SAST context for security-review |

Pass availability info to each agent so they can use enhanced tools or fall back to Glob/Grep/Read. All read-only review agents grant these MCP tools; see [`knowledge/codegraph-vs-graphify.md`](../../knowledge/codegraph-vs-graphify.md) for tool selection and the fallback contract. Include availability in the final report per `knowledge/review-template.md`.

