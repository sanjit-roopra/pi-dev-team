## pi port notes (read first — these override the steps below)

This is the pi port of `/setup`. Follow the steps below with these substitutions:

- **Hard dependencies (Step 3):** the `claude` CLI is not required. `pi`, `python3`, `jq`, `git` and `gh` are.
- **Step 4:** run the `project-init` skill with the `skill` tool (`dev-team:project-init` and `project-init` are the same).
- **Step 7 (agent templates):** activate templates into `.claude/agents/` exactly as written. The pi `subagent` tool loads project agents from `.pi/agents/` and `.claude/agents/`, and they take precedence over the package agents.
- **Step 8 / 8a (project CLAUDE.md):** pi loads context files from the project root and its ancestors (`AGENTS.md`, or `CLAUDE.md`), **not** from `.claude/CLAUDE.md`. Everywhere these steps say `.claude/CLAUDE.md`, use `AGENTS.md` at the repository root instead (if the repo already has a root `CLAUDE.md` and no `AGENTS.md`, use that `CLAUDE.md`). Same merge/skip and marker rules.
- **Step 9 (formatting hook):** do not write `.claude/settings.json`. Instead set `"autoFormat": true` in `.pi/dev-team.json` (create the file if missing, keep other keys). The pi extension then runs `hooks/post_format.py` (prettier / ruff / black, auto-detected) after every `write`/`edit`.
- **Step 10 (/pr):** write the generated project command to `.claude/skills/pr/SKILL.md` as written. The pi port resolves project skills in `.pi/skills/` and `.claude/skills/` before the package's own.
- **Step 11:** also add `.pi/dev-team.local.json` to the `.gitignore` block.
- **Step 12 (report):** list `AGENTS.md` and `.pi/dev-team.json` instead of `.claude/CLAUDE.md` and `.claude/settings.json`. Add a line recommending `/dev-team models` to map the opus/sonnet/haiku agent tiers to this user's models.
