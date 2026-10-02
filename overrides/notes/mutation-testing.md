## pi port notes

- Scripts in this skill that shell out to `claude --print` / `claude -p` run through the pi port's `claude` CLI shim (on `PATH` inside pi), which executes `pi --mode json -p --no-session` and returns a Claude-style result envelope. `CLAUDE_BIN` / `CLAUDE_CLI` may point at it explicitly.
