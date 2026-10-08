---
name: debug-pi-session
description: Debug or measure how pi-dev-team behaved in recorded pi sessions — what a run did, why it stalled or cost too much, which agents failed, which hooks blocked, which skill branches ran, and where context tokens went. Use when the user asks to look at a pi-dev-team session, debug a /build, /code-review or /ship run, find token or cost hotspots, or measure skill usage before or after a change.
---

# Debug a pi-dev-team session

`devtools/session_report.py` reads pi's session logs (read-only, stdlib only) and reports what dev-team did. Run it from the repository root. Every subcommand takes `--json`; use it when you want to process the result further.

## Commands

| Command | Answers |
|---|---|
| `python3 devtools/session_report.py projects` | Which projects have pi sessions, and how many used dev-team |
| `… sessions -p <project>` | One row per session: start, first prompt, turns, compactions, skill loads, dispatches, failed dispatches, tool errors, hook blocks, main and subagent cost |
| `… timeline <session> [-p <project>] [--tools]` | The ordered events of one session. `<session>` is a file path, a unique part of the id (the `session` column above), or `latest` with `-p` |
| `… skills -p <project>` | Each skill's load count, average size, median turns it stayed in context, and `tokenTurns` (size × turns) |
| `… tools -p <project> [--big 3500]` | Tool-output tokens by tool, and how much came from large outputs |
| `… branches -p <project> -s <skill> [--outputs <text>]` | Inside each run of a skill: scripts it ran, reference files it read, agents it dispatched, skills it loaded, edits and errors. `--outputs` prints the output of bash calls whose command contains the text |

`-p` takes the session directory name or any unique part of it, for example `dstm`. An ambiguous name lists the candidates. `--sessions-dir` overrides the default (`$PI_CODING_AGENT_DIR/sessions`, else `~/.pi/agent/sessions`).

## Recipes

- **A run stalled or stopped.** `timeline latest -p <project>`, then look at the events before the stop: `error`, `hook-block`, `agent-done … FAILED`, a `compaction` in the middle of a step. Add `--tools` to see every tool call with its output size.
- **An agent failed or returned nothing.** `sessions` shows `failedDispatches`; `timeline` shows each `agent-done` line with model, tier, cost and duration.
- **A guard or hook blocked something.** `hookBlocks` in `sessions`; the `hook-block` line in `timeline` carries the hook's message.
- **A session cost too much.** Compare `mainCostUsd` and `subagentCostUsd` in `sessions`. Then `skills` and `tools` for the same project show what filled the context.
- **Did a skill step run?** `branches -s <skill>` lists each step's script per run (for example `script build_jobs.py` for /build's scheduling). A step that never shows up never ran. Use `--outputs <script>` to see what the script decided, for example `--outputs build_jobs.py` prints `unset` when concurrency was not configured.
- **Before and after a skill change.** Run `skills` and `branches` on sessions from before and after, and compare `avgTokens`, `tokenTurns` and the per-run markers.

## Read the numbers correctly

- Token counts are estimates: characters / 4.
- The script follows the active branch (what the model saw). Costs include abandoned branches, because they were paid for.
- `turns in context` stops at the compaction that dropped the entry. A compaction that keeps the entry does not stop it.
- A skill run lasts from its load to the next workflow-skill load (`build`, `code-review`, `pr`, `plan`, `continue`, …) or the end of the session. Work after the run but before the next load is counted to it.
- A marker proves that a step ran, not that the model read that part of the skill.
- Subagents run with `--no-session`, so their transcripts are not stored. Only the parent's `dev-team-subagent-usage` entry (agent, model, tier, ok, cost, duration) is available. A skill a subagent loaded is not visible.
- Skills loaded by a slash command (`/continue`) arrive as a user message starting with `<skill name=…>`; the report counts them with `via slash`.
