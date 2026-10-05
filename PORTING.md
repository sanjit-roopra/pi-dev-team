# Porting dev-team (Claude Code) to pi

Upstream: `bdfinst/agentic-dev-team`, plugin `plugins/dev-team` v14.0.0 (commit 2bf3d98, 2026-09-30).
Target: pi coding agent 1.0.x (`@earendil-works/pi-coding-agent`; verified on 1.0.0 and 1.0.1, which provide the `agent_settled` event autocompact needs).

## 1. What upstream is

`dev-team` is a Claude Code plugin made of five kinds of parts (upstream counts; the port drops a few skills and adds two agents, see section 4 and the README):

| Part | Count | What it relies on in Claude Code |
|---|---|---|
| Agents (`agents/*.md`) | 46 | `Agent`/`Task` tool with `subagent_type`, frontmatter `model: opus/sonnet/haiku`, `effort`, `tools`, `skills` |
| Skills (`skills/*/SKILL.md`) | 99 (96 user-invocable) | Slash commands, `$ARGUMENTS`/`$0` substitution, `Skill` tool for chaining, `AskUserQuestion`, `allowed-tools` |
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
| `${CLAUDE_PLUGIN_ROOT}` | Set in `process.env` by the extension, so bash, hooks, scripts and subagents see it | `index.ts` (`applyEnv`) |
| `CLAUDE_PROJECT_DIR`, `CLAUDE_SESSION_ID` | Same, from `ctx.cwd` and the pi session id | same |
| Slash command `/plan args` | Extension command `/plan` that expands `SKILL.md` with `$ARGUMENTS`, `$0..$N` substituted and sends it as the user turn | `skills.ts` |
| `Skill` tool (skill chaining, e.g. `/specs` -> `/plan`) | `skill` tool: `{name, args}` returns the expanded skill | `skills.ts` |
| Skill listing for the model | Compact index (name, command, first ~220 chars of the description) in a `<dev_team>` system-prompt section, like Claude Code's budgeted Skill tool listing. Skills are deliberately *not* registered as native pi skills: pi's full listing of 99 descriptions was 61 KB of system prompt; the compact index keeps the whole prompt at ~26 KB. Project skills (`.pi/skills`, `.claude/skills`) are used only when pi trusts the project, as pi does for its own | `skills.ts`, `index.ts` |
| `Agent` / `Task` tool | `dev_team_subagent` tool: spawns `pi --mode json -p --no-session` with the agent body as appended system prompt, mapped tools, tier-resolved model, thinking level from `effort`. Single, parallel (`tasks[]`), `isolation: "worktree"`. Namespaced to coexist with other extensions such as `pi-subagents`. Follows pi's `examples/extensions/subagent`: child usage (including its own nested dispatches) is returned as the tool result's `usage` (pi adds it to session totals), and the cost meter credits nested dispatches to the agent and model that ran them; project agents are skipped only when pi trust was declined for the project (also for `--dev-team-agent`), and the child gets that decision explicitly (`--no-approve`; `--approve` only in the session's own directory, symlinks resolved, or a worktree this session made of the repository rooted there, since pi decides trust per directory); `renderCall`/`renderResult` draw live per-agent progress in the TUI, with child text stripped of terminal escape sequences and carriage returns as pi's own renderer does, and each child tool call shown with its key argument (`$ cmd`, `read path`); output over 50 KB (by bytes) is cut; the model is told which file holds the complete output and how to page through it, the TUI only shows the path; child tool calls are kept as structured summaries (a few shown arguments, capped) and formatted at render time; the tool declares pi's safety hints (`destructiveHint`, `openWorldHint`) for permission extensions | `subagent.ts`, `child-run.ts`, `trust.ts`, `subagent-render.ts`, `subagent-types.ts`, `terminal-text.ts` |
| `model: opus/sonnet/haiku/fable` | Tier table in `dev-team.json` (per user or project). The project's `.pi/dev-team.json` is ignored when pi trust was declined, and its `env` may only set an explicit list of dev-team tuning settings (`PROJECT_ENV_SETTINGS` in `config.ts`, plain numbers, words or flags): pi asks about trust only when a repo has pi-protected files, so a repo with just this file is trusted without a prompt, and its env must not reach `PATH`, `NODE_OPTIONS`, `PYTHONPATH`, a path the port reads or runs (`DEV_TEAM_PY_CACHE` is executed by `hooks/py.sh`), a program choice, or a gate bypass. Its `hooks` are ignored (hooks include the guards; set them in your own `~/.pi/agent/dev-team.json`); `/dev-team` status lists what was ignored. Repo-supplied files (agents, skills, settings, config) are read only when they are regular files up to 1 MB (`safe-read.ts`). Default `inherit` = parent's model. Presets: `github-copilot`, `anthropic`, `inherit` | `config.ts`, `/dev-team models` |
| `effort: low/medium/high` | `--thinking low/medium/high` | `agents.ts` |
| `tools: Read, Grep, Glob, Bash, Edit, Write` | `read, grep, find, ls, bash, edit, write` (+ `skill`, `dev_team_subagent`, `ask_user`, `web_fetch` when listed) | `agents.ts` |
| Agent `skills:` frontmatter | Skill names appended to the child system prompt as a hint, with how to load them (exactly what upstream's `subagent_skill_context.py` injects, because Claude Code does not preload skills for plugin agents). Full preload would add up to 290 KB per dispatch | `subagent.ts` |
| Agent `memory:`, `color:` | Ignored (UI / Claude-only persistent agent memory) | – |
| Agent `tools: Bash(cmd *)` scoped grants | pi cannot scope bash; the allowed patterns are stated in the child prompt | `agents.ts` |
| `AskUserQuestion` | `ask_user` tool (select or free text; errors in non-interactive mode so gates fall back to their documented default). `model-only` exposure, so codemode scripts cannot ask the user | `tools-misc.ts` |
| `WebFetch` | `web_fetch` tool (URL to text). `WebSearch` has no equivalent; skills fall back as upstream documents | `tools-misc.ts` |
| hooks.json + Python hooks | Hook bridge: reads upstream `hooks/hooks.json`, builds the Claude-shaped stdin payload from pi events, runs the same Python scripts, translates exit codes and JSON back | `hooks.ts` |
| PreToolUse | `tool_call` (block, or mutate input for `updatedInput`) | |
| PostToolUse | `tool_result` (advisories appended to the tool result, `decision: block` sets `isError`) | |
| SessionStart / UserPromptSubmit / Stop / SessionEnd | `session_start` / `input` / `agent_end` / `session_shutdown` | |
| SubagentStop | Fired by the `dev_team_subagent` tool after each child, with a synthetic Claude-format transcript so `review_verdict_recorder.py` and `subagent_completion_guard.py` run unchanged | `transcript.ts` |
| `cost_meter.py` (parses Claude transcripts, Claude-only price table) | TypeScript cost meter using pi's own `usage.cost` (works for Copilot and every provider). Same `cost-metering.jsonl` row shape plus `session_id`, so `/cost-report`, `regression`, `pace`, `/autoship --max-cost-usd` keep working | `metrics.ts` |
| `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` (Claude Code compacts at that % of the window; written by `/setup` via `scripts/set_autocompact_env.py`) | Read with the same precedence as `hooks/lib/autocompact_config.py` (process env, `.claude/settings.local.json`, `.claude/settings.json`, user settings). At `agent_settled` (after pi's own retry and overflow recovery, never inside a run) the extension calls `ctx.compact()` once usage reaches that % (`ctx.getContextUsage()` knows every model's window). Inside one long run pi's own threshold (`contextWindow - reserveTokens`) is the backstop. Project settings files are ignored when pi reports the project untrusted. Unconfigured repos keep pi's default | `autocompact.ts` |
| SessionStart `source: "compact"` (`post_compact_state_reinject.py`) | Fired from pi's `session_compact` event. The re-injected `/build` state is added to the context with `sendMessage(..., { triggerTurn: false })`, deferred to the end of a running turn, so like Claude's `additionalContext` it never starts a model turn by itself. SessionStart matchers are applied to the source | `index.ts` |
| `claude -p` / `claude --print` in scripts | `bin/claude` shim translating the flags the scripts use into `pi --mode json -p` and printing a Claude-style result envelope. Prepended to `PATH` inside pi only. Its pi children get `--no-approve` when the session declined trust, and `--approve` only when run in the session's own directory (`DEV_TEAM_TRUSTED_DIR`) | `bin/claude`, `trust.ts` |
| `test -t 0` interactivity check | Always false under a tool shell (would auto-approve every gate). Patched to `DEV_TEAM_INTERACTIVE=1`, which the extension sets when a human UI is attached | sync patch |
| `.claude/` project state | Kept as is (`.claude/memory`, `.claude/metrics`, `.claude/hooks`). 67 Python files and ~50 skills address it; changing the name buys nothing and breaks resync | – |
| `CLAUDE.md` | pi reads both `AGENTS.md` and `CLAUDE.md`. `/setup` writes `AGENTS.md` | override |
| `/setup`, `/help`, `/version`, `/upgrade`, `/headless-run` | Rewritten for pi | `overrides/` |

### Tools the extension adds

The model uses dev-team through four tools:

| Tool | Claude Code equivalent | Notes |
|---|---|---|
| `dev_team_subagent` | Agent / Task | Runs the agent in a child `pi` process with its own context, tools and tier model. Single calls, parallel calls (several calls in one message, or `tasks[]`), and `isolation: "worktree"`. Accepts `subagent_type`/`prompt` too. Live per-agent progress in the TUI; child spend counts in pi's session totals. |
| `skill` | Skill | Loads a skill with arguments substituted. This is how skills chain (`/specs` → `/plan`, `/ship` → everything). |
| `ask_user` | AskUserQuestion | The human gates. In non-interactive runs (`pi -p`, subagents) it tells the model to take the documented default. |
| `web_fetch` | WebFetch | URL to text. |

The dispatch tool is named `dev_team_subagent` so this package can coexist with `pi-subagents`, which registers `subagent`. Dev-team workflows use their own dispatch tool for model tiers, hooks, and metrics. Other workflows can still use the other package's `subagent` tool.

## 4. What is dropped, and why

| Upstream | Reason |
|---|---|
| Skills `agent-audit`, `agent-eval`, `harness-e2e-check`, `long-eval`, `orchestration-benchmark`, `claude-setup-review` | Test or audit Claude Code's own harness and plugin layout. The agent files `claude-setup-review` and `session-analysis` still ship (agents stay byte-identical) but nothing in the port dispatches them |
| Skill `session-review` | Mines `~/.claude/projects` transcripts. A pi session backend for `session_log` is future work |
| Hook `mcp_json_repowise_nudge` | About Claude's `.mcp.json` |
| Hooks `code_intelligence_nudge`, `code_intelligence_turn_mark`, `phase_marker` | Need Claude transcript turn structure; nudges only. Off by default, can be re-enabled |
| Monorepo-only hooks (`contract_version_guard`, `pre_commit_knowledge_index`, `knowledge_index`, `skills_index`, both banned-script scanners, `eval_compliance_check`) | Only act inside the upstream repo itself. Shipped but disabled by default |

## 5. Known differences

- Hook output. In Claude Code, text a PreToolUse/PostToolUse hook prints with exit 0 is only shown in the transcript view. The plugin was written as if the model sees it. The port appends it to the tool result so the model does see it (`hookOutputToModel`, default on).
- Parallel tool calls. Claude Code runs several `Agent` calls in one message in parallel; so does pi. The `dev_team_subagent` tool also accepts `tasks[]`. A global limit (`maxParallelAgents`, default 6) applies across both.
- Subagent transcripts are not saved as sessions (`--no-session`). Usage is captured from the JSON event stream and recorded.
- `allowed-tools` in skills is advisory in pi (as in upstream under `bypassPermissions`).
- Autocompact timing. Claude Code compacts at `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` between any two turns. The port compacts at that percentage when an agent run ends, because `ctx.compact()` aborts a running turn; within one long run pi's own threshold applies.
- GitHub text style. The port adds rules for pull request, issue and comment text (`lib/github-style.ts`, with `lib/gh-command.ts` and `lib/shell-scan.ts`: plain English after ASD-STE100 and a skim-first layout). The rules are in the `dev_team` system-prompt section of every session and subagent. In `tool_call`, before the PreToolUse hook bridge, a quote- and heredoc-aware scan finds each `gh pr|issue create|edit|comment` and checks its literal title and body. A breaking call is blocked once with the list of problems; the identical resend goes on to the hooks, so `pre_pr_review` still applies (`githubStyle`: `block`, `warn`, `off`; `off` also drops the rules from the prompt). Notes on `/pr`, `/specs`, `/issues-from-plan`, `/issues-from-assessment` and `/autoship` keep their required sections; `/pr` moves Decisions & Assumptions and the Evidence Bundle into one `<details>` block.
- `skill-injection.jsonl` (v14 instrument stream) is not written. The port injects skill hints natively instead of via `subagent_skill_context.py`, and uptake is computed from Claude subagent transcripts, which pi children do not save.

## 6. Implementation plan (done)

1. `sync/sync_upstream.py`: copy, drop list, overrides, frontmatter normalisation (description <= 1024, Claude keys moved under `metadata`), text patches, `UPSTREAM.json`.
2. Extension modules: `config`, `agents`, `skills` (commands + `skill` tool), `subagent` (+ `subagent-types`, `subagent-render`, `child-run`, `trust`, `terminal-text`), `hooks` (bridge; the Python interpreter is resolved on first use, not at load), `transcript`, `session-files` (one private `mkdtemp` directory per pi process, owner-only files created exclusively, removed when pi quits; kept across reload, new, resume and fork, whose tool results may name them), `metrics`, `autocompact`, `safe-read`, `shell-scan`, `gh-command`, `github-style`, `tools-misc` (`ask_user`, `web_fetch`), and in `index.ts` the plugin env, the `/dev-team` command and the compatibility guidelines in the system prompt.
3. `bin/claude` shim.
4. Overrides: setup, help, version, upgrade, headless-run. Notes: autoship, issues-from-assessment, issues-from-plan, mutation-night-watch, mutation-testing, pr, project-init, setup, specs.
5. Verification: unit tests for pure mapping code; offline end-to-end runs of the real `pi` binary against a scripted provider (commands, `skill`, `dev_team_subagent` single/parallel/worktree, hook blocks, SubagentStop ledger rows, cost rows); upstream Python hook test suite against the shipped copy.

## 7. Verification

- **Byte identity.** `hooks/`, `scripts/`, `tools/`, `knowledge/`, `templates/` and the 46 upstream agents are byte-identical to upstream (`diff -rq`). Only 17 `SKILL.md` files differ, each by a listed patch or note (`UPSTREAM.json`). The upstream Python test suite therefore applies unchanged.
- **Upstream Python suite** run against the shipped copy (`uv run --with pytest ... pytest plugins/dev-team/tests/{hooks,scripts,lib}` plus the top-level `tests/test_*.py` added in v14): 4293 passed. The single error is `test_durable_runner.py`, which tests the dropped `long-eval` skill.
- **Unit tests** (`test/unit`, node:test, 496 tests): tool and MCP-name mapping, tier and effort resolution, parsing of every upstream agent and skill, argument substitution, hook wiring, Claude input mapping, the synthetic transcript shape, argument forwarding, SessionStart source matchers, autocompact validity, precedence and threshold, trust-aware agent and skill discovery, config loading (trust gate, project env allowlist and values, malformed env, project hooks ignored, file guard), the bounded read itself, the GitHub style shell scan, gh flag extraction, rules and block-once gate (including hook order and the resend), skill file guard and untrusted-skill reasons, child trust flags (session directory, own worktrees, symlinks) and the shim trust env, the cost row's nested crediting, child event folding and nested-usage crediting, progress streaming and the model-facing result text, usage roll-up, byte-safe output cutting and the full-output note for model and view, the private session files (modes, no overwrite, path segments, failed saves, transcripts, cleanup), loading the extension with a fake pi (no process started at load, safety hints on all four tools, `ask_user` model-only), and the TUI renderers including tool-call formatting and terminal-escape sanitizing. The renderers were also drawn once by hand with pi's real theme; that check is not automated.
- **Python tests** (`test/py`, 12 tests): sync helpers (description trimming, note insertion, idempotency) and the `claude` shim (flag translation, envelope, error path, trust forwarding in the child argv).
- **End-to-end** (`test/e2e/run.mjs`, 28 scenarios). These run the real `pi` binary with an offline scripted provider in throwaway git repos, verified on pi 1.0.0 and 1.0.1:
  - `/commands` with `$0`/`$ARGUMENTS`
  - the plugin env in bash
  - the `autocompact_setup_nudge` advisory, shown only while autocompact is unconfigured
  - subagent usage on the tool result matching the children's usage
  - project agents running by default with a trusted child, and with `--no-approve` package agents only and an untrusted child
  - `--dev-team-agent` ignoring project agents under `--no-approve`
  - the cost row crediting a nested dispatch to the agent that ran it
  - project `.pi/dev-team.json`: an allowed tuning setting applied, `NODE_OPTIONS` and `DEV_TEAM_PY_CACHE` not, nothing under `--no-approve`; its `hooks` cannot switch the guards off
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
