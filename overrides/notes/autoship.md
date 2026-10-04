## pi port notes (read first)

- Run each unit's `/ship` in an isolated child so `DEV_TEAM_AUTO_APPROVE=1` and its cost stay scoped to that unit: use the `headless-run` skill (`DEV_TEAM_AUTO_APPROVE=1 pi --mode json -p --no-session "/ship ..."`) rather than invoking `/ship` in this conversation.
- `$CLAUDE_SESSION_ID` is set by the pi extension to the pi session id.
- The GitHub MCP fallback (`mcp__github__*`) only exists if the user configured a GitHub MCP server in `.pi/mcp.json`; otherwise `gh` is required.
- Issue and comment text follows the "GitHub text style" from the system prompt. Keep every heading, section and marker that this skill's template requires, because later steps read them. Write the prose inside them plainly and briefly. If the template itself breaks a rule (for example a required list that is longer than the limit), send the same `gh` command again unchanged: the extension blocks it only once.
