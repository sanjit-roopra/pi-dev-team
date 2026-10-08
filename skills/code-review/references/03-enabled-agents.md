<!-- step 3 (agent eligibility and the change-shape, change-size and diff-signal gates). Upstream text of skills/code-review/SKILL.md, unchanged; the pi core SKILL.md summarizes it. Everything below the marker is verbatim. -->
<!-- verbatim-below -->
### 3. Determine enabled agents

If `--background`: run only `doc-review`, `arch-review`, `naming-review`, `structure-review`. Skip all others.

Otherwise read the roster from the **Review Agents** section of `knowledge/agent-registry.md` — each row names an agent and its `agents/<name>.md` file. **Never `Read` the bare `agents/` directory** (it throws `EISDIR`); if you must confirm files on disk, list them with `Glob("agents/*.md")`, never a directory `Read` (see `${CLAUDE_PLUGIN_ROOT}/knowledge/directory-enumeration.md`). All are enabled by default.

**Agent eligibility is resolved by `select_lenses.py` (#1523).** For a diff-scoped run (auto-scope or `--since <ref>`) compute the changed-file list first — the same helper step 4 reuses for the `project-structure` context payload, so this is one computation feeding two consumers, not two ways to derive the same fact (#1733, #1734). **Always** carry the same `-c diff.relative=false -c core.quotePath=false` overrides step 1's own listing uses — omitting them here would let a repo/global `diff.relative=true` (or a non-ASCII path under default `core.quotePath`) desync this list from step 1's `--files`, silently zeroing every `--added` membership match below:

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

`$CHANGED_JSON` holds `{"files": [{"path", "status"}, ...], "added": [...]}`. Extract both lists into their own variables **first, with an explicit failure check** — a process substitution's own exit status is invisible to the command it feeds, so if the extraction silently produced nothing this step is where that must be caught, not left for `select_lenses.py` to (indistinguishably) treat as "nothing changed":

```bash
FILES_LIST=$(printf '%s' "$CHANGED_JSON" | python3 -c 'import json, sys; print("\n".join(f["path"] for f in json.load(sys.stdin)["files"]))') \
  || { echo "ERROR: failed to extract file list from CHANGED_JSON" >&2; exit 1; }
ADDED_LIST=$(printf '%s' "$CHANGED_JSON" | python3 -c 'import json, sys; print("\n".join(json.load(sys.stdin)["added"]))') \
  || { echo "ERROR: failed to extract added-file list from CHANGED_JSON" >&2; exit 1; }
```

Now run, feeding those two variables — not a separately-interpolated `<target files>` placeholder — to `select_lenses.py` via `--files-from`/`--added-from` process substitution:

```bash
python3 "${CLAUDE_PLUGIN_ROOT}/scripts/select_lenses.py" \
  --files-from <(printf '%s\n' "$FILES_LIST") \
  --added-from <(printf '%s\n' "$ADDED_LIST")
```

Deriving both from the same quoted `$CHANGED_JSON` variable — rather than re-interpolating individual paths as shell words — is what actually closes the injection surface; `--files-from`/`--added-from` on their own only fix the two hazards specific to `select_lenses.py`'s **own** argv parsing (a path beginning with `-` reinterpreted as a flag; word-splitting on an unquoted space) and do not by themselves protect a caller that builds their input by shell-interpolating untrusted path text some other way. For `--path`/`--all`/the full-repository fallback, where there is no diff and therefore no `$CHANGED_JSON`, this skill still passes the target-file list as plain `--files <target files>` argv, matching every other file-list-consuming script call in this skill (`change_shape.py`, `change_size.py`, `closing_pass.py`) — narrowing that broader, pre-existing pattern is a separate initiative, not part of this fix.

Always pass `--added-from` for a diff-scoped run, **even when `added` is `[]`** — an empty process substitution still supplies an explicit empty set (narrows away any added-only lens), whereas omitting the flag entirely reverts to the fail-safe fallback (matches an added-only `Scope:` like a plain glob list). Omit both `--files-from` and `--added-from` only for `--path`/`--all`/the full-repository fallback.

Take its `lenses` array as the Scope-eligible roster, and **surface its `warnings`** in the review output — a bare agent name means that agent is missing its `Scope:` declaration and was included include-biased; `unnarrowed-added-only:<name>` (#1733) means an added-only lens was kept un-narrowed (matched like a plain glob list) because this run supplied no `--added`/`--added-from`; `skipped-non-executable:<name>` (#1923) means a `Scope: always` lens on the resolver's own `NON_EXECUTABLE_SKIP_ELIGIBLE` allowlist (`correctness-review` today) was dropped from `lenses` because every changed file matched a docs/config/asset/lockfile pattern that lens's own `## Skip` clause already covers — this is a deliberate cost optimization, not a coverage gap, so treat it as informational rather than `fail`-equivalent, distinct from the two shapes below; `unreadable-registry:<file>` means the roster could not be read at all; `unreadable-files-from:<path>`/`unreadable-added-from:<path>` mean the named `--files-from`/`--added-from` source could not be read — **treat either as equivalent to a `fail` status** for this run (an unreadable source is not "nothing changed") rather than proceeding as if the (now-truncated) file list were complete. Never silently drop any of these shapes from the report. The resolver reads each review agent's body-level `Scope:` declaration — `Scope: always` (eligible for any non-empty changeset), a glob list (eligible only when at least one target file matches a declared glob), `Scope: added-only` + globs (eligible only when a target file matching a declared glob was newly *added* — `component-architecture-review`'s dual-placement rule, #1733: unconditional in `/repo-review`, added-only here), `Scope: test-files` (eligible only when a changed file is a test file, resolved against `knowledge/test-file-indicators.md`'s single shared encoding rather than a glob list, which could not express `test_*.py`, `__tests__/`, or the C#/Java annotation indicators — `test-smell-review` declares this, #1978; note `test-review` deliberately stays `Scope: always`, because its coverage-gap check must see production diffs that add code *without* a matching test), or `Scope: on-demand` (never eligible for this per-diff roster at all — `token-efficiency-review`, `ai-provenance-review`, and `claude-setup-review` declare this; they are repo-wide drift/trend metrics dispatched instead by the whole-tree `/repo-review` command, #1735, and `refactor-opportunity-review` declares it too, #1976, dispatched by name at `/build`'s slice review checkpoint where its post-GREEN charter actually applies). `Scope:` is a body declaration, not frontmatter (`agent-contract.json`). This is the single source of truth shared with `/build`'s inline checkpoints: adding or changing an agent's trigger scope needs only an edit to that agent's own body — zero edits to this skill. (The framework-reactivity agents react/vue/angular are **not** in the resolver's roster; they are governed by the manifest rule below.)

**Framework-specific reactivity review** — dispatch based on the project's dependency manifest (`package.json` etc.):

- React (`react` / `react-dom` in deps): include `react-reactivity-review` scoped to `.jsx`/`.tsx` and React-importing `.js`/`.ts` files
- Vue (`vue` in deps): include `vue-reactivity-review` scoped to `.vue` and Vue-importing `.js`/`.ts` files
- Angular (`@angular/core` in deps): include `angular-reactivity-review` scoped to `*.component.ts`, `*.component.html`, `*.service.ts`, and general `.ts` files

If `review-config.json` exists at the repo root, honor its per-agent `"enabled": false` flags.

**Change-shape gate for low-yield lenses (#1254).** After the eligible roster is
known, drop the two low-yield code lenses (`performance-review`,
`correctness-review`) when the changeset has **no runtime surface** — every
target file is documentation or config, so those lenses would only no-op. Decide
deterministically with the shared helper (not by eyeballing the file list):

```bash
python3 "$CLAUDE_PLUGIN_ROOT/skills/code-review/scripts/change_shape.py" --files <target files>
```

It prints `{"hasRuntimeSurface": <bool>, "isTestOnly": <bool>, "isProseOnly":
<bool>, "skipLenses": [...]}`. When `skipLenses` is non-empty, exclude those
agents from this run and note the skip in the report (they were gated by
change shape, not by `Scope:`).

`isProseOnly` (#2104) reports a third, independent property: every changed
file is `.md`/`.mdx`. Unlike `hasRuntimeSurface`, this makes **no** exception
for functional Claude-config markdown (`agents/`, `skills/`, `knowledge/`,
`.claude/`, …) — that markdown drives agent behavior, so `performance-review`
and `correctness-review` still apply to it, but a `.md` file cannot exhibit an
injection/auth/data-exposure vulnerability, a domain-boundary leak, a
test-coverage gap, or a resource leak/N+1 query regardless of whether it also
happens to be functional config. When `isProseOnly` is true, `skipLenses`
additionally drops `security-review`, `domain-review`, `test-review`, and
`performance-review` — each of those four agents' own `## Skip` clause
already self-reports skip on a documentation-only target, so keeping them in
the roster either pays for a self-reported skip or, worse, produces an
ungrounded finding stretched to fit the lens (the motivating case: a 9-agent
panel dispatched against a single-file skill-markdown diff produced
elaborate security/domain/test/performance framing for what were really
prose nits). `correctness-review`, `spec-compliance-review`, `doc-review`,
`structure-review`, `naming-review`, and `arch-review` stay in the roster —
they meaningfully review markdown-as-instructions. This is narrower than
`select_lenses.py`'s own `NON_EXECUTABLE_SKIP_ELIGIBLE` allowlist, which
considered and rejected filtering `security-review`/`domain-review` for its
broader "non-executable" category (docs **and** config/lockfiles/assets) —
see that module's comment. This gate never widens to config, so that
rejection does not apply here.

`isTestOnly` (#1964) reports a second, independent property: every changed file
is *provably* a test file (`knowledge/test-file-indicators.md`). It currently
**gates nothing** — `change_shape.py`'s `TEST_ONLY_SKIP_LENSES` ships empty —
and exists so `/build` can stamp `diff_shape` on its `review-value.jsonl` rows
and `/harness-audit` can split per-lens outcomes by it. Populating that list is
a separate, per-lens decision that must cite the measured split, exactly as the
architectural-impact gate requires for widening `GATED_LENSES`. Read the field
for telemetry; do not narrow a roster on it until it does gate something. The gate is **fail-safe**: any
file it cannot prove is doc/config (source, an unknown extension, or functional
Claude-config markdown under `agents/`, `skills/`, `knowledge/`, `.claude/`, …)
counts as runtime surface and keeps every lens. This never fires on a pure-docs
changeset — that is already handled earlier by the documentation-only
short-circuit; this gate covers the doc/config-**mixed** and config-only diffs
the short-circuit does not. Bypassed by `--force` and by `--agent <name>` (an
explicit single-agent request always runs that agent).

**Change-size gate for small changesets (#1339).** After `Scope:` eligibility
and the change-shape gate above have both been applied, apply this gate —
never before, and never in a way that re-adds an agent either already removed.
It narrows the `Scope: always` roster by diff *size* rather than file *type*:
the pre-PR hook (`hooks/pre_pr_review.py`, #1886) requires a `.pr-review-passed`
hash match **and** (#1461, floor lowered to 1 by #2147) >= 1 distinct, recent,
registered review-agent dispatch recorded in the dispatch ledger — so this
gate must never narrow `keepAgents` below 1, and today's four-agent floor
(`security-review`, `correctness-review`, `spec-compliance-review`,
`doc-review`) clears that with room to spare. Which specific agents to keep at
a given diff size remains this step's decision, not the hook's — the hook
only enforces the *count*
floor, never which agents satisfy it.

**Applies only to diff-scoped reviews** — auto-scoped uncommitted changes, or
`--since <ref>`. `--path`, `--all`, and the full-repository fallback review
complete files, not a diff, so this gate never engages for those scopes
(existing eligibility unchanged).

Compute the numstat lines and feed them to the shared helper — for auto-scope,
union unstaged and staged the same way step 1 unions `--name-only`:

```bash
# Auto-scope (uncommitted changes):
{ git diff --numstat; git diff --cached --numstat; } | python3 "$CLAUDE_PLUGIN_ROOT/skills/code-review/scripts/change_size.py" --numstat-from -

# --since <ref>:
git diff --numstat <ref>...HEAD | python3 "$CLAUDE_PLUGIN_ROOT/skills/code-review/scripts/change_size.py" --numstat-from -
```

It prints `{"filesChanged": <int>, "addedLines": <int>, "qualifiesForFastPath":
<bool>, "keepAgents": [...]}`. When `qualifiesForFastPath` is `true`, drop
every `Scope: always` agent **not** in `keepAgents` (today: `security-review`,
`correctness-review`, `spec-compliance-review`, `doc-review` — the four lenses
that stay meaningful at any diff size; the rest are code-quality-at-scale
concerns a diff this small essentially cannot exhibit meaningfully) and note
the drop in the report (gated by change size, not by `Scope:`).
`Scope:`-glob-matched agents are unaffected — they already run only against
matching file types, so a diff this small already narrows their incremental
cost to near-zero. The gate is **fail-safe**: any `git diff --numstat` error,
binary-file marker, or unparseable line disqualifies the run (full panel), as
does any file under `hooks/` or `skills/code-review/` (the enforcement
machinery and this gate's own orchestration) — a change there is exactly the
case where a cheap, self-certifying review is a problem, so it never qualifies
for the shortcut it defines, regardless of size. Bypassed by `--force` and by
`--agent <name>`, matching the change-shape gate's bypass list.

**Diff-signal gate for structural and concurrency lenses.** Apply this
**third**, after `Scope:` eligibility, the change-shape gate, and the
change-size gate — never before, and never to re-add an agent an earlier gate
already removed. It narrows by *what the diff's content proves is absent*
rather than by file type or diff size, and it gates two lenses:
`arch-review` (structural signals) and `concurrency-review` (concurrency
primitives, #1975).

`arch-review` is `Scope: always` and opus-tier, so it runs on every non-empty
changeset — including diffs that cannot exhibit what it looks for. Its scope
is ADR compliance, layer-boundary violations, dependency direction, and
pattern consistency: all properties of *structure*. A diff that adds a guard
clause inside an existing function, with no import change, no added/moved/
deleted file, no manifest edit, and no public-interface change, has moved no
boundary for it to evaluate. Decide deterministically:

```bash
# Auto-scope (uncommitted changes):
{ git -c diff.relative=false diff --no-color; git -c diff.relative=false diff --cached --no-color; } \
  | python3 "$CLAUDE_PLUGIN_ROOT/skills/code-review/scripts/change_impact.py" --files <target files>

# --since <ref>:
git -c diff.relative=false diff --no-color <ref>...HEAD \
  | python3 "$CLAUDE_PLUGIN_ROOT/skills/code-review/scripts/change_impact.py" --files <target files>
```

It prints `{"signals": [...], "hasArchitecturalImpact": <bool>, "skipLenses":
[...], "reason": <str|null>}`. Exclude any agent in `skipLenses` and note the
skip in the report (gated by diff signal, not by `Scope:`). The seven signals
are `structure` (file added/deleted/renamed), `dependency` (an import/require
line added or removed), `manifest`, `infra`, `interface` (a public/exported
symbol declaration added or removed), `adr`, and `concurrency` (a concurrency
primitive added, removed, **or visible in a hunk's context lines** —
async/await, threads, locks, channels, atomics; removing synchronization is a
concurrency change exactly as much as adding it, and the context lines are
what keep the lens on a body-only edit inside an already-locked block, which
carries no primitive on its own changed line). `hasArchitecturalImpact` reports only the first six: a diff whose
sole signal is `concurrency` has moved no boundary, so it keeps
`concurrency-review` while `arch-review` still drops.

The gate is **fail-safe and include-biased**: an unparseable diff, an empty
diff, or any file it cannot classify all count as impact and keep every lens.
It can only remove a lens it can prove has nothing to look at. Bypassed by
`--force` and `--agent <name>`, matching the other two gates' bypass list.

**Only these two lenses are gated, deliberately.** Both pass the same test —
the lens's subject must be *provably absent* from the diff, not merely
unlikely to appear in it: `arch-review` reviews structure, and
`concurrency-review` reviews races, async ordering, idempotency, and
shared-state safety, none of which can exist where no concurrency primitive
does. `domain-review`
is the obvious next candidate and is excluded on purpose: its scope covers
"business logic placement", and putting business logic into a controller
method body is a real violation introduced by a *body-only* edit with no
structural signal — exactly the diff shape this gate skips. Widen
`GATED_LENSES` from #1624's measured per-agent data, not from intuition about
which lens probably no-ops. Same evidence-first discipline
`knowledge/verification-mode.md` applies to tier-down opt-ins.

