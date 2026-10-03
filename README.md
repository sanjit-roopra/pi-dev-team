# pi-dev-team

A port of Bryan Finster's **dev-team** plugin ([bdfinst/agentic-dev-team](https://github.com/bdfinst/agentic-dev-team), Claude Code) to the [pi coding agent](https://pi.dev). It works with any model provider pi supports, including GitHub Copilot.

What you get is the whole dev-team:

- **Agents (48).** An orchestrator, team personas (software engineer, QA, architect, product manager, security, platform, tech writer, UX), about 25 review lenses and 5 plan critics. Explore and general-purpose agents are added.
- **Skills (92).** The `/specs → /plan → /build → /pr` workflow plus `/code-review`, `/ship`, `/triage`, `/fix`, `/test-improve`, `/continue`, mutation testing and the rest.
- **Guard hooks.** careful / freeze / guard, tests frozen during REFACTOR, the verify-loop guard, the `gh pr create` review gate, and the review-verdict and dispatch ledgers.
- **Knowledge base, scripts, templates.** Byte-identical to upstream.

Upstream version: see `UPSTREAM.json` (currently dev-team v14.0.0).

## Install

Requirements:

- pi ≥ 1.0
- git
- Python ≥ 3.10 (hooks and scripts)
- `gh` for PRs and issues
- `jq` recommended

```bash
pi install git:github.com/sanjit-roopra/pi-dev-team  # user-wide from GitHub
pi install ./pi-dev-team            # or from a local checkout
pi install -l ./pi-dev-team         # or for one project (.pi/settings.json)
```

To update an existing Git installation:

```bash
pi update git:github.com/sanjit-roopra/pi-dev-team
```

Then, inside pi:

```
/dev-team doctor      # checks python, git, gh, jq and your model tiers
/dev-team models      # map the opus/sonnet/haiku/fable agent tiers to your models
/setup                # provision the current repo (AGENTS.md, stack detection, .gitignore, ...)
```

### GitHub Copilot

1. Log in: `/login github-copilot` (or `pi` → `/login`).
2. Pick a main model: `/model github-copilot/claude-sonnet-5.5` (any Copilot model works).
3. `/dev-team models` → `preset: github-copilot`. Upstream routes agents by tier: opus for deep reviews, sonnet for most work, haiku for cheap lenses. The preset maps those tiers to the Copilot Claude models:

```json
{
  "models": {
    "opus": "github-copilot/claude-opus-5.5",
    "sonnet": "github-copilot/claude-sonnet-5.5",
    "haiku": "github-copilot/claude-haiku-4.5",
    "fable": "github-copilot/claude-fable-5.1"
  }
}
```

The default is `"inherit"` for every tier, meaning every agent runs on the model you are using. That is the safe choice when a provider has no cheap and expensive variants, or when Copilot premium-request multipliers matter more to you than per-agent routing.

## Use

The same as upstream:

```
/specs add rate limiting to the public API
/plan
/build
/pr
```

Other useful commands:

- `/code-review`: the reviewer swarm plus the fix loop.
- `/ship`: runs the whole pipeline.
- `/triage` and `/fix`: bug work.
- `/help` and `/help --all`: the command list.

Every user-invocable upstream skill is a `/command`.

The model uses dev-team through four tools the extension adds:

| Tool | Claude Code equivalent | Notes |
|---|---|---|
| `dev_team_subagent` | Agent / Task | Runs the agent in a child `pi` process with its own context, tools and tier model. Single calls, parallel calls (several calls in one message, or `tasks[]`), and `isolation: "worktree"`. Accepts `subagent_type`/`prompt` too. Live per-agent progress in the TUI; child spend counts in pi's session totals. |
| `skill` | Skill | Loads a skill with arguments substituted. This is how skills chain (`/specs` → `/plan`, `/ship` → everything). |
| `ask_user` | AskUserQuestion | The human gates. In non-interactive runs (`pi -p`, subagents) it tells the model to take the documented default. |
| `web_fetch` | WebFetch | URL to text. |

The dispatch tool is named `dev_team_subagent` so this package can coexist with
`pi-subagents`, which registers `subagent`. Dev-team workflows use their own
dispatch tool for model tiers, hooks, and metrics. Other workflows can still use
the other package's `subagent` tool.

## Configure

Configuration files are merged in this order, later wins:

1. `~/.pi/agent/dev-team.json`
2. `<project>/.pi/dev-team.json`
3. `<project>/.pi/dev-team.local.json`

```jsonc
{
  "models": { "opus": "inherit", "sonnet": "inherit", "haiku": "inherit", "fable": "inherit" },
  "thinking": { "low": "low", "medium": "medium", "high": "high" },   // agent `effort` -> pi thinking level
  "maxParallelAgents": 6,          // concurrent child processes across all subagent calls
  "maxSubagentDepth": 2,           // orchestrator -> reviewer is depth 2
  "subagentTimeoutSec": 3600,
  "autoFormat": false,             // run prettier/ruff/black after write/edit (/setup turns this on)
  "skillIndex": "compact",         // compact | full | off — skill list in the system prompt
  "claudeShim": true,              // `claude -p` in upstream scripts runs pi instead
  "env": { "DEV_TEAM_MAX_PARALLEL_BUILDS": "2" },   // in a project file: dev-team tuning settings only
  "hooks": { "enabled": true, "disabled": ["..."], "enable": ["version_check"], "outputToModel": true, "timeoutSec": 60 }
  // in a project file, hooks can be added and advisory ones turned off; guards stay on
}
```

- **Environment variables.** Upstream's `DEV_TEAM_*` variables work unchanged, for example `DEV_TEAM_AUTO_APPROVE=1`, `DEV_TEAM_AUTOCOMPACT_NUDGE=0` and `DEV_TEAM_COST_METER=off`.
- **Cost metering.** Needs the same opt-in as upstream: `/telemetry on`, which writes `~/.claude/telemetry.json`. Costs come from pi's own usage accounting, so they are correct for Copilot and every other provider.
- **Hooks.** `/dev-team hooks` lists every hook and whether it is on.

## How it is built

The port is a **compatibility runtime** rather than a rewrite. `sync/sync_upstream.py` copies upstream's agents, skills, hooks, scripts and knowledge. The Python code and knowledge stay byte-identical. The sync then applies a small set of listed patches and notes, and the TypeScript extension in `extensions/dev-team/` provides the Claude Code contract that content expects.

[PORTING.md](PORTING.md) has the full analysis, the concept mapping, what was dropped and why, and the known differences.

Update to a new upstream release:

```bash
git clone https://github.com/bdfinst/agentic-dev-team ../agentic-dev-team   # or pull
python3 sync/sync_upstream.py --upstream ../agentic-dev-team
```

The sync fails loudly if a patch no longer matches.

## Tests

```bash
./test/link-deps.sh            # once: links the globally installed pi packages for the unit tests
npm test                       # TypeScript unit tests + Python tests (sync, claude shim)
npm run e2e                    # real pi binary + offline scripted model: commands, guards, subagents,
                               # worktrees, ledgers, cost meter, claude shim, installed-package children

# upstream Python suite against this package (uses uv, no pip):
# copy the package dirs into an agentic-dev-team checkout's plugins/dev-team, then
uv run --no-project --with pytest --with pytest-asyncio --with hypothesis --with pytest-xdist \
  --with jsonschema --with pyyaml python -m pytest -n 8 plugins/dev-team/tests/{hooks,scripts,lib}
```

## License

MIT. The upstream content is © Bryan Finster (see LICENSE). This package is an unofficial port and is not affiliated with Anthropic or the pi project.
