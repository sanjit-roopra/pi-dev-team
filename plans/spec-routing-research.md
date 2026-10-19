# pi-dev-team vs MinimumCD Agent-Assisted Specification

Source: https://beyond.minimumcd.org/docs/agentic-cd/specification/agent-assisted-specification/ (page modified 2026-10-08, commit 43319b8)
Port: upstream v14.0.0 @ 2bf3d9852 (`UPSTREAM.json:4-5`). Upstream main is v14.0.1, 7 commits ahead. The only spec change since is style-only (579a4e333). Upstream has no hypothesis, eval design or delivery contract either.

---

## 1. Spec flow today

| # | Step | Who | Artifact | file:line |
|---|------|-----|----------|-----------|
| 0 | Format/version check of existing spec | orchestrator | — | `skills/specs/SKILL.md:77-79` **(bug: flags every spec as old format, see §5 #1)** |
| 1 | Human drafts Intent / Architecture / AC | human | draft text | `skills/specs/SKILL.md:96-104,108-115` |
| 2 | Agent critiques: gap / ambiguity / conflict / scope | orchestrator, same agent inline | findings | `skills/specs/SKILL.md:117-124` |
| 3 | Ambiguity protocol: infer → predictability check (≤1 alternative) → inferable vs requires-stakeholder-input | orchestrator | Ambiguity Log | `skills/specs/SKILL.md:126-159`; `references/predictability-check.md:16-25` |
| 4 | Step C: blocking questions sent in one batch; waits, no default | human | answers | `skills/specs/SKILL.md:149-153` |
| 5 | Human decides; agent refines; max 2 iterations, then escalate | human + agent | refined artifacts | `skills/specs/SKILL.md:91,115` |
| 6 | Glossary capture; a term counts as verified only after human confirms | agent + human | Glossary | `skills/specs/SKILL.md:189-196`; `references/glossary.md:21-52` |
| 7 | Completeness sweep: CRUD per entity + authn/authz/audit/errors | agent | Ambiguity Log rows | `skills/specs/SKILL.md:198-219`; `references/completeness-checklist.md:30-83` |
| 8 | Consistency gate: 6 hard-stop checks | agent self-check | checklist | `skills/specs/SKILL.md:221-232`; `references/persistence.md:54-60` |
| 9 | Persist spec to file/issue | agent | `docs/specs/*.md` or issue | `references/persistence.md:23-60,84-85` |
| 10 | /plan runs automatically, no confirmation | agent | — | `references/persistence.md:97-115` |
| 11 | /plan: vertical slices + Gherkin per slice (happy/neg/edge/error) + steps | agent | plan file | `skills/plan/SKILL.md:34,66-75`; `references/plan-template.md:38-104` |
| 12 | 1-5 plan-review-* critics, chosen by tier | sub-agents | Plan Review Summary | `skills/plan/SKILL.md:119-160` |
| 13 | Plan gate: whole plan shown; auto-approves if DEV_TEAM_INTERACTIVE≠1 | human / auto | `## Approval` | `skills/plan/SKILL.md:168-171` |
| 14 | /build: AC-quality gate (auto-passes non-interactive) | spec-compliance-review | audit line | `skills/build/SKILL.md:100-127` |
| 15 | software-engineer gets step + Gherkin ("design is settled") | worker | commits | `skills/build/SKILL.md:158` |
| 16 | Spec-compliance check at each checkpoint (AC→impl+test) | spec-compliance-review | findings | `agents/spec-compliance-review.md:21-49`; `skills/build/SKILL.md:194,205` |
| 17 | 4.9 runtime verify | agent | `metrics/verify-log.jsonl` | `skills/build/SKILL.md:278-292` |
| 18 | PR; human ticks AC checkboxes | human | PR body | `skills/pr/SKILL.md:19-22,162-173`; `skills/plan/SKILL.md:99` |

Spec stage dispatches no agent and invokes no skill (`skills/specs/SKILL.md`, `role: orchestrator` at `:4`).

---

## 2. Coverage matrix vs MinimumCD

| Element | Status | Where | Note |
|---|---|---|---|
| Cycle: human drafts → agent critiques → human decides → agent refines | ✅ | `skills/specs/SKILL.md:108-115,94` | Same loop. "Preserve human language". Max 2 iterations. |
| Agent does not write the spec | ✅ | `skills/specs/SKILL.md:92` | `design-doc` breaks this: agent drafts (`skills/design-doc/SKILL.md:48-79`). |
| Small scope: next thin slice, >15 min = split | 🟡 | `skills/specs/SKILL.md:88,171-187` | One whole feature per spec on purpose; slicing happens in /plan. No time or AC cap. Real plan 617 lines, 5 slices. |
| Stage 1 Intent | ✅ | `skills/specs/SKILL.md:100` | Free-form, 1-3 paragraphs. |
| Stage 1 hypothesis "We believe X → Y because Z" | ❌ | — | Missing in port and upstream. "hypothes" grep hits only debugging, PBT lib, `gherkin-derive:207`. |
| Stage 1 hypothesis pressure-test (measurable, causal, alternatives) | ❌ | — | `design-doc:59-63` alternatives are solution alternatives, not alternative causes. |
| Stage 1 ambiguity / assumptions / missing constraints | ✅+ | `skills/specs/SKILL.md:126-159` | Stronger than MinimumCD: predictability check + classification + log. |
| Stage 1 suggest splits | 🟡 | `skills/specs/SKILL.md:182-187` | Only for unrelated features, never for size. |
| Stage 2 Gherkin: success/error/edge | 🟡 | `skills/plan/SKILL.md:66-75` | Moved to /plan per slice (upstream design choice). |
| Stage 2 rationale per scenario | ❌ | — | No `# why:` convention. |
| Stage 2 missing: boundary/concurrency/failure | ✅ | `skills/plan/SKILL.md:68-75` | |
| Stage 2 missing: interaction with existing behaviour | ❌ | `skills/plan/SKILL.md:66-75` | Category not listed. |
| Stage 2 weak scenario that two implementations pass differently | 🟡 | `agents/plan-review-acceptance.md:28-62`; `references/predictability-check.md:17-26` | Two-implementations test exists only for spec AC, not Gherkin. `gherkin-quality-critic` wired only to gherkin-derive:378 / gherkin-public:172. |
| Stage 3 arch constraints / integration / deps | 🟡 | `skills/specs/SKILL.md:101` | Free-form. Architect claims to lead (`agents/architect.md:54`) but is never dispatched. |
| Stage 3 Musts / Must Nots / Preferences / Escalation Triggers | 🟡 | `design-doc:74-75`; `plan-review-strategic.md:36`; `build/SKILL.md:381-405` | Pieces only. Generic build escalation list, no per-feature triggers. Worker gets none (`build:158`). |
| Stage 3 NFRs + rationale + human-set thresholds | 🟡 | `references/completeness-checklist.md:56-62` | Only a "prompt to look". `feature-file-validation/.../validation-rules.md:44-46` routes NFRs to perf specs that nothing produces. |
| Stage 4 AC observable | ✅ | `skills/specs/SKILL.md:102`; `plan-review-acceptance.md:32` | Binary-verifiability check happens at /plan. |
| Stage 4 cross-artifact consistency | ✅ | `skills/specs/SKILL.md:221-232` | |
| Gate: clarity | ✅ | `:225` | |
| Gate: testability | 🟡 | `plan-review-acceptance.md:32` | Not a spec-gate item; checked one stage later. |
| Gate: scope | 🟡 | `:227` | Covers "not over-engineered". Per-slice scope contradicts `:88` by design, so don't add it. |
| Gate: terminology | ✅ | `:228` | |
| Gate: completeness | ✅ | `:226`, sweep `:198-219` | |
| Gate: conflicts | ✅ | `:229` | |
| Gate: hypothesis measurable after deploy | ❌ | — | |
| Human resolves before test gen / impl | 🟡 | `skills/specs/SKILL.md:149-153`; `ship/SKILL.md:166-174` | Hard gate, but auto-proceeds via `/specs`→/plan auto-invoke, plan auto-approve and the 120s ask timeout. |
| Discovery loop: principal-architect interview | ❌ | — | No /specs discovery mode. |
| Discovery: 3-5 questions per round | 🟡 | `agents/product-manager.md:29-36`; `design-interrogation/SKILL.md:43-48` | Inconsistent: PM asks one batch, design-interrogation one at a time, /specs one batch. |
| Discovery: running decision log | 🟡 | `references/persistence.md:45-52` | Ambiguity Log only, no round/source columns. `design-interrogation:69-75` summary is chat-only. |
| Task decomposition: planner-worker | ✅ | `skills/build/SKILL.md:158` | |
| Task decomposition: <2h, explicit inputs/outputs | 🟡 | `plan-template.md:62-94`; `plan/SKILL.md:34,75` | One behaviour per step, but no time-box, no Inputs/Outputs fields, and a step may cover multiple scenarios. |
| Eval design: known-good happy / highlight / empty | 🟡 | `plan/SKILL.md:68-75`; `build/SKILL.md:278-292` | Gherkin covers happy and empty. No numbered input→output table, no highlight case. 4.9 logs no per-case result. |
| Phase 4 stress-test ("junior dev confused") | 🟡 | `skills/specs/SKILL.md:122,136-143,162` | Thought experiments by the same agent. No fresh-reader dispatch. |
| Self-containment test | 🟡 | `references/predictability-check.md` | Same as above. |
| Independent spec critic | 🟡 | `agents/plan-review-*`, `gherkin-quality-critic`, `spec-reviewer` | None dispatched from /specs. Repo rejects a spec severity scheme 5× (`specs/SKILL.md:216` + refs). |
| Agent Delivery Contract authority order | 🟡 | `specs/SKILL.md:90,92`; `build/SKILL.md:384-403` | Ownership stated, no precedence order, no "can't edit unowned artifact" rule. |
| Small-batch sessions (1 scenario / 1 session / 1 commit) | 🟡 | `build/SKILL.md:48,153-156` | Commit per step; no per-session scope limit. |
| Session context handoff | 🟡 | `skills/handoff/SKILL.md:87-104`; `hooks/post_compact_state_reinject.py:13` | Model-facing, not the MinimumCD template. |

Beyond MinimumCD (already in pi-dev-team): predictability check, inferable/stakeholder classification, CRUD completeness sweep, validate mode for third-party specs (`specs/SKILL.md:39-69`), LOW_VALUE triage (`:161-169`), human-verified glossary.

---

## 3. Other implementations

| Tool | Technique | In pi-dev-team? | Borrow? |
|---|---|---|---|
| spec-kit `/clarify` (https://raw.githubusercontent.com/github/spec-kit/main/templates/commands/clarify.md) | ≤5 questions, recommended answer, "why it matters" line, 10-category Clear/Partial/Missing taxonomy, `## Clarifications / Session date / Q→A` folded into spec | 🟡 PM gives a default per question; no taxonomy, no Q→A log | **Yes**: base for discovery mode (G06) |
| spec-kit `/analyze` (…/analyze.md) | Read-only cross-artifact report, severity, requirement→task coverage %, ≤50 findings | 🟡 inline boolean gate | **Partly**: coverage table yes; severity conflicts with repo design (`specs/SKILL.md:216`) |
| spec-kit `/checklist` (…/checklist.md) | "Unit tests for English": checks requirement quality; bans Verify/Test items | ❌ | Yes, as weak-scenario wording for plan-review-acceptance |
| spec-kit assess extension (https://github.com/github/spec-kit) | go / needs-clarification / kill on ideas | ❌ | Maybe, paired with hypothesis |
| Kiro (https://kiro.dev/docs/specs/) | EARS reqs, design.md with sequence diagrams, live task status, Quick Spec bypass, inline comment review, PBT traced to requirements | 🟡 waves (`plan_waves.py`), PBT skill exists | Yes: live task status, sequence diagram, quick path |
| OpenSpec (https://github.com/Fission-AI/OpenSpec) | ADDED/MODIFIED/REMOVED deltas against living specs; archive merges | ❌ | Maybe for brownfield; large change |
| BMAD (https://github.com/bmad-code-org/BMAD-METHOD) | Scale-adaptive Quick Flow; PRFAQ working-backwards; readiness gate PASS/CONCERNS/FAIL | 🟡 tiers in /plan | PRFAQ as a hypothesis aid: low priority |
| superpowers brainstorming / writing-plans (https://github.com/obra/superpowers) | 200-300 word playback; 2-5 min tasks; plan "not much longer than spec"; multi-project split | ❌ playback; 🟡 step size | **Yes**: playback brief = fix for the visibility problem |
| mattpocock grilling / grill-with-docs (https://github.com/mattpocock/skills) | Asks the frontier of unblocked questions per round, numbered, recommended answer; glossary + ADRs written as a side effect | 🟡 `design-interrogation` (one at a time) | **Yes**: frontier round = natural 3-5 question cap; decision log as a side effect |
| anthropic doc-coauthoring (https://raw.githubusercontent.com/anthropics/skills/main/skills/doc-coauthoring/SKILL.md) | Reader test: fresh no-context subagent answers predicted questions | ❌ | **Yes**: G07 implementation |
| Claude Code plan mode (https://code.claude.com/docs/en/best-practices) | Interview with AskUserQuestion → SPEC.md → fresh session; skip planning if the diff fits in one sentence | 🟡 | Quick-path rule |
| Traycer (https://docs.traycer.ai/guides/plan-a-feature.md) | Epic brief first; anchored comments; artifact-critique; plan-vs-impl verify | 🟡 spec-compliance-review | Brief-first pattern |
| zero-pi (https://pi.dev/packages/@gonrocca/zero-pi) | pi SDD pipeline, `.sdd/<slug>/` trail, clarify stops only on blocking ambiguity | ✅ similar | No; pi-dev-team is a superset |
| @dreki-gg/pi-plan-mode (https://pi.dev/packages/@dreki-gg/pi-plan-mode) | PLAN.md + self-contained START-PROMPT.md; `[DONE:n]` markers; plans.jsonl | 🟡 build-phase.json | START-PROMPT = MinimumCD context handoff: maybe |
| CodeRabbit walkthrough (https://docs.coderabbit.ai/pr-reviews/walkthroughs) | Change cohorts + Mermaid sequence diagram in the PR | ❌ | **Yes**: G19 |
| Willison linear walkthrough / Showboat (https://simonwillison.net/guides/agentic-engineering-patterns/linear-walkthroughs) | Fresh agent writes walkthrough.md with exec-proven output | ❌ | Yes: G20 |
| Warp / Tidewave (https://docs.warp.dev/agents/capabilities/computer-use/artifacts-in-prs.md) | Screenshots / video in PR as proof of work | 🟡 screenshots captured (`agents/quality-reviewer.md:75,123`), not added to the PR | Yes: cheap wiring |
| Copilot coding agent (https://docs.github.com/en/copilot/how-tos/use-copilot-agents/coding-agent/track-copilot-sessions) | Agent updates PR body with status while working | ❌ | Yes: G17 |
| Devin interactive planning (https://docs.devin.ai/work-with-devin/interactive-planning) | Plan with code citations; 30s auto-proceed while the plan stays visible | 🟡 timeout exists; plan not shown | Yes: pattern for G17 |
| Thoughtworks HDD (https://www.thoughtworks.com/en-gb/insights/articles/how-implement-hypothesis-driven-development) | "We believe… we'll know when <signal>" | ❌ | **Yes**: G01 template |
| decision-log skill (https://skills.sh/bonkey/skills/decision-log) | Short ADR at plan-mode exit | 🟡 adr-author (heavyweight) | Maybe |
| Cline Memory Bank (https://docs.cline.bot/prompting/cline-memory-bank) | activeContext/progress files readable by humans | 🟡 build-phase.json (machine-facing) | Idea only |
| Tessl | Pivoted to a skills registry | — | No |

No hypothesis-driven agent skill and no feature-level eval-design skill found anywhere. Both would be new in pi-dev-team.

---

## 4. Visibility problem ("what are you building")

**Current mechanisms**

| Mechanism | Where | Audience |
|---|---|---|
| Spec gate shows Intent/Arch/AC/Ambiguity Log | `skills/ship/SKILL.md:173-174` | human, if interactive |
| Full plan + review summary at plan gate | `skills/plan/SKILL.md:170` | human, if interactive |
| `## Approval` auto-approve record | `skills/plan/SKILL.md:171` | file, after the fact |
| config-changelog.jsonl | `skills/human-oversight-protocol/SKILL.md:119-170` | machine / audit |
| Build Progress checkboxes, build-phase.json | `skills/build/SKILL.md:197-203`; `hooks/lib/build_state.py:3,49` | disk / model |
| post-compact re-inject | `hooks/post_compact_state_reinject.py:13` | model only |
| TUI status line `dev-team: N agent call(s) running` | `extensions/dev-team/index.ts:482,507` | human, no content |
| Agent rows: name + 80/50-char prompt preview | `extensions/dev-team/lib/subagent-render.ts:33-34,297-312` | human, no step id |
| /issues-from-plan one line per slice | `skills/issues-from-plan/SKILL.md:78-91` | opt-in, default No |
| PR: 1 sentence + ≤3 bullets; Decisions inside `<details>` | `skills/pr/SKILL.md:19-22,162-173` | human, after the build |
| autoship round table: Issue/Batch/Status/Notes | `skills/autoship/SKILL.md:1037-1043` | human, no "built" or PR column |

**Why they fall short**
- Main review artifact too big: plan 617 lines, 473 of them slice detail (`plans/dev-team-usage-command.md`). Contradicts the "200 lines of plan" premise (`human-oversight-protocol/SKILL.md:17-27`).
- No TL;DR, no "Slice N: user can…", no "what you'll see when done". The Mermaid DAG shows step dependencies, not behaviour (`plan-template.md:106-113`).
- Gates auto-proceed silently:
  - /specs→/plan auto-invoke (`persistence.md:97-115`)
  - 120s ask timeout to default (`tools-misc.ts:110-119`, `config.ts:107`)
  - plan auto-approve (`plan/SKILL.md:168-171`)
  - /autoship headless with DEV_TEAM_AUTO_APPROVE=1 (`autoship/SKILL.md:27,771-773`)
  - Result: user may never see the plan before code exists.
- Nothing reads build-phase.json or Build Progress (0 hits in `extensions/`), so there is no live "Step 2.3/11: <title>" anywhere.
- /build "no narration" rule (`build/SKILL.md:52`) plus the Farley/evidence report (`:350-375`): process evidence, not "what now works".
- /continue port note prints `Resuming Step N.M of <plan>` (`continue/SKILL.md:18-21`). The Session State template (`:62-83`) is still in the file but likely skipped in practice. Verifier: the "shrunk" claim is partly overstated.
- Most important human info (auto-approvals, inferred ambiguities, worker assumptions) sits collapsed in the PR `<details>`.
- Anthropic RCT (https://www.anthropic.com/news/AI-assistance-coding-skills): AI users scored 17% lower on comprehension; question-askers ≥65%, delegators <40%. More output does not fix this; explain-back does.

**Fixes**
- `## At a glance` block, ≤15 lines, at the top of the plan. Gate shows only that block plus the review summary (G16).
- On every auto-approve, push the brief to chat, a draft PR body / issue comment, and PushNotification. Non-blocking (G17).
- Status line `Slice 2/5 · Step 2.3/11: <title>` from build-phase.json; step id on agent rows (G18).
- /build ends with "Now works: user can…" per AC. PR shows it, uncollapses the timeout/auto items, adds a Mermaid diagram when interfaces change, embeds screenshots (G19).
- Autoship table gains `Built` and `PR` columns (G19).
- Optional `/explain-build` code tour + 2-3 check questions, skipped by default on timeout (G20).

---

## 5. Ranked recommendations

| # | Change | Files | Effort | Impact |
|---|---|---|---|---|
| 1 | **Fix spec plumbing**: write `<!-- spec-version: N -->` in the template and check that; drop dead `docs/experiments/` cites; repoint ubiquitous-language from /specs to /plan (G14) | `skills/specs/SKILL.md:1-6,24,34,77-79`; `skills/specs/references/persistence.md:23-24`; `skills/ubiquitous-language/SKILL.md:~192-197` | S | High: today every existing spec run halts for user input |
| 2 | **Plan `## At a glance`**: goal, "Slice N: user can…", "when done you'll see…", optional sequenceDiagram. Gate shows only this + review summary (G16) | `skills/plan/references/plan-template.md:22`; `skills/plan/SKILL.md:170` | S | High: direct fix for "what are you building" |
| 3 | **Push the brief on auto-approve/timeout**: chat + draft PR body / issue comment + PushNotification; non-blocking (G17) | `skills/plan/SKILL.md:171`; `skills/specs/references/persistence.md:97-115`; `skills/autoship/SKILL.md:771-773` | S-M | High: user sees the plan without being a bottleneck |
| 4 | **Hypothesis section + gate item 7**: `## Hypothesis` (We believe / will result in / because / we'll know when <signal> by <date>); critique: measurable? causal? alternatives? Missing = gap finding (G01, G10) | `skills/specs/SKILL.md:98-102,221-232`; `skills/specs/references/persistence.md:23-60` | S | High: largest MinimumCD gap; also answers "why are we building this" |
| 5 | **Step C timeout default**: each question carries a recommended default; on timeout log `assumed (timeout)` and list it at the top of the PR. Reword /ship to surface these items, not block on them (G15) | `skills/specs/SKILL.md:149-155`; `skills/ship/SKILL.md:166-174`; `skills/pr/SKILL.md:162-173` | S | High: removes conflict with #51 and the not-a-bottleneck rule |
| 6 | **Live progress + "Now works" report**: status line `Slice x/y · Step a.b/n: <title>` from build-phase.json; step id on agent rows; /build "Now works: user can…" per AC; PR uncollapses auto/timeout items + embeds screenshots; autoship `Built`/`PR` columns (G18, G19) | `extensions/dev-team/index.ts:482,507`; `lib/subagent-render.ts:297-312`; `skills/build/SKILL.md:350-375`; `skills/pr/SKILL.md:19-22`; `skills/autoship/SKILL.md:1037-1043` | M | High (visibility) |
| 7 | **Feature constraints + NFR + eval cases in spec**: <br>- Architecture Spec gets Musts / Must Nots / Preferences / Escalation Triggers <br>- NFR table: category / req / threshold=[HUMAN] / rationale; blank threshold → requires-stakeholder-input <br>- `### Evaluation cases` (happy, highlight, empty: input→expected); /build 4.9 runs them per case <br>- /build passes Must Nots + triggers to the worker; spec-compliance-review checks them <br>(G02, G03, G04) | `skills/specs/SKILL.md:101-102`; `references/persistence.md:28-45`; `skills/build/SKILL.md:158,278-292`; `agents/spec-compliance-review.md:40` | M | Med-High: closes MinimumCD Stage 3/4 |
| 8 | **Discovery mode + fresh-reader critic**: <br>- /specs `discovery` mode: rounds of 3-5 questions with recommended answer + "why it matters"; `## Decision Log` (round/Q/A/source); align PM + design-interrogation round size <br>- Before the gate, a fresh subagent reads only the spec and lists the questions it would need to ask; each = gap finding; pass at 0 blocking <br>- Wire architect / threat-modeling / api-design / ubiquitous-language into Stage 3 <br>- Routing rule: design-doc = explore alternatives, /specs = committed contract <br>- No severity scheme (repo design) <br>(G06, G07, G13; G08 coverage-table only) | `skills/specs/SKILL.md:39-69,101,189-196,221`; `agents/product-manager.md:29-36`; `skills/design-interrogation/SKILL.md:43-48`; `skills/design-doc/SKILL.md:3`; new `agents/spec-reader.md` | M-L | Medium: quality; makes architect's claimed role real |

Lower priority (not top 8):
- G09: plan-review-acceptance discrimination check, reusing the predictability-check pattern; add an "existing behaviour" Gherkin category; `# why:` per scenario.
- G11: per-step `Inputs:`/`Outputs:`, ≤1 scenario per step.
- G12: 5-line authority-order rule in /build escalation.
- G05: soft size signal (AC > ~5 → offer a split). Keep feature-per-spec; don't fight the upstream design.
- G20: `/explain-build` tour.
- Upstream sync of 579a4e333 (documentation style) is trivial.

Dropped or adjusted per verifiers:
- G08 severity levels: dropped, contradicts `specs/SKILL.md:216`.
- G10 per-slice scope gate item: dropped, contradicts `:88`.
- G04 and G07 downgraded from missing to partial.
- G18 /continue: template still present.