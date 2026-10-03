# Porting dev-team (Claude Code) to pi

Upstream: `bdfinst/agentic-dev-team`, plugin `plugins/dev-team` v14.0.0 (commit 2bf3d98, 2026-09-30).
Target: pi coding agent 0.99.x (`@earendil-works/pi-coding-agent`).

## 1. What upstream is

`dev-team` is a Claude Code plugin made of five kinds of parts:

| Part | Count | What it relies on in Claude Code |
|---|---|---|
| Agents (`agents/*.md`) | 46 | `Agent`/`Task` tool with `subagent_type`, frontmatter `model: opus/sonnet/haiku`, `effort`, `tools`, `skills` |
| Skills (`skills/*/SKILL.md`) | 99 (95 user-invocable) | Slash commands, `$ARGUMENTS`/`$0` substitution, `Skill` tool for chaining, `AskUserQuestion`, `allowed-tools` |
| Hooks (`hooks/*.py`, `hooks.json`) | 42 wired | PreToolUse / PostToolUse / SessionStart / Stop / SubagentStop / SessionEnd / UserPromptSubmit, JSON on stdin, exit 2 = block |
| Scripts, libs, tools | ~135 Python files | `${CLAUDE_PLUGIN_ROOT}`, `.claude/` project state, 6 call sites of `claude -p` |
| Knowledge, templates | ~135 files | Plain markdown and JSON, referenced by path |

Many guarantees in the skills are only true because a hook enforces them: careful/freeze/guard, tests-frozen during REFACTOR, the verify loop guard, the `gh pr create` review gate, the review-verdict ledger, cost metering.

## 2. Porting strategy: a compatibility runtime, not a rewrite

Rewriting 99 skills and 46 agents by hand would fork the content and make every upstream release a manual merge. Instead the port ships the upstream content almost unchanged and adds a pi extension that provides the Claude Code runtime contract that content expects.

```
upstream plugins/dev-team  --sync/sync_upstream.py-->  pi-dev-team package
                                                      + extensions/dev-team (TypeScript runtime)
                                                      + bin/claude (CLI shim -> pi)
                                                      + overrides/ (pi-specific skills)
```

`sync/sync_upstream.py` is re-runnable. A new upstream release is one command, and the diff shows only upstream changes plus the small, listed patch set.

## 3. Concept mapping

| Claude Code | pi port | Where |
|---|---|---|
| Plugin + marketplace | pi package (`pi install ./pi-dev-team` or `git:`) | `package.json` |
| `${CLAUDE_PLUGIN_ROOT}` | Set in `process.env` by the extension, so bash, hooks, scripts and subagents see it | `extensions/dev-team/env.ts` |
| `CLAUDE_PROJECT_DIR`, `CLAUDE_SESSION_ID` | Same, from `ctx.cwd` and the pi session id | same |
| Slash command `/plan args` | Extension command `/plan` that expands `SKILL.md` with `$ARGUMENTS`, `$0..$N` substituted and sends it as the user turn | `skills.ts` |
| `Skill` tool (skill chaining, e.g. `/specs` -> `/plan`) | `skill` tool: `{name, args}` returns the expanded skill | `skills.ts` |
| Skill listing for the model | Compact index (name, command, first ~220 chars of the description) in a `<dev_team>` system-prompt section, like Claude Code's budgeted Skill tool listing. Skills are deliberately *not* registered as native pi skills: pi's full listing of 99 descriptions was 61 KB of system prompt; the compact index keeps the whole prompt at ~26 KB | `skills.ts`, `index.ts` |
| `Agent` / `Task` tool | `dev_team_subagent` tool: spawns `pi --mode json -p --no-session` with the agent body as appended system prompt, mapped tools, tier-resolved model, thinking level from `effort`. Single, parallel (`tasks[]`), `isolation: "worktree"`. Namespaced to coexist with other extensions such as `pi-subagents`. Follows pi's `examples/extensions/subagent`: child usage is returned as the tool result's `usage` (pi adds it to session totals), project agents are skipped only when pi trust was declined for the project, and `renderCall`/`renderResult` draw live per-agent progress in the TUI | `subagent.ts`, `subagent-render.ts` |
| `model: opus/sonnet/haiku/fable` | Tier table in `dev-team.json` (per user or project). Default `inherit` = parent's model. Presets for GitHub Copilot, Anthropic, OpenAI | `config.ts`, `/dev-team models` |
| `effort: low/medium/high` | `--thinking low/medium/high` | `agents.ts` |
| `tools: Read, Grep, Glob, Bash, Edit, Write` | `read, grep, find, ls, bash, edit, write` (+ `skill`, `dev_team_subagent`, `ask_user`, `web_fetch` when listed) | `agents.ts` |
| Agent `skills:` frontmatter | Skill names appended to the child system prompt as a hint, with how to load them (exactly what upstream's `subagent_skill_context.py` injects, because Claude Code does not preload skills for plugin agents). Full preload would add up to 290 KB per dispatch | `subagent.ts` |
| Agent `memory:`, `color:` | Ignored (UI / Claude-only persistent agent memory) | – |
| Agent `tools: Bash(cmd *)` scoped grants | pi cannot scope bash; the allowed patterns are stated in the child prompt | `agents.ts` |
| `AskUserQuestion` | `ask_user` tool (select or free text; errors in non-interactive mode so gates fall back to their documented default) | `ask-user.ts` |
| `WebFetch` | `web_fetch` tool (URL to text). `WebSearch` has no equivalent; skills fall back as upstream documents | `web-fetch.ts` |
| hooks.json + Python hooks | Hook bridge: reads upstream `hooks/hooks.json`, builds the Claude-shaped stdin payload from pi events, runs the same Python scripts, translates exit codes and JSON back | `hooks.ts` |
| PreToolUse | `tool_call` (block, or mutate input for `updatedInput`) | |
| PostToolUse | `tool_result` (advisories appended to the tool result, `decision: block` sets `isError`) | |
| SessionStart / UserPromptSubmit / Stop / SessionEnd | `session_start` / `input` / `agent_end` / `session_shutdown` | |
| SubagentStop | Fired by the `dev_team_subagent` tool after each child, with a synthetic Claude-format transcript so `review_verdict_recorder.py` and `subagent_completion_guard.py` run unchanged | `transcript.ts` |
| `cost_meter.py` (parses Claude transcripts, Claude-only price table) | TypeScript cost meter using pi's own `usage.cost` (works for Copilot and every provider). Same `cost-metering.jsonl` row shape plus `session_id`, so `/cost-report`, `regression`, `pace`, `/autoship --max-cost-usd` keep working | `metrics.ts` |
| `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` (Claude Code compacts at that % of the window; written by `/setup` via `scripts/set_autocompact_env.py`) | Read with the same precedence as `hooks/lib/autocompact_config.py` (process env, `.claude/settings.local.json`, `.claude/settings.json`, user settings). At `agent_end` the extension calls `ctx.compact()` once usage reaches that % (`ctx.getContextUsage()` knows every model's window). `ctx.compact()` aborts a running turn, so inside one long run pi's own threshold (`contextWindow - reserveTokens`) is the backstop. Unconfigured repos keep pi's default | `metrics.ts` |
| SessionStart `source: "compact"` (`post_compact_state_reinject.py`) | Fired from pi's `session_compact` event. The re-injected `/build` state reaches the model on the next turn, or as a steer message when compaction happened mid-run. SessionStart matchers are applied to the source | `index.ts` |
| `claude -p` / `claude --print` in scripts | `bin/claude` shim translating the flags the scripts use into `pi --mode json -p` and printing a Claude-style result envelope. Prepended to `PATH` inside pi only | `bin/claude` |
| `test -t 0` interactivity check | Always false under a tool shell (would auto-approve every gate). Patched to `DEV_TEAM_INTERACTIVE=1`, which the extension sets when a human UI is attached | sync patch |
| `.claude/` project state | Kept as is (`.claude/memory`, `.claude/metrics`, `.claude/hooks`). 67 Python files and ~50 skills address it; changing the name buys nothing and breaks resync | – |
| `CLAUDE.md` | pi reads both `AGENTS.md` and `CLAUDE.md`. `/setup` writes `AGENTS.md` | override |
| `/setup`, `/help`, `/version`, `/upgrade`, `/headless-run` | Rewritten for pi | `overrides/` |

## 4. What is dropped, and why

| Upstream | Reason |
|---|---|
| Skills `agent-audit`, `agent-eval`, `harness-e2e-check`, `long-eval`, `orchestration-benchmark`, `claude-setup-review` and agent `claude-setup-review` | Test or audit Claude Code's own harness and plugin layout |
| Skill `session-review` and agent `session-analysis` | Mine `~/.claude/projects` transcripts. A pi session backend for `session_log` is future work |
| Hook `mcp_json_repowise_nudge` | About Claude's `.mcp.json` |
| Hooks `code_intelligence_nudge`, `code_intelligence_turn_mark`, `phase_marker` | Need Claude transcript turn structure; nudges only. Off by default, can be re-enabled |
| Monorepo-only hooks (`contract_version_guard`, `pre_commit_knowledge_index`, `knowledge_index`, `skills_index`, both banned-script scanners, `eval_compliance_check`) | Only act inside the upstream repo itself. Shipped but disabled by default |

## 5. Known differences

- Hook output. In Claude Code, text a PreToolUse/PostToolUse hook prints with exit 0 is only shown in the transcript view. The plugin was written as if the model sees it. The port appends it to the tool result so the model does see it (`hookOutputToModel`, default on).
- Parallel tool calls. Claude Code runs several `Agent` calls in one message in parallel; so does pi. The `dev_team_subagent` tool also accepts `tasks[]`. A global limit (`maxParallelAgents`, default 6) applies across both.
- Subagent transcripts are not saved as sessions (`--no-session`). Usage is captured from the JSON event stream and recorded.
- `allowed-tools` in skills is advisory in pi (as in upstream under `bypassPermissions`).
- Autocompact timing. Claude Code compacts at `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` between any two turns. The port compacts at that percentage when an agent run ends, because `ctx.compact()` aborts a running turn; within one long run pi's own threshold applies.
- `skill-injection.jsonl` (v14 instrument stream) is not written. The port injects skill hints natively instead of via `subagent_skill_context.py`, and uptake is computed from Claude subagent transcripts, which pi children do not save.

## 6. Implementation plan (done)

1. `sync/sync_upstream.py`: copy, drop list, overrides, frontmatter normalisation (description <= 1024, Claude keys moved under `metadata`), text patches, `UPSTREAM.json`.
2. Extension modules: `config`, `env`, `agents`, `skills` (commands + `skill` tool), `subagent`, `hooks` (bridge), `transcript`, `metrics`, `ask-user`, `web-fetch`, `/dev-team` command, compatibility guidelines in the system prompt.
3. `bin/claude` shim.
4. Overrides: setup, help, version, upgrade, headless-run.
5. Verification: unit tests for pure mapping code; offline end-to-end runs of the real `pi` binary against a scripted provider (commands, `skill`, `dev_team_subagent` single/parallel/worktree, hook blocks, SubagentStop ledger rows, cost rows); upstream Python hook test suite against the shipped copy.

## 7. Verification

- **Byte identity.** `hooks/`, `scripts/`, `tools/`, `knowledge/`, `templates/` and the 46 upstream agents are byte-identical to upstream (`diff -rq`). Only 13 `SKILL.md` files differ, each by a listed patch or note (`UPSTREAM.json`). The upstream Python test suite therefore applies unchanged.
- **Upstream Python suite** run against the shipped copy (`uv run --with pytest ... pytest plugins/dev-team/tests/{hooks,scripts,lib}` plus the top-level `tests/test_*.py` added in v14): 4293 passed. The single error is `test_durable_runner.py`, which tests the dropped `long-eval` skill.
- **Unit tests** (`test/unit`, node:test, 24 tests): tool and MCP-name mapping, tier and effort resolution, parsing of every upstream agent and skill, argument substitution, hook wiring, Claude input mapping, the synthetic transcript shape, argument forwarding, SessionStart source matchers, autocompact setting precedence, untrusted discovery, usage roll-up, and the TUI renderers (also checked against pi's real theme).
- **Python tests** (`test/py`, 10 tests): sync helpers (description trimming, note insertion, idempotency) and the `claude` shim (flag translation, envelope, error path).
- **End-to-end** (`test/e2e/run.mjs`, 23 scenarios). These run the real `pi` binary with an offline scripted provider in throwaway git repos, verified on pi 1.0.0:
  - `/commands` with `$0`/`$ARGUMENTS`
  - the plugin env in bash
  - the `autocompact_setup_nudge` advisory, shown only while autocompact is unconfigured
  - subagent usage on the tool result matching the children's usage
  - project agents running by default, and skipped with `--no-approve`
  - `pre_tool_guard`, `destructive_guard`, freeze scope and `pre_pr_review` blocks
  - PostToolUse advisories reaching the model
  - single and parallel subagents
  - the dispatch ledger and review-verdict ledger rows (pass/findings)
  - worktree isolation, both kept and removed
  - the `skill` tool and `ask_user` (non-interactive)
  - cost rows split by agent type
  - the `claude -p` shim
  - coexistence with an extension registering `subagent`, in both load orders
  - parent/child prompt mapping and dispatch depth limits
  - an installed package whose guards also run inside subagent children alongside the other extension
- **Interactive.** A tmux session in pi's TUI covered `/dev-team` status, `/plan` expansion, and an `ask_user` select dialog whose answer reaches the model.
- **Not verified here.** Runs against real model providers. The sandbox had no provider credentials, so the first real Copilot run is the remaining check.
