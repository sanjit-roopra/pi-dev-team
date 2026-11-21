# Architecture

Read this file before you change an extension, the hook bridge, an agent, a skill or a hook. To use the package, read [README.md](../README.md). To run the tests and make a release, read [CONTRIBUTING.md](../CONTRIBUTING.md).

pi-dev-team is a pi package. Two TypeScript extensions give pi the runtime: commands, tools, guards, agent dispatch and cost views. The other folders hold the content that the model reads (agents, skills, knowledge) and the Python code that runs around it (hooks, scripts).

## The parts of the package

`package.json` loads two extensions: `extensions/spend/index.ts` and `extensions/dev-team/index.ts`. Every other part is content or code that the dev-team extension gives to the model or runs.

| Part | What it holds | Who uses it |
|---|---|---|
| `extensions/dev-team/` | The runtime: commands, tools, the hook bridge, agent dispatch, guards and autocompact. `gate/` and `lean/` hold the review profile sections. | pi loads it. |
| `extensions/spend/` | `/spend` and the GitHub Copilot AI credits status line. It needs nothing from `extensions/dev-team/`. | pi loads it. |
| `extensions/shared/` | `terminal-text.ts`, which both extensions use. | Both extensions |
| `agents/` | 46 agent files: markdown with frontmatter (`name`, `description`, `tools`, `model`, `effort`, `skills`). | `dev_team_subagent` |
| `skills/` | 92 skills, one `skills/<name>/SKILL.md` each. 89 are user commands. Some have `references/`, scripts or adapters. | Commands, the `skill` tool |
| `hooks/` | Python hook scripts, `hooks.json` (which event runs which script), `guards.json` and `hooks/lib/`. | The hook bridge |
| `scripts/` | Python helpers that skills run, for example `build_phase.py` and `example_replay.py`. | The model, through `bash` |
| `knowledge/` | Reference text that prompts cite by path, and `index.json`. | The model |
| `templates/` | `ACCEPTED-RISKS.md.tmpl` and the agent templates in `templates/agents/` that `/setup` activates. | Skills |
| `tools/` | `entropy-check.py` and `model-hash-verify.py`. | Skills, for example `static-analysis-integration` |
| `bin/dev-team-run` | A helper that runs one headless pi call for a Python script and prints a JSON result. | Scripts, through `PATH` |

`devtools/` (maintainer scripts) and `test/` are in the repository only. The npm package does not ship them.

### Environment that the extension sets

`${DEV_TEAM_ROOT}` is the package root. The extension sets it in its own process environment, so bash, hooks, scripts and agents see it. A path such as `scripts/build_phase.py` in a prompt is relative to it.

| Variable | Value |
|---|---|
| `DEV_TEAM_ROOT` | The package root. Set at load, at each session start and for each hook. |
| `DEV_TEAM_PROJECT_DIR` | The session directory (`ctx.cwd`). A hook gets the directory it runs in. |
| `DEV_TEAM_SESSION_ID` | The pi session id. |
| `DEV_TEAM_INTERACTIVE` | `1` when a UI is attached and questions are on (`askTimeoutSec` over 0, or wait mode). Removed for agents. |
| `DEV_TEAM_NESTED` | The process id of the session. A pi process that finds another id at load runs inside a tool call of another session. |
| `DEV_TEAM_PI_ARGS`, `DEV_TEAM_TRUSTED_DIR` | The session's trust decision, for `dev-team-run` (see [Trust](#trust)). |
| `PATH` | `bin/` first when `cliShim` is `true` (the default). |
| `DEV_TEAM_REVIEW`, `DEV_TEAM_EXAMPLES` | The values from the user's shell at load, written again into the session, each agent and each hook. A configuration file's `env` cannot change them. |

The merged configuration's `env` entries are also exported. A project file can only set the names in `PROJECT_ENV_SETTINGS` (`lib/config.ts`). An agent process also gets `DEV_TEAM_SUBAGENT=1`, `DEV_TEAM_SUBAGENT_DEPTH`, `DEV_TEAM_AGENT_NAME` and `DEV_TEAM_PARENT_SESSION_ID`.

## How a skill becomes a command

Each skill whose frontmatter does not set `user-invocable: false` becomes a pi command with the same name. `lib/skills.ts` does the work. When the user types `/plan add rate limits`, this happens:

1. The command reads `SKILL.md` again, through the same 1 MB size guard as at load.
2. It fires the `UserPromptSubmit` hook with the command text.
3. For `plan`, `specs` and `ship`, it saves the request text (see [Saved requests](#saved-requests-and-the-request-folder-guard)).
4. It expands the skill and sends the result as the user turn.

In print, json and rpc mode, the command waits until that turn ends.

### Expansion and arguments

Expansion removes the frontmatter and wraps the body in `<skill name="..." location="...">`. A header line names the folder that relative references resolve from, and says that `${DEV_TEAM_ROOT}` is set. A command also adds "The user invoked `/plan ...`. Follow the skill above." and the path of the saved request, if there is one.

| In the skill body | Becomes |
|---|---|
| `$ARGUMENTS` | The whole argument text |
| `$ARGUMENTS[N]` | Argument N, counted from 0 |
| `$N` (one digit) | Argument N, counted from 0 |
| No placeholder | The text, appended as `ARGUMENTS: <text>` |

Arguments split like a shell command: spaces separate them, and single or double quotes group them.

The review profile (`DEV_TEAM_REVIEW`, default `gate`) adds a section from `extensions/dev-team/gate/` or `lean/` to `/plan`, `/build`, `/code-review` and `/ship`. The example check adds one step to `/specs` (`gate/specs-examples.md`). The section goes after the last `<!-- pi-notes -->` marker, or after the title when there is no marker. 13 skills hold a `## pi notes` block between two such markers, with rules that this package adds to the skill. [docs/review-profiles.md](review-profiles.md) describes the profiles and the example check.

### The skill tool

The `skill` tool takes `{ name, args }` and returns the same expansion, without the "user invoked" line. It accepts a leading `/` and a `dev-team:` prefix. Skills chain through this tool: `/specs` loads `/plan`, and `/ship` loads every phase. The system prompt tells the model that "run /plan" in a prompt means a `skill` call, never a request to the user.

### The compact skill index

The model learns which skills exist from an index in the `dev_team` section of the system prompt. Each line is `- <name> (/<name>): <description>`. The `(/<name>)` part shows only for a user command.

| `skillIndex` | Effect |
|---|---|
| `compact` (default) | Each description is cut to `skillIndexChars` characters (default 220), at a sentence end when one is near. |
| `full` | Full descriptions. |
| `off` | No index, and no skill list in agent prompts. |

The package skills are not registered as pi's own skills. pi's listing of every full description measured 61 KB of system prompt. With the compact index, the whole prompt measured about 26 KB.

An agent gets no full index. Its prompt lists only the skills that its frontmatter or its body names, plus the project skills. It says that any other skill loads by name. The full index is about 21,000 characters (about 5,000 tokens) on every turn of every dispatch.

A project skill (`.pi/skills/<name>/SKILL.md`) replaces a package skill with the same name, for example the project `/pr` that `/setup` writes. Project skills count only when pi trusts the project.

## Agents and dev_team_subagent

An agent is a markdown file whose body is a system prompt. The `dev_team_subagent` tool runs each dispatch as a separate pi process: `pi --mode json -p --no-session`. In this file, "the session" is the pi session that the user talks to, and "the agent" is that separate process.

The tool looks up `.pi/agents/` first (only when pi trusts the project), then `agents/`. A name can have a `dev-team:` prefix and any case.

| Call field | Meaning |
|---|---|
| `agent` (or `subagent_type`) | The agent name |
| `task` (or `prompt`) | The full task text. The agent sees only this, not the conversation. |
| `description` | A label of 3 to 5 words for the progress view |
| `model`, `thinking` | A tier or `provider/id`, and a thinking level |
| `cwd`, `isolation` | The working folder, and `"worktree"` for a new Git worktree |
| `tasks[]` | Several dispatches with the same fields, run at the same time |

### Frontmatter in the agent process

| Field | What the agent process gets |
|---|---|
| `model` | A tier name goes through the `models` table. `inherit`, or a tier mapped to `inherit`, uses the session model. A `provider/id` value is used as is. |
| `effort` | `--thinking`, through the `thinking` table. A dispatch `thinking` value can lower it, never raise it. |
| `tools` | `--tools`, mapped as in the next table. No `tools` field gives pi's default tools. |
| `skills` | The skill names, listed in the agent prompt with how to load them. |
| `memory`, `color` | Ignored. |

The tiers are `opus`, `sonnet`, `haiku` and `fable`. By default every tier is `inherit`. `/dev-team models` writes a preset (`github-copilot`, `anthropic`, `inherit`) or a custom table into the user or project configuration. `/dev-team doctor` advises a preset when the default tiers still run on the session model. No package agent names `fable`.

Agents with `effort: high` include `correctness-review`, `plan-review-acceptance`, `software-engineer` and `qa-engineer`. Most review lenses (review agents with one topic each) and plan critics (agents that review a plan) have `effort: medium`. The rule "lower, never raise" exists because the session passed its own level on most dispatches. A lens set to `medium` then ran at `high`.

### Tool names

The prompt files name tools as `Read`, `Bash` or `Agent`. The extension maps them to pi tools. The dev-team guide (the `dev_team` section of the system prompt) states the same mapping for prose.

| Name in a prompt | pi tool |
|---|---|
| `Read`, `Grep`, `LS`, `Bash`, `Write` | `read`, `grep`, `ls`, `bash`, `write` |
| `Glob` | `find` and `ls` |
| `Edit`, `MultiEdit`, `NotebookEdit` | `edit` |
| `Skill`, `AskUserQuestion`, `WebFetch` | `skill`, `ask_user`, `web_fetch` |
| `Agent`, `Task` | `dev_team_subagent` |
| `TodoWrite`, `WebSearch` | None |
| `mcp__<pattern>` | Each pi tool that matches, plus `codemode` when it exists |
| `Bash(<pattern>)` | `bash`, all of it. The patterns are stated in the agent prompt. |

An agent at depth `maxSubagentDepth` (default 2) cannot dispatch further, so its tool list loses `dev_team_subagent`.

### The agent prompt

The agent process gets the same `dev_team` guide as the session, without the full skill index and without the Agent tiers line. The agent's own text goes into a `dev_team_agent` section after the guide. So agents with the same tools and model share one cached prompt prefix: pi's prompt, the project context, the folder and the guide. The flag `--dev-team-agent-prompt 1` tells the agent process that it runs as an agent.

In the guide, the orchestrator that the skills describe is the session. Skills that run commands or write files (`/code-review`, `/build`, `/pr`, `/ship`, `/fix`) run in the session. A model dispatches an agent only when the agent's `tools:` cover the work. A dispatched agent does not start those skills unless its task says so. This rule exists because a model read "Role: orchestrator" in `/code-review` as "dispatch the `orchestrator` agent". That agent has no bash or write, so the review stopped.

### The result

The tool result holds the agent's final text. Over 50 KB (by bytes), the tool cuts the text and tells the model how to page through the full file. The tool always saves the full output to a file in the temporary folder of the session. A single dispatch ends with `[model <provider/id>, tier <tier>]`. A parallel result names the model in each section heading.

The agent's token use goes back as the tool result's `usage`, so pi adds it to the session totals. The tool also writes a `dev-team-subagent-usage` session entry. It credits the dispatches that the agent made itself to their own agent and model.

Around each dispatch, the tool fires two hooks. `PreToolUse` with tool name `Agent` runs before the agent starts, and can block that dispatch. `SubagentStop` runs after it ends, with a transcript in the format that the hooks read.

### Worktrees

`isolation: "worktree"` runs the agent in a new Git worktree. The repository needs at least 1 commit.

1. The tool runs `git worktree add -b dev-team/<agent>-<id> <repo root>/.pi/dev-team/worktrees/<agent>-<id> HEAD`.
2. The agent works there. The branch starts at local `HEAD`, so specs and plans that the session wrote before the dispatch are visible.
3. If the agent changed nothing and made no commit, the tool removes the worktree and the branch.
4. If not, the tool keeps both and names them in the result.

Changes to dev-team state in the worktree do not count as work. In a parallel call, an agent that can write and shares its folder with other agents gets a warning in the result.

### Trust

pi decides trust per folder. The tool passes the session's decision to each agent process:

| Session trust | The agent runs in | Flag |
|---|---|---|
| Declined | Any folder | `--no-approve` |
| Granted | The session folder (symlinks resolved) | `--approve` |
| Granted | A worktree that this session made of the repository rooted there | `--approve` |
| Granted | Another folder | None. The agent process decides. |

When trust is declined, project agents do not run, and the result names them. `dev-team-run` gets the same decision: `--no-approve` in `DEV_TEAM_PI_ARGS`, or `--approve` only when it runs in `DEV_TEAM_TRUSTED_DIR`.

The project configuration (`.pi/dev-team.json` and `.pi/dev-team.local.json`) counts only for a trusted project. pi asks about trust only when a repository has pi-protected files. So pi trusts a repository with only `.pi/dev-team.json` without a prompt. For that reason the extension filters project files:

| Project key | Rule |
|---|---|
| `hooks`, `allowPiSubagents`, `askTimeoutSec`, `answerMode`, `notify` | Ignored. Set them in `<agentDir>/dev-team.json`. |
| `env` | Only names in `PROJECT_ENV_SETTINGS`, with plain values (letters, digits, `.`, `_`, `-`, at most 64 characters) |
| `autocompactMaxTokens` | Only 0, or 50000 and more |
| `maxParallelAgents` | Only a whole number from 1 to 16 |

`/dev-team status` lists what it ignored. The extension reads files from the repository (agents, skills, configuration) only when they are regular files of 1 MB or less (`lib/safe-read.ts`).

### Live progress

`renderCall` and `renderResult` draw one row per agent in pi's TUI. While a dispatch runs, the row redraws once a second. It shows:

- The time per agent and for the call, and the tool call that runs now with its time.
- The time that the model spent on its current step so far.
- Agents that wait for a free slot, with their place in line.
- The spend so far.
- Each tool call of the agent with its key argument, for example `$ cmd` or `read path`.

On a call with `tasks[]`, `description` labels the header. The row shows agent text without terminal escape sequences and carriage returns. The tool declares pi's safety hints (`destructiveHint`, `openWorldHint`) for permission extensions.

### Parallel limit

One limiter covers every dispatch of the session, from several calls in one message or from `tasks[]`. `maxParallelAgents` sets it (default 6). `DEV_TEAM_MAX_PARALLEL_AGENTS` in the process environment wins over every configuration file, for containers that mount the agent folder over. A freed slot goes straight to the next agent in line. Each agent stops after `subagentTimeoutSec` (default 3600).

The tool name is `dev_team_subagent`, so the package can run next to pi-subagents. The extension hides and blocks the pi-subagents tools unless the user's own configuration sets `allowPiSubagents: true`. Other dispatch tools skip the tier models, the dispatch hooks and the review evidence that `pre_pr_review.py` checks before `gh pr create`.

## The hook bridge

A hook is a Python script that runs on an event, for example before a tool call. `lib/hooks.ts` reads `hooks/hooks.json`, takes the last `hooks/<name>.py` in each command, and runs that script with Python. It tries `DEV_TEAM_PYTHON`, `python3` and `python`, and needs Python 3.10 or later. Without it, every hook is off, and pi shows `dev-team: python >= 3.10 not found — hook guards are disabled.`

### Events

| Hook event | pi event | Notes |
|---|---|---|
| `SessionStart` | `session_start`, `session_compact` | Source `startup`, `clear`, `resume` or `compact`. Not in agent processes. |
| `UserPromptSubmit` | `input`, and each dev-team command | pi does not pass extension commands to `input`, so the command fires it. |
| `PreToolUse` | `tool_call` | For `dev_team_subagent`: once per dispatch, inside the tool. |
| `PostToolUse` | `tool_result` | |
| `Stop` | `agent_end` | Only in the session, not in agent processes. |
| `SubagentStop` | After each dispatch | Fired by `dev_team_subagent`. |
| `SessionEnd` | `session_shutdown` | Reason `prompt_input_exit` on quit, else `other`. |

A matcher in `hooks.json` is a regular expression. It must match the whole tool name (or the `SessionStart` source). A script that `hooks.json` lists twice for one event runs once.

### The hook payload

Each script gets one JSON object on stdin. Every payload has `hook_event_name`, `session_id`, `cwd` and `transcript_path`.

| Event | Extra fields |
|---|---|
| `PreToolUse` | `tool_name`, `tool_use_id`, `tool_input` |
| `PostToolUse` | The same, plus `tool_response` |
| `UserPromptSubmit` | `prompt` |
| `SessionStart` | `source` |
| `Stop` | `stop_hook_active` (`false`) |
| `SubagentStop` | `agent_transcript_path`, `agent_id`, `agent_type` (`dev-team:<agent>`), `stop_hook_active` |
| `SessionEnd` | `reason` |

`tool_name` uses the names in the [tool names](#tool-names) table: `bash` is `Bash`, `find` is `Glob`, `dev_team_subagent` is `Agent`. `tool_input` uses these fields, with absolute paths:

| pi tool | `tool_input` |
|---|---|
| `write` | `file_path`, `path`, `content` |
| `edit` | `file_path`, `path`, `old_string`, `new_string` (each joins all edits with newlines), `replace_all: false` |
| `read` | `file_path`, `path`, `offset`, `limit` |
| `grep`, `find`, `ls` | `pattern`, `path` (and `glob` for `grep`) |
| `bash` | `command`, `timeout` |
| `skill` | `skill`, `name`, `args` |
| `dev_team_subagent` | `subagent_type`, `prompt`, `description`, `model` |

For `bash`, `tool_response` holds `output`, `exit_code`, `stdout`, `stderr` and `interrupted`. For other tools, it holds `output` and `success`.

A hook runs in the session folder with the process environment, the configuration `env`, `DEV_TEAM_ROOT` and `DEV_TEAM_PROJECT_DIR`. It stops after `hooks.timeoutSec` seconds (default 60).

### Exit codes and output

| Exit | Output | Effect |
|---|---|---|
| 2 | Any | Block. The reason is stdout plus stderr. |
| 0 | JSON `hookSpecificOutput.updatedInput` | Changes the call: the bash command, the agent task, the file path or the written content. |
| 0 | JSON `hookSpecificOutput.additionalContext` | An advisory for the model. |
| 0 | JSON `permissionDecision: "deny"` or `decision: "block"` | Block, with `permissionDecisionReason` or `reason`. |
| 0 | JSON `systemMessage` | A notice for the user. |
| 0 | Plain text on stdout | An advisory for the model. |
| 0 | Text on stderr | A notice for the user. |
| Other, or timeout | Any | No block. The user sees `[<hook>] failed (...)`. |

An advisory on a tool call goes into the tool result, after `dev-team hook notes:`, so the model sees it. Set `hooks.outputToModel: false` to show advisories to the user instead. A `PostToolUse` block adds `dev-team hook feedback (must address):` and marks the result as an error. `SessionStart` text goes into the context before the next model run. After a compaction, the bridge adds that text without starting a turn.

When the destructive-command guard marks a command `CAUTION` and a human is attached, pi asks "Run this destructive command?". The dialog waits `askTimeoutSec` seconds. No answer means no.

### Order of checks on a tool call

| Order | Check | Source |
|---|---|---|
| 1 | Block pi-subagents tools | `lib/pi-subagents.ts` |
| 2 | Request-folder guard (example check on) | `lib/request-guard.ts` |
| 3 | Brief check for plain requests (`routing: "brief"`) | `lib/brief.ts` |
| 4 | GitHub text style, and plain language in `ask_user` and `dev_team_brief` | `lib/github-style.ts`, `lib/plain-questions.ts` |
| 5 | `PreToolUse` hooks, then the `CAUTION` dialog, then `updatedInput` | `lib/hooks.ts` |

### Hooks that are off by default

`DEFAULT_DISABLED_HOOKS` in `lib/config.ts` holds the list. `/dev-team hooks` shows the state of every hook.

| Hook | Why it is off |
|---|---|
| `cost_meter` | The TypeScript cost meter replaces it (see [Cost metering](#cost-metering-and-spend)). |
| `subagent_skill_context` | The agent prompt already lists the agent's skills. |
| `code_intelligence_nudge`, `code_intelligence_turn_mark`, `phase_marker` | They need a per-turn transcript structure that pi does not write. They only give nudges. |
| `version_check` | Opt-in. Once a day, it checks whether the Git checkout of the package is behind its `origin` remote, and then suggests `/upgrade`. |

`hooks.disabled` in `<agentDir>/dev-team.json` replaces the list, and `hooks.enable` turns single hooks back on. A project file cannot change `hooks`, so a cloned repository cannot turn off a guard. With `autoFormat: true`, `post_format.py` runs after each `write` and `edit`, whatever the list says.

## The tools that the extension adds

| Tool | What it does | Notes |
|---|---|---|
| `dev_team_subagent` | Runs agents as separate pi processes (see [Agents](#agents-and-dev_team_subagent)). | Single calls, `tasks[]` and worktrees. |
| `skill` | Returns a skill with its arguments substituted. | Read-only hint. |
| `ask_user` | Asks the human: a choice or free text, in plain language (`lib/plain-questions.ts`). | `model-only` exposure, so codemode scripts cannot call it. Waits `askTimeoutSec` (default 120). `w` or `answerMode: "wait"` stops the timeout. Without a human, it tells the model to take the documented default. |
| `web_fetch` | Returns the text of a URL. HTML becomes plain text. | At most 60,000 characters, 30 s timeout. `http://` becomes `https://`, except for localhost. |
| `dev_team_brief` | Shows the brief for a plain request: `question`, `tiny`, `feature`, `vague` or `resume`. | With `routing: "brief"` (default), file changes are blocked until the brief. A `feature` brief asks the human, then runs `/ship`. |
| `dev_team_approve_examples` | Shows the examples that `/specs` proposes. Only an approval or an edit saves them. | Registered only while the example check is on. `model-only` exposure. At most 40 lines and 4000 characters. |

The extension also adds these commands and flags:

- `/dev-team` with `status`, `models`, `hooks`, `doctor`, `wait` and `timeout`. The status line shows `pi-dev-team <version>`, with the version from `package.json`.
- One command per user-invocable skill. The spend extension adds `/spend`.
- `--dev-team-agent <name>` runs a pi process as that agent, and `--dev-team-tier <tier>` picks a tier. `dev-team-run` uses both.

### Changes to pi's own tool results

| Feature | What it does |
|---|---|
| Read dedup (`readDedup`, default on) | A `read` whose text equals an earlier read of the same file range, from an earlier turn, returns a one-line note. Reads under 2000 characters are not changed. The record resets on compaction, a branch switch and a session start. A second identical read returns the full text. |
| Tool argument watchdog | A tool call whose arguments stream past 256,000 characters (`dev_team_subagent`) or 4,000,000 characters (other tools) stops the run, and the user sees why. |

## State on disk

pi-dev-team keeps project state in `.pi/dev-team/` (`STATE_DIR` in `lib/state-dir.ts` and in `hooks/lib/artifact_paths.py`). Never use `.pi` alone for state: the files next to it are configuration.

| Path | What it holds |
|---|---|
| `.pi/dev-team/memory/` | Phase progress, `brief.json`, `build-phase.json` and the saved requests in `requests/` |
| `.pi/dev-team/metrics/` | `cost-metering.jsonl`, the review-verdict ledger and other metrics |
| `.pi/dev-team/hooks/` | `freeze-state.json` and `careful-state.json` |
| `.pi/dev-team/worktrees/` | Agent worktrees |
| `.pi/dev-team/` (other entries) | `plans/`, `review-summaries/`, `evals/`, `init-state.json`, `project-stack.json`, `session-metrics.json`, `telemetry.json`, `code-intelligence-turn-state.json`, `model-overrides.json`, `session-model` |

The saved requests and the brief resolve from the session folder. The metrics resolve from the Git root of the session folder.

| Configuration, not state | Purpose |
|---|---|
| `.pi/dev-team.json` | The project's configuration, in Git |
| `.pi/dev-team.local.json` | One user's project configuration, not in Git |
| `.pi/agents/`, `.pi/skills/` | Project agents and skills |
| `.pi/settings.json` | pi's own project configuration |
| `.dev-team/examples.json` | The example check's cases, in the repository root |

User state lives in `<agentDir>/dev-team/`. `agentDir` is `PI_CODING_AGENT_DIR` (with `~` expanded) or `~/.pi/agent`. It holds `telemetry.json` (the telemetry consent) and `metrics/` (`telemetry.jsonl`, `artifact-usage.json`). The user configuration is `<agentDir>/dev-team.json`.

Each pi process also writes a private temporary folder, `pi-dev-team-<random>` (mode 0700). It holds the agent transcripts for `SubagentStop` and the full agent outputs. pi removes it on quit. A reload, new, resumed or forked session keeps it, because tool results can still name its files.

### One-time migration

`lib/migrate-state.ts` moves older dev-team state from `.claude/` into `.pi/dev-team/`. It runs at each session start, in the top session only (not in an agent, not with `DEV_TEAM_NESTED` from another process). It runs after the extension sets the environment and before the `SessionStart` hooks.

| Level | What happens |
|---|---|
| User | First, the migration copies `~/.claude/telemetry.json` and `~/.claude/metrics/{telemetry.jsonl,artifact-usage.json}` into `<agentDir>/dev-team/`. It copies a file only when the source is a regular file and the target is absent. It never moves them. After a copy run without errors, it writes the marker `<agentDir>/dev-team/.migrated-from-claude` (only when `~/.claude/` exists), and later runs copy nothing. |
| Project | Then each dev-team entry moves from `<base>/.claude/<entry>` to `<base>/.pi/dev-team/<entry>`. `<base>` is the session folder and its Git root, when they differ. |

The migration skips a base in two cases:

- The `.claude` of the base is the user's `~/.claude`, by path or after it resolves symlinks. This is the case when pi runs in the home folder.
- The base has the marker `.pi/dev-team/.migrated-from-claude`.

An entry moves only when all of these are true:

- The old path exists with the kind that `MIGRATED_ENTRIES` names (folder or file), and it is not a symlink.
- No folder on the old path or on the new path is a symlink, and the new path does not exist.
- Git tracks nothing at the old path or in a folder above it. So a cloned repository cannot plant state.
- No folder from `.claude` down to the entry holds its own `.git`, and `.claude` is in the same Git toplevel as the base. A nested repository or a submodule counts as tracked.

Any Git failure other than "not a git repository" leaves the state in place and adds one note for the base: `git ls-files failed (<reason>); <base>/.claude state left in place`. So the marker is not written, and a later run tries again. The Git calls set `core.fsmonitor=false` and have a 3-second timeout, so the configuration of a repository cannot run a command. `git ls-files` lists only the migrated entries.

How an entry moves:

- A file moves by a hard link and an unlink. So it never replaces a file that appeared at the new path.
- A folder moves into the stage `<new>.migrating`, and the migration renames the stage into place only when it is complete. A later run finishes a stage that an earlier run left. If the new folder appeared in the meantime, the run merges the stage into it and moves the rest of the old folder there. It never replaces a file, and a note names each stage or old folder that still holds a clash.
- A folder that holds kept files moves child by child into the stage.
- An entry on another filesystem (`EXDEV`) is not moved, and the migration creates nothing for it. When `EXDEV` comes in the middle of a folder move, the migration first puts the staged children back into the old folder. The notice names the entry, so the user can move it.

Each entry and each copy has its own error handling, so one failure does not stop the rest. After a run with no error and no note, the migration writes the marker, when something moved or `.pi/dev-team/` already exists. Later runs then skip that base.

The migration never moves these entries:

| Group | Entries |
|---|---|
| Kept in a moved folder | `memory/.pr-review-passed`, and in `metrics/`: `review-verdicts*`, `boundary-events.jsonl`, `gate-bypass-audit.jsonl`. A moved untracked copy can make a planted file into a trusted one. |
| Claude Code configuration | `settings*.json`, `CLAUDE.md`, `rules`, `plugins`, `projects` |
| Claude Code content | `skills`, `commands`, `agents`, `agent-memory`, `agent-memory-local` |
| State tied to its place | `worktrees`, because Git links them by their absolute path |

After a run that moved, copied or skipped something, a session with a UI shows one notice line. The line names what moved, the kept files, and `.claude/agents` and `.claude/worktrees` if they exist. The first error shows one time per pi process as a warning and never stops the session.

## Cost metering and /spend

The cost meter (`lib/metrics.ts`) runs at each `agent_end` of the session. It appends one row for the whole session to `<Git root>/.pi/dev-team/metrics/cost-metering.jsonl`. It takes the cost from pi's own `usage.cost`, so it works for every provider, GitHub Copilot included.

| Row field | Content |
|---|---|
| `timestamp`, `transcript`, `session_id` | When, which session file, which session |
| `total` | `input_tokens`, `output_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens`, `cost_usd` |
| `by_model`, `by_thread`, `by_agent_type` | The same totals per model, per thread and per agent (`main` or `dev-team:<agent>`) |
| `unpriced_models`, `source` | `[]` and `"pi-dev-team"` |

The meter writes a row only when `<agentDir>/dev-team/telemetry.json` holds `"enabled": true` (`/telemetry on`) and `DEV_TEAM_COST_METER` is not `off`. `/cost-report`, `cost_meter.py regression|pace` and `/autoship --max-cost-usd` read these rows.

The spend extension (`extensions/spend/`) owns `/spend` and the AI credits status line. It reads pi's session entries and the `dev-team-subagent-usage` entries that `dev_team_subagent` writes. The month view reads the saved pi session files of all projects since the 1st of the month. For `github-copilot` models, AI credits are the USD cost times 100. The spend extension runs without the dev-team extension: switch off `extensions/dev-team/index.ts` with `pi config`, or with a package filter in `.pi/settings.json`.

## Autocompact

The extension compacts the session between runs once the context reaches a set percentage or a set number of tokens. It checks at `agent_settled`, after pi's own retry and overflow recovery, in TUI and RPC mode, in the session only. It does not check at `agent_end`, because `ctx.compact()` stops a running turn. Inside one long run, pi's own threshold (`contextWindow - reserveTokens`) applies.

The percentage (1 to 100) comes from the first source that sets it:

| Order | Source | Label in messages |
|---|---|---|
| 1 | `DEV_TEAM_AUTOCOMPACT_PCT` in the process environment | `process env` |
| 2 | `autocompactPct` in `.pi/dev-team.local.json` | `dev-team.local.json` |
| 3 | `autocompactPct` in `.pi/dev-team.json` | `dev-team.json` |
| 4 | `autocompactPct` in `<agentDir>/dev-team.json` | `user dev-team.json` |

The extension reads the two project files only when pi trusts the project. The Python side (`hooks/lib/autocompact_config.py`) uses the same order and labels, but it reads the project files even when pi does not trust the project. `/setup` writes `autocompactPct` into `.pi/dev-team.json` through `scripts/set_autocompact_env.py` (default 40). When no source sets it, `autocompact_setup_nudge.py` suggests `/setup` at session start, unless `.pi/dev-team/memory/autocompact-nudge-off` exists.

`autocompactMaxTokens` (default 200000, 0 turns it off) is a token ceiling on top of the percentage. Whichever is reached first compacts. On a window of 1M tokens, pi's default lets the context grow past 400,000 tokens. Every turn reads the whole context again, and every cache miss writes all of it again. Before it compacts, the extension shows `dev-team: context at <N>% (<reason>), compacting.`

## The GitHub text style check

The check keeps pull request, issue and comment text short and plain. It follows plain English after ASD-STE100 and a layout for readers who skim. The rules are in the `dev_team` section of every session and agent prompt (`GITHUB_STYLE_GUIDE` in `lib/github-style.ts`).

| Rule | Limit |
|---|---|
| Title | 69 characters or fewer |
| Visible body words | 250 for a pull request or issue, 150 for a comment |
| Sentence | 25 words or fewer |
| List | 5 items or fewer |
| Words and marks | No em-dashes, bold, hedges (`should`, `may`, `might`) or filler words |

Code, URLs, HTML comments, tables, headings and `<details>` blocks do not count as visible words.

In `tool_call`, before the `PreToolUse` hooks, a quote-aware and heredoc-aware scan (`lib/gh-command.ts`, `lib/shell-scan.ts`) finds each `gh pr|issue create|edit|comment`. It checks the literal title and body, and a `--body-file` up to 400,000 bytes. The extension blocks a call that breaks a rule once, with the list of problems. The same command with the same text runs on the second try and goes on to the hooks, so `pre_pr_review` still applies.

| `githubStyle` | Effect |
|---|---|
| `block` (default) | Block once, as above. |
| `warn` | The call runs. The problems go into the tool result. |
| `off` | No check, and no rules in the prompt. |

Text that the shell builds at run time, for example `--body "$BODY"`, is not checked. The notes on `/pr`, `/specs`, `/issues-from-plan`, `/issues-from-assessment` and `/autoship` keep the sections that those skills require. `/pr` puts Decisions & Assumptions and the Evidence Bundle into one `<details>` block.

## Saved requests and the request-folder guard

The plan, the build and the reviewers check the work against the user's own words, not against a summary that the model wrote. Code saves those words in `.pi/dev-team/memory/requests/` (`REQUEST_DIR` in `lib/skills.ts`).

| Saved file | When |
|---|---|
| `plan-<time>.md`, `specs-<time>.md`, `ship-<time>.md` | A typed `/plan`, `/specs` or `/ship` with request text after it |
| `request-<time>.md` | A typed request that is not a command, while the example check is on (the default) |
| `approved-<time>.md` | Examples that the human approved or edited in `dev_team_approve_examples` |

`hasRequestText` decides what counts as request text. Flags, issue numbers, URLs and file paths do not count, so `/ship 123` and `/specs docs/spec.md` save nothing. Then the issue or the document is the request. A pi process started by another session's tool call (`DEV_TEAM_NESTED`) saves nothing, because its prompt is model text.

The extension writes the folder owner-only: files 0600, a new folder 0700. An existing folder keeps its mode. The folder gets its own `.gitignore` of `*`, because it holds whatever the user typed. The extension creates files with `wx`, so it never overwrites a file, and it writes nothing through a symlinked folder.

### The guard

While the example check is on, `lib/request-guard.ts` blocks the model's own writes to that folder. `scripts/example_replay.py` accepts a case only when it quotes a saved request word for word, so the check is only as honest as the folder. The guard blocks:

- A `write` or `edit` path in the folder, or in `.pi`, `.pi/dev-team` and `.pi/dev-team/memory` above it. Symlinks are resolved, and case is folded on macOS and Windows.
- A bash write that the scan can see, for example a redirect, `cp`, `mv`, `tee`, `ln`, `touch`, `rm` or `sed -i`. This includes writes behind `timeout`, backticks and `$(...)`, and after a `cd` or `pushd`.
- On a line that names the folder, any command that is not a known read, for example `cat`, `ls`, `grep` or `example_replay.py`.
- A computed target on a line that names the state folder or `.pi` itself (`x=.pi`), not `.pi/settings.json` or `.pi/agents`. Also a write after a `cd` that the scan cannot follow, on a line that names the state folder, `.pi` itself, `memory` or `requests`.
- Any `powershell` line that names the folder.

The guard is a static scan, not a sandbox. A program that builds the path at run time gets past it, for example `python -c` that joins strings. Other gaps: `find ... -delete`, `git clean -fdx`, unquoted globs, hard links and writes from a worktree agent, whose guard protects its own worktree. It also blocks too much in one case. A command that is not a read is blocked when its text names both `memory` and `requests`, for example `pytest tests/test_memory_requests.py`.

## The code-review slim core

`skills/code-review/SKILL.md` is a short core of about 37 KB. The full skill text is about 100 KB (25,000 tokens). In recorded sessions it stayed in context for a median of 57 turns per load, and some of its sections never ran. The full text is in `skills/code-review/references/`, split by step into 12 files.

The core keeps every command except `dispatch_waves.py`, because one call sends all lenses. It keeps the MUST rules word for word. A table at the top names each reference and when to read it. Four reads are required:

| Reference | Required when |
|---|---|
| `references/01-target-files.md` | The documentation-only short-circuit fires (step 1). |
| `references/04b-context-pack.md` | `DEV_TEAM_REVIEW_CONTEXT_PACK=on` |
| `references/04d-contract-validation-and-retry.md` | `dispatch_reconcile.py` reports a `missing` agent. |
| `references/06-findings-and-fix-loop.md` | Before the first fix iteration (step 6a). |

The core says not to read references otherwise. Where the core and a reference disagree, the reference wins, with three exceptions:

- Step 9 also runs under `--json`. Three old sentences in the references say otherwise.
- The lean fix rule wins over the fix loop.
- The single dispatch replaces the dispatch waves.

`test/py/test_slim_skills.py` checks that the core and the references agree on the rules and commands.

## The sensitive-file guard

`hooks/pre_tool_guard.py` blocks agent `Write` and `Edit` calls on files that look like secrets. Its patterns are in `hooks/guards.json`, next to the hook.

| List | Patterns |
|---|---|
| `blocked_paths` | `.env`, `.env.*`, `*.pem`, `*.key`, `*.p12`, `*.pfx`, `*credential*`, `*secret*`, `*.token`, and the folders `secrets/*`, `.secrets/*`, `credentials/*`, `secret/*`, `.secret/*`, `.credentials/*` |
| `warn_paths` | `.pi/settings.json`, `.pi/dev-team.json`, `.pi/dev-team.local.json` |
| `allowed_paths` | `*.md` |

A pattern without `/` matches the file name only, so `*secret*` does not block a file under `secrets-manager/`. A pattern with `/` matches the end of the path. The guard checks the path as written and as resolved, so a harmless-named symlink to a blocked file stays blocked. The folder patterns keep secret folders blocked under file-name matching.

The user adds exceptions as comma-separated patterns in `DEV_TEAM_GUARD_ALLOWED_PATHS`. Only the `env` of `<agentDir>/dev-team.json` can set it, because a project's `env` is limited to `PROJECT_ENV_SETTINGS`. The guard also blocks agent writes to that file. It normalizes the path, resolves symlinks and reads `PI_CODING_AGENT_DIR`. So neither a cloned repository nor an agent can approve its own write. The block message names the pattern, the configuration file that the hook reads and how to add an exception. Approval in chat does not lift the block.

The guard does not see bash commands. The same hook holds the `/freeze` scope lock, from `.pi/dev-team/hooks/freeze-state.json` under the repository of the tool call.

## Build dead-end retry

A `/build` step reaches a dead-end when its repair loop gives the same failure signature twice. The pi notes in `skills/build/SKILL.md` add one retry on the next tier up before the build stops for the human:

1. The session commits the work of the dead-end step.
2. It finds the next tier: `haiku` to `sonnet` to `opus`. `fable` is never a retry target.
3. It dispatches `software-engineer` again for the same step, with `model: "<next tier>"`. The task names that commit, the improved tests, the remaining failure signature and the fixes already tried.
4. If the retry also dead-ends, the build stops as before.

The session skips the retry when the step has no tier, or when the Agent tiers line shows the same model for both tiers. With the default configuration every tier is `inherit`, so there is no retry. The retry runs at most once per step and never chains.

The session reads the tiers from two places. The guide has an Agent tiers line, for example `Agent tiers (the model a dispatch with model: "<tier>" runs on): opus = <model>, ...`. Each dispatch result names `[model <provider/id>, tier <tier>]`. Agent prompts leave out the Agent tiers line, so their shared cached prefix does not hold the session model. A tier name other than the four known tiers does not show. A value that is not a model id in pi's catalog shows as `(not a model id)`.

## Rules in the prompt files

Some rules live in the agent and skill text, not in TypeScript. Change them in the prompt file that holds them.

| Rule | Where | What it does |
|---|---|---|
| Reuse ladder | `agents/software-engineer.md` | Before it writes code, the agent checks whether the code needs to exist, then the codebase, the standard library and installed dependencies. A deliberate shortcut gets a `shortcut:` comment. The report ends with one `Skipped:` line. |
| Simplify lens | `agents/refactor-opportunity-review.md` | Only deletes, inlines or replaces production code. Extraction and duplication belong to `structure-review`. |
| Lean fix rule | `agents/structure-review.md`, `agents/quality-reviewer.md`, the code-review core | A restructuring `warning` that grows production code is a report-only suggestion. |
| The request outranks the plan | pi notes of `/plan`, `/specs`, `/ship`, `/build`, and `agents/spec-compliance-review.md` | The saved request is the spec. A point that the request leaves open stays an open question. A reviewer reports an `error` only on explicit evidence. |
| Phase record helper | `scripts/build_phase.py`, `/build`, `software-engineer` | Writes `.pi/dev-team/memory/build-phase.json` in one command, chained onto a test run, never in a turn of its own. |

The phase record helper exists because one measured run spent 44 model turns (855 s) only on writing that record. The REFACTOR markers chain onto a green test run with `set -o pipefail`, so a red run piped into `tail` cannot write the marker. `/build` step 5 also sends the final verification and the Farley Score dispatch in one message, so they run at the same time.

## Known limits

| Area | Limit |
|---|---|
| Agents | Agent runs are not saved as pi sessions (`--no-session`). The extension records usage from the JSON event stream. |
| Agents | pi cannot scope bash. `Bash(<pattern>)` grants all of bash, and the prompt states the patterns. |
| Agents | `memory:` and `color:` in agent frontmatter do nothing. `WebSearch` and `TodoWrite` have no pi tool. |
| Agents | After a single dispatch, the `[model ...]` line follows the JSON of a review agent. `validate_review_output.py` still finds the JSON, but counts it as `prose-preamble`, not `clean`. |
| Skills | `allowed-tools` in a skill does not limit the tools. |
| Skills | `skill-injection.jsonl` is not written, because the agent prompt lists skills directly. |
| Autocompact | It compacts only between runs. Inside one long run, pi's own threshold applies. |
| Guards | The GitHub text style check reads literal text only. The sensitive-file guard does not see bash. The request-folder guard is a static scan. |
| Hooks | Without Python 3.10 or later, every hook is off. The hooks in `DEFAULT_DISABLED_HOOKS` are off by default (see [Hooks that are off by default](#hooks-that-are-off-by-default)). |

## Verification

Run `./test/link-deps.sh` one time, then `npm test` and `npm run e2e`. [CONTRIBUTING.md](../CONTRIBUTING.md) has the details.

| Layer | Where | Command | What it covers |
|---|---|---|---|
| Unit | `test/unit/*.test.ts` | `npm test` (`node --test`) | Configuration, trust, tool mapping and the hook bridge. Agent runs, progress, cost rows and session files. The GitHub text style check, the request-folder guard, the review profile and the approved-examples tool. The TUI renderers, `/spend` and the one-time migration. |
| Python | `test/py/test_*.py` | `npm test` (`unittest`) | The code-review core, `dev-team-run`, the sensitive-file guard, the changelog script, `build_phase.py`, `example_replay.py` and the session report tool |
| End-to-end | `test/e2e/run.mjs` | `npm run e2e` | The real `pi` binary with an offline scripted provider (`test/fixtures/scripted-provider.ts`), in throwaway Git repositories with a throwaway `HOME` |

The end-to-end tests cover the commands and the `skill`, `ask_user` and `dev_team_subagent` tools. They also cover hook blocks and advisories, ledger and cost rows, trust, worktrees and `dev-team-run`. One scenario runs the package next to another extension's `subagent` tool. To run some scenarios only, pass part of their name: `node test/e2e/run.mjs subagent`.

`test/py/test_example_replay.py` opens ports on `127.0.0.1`. If a sandbox blocks localhost, run the Python tests in a container.

CI (`.github/workflows/ci.yml`) runs on each pull request and each push to `main`. It uses Node 24, Python 3.12 and pi 1.3.0, and runs `npm test`, `npm run e2e` and a `tsc` type check. No test and no CI job calls a real model provider. A change that depends on real model behavior needs a run with a real provider outside CI.
