# pi-dev-team

pi-dev-team gives the [pi coding agent](https://pi.dev) a team of AI agents. The team writes a spec, plans, builds with tests, reviews the code, and opens a pull request. You approve each important step.

It is a port of Bryan Finster's dev-team plugin for Claude Code ([bdfinst/agentic-dev-team](https://github.com/bdfinst/agentic-dev-team)). It works with every provider pi supports, for example GitHub Copilot, Anthropic and OpenAI.

## Quick start

1. Install pi: `npm install -g @earendil-works/pi-coding-agent`
2. Install this package: `pi install git:github.com/sanjit-roopra/pi-dev-team`
3. Start pi in a Git repository: `cd my-project && pi`
4. Log in to a provider: `/login`
5. Check the install: `/dev-team doctor`. Install any tool marked `MISSING` (see [Requirements](#requirements)).
6. Prepare the repository: `/setup`
7. Give the team a task: `/specs add rate limiting to the public API`

## Requirements

| Tool | Version | If it is missing |
|---|---|---|
| [Node.js](https://nodejs.org) | 22.19+ | pi does not start. |
| [pi](https://pi.dev) | 1.0+ | The package does not load. |
| Git | recent | Most commands do not work. |
| Python | 3.10+ | The guard hooks are off. pi shows a warning. |
| [GitHub CLI](https://cli.github.com) (`gh`) | recent | `/pr` and `/ship` cannot open a pull request. |
| `jq` | any | Some quality gates do not run. |

A guard hook is a small script that runs around a tool call. It can stop an unsafe action, for example a pull request without a code review.

## How the team works

| Command | What it does | Result |
|---|---|---|
| `/specs <task>` | Asks questions until the task is clear, then writes intent, architecture notes and acceptance criteria. | Spec file or GitHub issue |
| `/plan` | Splits the work into small steps, each with its own tests. | `plans/<task>.md` |
| `/build` | Builds one step at a time: test, make it pass, clean up. | Commits on your branch |
| `/pr` | Runs tests, linter and code review, then opens a pull request. | Pull request |

Each command stops and asks you before it continues. `/ship <task>` runs all four, with the same stops.

Other commands:

- `/code-review`: about 25 agents review your change, one topic each (security, tests, naming, ...).
- `/triage <bug>`: finds the root cause and writes a fix plan.
- `/fix <bug>`: triage, prove the bug, fix it with tests, open a pull request.
- `/continue`: continues your last session's work.
- `/help`: the main commands. `/help --all`: all commands.

## Choose the models

Each agent has a tier: `opus` (deep reviews, hard design), `sonnet` (most work), `haiku` (small checks), `fable` (strongest; unused by default).

By default every tier uses your session model. To map tiers to models, run `/dev-team models` and pick a preset:

- `github-copilot`: the Claude models of GitHub Copilot
- `anthropic`: the Claude models of the Anthropic API
- `inherit`: your session model (default)
- `custom`: set each tier yourself

A code review can start more than 20 agents, so cheaper models for the lower tiers save a lot. `/dev-team doctor` suggests a preset when one fits your provider.

If a `/build` step fails the same way twice, the team retries it once on the next stronger tier, then asks you. With `inherit` there is no stronger model, so no retry.

## Safety and cost

The agents can do what you can do in a terminal: change files, run commands, and make many model calls (up to 6 agents at once).

- The guard hooks reduce the risk. For example, they block `gh pr create` until a code review passes. They need Python.
- pi shows each running agent: its time, cost, current command and its place in the queue.
- pi's footer shows the session cost in USD, agents included. With GitHub Copilot, the status line also shows the session's AI credits.

To limit the work, set these in `~/.pi/agent/dev-team.json`:

```json
{ "maxParallelAgents": 2, "subagentTimeoutSec": 900 }
```

### See where the spend went

Run `/spend` for a chart of what your sessions cost, for every provider (local models count as $0).

- Views: **By model**, **By provider**, **By agent** (`Tab` to switch).
- Scope: this session, or this month across all projects (`s` to switch). Or run `/spend session` / `/spend month`.
- Split bars show providers, and main `█` / subagents `▓` / overhead `▒` (cache warm-ups, compaction, summaries).
- Without a terminal UI (`pi -p`, RPC), `/spend` prints a text summary.
- `Esc` or `q` closes it.

| Term | Meaning |
|---|---|
| USD | pi's catalog price for the tokens. For a ChatGPT or Claude plan, not what the plan bills. |
| AI credits | GitHub Copilot's unit: 1 credit per $0.01 of Copilot's USD, before your plan's allowance ([pricing](https://docs.github.com/en/copilot/reference/copilot-billing/models-and-pricing)). |

The month starts on the 1st at 00:00 UTC, like GitHub's billing period. `/dev-team usage` is the old name of `/spend` and still works.

For a per-run cost log with a regression check, run `/telemetry on`, then `/cost-report` after a run. `/telemetry on` also records, on your machine only, which commands and skills you use.

### Use `/spend` without the team

`/spend` is its own extension (`extensions/spend/index.ts`) and needs nothing from the team. To switch the team off in one project, run `pi config --local` there and switch off `extensions/dev-team/index.ts`. To switch it off everywhere, do the same with `pi config`. pi reads a project's settings only when you trust the project.

## Pull request and issue text

The team writes for a reader who skims ([SimpleEnglish](https://github.com/AminBlg/SimpleEnglish), [i-have-adhd](https://github.com/ayghri/i-have-adhd)):

- Title: 69 characters or fewer. First sentence: what changes and why.
- Body: 250 words or fewer (comment: 150). Sentences: 25 words. Lists: 5 items.
- No em-dashes, bold, hedges (should, might) or filler (robust, leverage). Long evidence goes in one `<details>` block at the end.

Before a `gh pr` or `gh issue` command writes text, the extension checks it. It blocks a rule break once and tells the agent what to fix; the same command a second time runs. Set `"githubStyle": "warn"` to only warn, or `"off"` to turn it off. Text the shell builds at run time (`--body "$BODY"`) is not checked.

## Configuration

Later files override earlier ones:

1. `~/.pi/agent/dev-team.json`: yours, all projects
2. `<project>/.pi/dev-team.json`: the project's, in Git
3. `<project>/.pi/dev-team.local.json`: yours, one project, not in Git

All settings, with defaults:

```jsonc
{
  "models": { "opus": "inherit", "sonnet": "inherit", "haiku": "inherit", "fable": "inherit" },
  "thinking": { "low": "low", "medium": "medium", "high": "high", "xhigh": "xhigh", "max": "max" }, // agent effort -> pi thinking level
  "maxParallelAgents": 6,      // agents at the same time (project file: 1 to 16)
  "maxSubagentDepth": 2,       // how deep agents can start agents
  "subagentTimeoutSec": 3600,  // stop an agent after this time
  "autoFormat": false,         // format files after each edit (/setup turns this on)
  "githubStyle": "block",      // block, warn or off: pull request and issue text rules
  "skillIndex": "compact",     // compact, full or off: the command list in the system prompt
  "skillIndexChars": 220,      // max description length in the compact list
  "autocompactMaxTokens": 200000, // compact between tasks at this many tokens; 0 = off (project file: 0 or 50000+)
  "readDedup": true,           // a repeated read of an unchanged file returns a short note
  "claudeShim": true,          // a `claude -p` call in the scripts runs pi instead
  "env": {},                   // DEV_TEAM_* settings, for example "DEV_TEAM_MAX_PARALLEL_BUILDS": "2"
  "hooks": { "enabled": true, "disabled": ["cost_meter", "..."], "enable": [], "outputToModel": true, "timeoutSec": 60 }
}
```

A project file cannot change `hooks`, and its `env` accepts only `DEV_TEAM_*` settings. So a cloned repository cannot turn off your guards. `/dev-team hooks` shows which guards are on.

### Sensitive-file guard

Agents cannot write files that look like secrets: `.env`, `*.key`, `*.pem`, names with `secret` or `credential`, or files in a `secrets/` or `credentials/` folder (full list: `hooks/guards.json`). Markdown files are allowed. Approving in chat does not lift the block.

To allow a file, add a pattern in your own `~/.pi/agent/dev-team.json` (a project file cannot):

```json
{ "env": { "DEV_TEAM_GUARD_ALLOWED_PATHS": "test/fixtures/*,*.example" } }
```

## Update

```bash
pi update git:github.com/sanjit-roopra/pi-dev-team
```

For one project only: `pi install -l git:github.com/sanjit-roopra/pi-dev-team`.

## Troubleshooting

| What you see | What to do |
|---|---|
| `dev-team: python >= 3.10 not found — hook guards are disabled.` | Install Python 3.10+, restart pi. |
| `/dev-team doctor` shows `NO AUTH (/login)` | Run `/login`, or set that tier to `inherit`. |
| `/dev-team doctor` shows `UNKNOWN MODEL` | Run `/dev-team models` and pick a preset again. |
| `gh pr create` is blocked | Run `/code-review` first, or use `/pr`. |
| An agent stops after one hour | Make the task smaller, or raise `subagentTimeoutSec`. |

## More information

- [PORTING.md](PORTING.md): how the port works and what differs from the Claude Code plugin
- [CONTRIBUTING.md](CONTRIBUTING.md): tests and upstream updates
- `UPSTREAM.json`: the upstream version (dev-team v14.0.0)

## License

MIT. Upstream content is copyright Bryan Finster (see [LICENSE](LICENSE)). This is an unofficial port, not part of Anthropic or the pi project.
