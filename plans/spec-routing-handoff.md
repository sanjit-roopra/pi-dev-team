# Handoff: plain-text routing, brief, grilling /specs, answer mode, plain-language questions

Status 2026-10-19: items 1-5 implemented on branch `spec-routing-brief` (draft-PR posting deferred: `pre_pr_review` blocks `gh pr create` before review; ntfy + brief at PR top instead).
Full research (coverage matrix vs MinimumCD, other tools, file:line evidence): `plans/spec-routing-research.md`.

## Why (user's problem)

- User often cannot tell what pi-dev-team is building.
- User mostly types plain text, rarely `/specs`, `/ship` etc.
- User finds AI language hard to read. Has ADHD. Wants SimpleEnglish + i-have-adhd style in questions too.
- User is often away: gates must time out to defaults (memory: user-not-bottleneck). But sometimes user wants to answer everything and the team must NOT continue alone.

## Evidence found

- 48 sessions in `~/.pi/agent/sessions` started with plain text. Only 1 ran `specs > plan > build > pr`. 29 ran no flow skill, 8 ran `build > pr > code-review` (no spec, no plan).
  - Script: parse each session jsonl, take first user message not starting with `/`, collect `toolCall` names == `skill` and their `arguments.name`.
- No routing exists: `input` handler (`extensions/dev-team/index.ts:469`) only fires telemetry. The model picks skills from the guide (`compatGuide`, `index.ts:625-641`) on its own.
- `/specs` asks ONE batch of blocking questions (`skills/specs/SKILL.md:149-153`), max 2 critique iterations (`:91,115`). Follow-up questions that depend on answers are never asked.
- Bug: `/specs` Step 1 (`skills/specs/SKILL.md:77-79`) compares the spec marker with frontmatter `version:`, which does not exist (`:1-6`). No template writes `<!-- spec-version: -->`. Every existing spec halts on an "older format?" question. Dead cites to `docs/experiments/` at `:24,34`.
- `askTimeoutSec: 120` (`lib/config.ts:107`). `0` means non-interactive (`index.ts:109`), NOT "wait forever".
- `ask_user` asks questions one by one; after one timeout it asks no more (`lib/tools-misc.ts:110-119`).
- SimpleEnglish + i-have-adhd rules exist only for GitHub text: `GITHUB_STYLE_GUIDE` + linter/gate in `lib/github-style.ts:52-63` (≤25 words/sentence, no filler list, can/will/must, ≤5 list items, point first, one next step).
- pi has no phone push. Only `ctx.ui.notify()` in the TUI. `PushNotification` is a Claude Code tool, not pi.
- Plans are too long to review (example: 617 lines in `plans/dev-team-usage-command.md`), no TL;DR.
- `build-phase.json` is read by nothing in `extensions/`. No live "which step" display.

## Agreed design (one PR, in this order)

### 1. Routing: plain text → brief first (LLM decides size, code enforces)
- Add a paragraph to `compatGuide`: before changing files for a plain request, call `dev_team_brief`.
- New tool `dev_team_brief({kind, building, doneWhen, assuming[], slices?})`, new file `extensions/dev-team/lib/brief.ts`.
  - `kind` chosen by the session model (no extra LLM call): `question` (no brief needed) / `tiny` (one sentence, ≤~3 files) / `feature` / `vague`.
  - `tiny`: render 3 lines (Building / Done when / Assuming), save `.claude/memory/brief.json`, return "continue". No wait.
  - `feature`: render ≤15-line "At a glance", ask ok via timed question, then tool tells model to run `/ship`.
  - `vague`: tool tells model to run `/specs` (grilling mode, see 2).
- Gate in `tool_call` handler (deterministic): `input` resets `briefSeen=false`. First write/edit/mutating bash with `briefSeen=false` → block "call dev_team_brief first".
  - Exempt: subagents; a flow skill (`specs/plan/build/fix/ship`) already ran this turn; config `"routing": "off"`.
- Backup size check (code): `tiny` but `git diff --numstat` > 3 files or ~150 lines → advisory "post updated brief or switch to /ship".
- Rejected: LLM classifier in `input` hook (extra call + latency, no repo context); regex keywords (brittle); prose rule alone (1/48 shows model ignores it).
- `/pr` puts `brief.json` content at the top of the PR body.

### 2. `/specs` = grill-with-docs (mattpocock/skills `grilling` + `domain-modeling`)
- Source: https://raw.githubusercontent.com/mattpocock/skills/main/skills/productivity/grilling/SKILL.md and `.../engineering/domain-modeling/SKILL.md`.
- Rounds: ask the whole "frontier" (questions whose prerequisites are settled), numbered, each with a recommended answer. Phrase so "yes" accepts. Recompute frontier after answers.
- Facts: look them up (subagent), never ask the user for facts. Only decisions go to the user.
- Stop: frontier empty AND user confirms shared understanding.
- Log every Q/A in `## Decision Log` in the spec.
- Domain-modeling rules: challenge terms against the glossary, propose precise terms ("account: Customer or User?"), invent edge-case scenarios, cross-check user claims against the code.
- Write terms to the EXISTING `.plans/domain/` (format of `skills/ubiquitous-language`), not a new GLOSSARY.md. ADRs via existing `adr-tools`, only when hard to reverse + surprising + real trade-off.
- On timeout: accept that round's recommendations, mark `assumed (timeout)`, STOP grilling (do not build rounds on guesses). Open branches go to the top of brief + PR as "decide these". "continue grilling" resumes.
- Tiny changes: no grilling, no doc writes.

### 3. Answer mode: wait or timeout (configurable)
- New config `answerMode`: `"timeout"` (default, current behavior, `askTimeoutSec`) | `"wait"` (never continue alone).
- Per-session switch: `/dev-team wait` and `/dev-team timeout`.
- Per-task: user message contains "grill me" or "ask me everything" → wait mode for that task.
- Key `w` in an open question stops its timer. CHECK FIRST whether pi's dialog API lets an extension add a key.
- Every question shows the mode: `⏱ 1:47 left · w = wait` or `⏸ waiting for you`.

### 4. Plain-language questions (SimpleEnglish + i-have-adhd)
- Apply `GITHUB_STYLE_GUIDE` rules to `ask_user` questions, the brief and the plan "At a glance".
- Fixed question template:
  ```
  Q2/5 · Rate limit: per user or per API key?
  Why it matters: shared keys hit the limit faster.
  → Recommended: per API key
    Other: per user · both
  ⏱ 1:47 · w = wait
  ```
- One question per screen, `Qn/N` progress, title ≤8 words, one "why" line, recommendation first, Enter/yes accepts, jargon gets a short meaning (`429 (= "too many requests")`).
- Enforce in code: `ask_user` runs the existing linter on question text; failure → block once with reason, model rewrites. Same mechanism as the `gh pr create` style gate.

### 5. Show the user what happens when it continues alone
- On auto-approve / timeout: post the brief as draft PR body or issue comment via `gh`. GitHub mobile app = phone push, no setup.
- Optional config `"notify": "ntfy:<topic>"` → `curl -d "<brief>" ntfy.sh/<topic>`. Use a random topic name (public otherwise).
- Fix the spec-version bug (write marker in template, compare to it) and drop dead `docs/experiments/` cites.

## Later (agreed not now)
- Hypothesis section ("We believe X → Y; we'll know when <signal>"), optional one question.
- Plan `## At a glance` + gate shows only it (partly covered by brief).
- Status line `Slice x/y · Step a.b/n` from `build-phase.json`; step id on agent rows.
- Musts / Must Nots / NFR thresholds / evaluation cases in spec.
- Fresh-reader agent that reads only the spec and lists confusions.

## How to start
1. `git fetch && git switch -c <branch> origin/main` (memory: branch from fresh main).
2. Implement 1–5 with tests under `test/`. Keep README changes shorter than before (memory: docs-shorter-is-better).
3. Review + open PR without asking (memory: review-and-pr-without-asking).
4. After ~2 weeks, rerun the session scan; target: most code-changing sessions show a brief.
