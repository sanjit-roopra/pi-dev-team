---
name: headless-run
description: >-
  Run a dev-team skill or prompt headlessly in an isolated pi subprocess
  (fresh session, JSON result, timeout). Use for scripted one-shot invocations
  and benchmark-harness cases, e.g. running /code-review once per case.
argument-hint: "<prompt-or-slash-command> [--cwd DIR] [--model MODEL] [--timeout SECS]"
user-invocable: true
allowed-tools: Read, Bash
---

# Headless Run

Role: worker. Runs one prompt in a separate, non-interactive pi process and
returns its JSON result. It does not review, plan or edit by itself.

Arguments: `$ARGUMENTS`

## Isolation

- New process, `--no-session` (nothing is written to the session store and the
  parent's session id is not reused).
- Non-interactive: `DEV_TEAM_INTERACTIVE` is unset, so every human gate takes
  its documented non-interactive default.
- Same packages and credentials as the parent (pi's auth store is read from
  `~/.pi/agent`), so the run uses the same providers.

## Steps

1. Parse `--cwd` (default: current directory), `--model` (default: the
   current `PI_PROVIDER/PI_MODEL`), `--timeout` (default 1800 seconds). The rest
   is the prompt. A leading `/name` is a dev-team command; pass it through
   unchanged, pi expands it in the child.
2. Run:

   ```bash
   cd "<cwd>" && timeout <secs> env -u DEV_TEAM_INTERACTIVE \
     pi --mode json -p --no-session --model "<model>" "<prompt>" > "$TMPDIR/headless-run-$$.jsonl"
   ```

3. Extract the result: the last `agent_end` event's final assistant text, its
   `stopReason`, and the summed `usage` of all `message_end` assistant events.
   Print one JSON object:
   `{"is_error": <bool>, "result": "<text>", "stop_reason": "...", "usage": {...}, "total_cost_usd": <n>, "log": "<path>"}`.
   Exit status 124 from `timeout` → `is_error: true, "result": "timeout"`.
