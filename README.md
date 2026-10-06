# pi-dev-team

pi-dev-team gives the [pi coding agent](https://pi.dev) a team of AI agents. The team writes a specification, makes a plan, builds the change with tests, reviews the code, and opens a pull request. You approve each important step.

The package is a port of the dev-team plugin by Bryan Finster ([bdfinst/agentic-dev-team](https://github.com/bdfinst/agentic-dev-team)), which was written for Claude Code. It works with every model provider that pi supports, for example GitHub Copilot, Anthropic, and OpenAI.

## Quick start

The installation takes about 5 minutes if Node.js and Python are already on your computer.

1. Install pi, if you do not have it: `npm install -g @earendil-works/pi-coding-agent`
2. Install this package: `pi install git:github.com/sanjit-roopra/pi-dev-team`
3. Go to a Git repository and start pi: `cd my-project && pi`
4. In pi, log in to a model provider: `/login`
5. Check the installation: `/dev-team doctor`
6. Prepare the repository for the team: `/setup`
7. Give the team its first task: `/specs add rate limiting to the public API`

After step 5, each line of the report starts with `ok` or `MISSING`. If a line shows `MISSING`, install that tool (see [Requirements](#requirements)).

## Requirements

| Tool | Version | The team uses it to | If it is missing |
|---|---|---|---|
| [Node.js](https://nodejs.org) | 22.19 or later | Run pi | pi does not start. |
| [pi](https://pi.dev) | 1.0 or later | Run the agents | The package does not load. |
| Git | Any recent version | Track changes, make worktrees | Most commands do not work. |
| Python | 3.10 or later | Run the guard hooks and scripts | The guards are off. pi shows a warning. |
| [GitHub CLI](https://cli.github.com) (`gh`) | Any recent version | Open pull requests and read issues | `/pr` and `/ship` cannot open a pull request. |
| `jq` | Any version | Run some quality gates | Those gates do not run. |

A guard hook is a small script that runs before or after a tool call. It can stop an unsafe action, for example a pull request without a code review.

## How the team works

A normal change goes through four commands. Each command stops and asks you before it continues.

| Command | What it does | What it leaves behind |
|---|---|---|
| `/specs <task>` | Asks you questions until the task is clear. Then it writes the intent, the architecture notes, and the acceptance criteria. | A spec file or a GitHub issue |
| `/plan` | Splits the work into small steps. Each step has its own tests. | `plans/<task>.md` |
| `/build` | Does the plan one step at a time. It writes a test, makes the test pass, and then cleans up the code. | Commits on your branch |
| `/pr` | Runs the tests, the linter, and the code review. Then it opens a pull request. | A pull request |

To do all four steps with one command, use `/ship <task>`. It stops at the same approval points.

### Other commands

- `/code-review`: About 25 review agents read your change at the same time. Each agent checks one topic, for example security, tests, or naming. Then the team can fix what they find.
- `/triage <bug>`: Finds the root cause of a bug and writes a fix plan.
- `/fix <bug>`: Does `/triage`, proves the bug, fixes it with tests, and opens a pull request.
- `/continue`: Continues the work from your last session.
- `/help`: Shows the main commands. `/help --all` shows all commands.

## Choose the models

Each agent has a tier. The tier tells the agent how strong a model it needs:

| Tier | Used for |
|---|---|
| `opus` | Deep reviews and difficult design work |
| `sonnet` | Most work |
| `haiku` | Small, cheap checks |
| `fable` | The strongest model. No agent uses this tier by default. |

By default, every tier uses the model that you selected in pi. To use a different model for each tier, run `/dev-team models` and select a preset:

- `github-copilot`: Uses the Claude models that GitHub Copilot gives you.
- `anthropic`: Uses the Claude models from the Anthropic API.
- `inherit`: Every agent uses your current model. This is the default.

If you use GitHub Copilot, every agent uses AI credits for the tokens it sends and receives. A code review can start more than 20 agents, so a less expensive model for the lower tiers can reduce the cost a lot.

## Safety and cost

The agents can do the same things that you can do in a terminal.

- They can read and change files in your repository.
- They can run shell commands, for example your tests.
- They can make many model calls. Up to 6 agents run at the same time by default.

The guard hooks reduce the risk. For example, they stop `gh pr create` until a code review passes, and they keep the tests fixed while the team cleans up code. The guards need Python.

To limit the work, set these values in `~/.pi/agent/dev-team.json`:

```json
{
  "maxParallelAgents": 2,
  "subagentTimeoutSec": 900
}
```

To see what the team spends, run `/telemetry on`. Then run `/cost-report`. The numbers come from pi, so they are correct for every provider.

pi's footer shows the cost of the whole session in USD, including the agents. If you use GitHub Copilot models, the status line also shows `GitHub Copilot: N AI credits` for the session, and the agent view shows the AI credits of each agent next to its USD cost. GitHub bills 1 AI credit for each $0.01 of token cost ([models and pricing](https://docs.github.com/en/copilot/reference/copilot-billing/models-and-pricing)). The number is gross usage: it does not subtract your plan's monthly allowance. It includes the usage of context compaction and branch summaries, counted at the model in effect when they ran, since pi does not record which provider ran them.

### See where the spend went

Run `/dev-team usage` to open a chart of what your sessions spent. It counts every provider, for example GitHub Copilot, OpenAI and Anthropic, and also local models that cost nothing.

- The header shows the total in USD. If GitHub Copilot served part of it, the header also shows the AI credits of that part.
- **By model** ranks the models by USD, largest first, with the share of the total. Each model shows its provider, for example `openai/gpt-5.5`.
- **By provider** ranks the providers by USD.
- **By agent** ranks the dev-team agents that ran as subagents. An agent that ran on two providers has one row for each, for example `software-engineer · github-copilot`. The share is of the subagent total.
- Each row shows USD, the AI credits (`cr`) when Copilot served it, and the share. If a row cost $0, for example a local model, the rows also show their tokens (`tok`). A $0 row has a share of 0%.
- Above the chart, split bars show how the USD divides. The first bar shows the providers, when more than one has a cost. The second bar shows the threads: main `█`, subagents `▓` and overhead `▒`. A thread always has the same glyph, so the bars read without colour.

| Term | Meaning |
|---|---|
| USD | pi's price for the tokens, from its model catalog. Every provider has it. |
| AI credits | What GitHub Copilot counts for its share: 1 AI credit for each $0.01 of Copilot's USD. It is gross use, before your plan's monthly allowance. |
| Tokens | The input, output and cache tokens of a run |
| Main | The USD of your own conversation with pi |
| Subagents | The USD of the dev-team agents that the team started, including the agents they started |
| Overhead | The USD that pi spends outside a turn: cache warm-ups, context compaction, and branch summaries |

For a ChatGPT or Claude plan, USD is pi's catalog price, not what the plan bills you.

The chart shows **this session** (all branches) at first. Press `s` to see **this month** instead: every saved pi session of all your projects, from the 1st of the month at 00:00 UTC. That is also when GitHub's monthly period starts, so the month's AI credits match GitHub's period. pi reads the files when you press `s` and shows the progress. The header shows the time of that reading ("as of"). To refresh, close the chart and open it again. A session that was forked or cloned counts once.

| Key | Action |
|---|---|
| `Tab`, `Shift+Tab` | Switch between By model, By provider and By agent |
| `s` | Switch between this session and this month. While the month loads, `s` cancels the loading. |
| `Esc`, `q`, `Ctrl+C` | Close |

Letter keys work in either case: `S` and `Q` do the same as `s` and `q`.

To start on a scope, run `/dev-team usage session` or `/dev-team usage month`. Without a terminal UI (`pi -p`, or an RPC client), the command prints a plain-text summary instead: the total, the same splits as the chart, and the models, providers and agents ranked with their USD, AI credits and share. The same argument selects the scope.

The month counts the session files that pi keeps in `~/.pi/agent/sessions/<project>/`. It does not count the transcripts in nested `run-N/session.jsonl` files that other extensions keep in the same folder. If a file cannot be read, the chart shows how many files it could not read.

## Pull request and issue text

The team writes pull requests, issues and comments for a reader who skims. The rules come from [SimpleEnglish](https://github.com/AminBlg/SimpleEnglish) (plain English after ASD-STE100) and [i-have-adhd](https://github.com/ayghri/i-have-adhd) (the point first, short lists, one next step):

- The title has 69 characters or fewer.
- The first sentence of the body says what changes and why.
- The visible body has 250 words or fewer (a comment has 150). Sentences have 25 words or fewer. Lists have 5 items or fewer.
- The text has no em-dashes, bold, hedges (should, may, might) or filler (robust, seamlessly, leverage).
- Long required content, for example the evidence bundle of `/pr`, goes at the end in one collapsed `<details>` block. Code, URLs, HTML comments, tables, headings and `<details>` blocks do not count toward the word limit.
- Headings and markers that a skill needs, for example the sections of a `/specs` issue, stay as they are.

Before a `gh pr` or `gh issue` command creates, edits or comments, the extension checks the title and the body. If the text breaks a rule, the extension blocks the command one time and tells the agent what to fix. If the agent sends the same command again, it runs. To only show the problems, set `"githubStyle": "warn"`. To turn off the check and the rules, set `"githubStyle": "off"`.

The check reads text in quotes, in `$(cat <<EOF ...)` and in a `--body-file`. It does not check text that the shell makes when the command runs, for example `--body "$BODY"`, or a `gh` command that runs inside another program, for example `bash -c` or `xargs`.

## Configuration

The package reads three configuration files. A later file overrides an earlier file.

1. `~/.pi/agent/dev-team.json`: Your settings for all projects
2. `<project>/.pi/dev-team.json`: The settings for one project, shared in Git
3. `<project>/.pi/dev-team.local.json`: Your own settings for one project, not in Git

All settings, with the default values:

```jsonc
{
  "models": { "opus": "inherit", "sonnet": "inherit", "haiku": "inherit", "fable": "inherit" },
  "thinking": { "low": "low", "medium": "medium", "high": "high", "xhigh": "xhigh", "max": "max" }, // agent effort -> pi thinking level
  "maxParallelAgents": 6,      // agents that run at the same time
  "maxSubagentDepth": 2,       // agents can start other agents, 2 levels deep
  "subagentTimeoutSec": 3600,  // stop an agent after this time
  "autoFormat": false,         // format files after each edit (/setup turns this on)
  "githubStyle": "block",      // block, warn, or off: the rules and the check for pull request and issue text
  "skillIndex": "compact",     // compact, full, or off: the command list in the system prompt (agents get a short compact list of their own skills; off removes it too)
  "skillIndexChars": 220,      // the maximum length of each description in the compact list
  "autocompactMaxTokens": 200000, // compact your session between tasks at this many context tokens; 0 = off (a project file: 0 or 50000 and more)
  "claudeShim": true,          // a `claude -p` call in the scripts runs pi instead
  "env": {},                   // DEV_TEAM_* settings, for example "DEV_TEAM_MAX_PARALLEL_BUILDS": "2"
  "hooks": { "enabled": true, "disabled": ["cost_meter", "..."], "enable": [], "outputToModel": true, "timeoutSec": 60 }
}
```

Some hooks are off by default. A project file cannot change the `hooks` setting. Only your own file in `~/.pi/agent/` can change it. In a project file, `env` accepts only `DEV_TEAM_*` tuning settings. These rules stop a cloned repository from turning off your guards or from changing your `PATH`.

To see which guard hooks are on, run `/dev-team hooks`.

## Update

To get the newest version, run:

```bash
pi update git:github.com/sanjit-roopra/pi-dev-team
```

To install the package for one project only, run `pi install -l git:github.com/sanjit-roopra/pi-dev-team` in that project. pi writes the package to `.pi/settings.json`.

## Troubleshooting

| What you see | Cause | What to do |
|---|---|---|
| `dev-team: python >= 3.10 not found — hook guards are disabled.` | pi cannot find Python 3.10 or later. | Install Python 3.10 or later. Then restart pi. |
| `/dev-team doctor` shows `NO AUTH (/login)` | You are not logged in to the provider of that tier. | Run `/login`, or set that tier to `inherit`. |
| `/dev-team doctor` shows `UNKNOWN MODEL` | pi does not know the model name of that tier. | Run `/dev-team models` and select a preset again. |
| `gh pr create` is blocked | The review gate needs a passed code review first. | Run `/code-review`, or use `/pr`, which runs the review for you. |
| An agent stops after one hour | The agent reached `subagentTimeoutSec`. | Make the task smaller, or increase the value. |

## More information

- [PORTING.md](PORTING.md): How the port works, what is different from the Claude Code plugin, and what is not ported
- [CONTRIBUTING.md](CONTRIBUTING.md): How to run the tests and update to a new upstream version
- `UPSTREAM.json`: The upstream version of this package (now dev-team v14.0.0)

## License

MIT. The upstream content is copyright Bryan Finster (see [LICENSE](LICENSE)). This package is an unofficial port. It is not part of Anthropic or the pi project.
