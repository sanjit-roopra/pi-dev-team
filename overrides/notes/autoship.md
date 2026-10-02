## pi port notes (read first)

- Run each unit's `/ship` in an isolated child so `DEV_TEAM_AUTO_APPROVE=1` and its cost stay scoped to that unit: use the `headless-run` skill (`DEV_TEAM_AUTO_APPROVE=1 pi --mode json -p --no-session "/ship ..."`) rather than invoking `/ship` in this conversation.
- `$CLAUDE_SESSION_ID` is set by the pi extension to the pi session id.
- The GitHub MCP fallback (`mcp__github__*`) only exists if the user configured a GitHub MCP server in `.pi/mcp.json`; otherwise `gh` is required.
