#!/usr/bin/env python3
"""Sync upstream bdfinst/agentic-dev-team `plugins/dev-team` into this pi package.

Usage:
  python3 sync/sync_upstream.py --upstream /path/to/agentic-dev-team

What it does (idempotent, stdlib only):
  1. Replaces the managed directories (agents, skills, hooks, scripts, knowledge,
     templates, tools, docs/upstream) with fresh copies from upstream.
  2. Drops skills that only make sense inside Claude Code (DROPPED_SKILLS).
  3. Copies pi-specific replacements from overrides/ over the result. A slim
     skill's override also carries its upstream text, unchanged, split into
     references/ by sync/split_skill_references.py.
  4. Normalises SKILL.md frontmatter for pi (description <= 1024 chars).
  5. Applies the small, explicit text patch sets (PATCHES, and LEAN_PATCHES for lean production code). Every patch must
     match at least once, so upstream drift is caught instead of silently
     skipped.
  6. Rebuilds knowledge/index.json.
  7. Writes UPSTREAM.json (commit, version, what was dropped/overridden/patched).

Everything not listed here (extensions/, bin/, sync/, overrides/, test/,
PORTING.md, README.md, package.json) is owned by the port and never touched.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import shutil
import subprocess
import sys
from pathlib import Path

PKG = Path(__file__).resolve().parent.parent
PLUGIN_SUBDIR = Path("plugins/dev-team")

MANAGED_DIRS = ["agents", "skills", "hooks", "scripts", "knowledge", "templates", "tools"]
UPSTREAM_DOCS_DEST = Path("docs/upstream")

# Skills that test, audit or drive Claude Code itself. See PORTING.md section 4.
DROPPED_SKILLS = [
    "agent-audit",
    "agent-eval",
    "claude-setup-review",
    "harness-e2e-check",
    "long-eval",
    "orchestration-benchmark",
    "session-review",
]

IGNORE = shutil.ignore_patterns("__pycache__", "*.pyc", ".pytest_cache", ".mypy_cache", ".ruff_cache")

DESCRIPTION_LIMIT = 1024

# Overrides that replace an upstream file, with the sha256 of the upstream
# version each one was ported from. When upstream changes one of these files,
# the override would silently discard that change, so sync fails until the
# override is re-ported and its hash updated here.
OVERRIDE_BASES: dict[str, str] = {
    "hooks/pre_tool_guard.py": "761e83e9d9bb66544ce465aaf301d0d5a52fd84b988238e6b947a0202dcdc3d5",
    "hooks/guards.json": "03916b358d3f5c5036d9517222d469f85404dc3c9cde1364dfb4d3bc7422c54b",
    # Slim core + verbatim references (sync/split_skill_references.py); re-port when upstream changes it.
    "skills/code-review/SKILL.md": "97d0b514bef1a8b9ee18c8e6d043419c0c43fffd1ab701aea3beaf5f9edb6303",
    # The simplify lens (PORTING.md section 5); the other lean-code agent edits are LEAN_PATCHES.
    "agents/refactor-opportunity-review.md": "e25b0d4ffe63dd4afd6a4dde59961145b2eb89d02e7523fadcd98e5b2d376f35",
    # pi-specific rewrites of upstream skills.
    "skills/upgrade/SKILL.md": "f04da3363a3ed9c9ff5887bd744715d9094e8366645fb5cee53f87170af418e2",
    "skills/version/SKILL.md": "b732c81872fb2b3ccf9c01841e4c8aa5a2c14f349b0c1a99c5474b8d4936277b",
    "skills/headless-run/SKILL.md": "080af9400a03d3c6152350646edbe016d70e381dc8654be8cf410d2c9134a855",
}

# Lean production code (PORTING.md section 5): the lean fix rule, word for word as in the code-review core, and
# the agent edits that carry it. Production code only; test scope stays with the Gherkin scenarios.
LEAN_FIX_RULE = (
    "**Lean fix rule (production code only).** A `warning` whose fix restructures code (extracts a function, splits a "
    "module, or introduces a type, interface, parameter object, wrapper or layer) and adds more production lines than it "
    "removes counts as a `suggestion` with confidence `none`: rewrite it so in the findings JSON before any script reads "
    "it, report it, never auto-apply it, and keep it out of the fix loop, overriding any actionability table that says "
    "otherwise (`/code-review` step 5b and `skills/code-review/references/05-aggregate.md`, "
    "`knowledge/three-phase-workflow.md` § Review Loop). `error` findings are unaffected. Exempt: every finding from `security-review`, `concurrency-review` or "
    "`correctness-review`; fixes that correct behavior (a bug, a race, a missing check or cleanup, a security or "
    "accessibility gap); a seam for a collaborator the blocker table in `knowledge/internal-collaborator-doubling.md` "
    "lets a test double (B1–B3); and test files (`knowledge/test-file-indicators.md`), fixtures and test helpers."
)
REUSE_LADDER = """- **Simplicity First (pre-write reuse ladder).** Read the code the change touches and trace the real flow first: be lazy about the solution, never about understanding the problem. Then walk this ladder and stop at the first rung that holds:
  1. Does it need to exist? Nothing asked for it, no scenario demands it and the design does not imply it → do not write it. The design implies synchronization, idempotency, transactions, retries and cleanup on error paths wherever state is shared, work is retried or resources are held.
  2. Does the codebase already have it? Call it.
  3. Does the standard library do it?
  4. Does the platform or framework do it natively?
  5. Does an already-installed dependency do it? Never add a dependency to save a few lines, with one exception: security primitives (cryptography, password hashing, token validation, sanitizing or escaping, parsers for untrusted input) always come from the standard library or a vetted library, never hand-rolled.
  6. Otherwise write the minimum that works: no speculative options, no single-use abstraction (an interface with one implementation, a wrapper or factory used once, a layer that only forwards) except a seam the blocker table in `knowledge/internal-collaborator-doubling.md` allows (B1–B3) or a helper that holds synchronization, a lock, atomics, idempotency, a transaction, a retry or cleanup, no configurability nobody asked for.

  Fewer lines, never denser lines: clarity beats brevity. No nested ternaries, no clever one-liners, no packing several steps into one expression to save a line. Never cut input validation, error handling at a real boundary, security, accessibility, synchronization, idempotency, transactions, retries or cleanup on error paths to save lines: they are requirements the design implies, even when no scenario names them.

  The ladder governs production code only. Test scope comes from the plan's Gherkin scenarios, never from this rule: write every test they call for.

  A deliberate shortcut gets a `shortcut:` comment at the spot, naming what it skips and when that would need revisiting, so `grep -rn "shortcut:"` lists the debt."""
LEAN_PATCHES: list[tuple[str, str, str, str]] = [
    (
        "agents/software-engineer.md",
        re.escape("- End-of-turn: one sentence on what was implemented and what tests confirm it.\n"),
        "- End-of-turn: one sentence on what was implemented and what tests confirm it, then one `Skipped:` line naming "
        "what you deliberately left out or did not check, and any problem you noticed but did not touch (a bug, dead or "
        "stale code), with the risk (`Skipped: none` when nothing was).\n",
        "lean production code: the engineer names what it skipped",
    ),
    (
        "agents/software-engineer.md",
        re.escape("(mention it instead, don't delete it)"),
        "(name it in your `Skipped:` line instead, don't delete it)",
        "lean production code: noticed dead code goes to Skipped:",
    ),
    (
        "agents/software-engineer.md",
        re.escape("- **Simplicity First (pre-write).** Before writing, choose the minimum code that solves the stated problem. "
                  "No speculative features, no single-use abstractions, no configurability nobody asked for."),
        REUSE_LADDER,
        "lean production code: the reuse ladder",
    ),
    (
        "agents/structure-review.md",
        re.escape("DRY violations:\n\n- Duplicated code blocks\n- Copy-paste patterns\n"),
        "DRY violations (rule of three):\n\n- The same block three or more times, or twice when both copies encode the same "
        "business rule (\"if the rule changes, must both change?\")\n- Two structurally similar blocks are not a finding\n",
        "lean production code: rule of three",
    ),
    (
        "agents/structure-review.md",
        re.escape("- Hardcoded dependencies (not injected)\n"),
        "- A hardcoded collaborator that the blocker table in `${CLAUDE_PLUGIN_ROOT}/knowledge/internal-collaborator-doubling.md` "
        "lets a test double (B1 out-of-process handle, B2 ambient state, B3 prohibitive cost), so a test cannot replace it. "
        "Other first-party collaborators constructed inline are not a finding\n- Module-level or static mutable state (a cache, "
        "registry or counter) shared across calls or requests: a shared-state finding. Propose scoping it or passing it "
        "explicitly; propose injection only for a B1–B3 collaborator. It is a race only when two accesses can interleave "
        "(concurrent entry, or an await between read and write); leave races to `concurrency-review`\n",
        "lean production code: inject only what the blocker table allows doubling",
    ),
    (
        "agents/structure-review.md",
        re.escape("## Authoring checklist\n"),
        LEAN_FIX_RULE + "\n\nEmit such findings as `suggestion` with confidence `none` yourself, and never rate a restructure "
        "that grows production code `error` unless it corrects behavior. Never propose an abstraction for a single use (one "
        "implementation, one caller, one value), except a seam the blocker table allows.\n\n"
        "## Authoring checklist\n",
        "lean production code: structure-review demotes growing restructures at the source",
    ),
    (
        "agents/structure-review.md",
        re.escape('- One responsibility per function/module; split when you need "and" to describe it.\n'
                  "- Inject dependencies; don't construct collaborators inline.\n"),
        "- One responsibility per module; inside a function, prefer early returns to new helpers.\n- Inject only what the blocker table (B1–B3 in "
        "`knowledge/internal-collaborator-doubling.md`) allows doubling: out-of-process handles, ambient state (clock, RNG, "
        "env, locale), prohibitive cost. Construct other first-party collaborators directly.\n",
        "lean production code: authoring checklist without single-use helpers",
    ),
    (
        "agents/structure-review.md",
        re.escape("- Before copying a block, extract it; third repeat is a defect.\n"),
        "- Two copies are fine; extract at the third, or at the second when both encode the same business rule.\n",
        "lean production code: rule of three at write time",
    ),
    (
        "agents/structure-review.md",
        re.escape("- Are there hidden static singletons or global state that aren't injected?\n"
                  '- For every "duplicate code" finding, did you verify it\'s semantic duplication and not just structural '
                  "similarity?\n"),
        "- Are there hidden static singletons or module-level mutable state shared across calls or requests? Report shared "
        "mutable state; propose injection only for a B1–B3 collaborator.\n"
        "- For a two-copy duplication finding, did you apply the semantic test? For three or more copies, did you confirm "
        "they are really the same block?\n",
        "lean production code: self-challenge matches the rule of three",
    ),
    (
        "agents/quality-reviewer.md",
        re.escape("| error or warning | high or medium | **Yes** — auto-apply |"),
        "| error or warning | high or medium | **Yes** — auto-apply, unless the lean fix rule below makes it a suggestion |",
        "lean production code: the fix-loop table defers to the lean fix rule",
    ),
    (
        "agents/quality-reviewer.md",
        re.escape("| suggestion | any | No — report only |\n"),
        "| suggestion | any | No — report only |\n\n" + LEAN_FIX_RULE + "\n",
        "lean production code: restructuring that grows production code is report-only",
    ),
    (
        "agents/plan-review-strategic.md",
        re.escape("4. **Root cause vs. symptom**"),
        "4. **Reuse before new code** — For each step that adds production code, does the plan name what it reuses (an "
        "existing function, the standard library, a platform feature, an installed dependency), or mark it `new:` with a "
        "reason? A step that builds what the codebase, standard library, platform or an installed dependency already "
        "provides is over-engineered. Tests are exempt: test scope comes from the Gherkin scenarios.\n"
        "5. **Root cause vs. symptom**",
        "lean production code: plans name their reuse",
    ),
    (
        "agents/plan-review-strategic.md",
        re.escape('    "minimum_viable_subset": "<which criteria/steps form the smallest useful increment>"\n  },'),
        '    "minimum_viable_subset": "<which criteria/steps form the smallest useful increment>",\n'
        '    "proposed_cut": "<at least one step, criterion, option or abstraction the plan can drop or defer, and why that '
        'is safe; never a security, validation or test step; none only after you looked for one>"\n  },',
        "lean production code: the strategic critic proposes a cut",
    ),
    (
        "agents/plan-review-strategic.md",
        re.escape("- Simpler alternative not considered → `warning`\n"),
        "- Simpler alternative not considered → `warning`\n- A production step builds what the codebase, standard library, "
        "platform or an installed dependency already provides → `warning`\n",
        "lean production code: reinventing is a warning",
    ),
]

# Speed-ups that skip no quality step (PORTING.md section 5): the build phase record is written by one helper
# command that shares a message with real work, the final verification and the Farley Score go out in one message,
# and review lenses and plan critics think at medium effort.
BUILD_PHASE_CMD = 'python3 "${CLAUDE_PLUGIN_ROOT}/scripts/build_phase.py"'
BUILD_PHASE_ANCHOR = 'treats an absent/non-`refactor` record as "nothing to enforce").\n'
BUILD_PHASE_RULE = (
    "**Write the record with one command, never in a turn of its own (pi port).** `" + BUILD_PHASE_CMD + " "
    "<implement|test|refactor|between-steps> <N.M> [--plan <plan path>] [--stage <test file>...]` writes the record "
    "above (a fresh `written_at`; `plan_path` carried over from the current record when `--plan` is left out; "
    "`test_files_staged` only for `refactor`), and `build_phase.py clear` deletes it. Do not write the record with a "
    "heredoc or the Write tool, and never spend a model turn on it alone:\n\n"
    "- **IMPLEMENT, TEST, `between-steps`.** No guard reads these, so send the call in the same message as the "
    "phase's next edit or test run (a parallel tool call, or chained into that bash command).\n"
    "- **Entering REFACTOR.** Chain it onto the green test run: `set -o pipefail; <test command> && " + BUILD_PHASE_CMD
    + " refactor <N.M> --stage <the step's test files>`. `--stage` runs `git add` on those files (new and untracked "
    "ones too) and records them in `test_files_staged`, so the record always matches the index baseline.\n"
    "- **Leaving REFACTOR.** Chain the next marker onto the post-refactor green test run: `set -o pipefail; <test "
    "command> && " + BUILD_PHASE_CMD + " implement <N.M>` (or `between-steps <next N.M>`). Never chain it onto a "
    "command that runs no tests (a commit alone), and never send it as a parallel call beside edits: until it has run "
    "the record still says `refactor`, so `refactor_test_freeze_guard.py` blocks a test edit and "
    "`refactor_test_revert_guard.py` restores test files after every bash call.\n"
    "- **`set -o pipefail` is required in both chains.** `&&` sees only the exit status of a pipeline's last "
    "command, so without it a red run piped into `tail` or `head` counts as green and the marker is written anyway. "
    "With it, the marker runs only when the tests passed.\n"
)
BUILD_PHASE_HANDOFF_ANCHOR = "delete it instead when this was the plan's last step.\n"
FINAL_VERIFY_ANCHOR = (
    "After all steps are complete, delete `.claude/memory/build-phase.json` if a `between-steps` record remains, then "
    "run the full test suite. Paste the output as final verification evidence.\n"
)
FINAL_VERIFY_RULE = (
    "**One message for the final verification and the Farley Score (pi port).** First resolve only Step 7 sub-steps "
    "1–2 (the branch base and the branch's changed test files: cheap git reads). Do not act on sub-step 3 here: its "
    "skip line and its \"continue to Step 8\" belong to Step 7, after Step 6 has run. Then send one assistant message "
    "with both calls, so they run at the same time:\n\n"
    "1. One bash call: `" + BUILD_PHASE_CMD + " clear`, then the full test suite and the lint, type-check and "
    "complexity tools the build ran (for example `ruff`, `python -m compileall`, `lizard`), each followed by its own "
    "exit code and joined with `;` so one failure does not hide the next result, for example `<suite>; echo "
    "\"SUITE_EXIT=$?\"; ruff check <files>; echo \"RUFF_EXIT=$?\"; ...`. The call's own exit status is only the last "
    "tool's, so read the tags: the suite is red when `SUITE_EXIT` is not 0, and a tool failed when its tag is not 0.\n"
    "2. When Step 7 found changed test files, the Step 7 Farley Score as a `dev_team_subagent` dispatch of "
    "`qa-engineer`: load the `farley-score` skill, score exactly those files, change no file, and return the "
    "suite-level Farley Score, rating and distribution.\n\n"
    "Step 7 sub-step 4 then presents that result instead of scoring again. Dispatch the Farley Score once more, after "
    "the fix, when the suite is red, or when Step 6 or any later fix changes or adds a test file on the branch; "
    "otherwise the first result stands.\n"
)
FARLEY_STEP7_ANCHOR = "4. Otherwise invoke the `farley-score` skill scoped to those files. "
FARLEY_STEP7_RULE = (
    "4. Otherwise present the Farley Score from Step 5's `qa-engineer` dispatch, or from its re-run when Step 5 says "
    "to dispatch it again (pi port); invoke the `farley-score` skill scoped to those files here only when Step 5 did "
    "not dispatch it. "
)
ENGINEER_TOOL_ANCHOR = (
    "A `PostToolUse` hook that rewrites files (e.g., a formatter) may have changed the file since your last Write/Edit.\n"
)
ENGINEER_BUILD_PHASE_RULE = (
    "- **Build phase record.** When your task runs `/build`'s per-behavior cycle and you keep "
    "`.claude/memory/build-phase.json` (your task says so, or you enter REFACTOR with no `refactor` record present), "
    "write it only with `" + BUILD_PHASE_CMD + "` (`skills/build/SKILL.md`, Phase-state bookkeeping), never with a "
    "heredoc and never in a turn of its own: IMPLEMENT and TEST markers go in the same message as that phase's next "
    "edit or test run; enter REFACTOR with `set -o pipefail; <test command> && " + BUILD_PHASE_CMD + " refactor <N.M> "
    "--stage <test files>`; leave it by chaining the next marker onto the post-refactor green test run the same way "
    "(`set -o pipefail; <test command> && ...`), never onto a command that runs no tests and never as a parallel call "
    "beside edits. Without `set -o pipefail`, a red run piped into `tail` or `head` still lets the marker run.\n"
)
# Review lenses and plan critics that think at medium effort. Kept at high: correctness-review,
# plan-review-acceptance, software-engineer and qa-engineer (which runs /build's Farley Score);
# spec-compliance-review is medium upstream. refactor-opportunity-review is an override: its file says medium itself.
MEDIUM_EFFORT_AGENTS = (
    "ai-provenance-review",
    "arch-review",
    "component-architecture-review",
    "concurrency-review",
    "domain-review",
    "naming-review",
    "performance-review",
    "security-review",
    "structure-review",
    "test-review",
    "test-smell-review",
    "token-efficiency-review",
    "plan-review-design",
    "plan-review-parallelization",
    "plan-review-strategic",
    "plan-review-ux",
)

# (glob relative to package root, regex, replacement, description)
PATCHES: list[tuple[str, str, str, str]] = [
    (
        "skills/plan/SKILL.md",
        r"or stdin is not a usable TTY \(`test -t 0` is false — the headless/CI/automation case\)",
        "or `DEV_TEAM_INTERACTIVE` is not `1` (pi sets it only when a human UI is attached; "
        "a tool shell never has a TTY, so `test -t 0` must not be used — the headless/CI/automation case)",
        "interactivity: tool shells have no TTY in pi",
    ),
    (
        "skills/build/SKILL.md",
        r"or stdin is not a usable TTY \(`test -t 0` is false — the headless/CI/automation case\)",
        "or `DEV_TEAM_INTERACTIVE` is not `1` (pi sets it only when a human UI is attached; "
        "a tool shell never has a TTY, so `test -t 0` must not be used — the headless/CI/automation case)",
        "interactivity: tool shells have no TTY in pi",
    ),
    (
        "skills/build/SKILL.md",
        r"(?s)\*\*Base-ref check \(top-level session.*?no crash-recovery surface\.\n",
        "**Base ref.** In pi, worktree subagents always branch from local HEAD; no setting or check is needed.\n",
        "worktrees: pi always branches from HEAD, so the Claude Code baseRef check is a false warning",
    ),
    (
        "agents/orchestrator.md",
        r"rule, and the \*\*`worktree\.baseRef` prerequisite users must set themselves\*\* — are",
        "rule — are",
        "worktrees: pi always branches from HEAD; no baseRef prerequisite",
    ),
    (
        "agents/orchestrator.md",
        r"; `/build`'s Step 4 detect-and-warn surfaces the `worktree\.baseRef`\nrequirement on every invocation regardless\.",
        ".",
        "worktrees: pi always branches from HEAD; no baseRef prerequisite",
    ),
    (
        "knowledge/three-phase-workflow.md",
        r"\*\*`worktree\.baseRef` prerequisite \(issue #553\)\.\*\*[^\n]*",
        "**Base ref.** In pi, worktree subagents always branch from local HEAD; no setting or check is needed.",
        "worktrees: pi always branches from HEAD; no baseRef prerequisite",
    ),
    (
        "knowledge/request-processing-flow.md",
        r" Worktree isolation requires Claude Code's `worktree\.baseRef` setting[^)]*\)\.",
        "",
        "worktrees: pi always branches from HEAD; no baseRef prerequisite",
    ),
    (
        "skills/review-agent/SKILL.md",
        r"Read `\.claude/agents/<name>\.md`\. If the file doesn't exist, list available\s+review agents from `\.claude/agents/`",
        "Read `.claude/agents/<name>.md` (project override) or else `${CLAUDE_PLUGIN_ROOT}/agents/<name>.md`. "
        "If neither exists, list available\nreview agents from `${CLAUDE_PLUGIN_ROOT}/agents/`",
        "agent definitions live in the package, not the project",
    ),
    (
        "skills/help/SKILL.md",
        r"1\. Use Glob to find every `skills/\*/SKILL\.md` file\.",
        "1. Use `find` to list every `${CLAUDE_PLUGIN_ROOT}/skills/*/SKILL.md` file, plus project skills in "
        "`.pi/skills/*/SKILL.md` and `.claude/skills/*/SKILL.md`.",
        "skills live in the package root",
    ),
    (
        "skills/triage/SKILL.md",
        r'Use the Agent tool with `subagent_type: "Explore"`',
        'Use the `dev_team_subagent` tool with `agent: "Explore"`',
        "Claude's built-in Explore agent is provided by the port",
    ),
    (
        "skills/context-loading-protocol/SKILL.md",
        r"Use at the start of every task to",
        "Use only for large multi-phase work (pi auto-compacts, so skip it for ordinary tasks) to",
        "ceremony: the context budget step does nothing for ordinary pi tasks",
    ),
    (
        "skills/performance-metrics/SKILL.md",
        r"Log task completion data to \.claude/metrics/\. Use at the end of every task to record",
        "Schema reference for .claude/metrics/. Hooks log task data, so do not invoke it at task end. Fields:",
        "ceremony: hooks log metrics, the skill writes nothing",
    ),
    (
        "agents/orchestrator.md",
        r"invoke at the start of every task to decide which agents and skills to load, and at phase transitions to unload/swap",
        "invoke only for large multi-phase work, to decide which agents and skills to load and unload at phase transitions",
        "ceremony: the context budget step does nothing for ordinary pi tasks",
    ),
    (
        "agents/orchestrator.md",
        r"invoke at task completion to log metrics, and during",
        "schema reference only (hooks log metrics); invoke during",
        "ceremony: hooks log metrics, the skill writes nothing",
    ),
    (
        "skills/build/SKILL.md",
        r"Invoke the \[Context Loading Protocol\]\(\.\./context-loading-protocol/SKILL\.md\) at the start of this task\..*?throughout the build\.",
        "Skip this unless the build is large and multi-phase; then invoke the "
        "[Context Loading Protocol](../context-loading-protocol/SKILL.md) to pick what to load per phase.",
        "ceremony: the context budget step does nothing for ordinary pi tasks",
    ),
    (
        "knowledge/telemetry-schema.md",
        r"`/performance-metrics` skill \(model-authored append at task completion\), via `hooks/task_completion_metrics\.py`",
        "`hooks/task_completion_metrics.py`",
        "ceremony: hooks log metrics, the skill writes nothing",
    ),
    (
        "knowledge/skills-registry.md",
        r"(?m)^\| `/(?:" + "|".join(map(re.escape, DROPPED_SKILLS)) + r")` \|.*\n",
        "",
        "the registry lists only skills the port ships",
    ),
    (
        "skills/specs/SKILL.md",
        r"\*\*Step C — Resolve `requires-stakeholder-input` items\.\*\* Collect all such items and present them as a single batch "
        r"to the human before writing acceptance criteria:\n\n> .*?\n\nWait for answers\. Only then finalize the criteria\.",
        "**Step C — Resolve `requires-stakeholder-input` items in rounds.** Load "
        "[`references/grilling.md`](references/grilling.md) and ask them in rounds: each round asks every open decision "
        "whose prerequisites are settled, with a recommended answer, then the next round asks what those answers opened. "
        "Stop when nothing is open, or at the first timeout (take that round's recommended answers, log them "
        "`assumed (timeout)`). Only then finalize the criteria.",
        "grilling: one batch of questions misses the questions its answers open",
    ),
    (
        "skills/specs/SKILL.md",
        r"  - If the marker is absent or predates the current skill version \(see frontmatter `version:`\):.*?\n"
        r"  - If the marker matches the current version:",
        "  - If the file has no `<!-- spec-version: 2 -->` line (the marker the body template in "
        "[`references/persistence.md`](references/persistence.md) writes): update it in place to the current template, "
        "keep every decision and log row, add the marker, and say so. Ask only when the user may want a fresh spec "
        "instead (recommended: update in place).\n"
        "  - If the marker is `<!-- spec-version: 2 -->`:",
        "spec version: compare with the marker the template writes, not a frontmatter field that does not exist",
    ),
    (
        "skills/specs/SKILL.md",
        r"\n\(Rec 1, `docs/experiments/RECOMMENDATIONS\.md`\)|, reported in\n`docs/experiments/02-final-results\.md`",
        "",
        "docs/experiments is not shipped",
    ),
    (
        "skills/specs/references/persistence.md",
        r"# Spec: <Feature Name>\n\n## Intent Description",
        "# Spec: <Feature Name>\n\n<!-- spec-version: 2 -->\n\n## Intent Description",
        "spec version: the template writes the marker /specs checks",
    ),
    (
        "skills/specs/references/persistence.md",
        r"(\| <decision text> \| `inferable` / `requires-stakeholder-input` \| inference / human \| <rationale or human's answer> \|\n)",
        "| <decision text> | `inferable` / `requires-stakeholder-input` | inference / human | <rationale or human's answer> |\n\n"
        "## Decision Log\n\n"
        "Every question asked in the grilling rounds and its answer.\n\n"
        "| Round | Question | Answer | Source |\n"
        "|-------|----------|--------|--------|\n"
        "| 1 | <question> | <answer> | `user` / `assumed (timeout)` / `assumed (no human)` |\n",
        "grilling: log every question and answer",
    ),
    (
        "agents/spec-compliance-review.md",
        re.escape("- For each criterion, locate the implementation that satisfies it\n"),
        "- When the task names a source request file (the user's own request, saved word for word), read it in "
        "full: it outranks the plan. A criterion, scenario, test or output that differs from one of its output examples "
        "is an unmet criterion (`error`), even when the plan or your task records the difference as a decision.\n"
        "- For each criterion, locate the implementation that satisfies it\n",
        "source request: check against the user's request, not only the plan",
    ),
    (
        "agents/spec-compliance-review.md",
        re.escape("- For each criterion, locate the implementation that satisfies it\n"),
        "- A plan choice on a point the source request leaves unclear (an item under `## Risks & Open Questions`, or a "
        "criterion marked open question, assumption or plan decision) is checked against the request, not honoured as "
        "settled. Report it as `unmet-criterion` `error` only on explicit evidence: a request example whose output "
        "differs between the planned reading and another, or, when no example decides, a request sentence that states "
        "the behaviour outright. A reading inferred from wording (a loop phrase, a field name, a sort rule) is a "
        "`suggestion` that names both readings and an input on which they differ; it never overturns the plan. Choices "
        "the request does not touch (internal structure, names, text it never shows) are not findings. A choice backed "
        "by an Ambiguity Log row with source `user`, or by the user's answer at plan approval, is settled: do not report "
        "it. Check open choices even when your task calls recorded choices settled.\n"
        "- For each criterion, locate the implementation that satisfies it\n",
        "source request: open plan choices are checked against the request, on explicit evidence only",
    ),
    (
        "skills/build/SKILL.md",
        re.escape(BUILD_PHASE_ANCHOR),
        BUILD_PHASE_ANCHOR + "\n" + BUILD_PHASE_RULE,
        "speed: the build phase record is one helper command that shares a message with real work",
    ),
    (
        "skills/build/SKILL.md",
        re.escape(BUILD_PHASE_HANDOFF_ANCHOR),
        "delete it instead when this was the plan's last step. Send `build_phase.py between-steps <next N.M>` (or "
        "`build_phase.py clear`) in the same message as the plan Edit above; the plan is not a test file, so no guard "
        "affects that Edit.\n",
        "speed: the step handoff record shares a message with the plan update",
    ),
    (
        "skills/build/SKILL.md",
        re.escape(FINAL_VERIFY_ANCHOR),
        FINAL_VERIFY_ANCHOR + "\n" + FINAL_VERIFY_RULE,
        "speed: the final verification and the Farley Score run in one message",
    ),
    (
        "skills/build/SKILL.md",
        re.escape(FARLEY_STEP7_ANCHOR),
        FARLEY_STEP7_RULE,
        "speed: Step 7 presents Step 5's Farley Score instead of scoring again",
    ),
    (
        "agents/software-engineer.md",
        re.escape(ENGINEER_TOOL_ANCHOR),
        ENGINEER_TOOL_ANCHOR + ENGINEER_BUILD_PHASE_RULE,
        "speed: the engineer writes the build phase record with the helper, never in a turn of its own",
    ),
] + [
    (f"agents/{name}.md", r"(?m)^effort: high$", "effort: medium", "speed: review lenses and plan critics at medium effort")
    for name in MEDIUM_EFFORT_AGENTS
]


def run(cmd: list[str], cwd: Path) -> str:
    try:
        return subprocess.run(cmd, cwd=cwd, capture_output=True, text=True, check=False).stdout.strip()
    except OSError:
        return ""


def split_frontmatter(text: str) -> tuple[list[str], str] | None:
    if not text.startswith("---"):
        return None
    lines = text.split("\n")
    for i in range(1, len(lines)):
        if lines[i].strip() == "---":
            return lines[1:i], "\n".join(lines[i + 1 :])
    return None


def fm_blocks(fm_lines: list[str]) -> list[tuple[str | None, list[str]]]:
    """Group frontmatter into top-level key blocks (key line + indented continuation)."""
    blocks: list[tuple[str | None, list[str]]] = []
    for line in fm_lines:
        m = re.match(r"^([A-Za-z0-9_-]+):", line)
        if m and not line.startswith((" ", "\t")):
            blocks.append((m.group(1), [line]))
        elif blocks:
            blocks[-1][1].append(line)
        else:
            blocks.append((None, [line]))
    return blocks


def block_value(lines: list[str]) -> str:
    first = lines[0].split(":", 1)[1].strip()
    rest = [l.strip() for l in lines[1:]]
    if first in (">", "|", ">-", "|-", ""):
        return " ".join(r for r in rest if r)
    val = " ".join([first] + [r for r in rest if r])
    if len(val) >= 2 and val[0] == val[-1] and val[0] in "\"'":
        val = val[1:-1]
    return val


def trim_description(desc: str) -> str:
    if len(desc) <= DESCRIPTION_LIMIT:
        return desc
    cut = desc[: DESCRIPTION_LIMIT - 1]
    # prefer ending at a sentence boundary
    dot = cut.rfind(". ")
    if dot > DESCRIPTION_LIMIT * 0.6:
        cut = cut[: dot + 1]
    return cut.rstrip() + ("" if cut.endswith(".") else "…")


def normalise_skill(path: Path) -> bool:
    text = path.read_text(encoding="utf-8")
    parts = split_frontmatter(text)
    if not parts:
        return False
    fm_lines, body = parts
    changed = False
    out: list[str] = []
    for key, lines in fm_blocks(fm_lines):
        if key == "description":
            desc = block_value(lines)
            trimmed = trim_description(desc)
            if trimmed != desc:
                out.append("description: " + json.dumps(trimmed, ensure_ascii=False))
                changed = True
                continue
        out.extend(lines)
    if changed:
        path.write_text("---\n" + "\n".join(out) + "\n---\n" + body, encoding="utf-8")
    return changed


NOTE_MARKER = "<!-- pi-port-notes -->"


def insert_note(skill_md: Path, note: str) -> None:
    """Insert a pi port note block after the first H1 (or after frontmatter)."""
    text = skill_md.read_text(encoding="utf-8")
    if NOTE_MARKER in text:
        return
    block = f"\n{NOTE_MARKER}\n{note.strip()}\n{NOTE_MARKER}\n"
    m = re.search(r"^# .*$", text, flags=re.M)
    if m:
        text = text[: m.end()] + "\n" + block + text[m.end() :]
    else:
        parts = split_frontmatter(text)
        text = text + block if not parts else text.replace("\n---\n", "\n---\n" + block, 1)
    skill_md.write_text(text, encoding="utf-8")


def stale_override_bases(root: Path, bases: dict[str, str]) -> list[str]:
    """Return the overridden files whose upstream copy under `root` no longer
    matches the hash the override was ported from (or no longer exists)."""
    stale = []
    for rel, sha in bases.items():
        f = root / rel
        if not f.is_file() or hashlib.sha256(f.read_bytes()).hexdigest() != sha:
            stale.append(rel)
    return stale


def copy_tree(src: Path, dst: Path) -> None:
    if dst.exists():
        shutil.rmtree(dst)
    shutil.copytree(src, dst, ignore=IGNORE, symlinks=True)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--upstream", required=True, help="checkout of bdfinst/agentic-dev-team")
    args = ap.parse_args()

    upstream = Path(args.upstream).resolve()
    plugin = upstream / PLUGIN_SUBDIR
    if not (plugin / "agents").is_dir():
        print(f"error: {plugin} does not look like plugins/dev-team", file=sys.stderr)
        return 2

    for name in MANAGED_DIRS:
        src = plugin / name
        if src.is_dir():
            copy_tree(src, PKG / name)
    if (plugin / "docs").is_dir():
        copy_tree(plugin / "docs", PKG / UPSTREAM_DOCS_DEST)
    for fname, dest in (("CHANGELOG.md", "docs/upstream/CHANGELOG.md"), ("README.md", "docs/upstream/README.md")):
        if (plugin / fname).is_file():
            shutil.copy2(plugin / fname, PKG / dest)

    # hooks/lib/plugin_version.py reads <root>/.claude-plugin/plugin.json for the version stamped on metrics rows.
    if (plugin / ".claude-plugin" / "plugin.json").is_file():
        (PKG / ".claude-plugin").mkdir(exist_ok=True)
        shutil.copy2(plugin / ".claude-plugin" / "plugin.json", PKG / ".claude-plugin" / "plugin.json")

    dropped = []
    for skill in DROPPED_SKILLS:
        target = PKG / "skills" / skill
        if target.exists():
            shutil.rmtree(target)
            dropped.append(skill)

    failures: list[str] = [
        f"{rel}: upstream changed this file, which overrides/{rel} replaces; re-port the override and update OVERRIDE_BASES"
        for rel in stale_override_bases(PKG, OVERRIDE_BASES)
    ]

    overridden: list[str] = []
    overrides = PKG / "overrides"
    if overrides.is_dir():
        for src in sorted(overrides.rglob("*")):
            if src.is_file() and "__pycache__" not in src.parts and src.relative_to(overrides).parts[0] != "notes":
                rel = src.relative_to(overrides)
                dst = PKG / rel
                dst.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(src, dst)
                overridden.append(str(rel))

    noted: list[str] = []
    for note in sorted((overrides / "notes").glob("*.md")) if (overrides / "notes").is_dir() else []:
        skill_md = PKG / "skills" / note.stem / "SKILL.md"
        if not skill_md.is_file():
            failures.append(f"overrides/notes/{note.name}: skill {note.stem} is missing; drop or rename the note")
            continue
        insert_note(skill_md, note.read_text(encoding="utf-8"))
        noted.append(note.stem)

    normalised = [
        str(p.relative_to(PKG)) for p in sorted((PKG / "skills").glob("*/SKILL.md")) if normalise_skill(p)
    ]

    patched: list[dict[str, object]] = []
    for pattern, regex, repl, why in PATCHES + LEAN_PATCHES:
        files = sorted(PKG.glob(pattern))
        hits = 0
        for f in files:
            text = f.read_text(encoding="utf-8")
            new, n = re.subn(regex, lambda _m: repl, text)
            if n:
                f.write_text(new, encoding="utf-8")
                hits += n
        if hits == 0:
            failures.append(f"{pattern}: /{regex[:60]}.../ ({why})")
        patched.append({"file": pattern, "reason": why, "hits": hits})

    # The index covers knowledge/ and skills/, so it is stale after the drops, overrides and patches above.
    subprocess.run([sys.executable, str(PKG / "hooks" / "lib" / "build_knowledge_index.py")], check=True)

    version = ""
    manifest = plugin / ".claude-plugin" / "plugin.json"
    if manifest.is_file():
        version = json.loads(manifest.read_text(encoding="utf-8")).get("version", "")
    info = {
        "repository": "https://github.com/bdfinst/agentic-dev-team",
        "plugin": "dev-team",
        "version": version,
        "commit": run(["git", "rev-parse", "HEAD"], upstream),
        "commitDate": run(["git", "log", "-1", "--format=%cI"], upstream),
        "droppedSkills": dropped,
        "overridden": overridden,
        "notes": noted,
        "normalisedFrontmatter": normalised,
        "patches": patched,
    }
    (PKG / "UPSTREAM.json").write_text(json.dumps(info, indent=2) + "\n", encoding="utf-8")

    print(f"synced dev-team {version} ({info['commit'][:10]})")
    print(f"  dropped {len(dropped)} skills, {len(overridden)} override files, {len(normalised)} frontmatter fixes")
    if failures:
        print("UPSTREAM DRIFT (review and update PATCHES / OVERRIDE_BASES):", file=sys.stderr)
        for f in failures:
            print("  - " + f, file=sys.stderr)
        return 1
    print(f"  {sum(int(p['hits']) for p in patched)} patch hits, all patches matched")
    return 0


if __name__ == "__main__":
    sys.exit(main())
