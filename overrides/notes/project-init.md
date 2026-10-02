## pi port notes (read first — these override the steps below)

- **MCP servers (Step 4c):** pi reads project MCP servers from `.pi/mcp.json` (user level: `~/.pi/agent/mcp.json`), not `.mcp.json`. Register CodeGraph/Repowise there, or with `pi mcp add -l <name> -- <command>`. Tell the user to run `/reload`.
- **Settings/hook guards (Step 4c, #1367):** there is no `.claude/settings.json` hook registration in pi; the settings.json guard reports `n/a (pi)`.
- **`CLAUDE.md` guard around `graphify install`:** apply the same guard to `AGENTS.md`.
- The `claude` CLI is not required; ignore checks for it.
