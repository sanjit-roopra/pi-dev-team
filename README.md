# pi-dev-team

pi-dev-team gives the [pi coding agent](https://pi.dev) a team of AI agents. The team writes a spec, makes a plan, builds the code with tests, reviews it and opens a pull request. You approve each important step. pi-dev-team works with every provider that pi supports, for example GitHub Copilot, Anthropic and OpenAI.

## Quick start

Install pi and the package:

1. Install pi: `npm install -g @earendil-works/pi-coding-agent`
2. Install pi-dev-team: `pi install git:github.com/sanjit-roopra/pi-dev-team`
3. Start pi in a Git repository: `cd my-project && pi`
4. Log in to a provider: `/login`

Give the team its first task:

1. Check the install: `/dev-team doctor`
2. Install each required tool that the report marks `MISSING` (see [Requirements](#requirements)). `semgrep` is optional. A missing `dev-team-run` means that `cliShim` is off.
3. Prepare the repository: `/setup`
4. Give the team a task: `/specs add rate limiting to the public API`

Result: the team asks about the open points, writes a spec and starts `/plan` by itself. After you approve the plan, run `/build`. When `/build` reports done, run `/pr`.

## Requirements

| Tool | Version | If it is missing |
|---|---|---|
| [Node.js](https://nodejs.org) | 22.19+ | pi does not start. |
| [pi](https://pi.dev) | 1.0+ | The package does not load. |
| Git | recent | Most commands do not work. |
| Python | 3.10+ | The guard hooks (scripts that run around a tool call) are off, and pi shows a warning. The [example check](#the-example-check) cannot run. |
| [GitHub CLI](https://cli.github.com) (`gh`) | recent | `/pr` and `/ship` cannot open a pull request. |
| `jq` | any | Some quality gates do not run. |
| [`lizard`](https://github.com/terryyin/lizard) | any | The quality bar installs it into the project's environment. |

A guard hook can stop an unsafe action, for example a pull request without a code review.

## How pi-dev-team works

You give the team a request: the text that you type. A slice is one part of the feature, from input to output, with its own steps and tests. The team works in four steps:

| Command | What it does | Result |
|---|---|---|
| `/specs <task>` | Asks questions until the task is clear. Then it writes the spec: intent, architecture notes and acceptance criteria. | A spec file or a GitHub issue |
| `/plan` | Splits the work into slices, and each slice into small steps with their tests. | `plans/<task>.md` |
| `/build` | Builds one slice at a time: tests, code, review. | Commits on your branch |
| `/pr` | Runs the tests, the linter and a code review, then opens a pull request. | A pull request |

To run the four steps:

1. Run `/specs <task>`. After the spec, `/specs` starts `/plan` by itself.
2. Approve the plan.
3. Run `/build`.
4. When `/build` reports done, run `/pr`.

`/ship <task>` runs all four steps for you, with the same questions.

Each approval is a question. If you do not answer in 120 seconds (`askTimeoutSec`), the team takes the recommended answer, for example "approve", and goes on. To make the team wait, press `w` or run `/dev-team wait` (see [Questions and timeouts](#questions-and-timeouts)).

These steps are the default flow: the gate review profile (a set of review steps) plus the example check. For more review, see [More review when you want it](#more-review-when-you-want-it).

### A plain request gets a brief first

When you type a request without a command, the team first shows a brief. A brief is a short summary of what the team will build, when it is done and what it assumes. The model picks one of these kinds:

| Kind | When | What happens |
|---|---|---|
| question | No file changes | The team answers. There is no brief. |
| tiny | One sentence, at most 3 files | The brief shows 3 lines, and the team goes on. |
| feature | A bigger change | The brief shows "At a glance" (at most 15 lines) and asks for your ok. Then the team runs `/ship`. |
| vague | Decisions that only you can make | The team runs `/specs`, which asks those decisions in rounds. |
| resume | The message answers a running command | The command goes on. |

If a tiny change grows past 3 files or 150 lines, the team must post a new brief or stop and run `/ship`. To turn off the brief, set `"routing": "off"` (see [Configuration](#configuration)).

### Your request is the spec

pi-dev-team saves your request word for word in `.pi/dev-team/memory/requests/`. With the [example check](#the-example-check) on (the default), it saves every request that you type. With the check off, it saves only the text after `/specs`, `/plan` and `/ship`.

The plan, the build and the reviewers check the work against that saved file. They do not check against a summary that the model wrote. A model copy can shorten your text, so code writes the file, not the model.

- `/plan` copies the output examples of your request into its scenarios unchanged.
- The spec-compliance review counts a difference from those examples as an unmet criterion.
- A point that your request leaves open becomes an open question for you, not a silent decision.

An issue number, a URL or a file path alone (`/ship 123`, `/specs docs/spec.md`) is not saved. Then the issue or the document is the request.

The saved files are owner-only (0600). A folder that pi-dev-team creates is 0700. An existing folder keeps its mode. The folder gets its own `.gitignore` of `*`, so the files stay out of Git also in a repository where `/setup` never ran.

### Questions and timeouts

Each question shows its time left. The default is 120 seconds (`askTimeoutSec`). If you do not answer in time, the team takes the recommended answer and goes on.

| To do this | Do this |
|---|---|
| Stop the timer for the rest of the questions | Press `w`. |
| Make every question in this session wait for you | Run `/dev-team wait`. |
| Switch back to timeouts | Run `/dev-team timeout`. |
| Make one request wait for every answer | Write "grill me" or "ask me everything" in the request. |
| Wait always, in every session | Set `"answerMode": "wait"` in `~/.pi/agent/dev-team.json`. |

The team can also send a [phone message](#phone-message-when-the-team-goes-on-alone) when it goes on without you.

### /specs: questions, then the spec

`/specs` asks the open decisions in rounds. Each round asks every decision whose prerequisites are settled, with a recommended answer. Then `/specs` writes three parts:

- Intent: what the change does and why.
- Architecture notes: where the change goes in the code.
- Acceptance criteria: when the change is done.

The spec goes in a file under `docs/specs/` or in a GitHub issue. When you wrote the spec together with the team, `/specs` then starts `/plan`. For a document that you bring, it offers `/plan` as the next step.

With the example check on, `/specs` adds one step after its questions: [approved examples](#approved-examples-in-specs).

### /plan: small steps

`/plan` writes a short plan: slices, steps and open questions. Each step has one line for its code, one for its test and one for its refactor.

- Gherkin scenarios (short given-when-then test cases) cover only behavior that the request states or shows in an example.
- Plan critics (review agents for the plan) do not run. The plan says `Plan review: skipped (gate profile)`.
- You approve the plan. Then run `/build`, or let `/ship` run it.

### /build: one slice at a time

`/build` starts one implementer agent per slice. The implementer works one step at a time: it writes the step, writes its tests and runs them. It runs the full test suite once at the end of the slice, and commits once.

The tests stay within a budget:

- One test per scenario.
- One test per rule of the request that no scenario covers.
- No tests of internal helpers, memory bounds, signals or injected file system failures, unless the request asks for them.

After each slice, a checkpoint (a review point in `/build`) reviews the change. A `complex` step also gets its own checkpoint. A review lens is a review agent with one topic.

| At | What runs |
|---|---|
| Every checkpoint | The spec-compliance lens and the correctness lens. Before them, `lizard`, and `jscpd` when it is installed. |
| The last slice | Also the simplify lens (it proposes only deletions) over every production file that the build changed. The security lens runs when the change needs it. |
| Every test command | It runs under `timeout 600`, so a hung test fails after 600 seconds. |

The review fixes only `error` findings, in one round. The build report lists the `warning` and `suggestion` findings. Every `lizard` limit breach and every `jscpd` copy in a changed file is an error.

Other rules of `/build`:

- No second review panel at the end. Only files that no checkpoint reviewed get a `/code-review`.
- No Farley Score (a test-quality score of 8 properties), unless you set `DEV_TEAM_FARLEY=on`.
- Agents get short tasks and write no report files. Their last message is their report.
- With no human attached, `/build` skips the Feedback & Learning step.
- A step that fails twice in the same way retries once on the next stronger [tier](#choose-the-models) (`haiku`, then `sonnet`, then `opus`). Then it stops and asks you. There is no retry when both tiers use the same model. With the default configuration, every tier uses the session model, so there is no retry.

### The quality bar in every session

The quality bar applies to all code: plain requests, `/fix`, review fixes and `/build`. Each function must have:

- A cyclomatic complexity (the number of paths through the code) of at most 10.
- At most 60 lines.
- At most 5 parameters.

Before the agent reports code work done, it runs the linter (`ruff check` for Python) and `lizard -w -C 10 -L 60 -a 5 <changed source files>`. It fixes every finding and runs both again until they are clean. If `lizard` is missing, the agent installs it into the project's environment.

The agent also writes the least code that works. It uses what the codebase, the standard library or an installed dependency already has. It never cuts input validation or error handling at a real boundary to save lines.

### Interface standards where the spec is silent

This rule is experimental. In its first benchmark run, it showed no effect.

Where the spec says nothing about a point, the agent follows the established standard for the interface:

- JSON Pointer for error locations.
- RFC 9457 for error bodies.
- RFC 9110 for status codes.
- ISO 8601 for times.

Where the spec is explicit, the spec wins, also against the standard. Where the request shows an example, the example decides.

### The example check

The example check makes the examples in your request its acceptance tests. It is on by default.

1. The agent copies each input-to-output example of your request into `.dev-team/examples.json`.
2. Before it reports the work done, it runs `scripts/example_replay.py` until the script exits 0.
3. The script runs each example against the program and compares the output.

The script compares output as text, or as JSON in any key order. Values that the program generates (ids, timestamps) go under `vary`, which still requires the shape of the example. So `2025-10-12T14:03:22Z` rejects `.148842Z` and `+00:00`.

The agent cannot write its own expected output:

- Each case must quote a saved request word for word in its `source`.
- Each expected value must appear in that quote.
- Each fenced code block of each saved request needs a case, or a skip with a reason.

Cases persist across requests. A later change that breaks an earlier example fails the check. A case stops counting only when `superseded_by` quotes newer request text that changes it. The superseded case still runs, and the check shows its failure but does not count it.

Weak spots:

| Limit | Effect |
|---|---|
| A vague request has no examples. | The check runs 0 cases and passes. |
| Examples written only in prose | They do not become cases. |
| Behavior that the request neither states nor shows | It is not checked. |
| A reply inside a running command is saved like a new request. | A fenced block that you paste there needs a case or a skip reason. |
| The write block is a scan of the command, not a sandbox. | A program that builds the path at run time gets past it. |

To turn the check off, start pi with `DEV_TEAM_EXAMPLES=off pi`.

#### Approved examples in /specs

With the check on, `/specs` proposes examples for each acceptance criterion that your request shows no example for. Each example is an input and its exact output. pi shows them in a dialog: "Are these the right examples?"

| You choose | What happens |
|---|---|
| Approve | pi-dev-team saves the text that you saw, unchanged, as `.pi/dev-team/memory/requests/approved-<time>.md`. The check then accepts these examples. |
| Edit them first | An editor opens. pi-dev-team saves your edited text instead. |
| Reject | Nothing is saved. The agent asks what is wrong, or proposes other examples. |
| No answer in time, `Esc`, an empty editor, or no human | Nothing is saved. The spec lists the examples under "Decide these". |

Only your own answer saves. pi-dev-team blocks agent writes to `.pi/dev-team/memory/requests/`. One dialog shows at most 40 lines, so you can read all of it. A timeout sends the phone message, if you set one up.

Read each example before you approve it. If you approve without reading, the agent grades itself again. Check the exact outputs: formats, precision, suffixes and error text. The tests compare those.

### /pr: tests, lint, review, pull request

`/pr` runs the tests, the linter and a code review. Then it opens the pull request. A guard hook blocks `gh pr create` until a code review passes.

`/pr` then turns on auto-merge (`gh pr merge --auto --squash`). So the pull request merges by itself when the checks and the required reviews pass. If the repository does not allow auto-merge, the pull request stays open.

To prevent auto-merge, use one of these commands:

- `/pr --no-auto-merge`
- `/pr --draft`
- `/ship --no-auto-merge`

When `gh` is logged in, `/pr` also files one GitHub issue. The issue lists the steps that the run skipped and the problems that it noticed but did not fix. The pull request links it under "Residual risks".

If the team took answers for you, the pull request lists them under "Decide these".

### Measured results

These results come from [SlopCodeBench](https://github.com/SprocketLab/slop-code-bench) runs. Hidden tests are tests that the agent does not see. Structural erosion is a SlopCodeBench code-shape score: lower is better. A SlopCodeBench checkpoint is one spec version of a problem. It is not a `/build` checkpoint.

| What was compared | Result |
|---|---|
| Example check on, against the same flow without it (52 SlopCodeBench checkpoints, 10 problems, one run each, GPT 6.1 Sol, version `2004010`) | Hidden tests: 78.2% against 70.3%. Structural erosion: 0.001 against 0.002. No function above complexity 10. About 10% more cost. |
| The same, on the 4 problems the check was tuned on | 77.8% and 77.1% in two runs, against 61.9% |
| The same, on the 6 other problems | 78.6% against 78.4% |
| Plain pi with only the quality bar, against the lean profile (file_merger) | The same hidden-test score and code shape. 31 minutes and $1.70, against 106 minutes and $13.67. |
| The other 9 review lenses at the `/build` slice checkpoints | 0 errors in 53 dispatches over 3 runs |
| A frozen test spec with a separate scenario author | 67.5%, at about twice the cost |
| More case and wording rules | 78.6% in one run, at about 35% more cost |

The gain of the example check comes from requests with concrete examples. On other requests, it costs little.

## Other commands

| Command | What it does |
|---|---|
| `/code-review` | About 20 review agents check your change, one topic each, for example security, tests and naming. |
| `/triage <bug>` | Finds the root cause and writes a fix plan. |
| `/fix <bug>` | Triages the bug, proves it with a test, fixes it and opens a pull request. |
| `/continue` | Continues the work of your last session. |
| `/spend` | Shows what your sessions cost (see [Safety and cost](#safety-and-cost)). |
| `/telemetry on` | Logs the cost of each run for `/cost-report`. It also logs which commands you use, on your machine only. |
| `/dev-team` | Shows the package status: `pi-dev-team <version>`, configuration files, tiers, agents and hooks. |
| `/dev-team models`, `hooks`, `doctor` | Map tiers to models, list the guard hooks, or check the install. |
| `/dev-team wait`, `timeout` | Questions wait for you, or time out (this session). |
| `/help`, `/help --all` | The main commands, or all commands. Neither lists `/spend` or `/dev-team`. |

## Phone message when the team goes on alone

If you do not answer a question in time, the team can tell your phone. It uses ntfy, a free phone app. You need no account.

1. Install the ntfy app from the App Store or Google Play.
2. Make up a long random name, for example `dev-team-k3v9q2x7m4`.
3. In the app, tap `+` and subscribe to that name.
4. Add the name to `~/.pi/agent/dev-team.json`: `{ "notify": "ntfy:dev-team-k3v9q2x7m4" }`

Result: the message shows what the team builds, or the answers that it took for you.

Anyone who knows the name can read your messages. For your own ntfy server, use `ntfy:<https url>`. Only your user file can set `notify`. Without it, nothing is sent.

## Choose the models

To map tiers to models, run `/dev-team models` and pick a preset. A tier is a model class that an agent names, for example `sonnet`. By default, every tier uses your session model.

| Tier | Used for |
|---|---|
| `opus` | Deep reviews and hard design |
| `sonnet` | Most work |
| `haiku` | Small checks |
| `fable` | The strongest tier. No package agent uses it by default. |

The presets:

- `github-copilot`: the Opus, Sonnet, Haiku and Fable models of GitHub Copilot.
- `anthropic`: the Opus, Sonnet, Haiku and Fable models of the Anthropic API.
- `inherit`: your session model (the default).
- `custom`: you set each tier yourself.

A code review can start about 20 agents, so cheaper lower tiers save money. `/dev-team doctor` suggests a preset for the provider of your session.

## Safety and cost

The agents can do what you can do in a terminal. They change files, run commands and make many model calls, with up to 6 agents at once.

- The guard hooks reduce the risk. For example, they block `gh pr create` until a code review passes. They need Python.
- The destructive-command guard (a guard hook for risky commands) marks some commands `CAUTION`. When you are at the terminal, pi asks before it runs one. No answer in time means no. Without a human, pi only shows the warning.
- pi shows each running agent: its time, its cost, its current command and its place in the queue.
- The footer of pi shows the session cost in USD, agents included. With GitHub Copilot, the status line also shows the AI credits of the session.

To limit the work, set these in `~/.pi/agent/dev-team.json`:

```json
{ "maxParallelAgents": 2, "subagentTimeoutSec": 900 }
```

### See where the spend went

Run `/spend` for a chart of what your sessions cost, for every provider. Local models count as $0.

![The /spend month view showing daily costs, provider and thread splits, and costs by model with USD and AI credits](docs/images/spend.png)

The image shows example data: monthly trends, provider shares, and main, agent and overhead costs.

| To do this | Do this |
|---|---|
| Switch the view: By model, By provider, By agent | Press `Tab`. |
| Switch the scope: this session, or this month in all projects | Press `s`, or run `/spend session` or `/spend month`. |
| Close the chart | Press `Esc` or `q`. |

The bars show main `█`, agents `▓` and overhead `▒`. Without a terminal UI, `/spend` prints text. The month starts on the 1st at 00:00 UTC.

| Term | Meaning |
|---|---|
| USD | The catalog price of pi for the tokens. With a subscription plan, for example a ChatGPT plan, this is not what the plan bills. |
| AI credits | The unit of GitHub Copilot: 1 credit per $0.01 of the Copilot USD price, before the allowance of your plan ([pricing](https://docs.github.com/en/copilot/reference/copilot-billing/models-and-pricing)). |

`/spend` also works without the team. To use it alone, switch off `extensions/dev-team/index.ts` with `pi config` (or `pi config --local`).

## More review when you want it

To run more review, start pi with another review profile (a set of review steps for `/plan`, `/build`, `/code-review` and `/ship`):

```bash
DEV_TEAM_REVIEW=lean pi   # more review lenses and plan critics
DEV_TEAM_REVIEW=full pi   # every review step the commands describe
```

The default profile is `gate`.

| Profile | What it adds to the default |
|---|---|
| `lean` | Plan critics up to the standard set, with one revision round. Four lenses at each slice (spec-compliance, correctness, structure, test), and every selected lens at the last slice. It has no quality bar in every session and no example check. |
| `full` | The command steps as written, with no profile section. One implementer per step, plan critics above the standard set, more fix rounds, the step 6 backstop review and the Farley Score. |

Under `lean`, the review still fixes only `error` findings, in one round. Spec-compliance review, structure review, lint, type-check and the complexity check run at every checkpoint.

| Variable | Values | What it does |
|---|---|---|
| `DEV_TEAM_REVIEW` | `gate` (default), `lean`, `full` | The review profile. An unknown value means `gate`, with a warning. |
| `DEV_TEAM_FARLEY` | `off` (default), `on` | Under `gate` and `lean`: run the Farley Score at the end of `/build`. |
| `DEV_TEAM_EXAMPLES` | `on` (default), `off` (or `0`, `false`, `no`) | Under `gate` only: run the [example check](#the-example-check). |
| `DEV_TEAM_MAX_PARALLEL_AGENTS` | a number, 1 or more | The most agents at once. It wins over every configuration file. |

Only your shell can set `DEV_TEAM_REVIEW`, `DEV_TEAM_FARLEY` and `DEV_TEAM_EXAMPLES`. The `env` of a configuration file cannot set them. So a cloned repository cannot change your review profile or turn off the example check.

Most review lenses and plan critics think at `medium` effort, in all profiles. A dispatch can lower the effort of an agent, but never raise it.

## Pull request and issue text

The team writes pull requests, issues and comments for a reader who skims. The rules come from two writing standards: [SimpleEnglish](https://github.com/AminBlg/SimpleEnglish) and [i-have-adhd](https://github.com/ayghri/i-have-adhd).

| Part | Rule |
|---|---|
| Title | 69 characters or fewer, in the imperative |
| First sentence | What changes and why |
| Body | 250 words or fewer (comment: 150). Code, URLs, tables, headings and `<details>` blocks do not count. |
| Sentences and lists | At most 25 words per sentence, at most 5 items per list |
| Words | No em-dashes, bold, emoji, hedges (should, might) or filler (robust, leverage) |

Long evidence goes in one `<details>` block at the end.

Before a `gh pr` or `gh issue` command sends text, pi-dev-team checks the title length, the word count and the sentence and list length. It also checks for em-dashes, bold, hedges and filler. The emoji and imperative rules are in the prompt only. The check blocks a rule break once and tells the agent what to fix. The same command a second time runs. Text that the shell builds at run time (`--body "$BODY"`) is not checked.

To only warn, set `"githubStyle": "warn"`. To turn the check off, set `"githubStyle": "off"`.

## Configuration

Later files override earlier ones:

1. `~/.pi/agent/dev-team.json`: yours, for all projects.
2. `<project>/.pi/dev-team.json`: the project's, in Git.
3. `<project>/.pi/dev-team.local.json`: yours, for one project, not in Git.

pi-dev-team reads the project files only when pi trusts the project. `PI_CODING_AGENT_DIR` replaces the folder `~/.pi/agent`. The process environment comes last: `DEV_TEAM_MAX_PARALLEL_AGENTS` overrides `maxParallelAgents`.

### Agents and models

| Key | Default | What it does |
|---|---|---|
| `models` | every tier `"inherit"` | Tier to `provider/model-id`, or `inherit` for the session model |
| `thinking` | `low`, `medium`, `high`, `xhigh`, `max` to the same name | Agent effort to pi thinking level |
| `maxParallelAgents` | `6` | The most agents at once. A project file can set 1 to 16. |
| `maxSubagentDepth` | `2` | How deep agents can start agents |
| `subagentTimeoutSec` | `3600` | Stop an agent after this many seconds. `0` means no limit. |
| `allowPiSubagents` | `false` | `true` lets the model use the tools of pi-subagents. User file only. |

### Questions, routing and text

| Key | Default | What it does |
|---|---|---|
| `askTimeoutSec` | `120` | Questions wait this long, then the team goes on. `0` means never ask. User file only. |
| `answerMode` | `"timeout"` | `timeout`, or `wait`: questions wait for you. User file only. |
| `routing` | `"brief"` | `brief` or `off`: a brief before a plain request changes files |
| `notify` | `""` | `"ntfy:<name>"`: the [phone message](#phone-message-when-the-team-goes-on-alone). User file only. |
| `githubStyle` | `"block"` | `block`, `warn` or `off`: the [pull request and issue text](#pull-request-and-issue-text) rules |

### Context and tools

| Key | Default | What it does |
|---|---|---|
| `autocompactMaxTokens` | `200000` | Compact the session between runs at this many context tokens. `0` means off. A project file can set `0`, or 50000 and more. |
| `autocompactPct` | not set | Compact the session between runs at this percent (1 to 100) of the context window of the model. `/setup` offers `40`. |
| `skillIndex` | `"compact"` | `compact`, `full` or `off`: the command list in the system prompt |
| `skillIndexChars` | `220` | The longest description in that list |
| `readDedup` | `true` | Reading an unchanged file again gives a short note. |
| `autoFormat` | `false` | Format files after each edit. `/setup` sets it. |
| `cliShim` | `true` | Put `bin/dev-team-run` on `PATH`, so scripts that call it run an agent through pi |

For `autocompactPct`, the first source that sets it wins: `DEV_TEAM_AUTOCOMPACT_PCT` in the process environment, then `.pi/dev-team.local.json`, `.pi/dev-team.json` and `~/.pi/agent/dev-team.json`.

### Hooks and environment

| Key | Default | What it does |
|---|---|---|
| `hooks` | `{ "enabled": true, "disabled": [...], "enable": [], "outputToModel": true, "timeoutSec": 60 }` | The guard hooks. `disabled` lists the hooks that are off by default. `enable` turns one of them on. User file only. |
| `env` | `{}` | `DEV_TEAM_*` environment variables, for example `"DEV_TEAM_MAX_PARALLEL_BUILDS": "2"` |

A project file cannot change `hooks`, so a cloned repository cannot turn off your guards. The `env` of a project file can set only the tuning variables in `PROJECT_ENV_SETTINGS` (`extensions/dev-team/lib/config.ts`). `/dev-team` lists each project key that it ignored. `/dev-team hooks` shows which guards are on.

### Sensitive-file guard

Agents cannot write files that look like secrets, for example `.env`, `*.key` or `*.pem`. The full list is in `hooks/guards.json`. Approval in chat does not lift the block.

Writes to `.pi/settings.json`, `.pi/dev-team.json` and `.pi/dev-team.local.json` get a warning.

To allow a file, add a pattern in your own `~/.pi/agent/dev-team.json`. A project file cannot do this.

```json
{ "env": { "DEV_TEAM_GUARD_ALLOWED_PATHS": "test/fixtures/*,*.example" } }
```

## Files pi-dev-team keeps in your project

| Path | What it holds | In Git |
|---|---|---|
| `.pi/dev-team/memory/` | Saved requests (`requests/`), the brief, build and review state | No |
| `.pi/dev-team/metrics/` | Cost rows and review verdicts | No |
| `.pi/dev-team/worktrees/` | Git worktrees for agents that run with `isolation: "worktree"` | No |
| `.pi/dev-team/` (other) | `plans/`, `review-summaries/`, `evals/`, `hooks/` and state files | No |
| `.pi/agents/` | Project agents. They take precedence over the package agents. | Yes, to share them |
| `.pi/skills/pr/SKILL.md` | The project `/pr` command that `/setup` writes | Yes |
| `.pi/dev-team.json` | Project configuration | Yes |
| `.pi/dev-team.local.json` | Your configuration for this project | No |
| `plans/<task>.md` | The plan that `/plan` writes | No, after `/setup` |
| `docs/specs/` | The spec files that `/specs` writes | Yes |
| `.dev-team-reports/` | Reports of review and analysis commands | No, except `test-improve/` |
| `.dev-team/examples.json` | Cases of the [example check](#the-example-check) | See [Keep state out of Git](#keep-state-out-of-git) |
| `AGENTS.md` | Project instructions that `/setup` writes. If the repository has a `CLAUDE.md` and no `AGENTS.md`, `/setup` adds to that file. | Yes |

Your own files are in `~/.pi/agent/`: `dev-team.json`, `dev-team/telemetry.json` and `dev-team/metrics/`.

### Keep state out of Git

Do not commit `.pi/dev-team/memory/`. It holds every request that you typed.

`/setup` adds these lines to `.gitignore`:

- State: `.pi/dev-team/memory/`, `.pi/dev-team/metrics/` and `.pi/dev-team/plans/`.
- Your configuration: `.pi/dev-team.local.json`.
- Reports: `/.dev-team-reports/*`, except `/.dev-team-reports/test-improve/`.
- Bare folders anywhere in the repository: `memory/`, `metrics/`, `plans/` and `reports/`. So `plans/<task>.md` stays out of Git.
- The review marker: `.pr-review-passed`.

Add `.pi/dev-team/` yourself to cover the rest, for example `worktrees/`. Do not ignore all of `.pi/`, because `.pi/dev-team.json` and `.pi/agents/` belong in Git.

The cases in `.dev-team/examples.json` quote the saved requests. Cases committed without their requests fail the check on a fresh clone. So do one of these:

- Keep `.dev-team/examples.json` out of Git too.
- Commit both. Remove the `.gitignore` that pi-dev-team writes in `.pi/dev-team/memory/requests/`, and un-ignore that folder.

### Move from older .claude folders

Older versions of pi-dev-team kept project state in `.claude/`. At session start, pi-dev-team moves that state to `.pi/dev-team/` and tells you what moved.

| What | From | To |
|---|---|---|
| Folders | `.claude/memory`, `metrics`, `plans`, `review-summaries`, `evals` | `.pi/dev-team/<same>` |
| State files | `.claude/init-state.json`, `project-stack.json`, `session-metrics.json`, `telemetry.json`, `code-intelligence-turn-state.json`, `model-overrides.json`, `session-model` | `.pi/dev-team/<same>` |
| Guard state | `.claude/hooks/freeze-state.json`, `.claude/hooks/careful-state.json` | `.pi/dev-team/hooks/<same>` |
| Your files (copied first, not moved) | `~/.claude/telemetry.json`. From `~/.claude/metrics/`: `telemetry.jsonl` and `artifact-usage.json`. | `~/.pi/agent/dev-team/telemetry.json` and `~/.pi/agent/dev-team/metrics/` |

pi-dev-team moves an entry only when all of these are true:

- The old path is a folder or a file, as the table expects, and not a symlink.
- The new path does not exist.
- Git tracks nothing under the old path, and the path is not in a nested repository or a submodule. If Git fails, pi-dev-team leaves the state and names the failure in the notice.

Only the top session moves state, not an agent. When pi runs in your home folder, pi-dev-team moves nothing, because `~/.claude/` is not project state.

After a run with no error and no note, pi-dev-team writes the marker `.pi/dev-team/.migrated-from-claude`. Later sessions skip that project. To run the move again, delete the marker. Your files copy one time: after a copy without errors, pi-dev-team writes `~/.pi/agent/dev-team/.migrated-from-claude`.

If an entry is on another filesystem, pi-dev-team skips it and names it in the notice. Move that entry yourself. An error does not stop the session or the other entries. pi shows the first error one time.

These stay where they are:

| What stays | Why |
|---|---|
| `.claude/agents/` | pi-dev-team no longer reads it. Move your project agents to `.pi/agents/` yourself. |
| `.claude/worktrees/` | Git links these by their absolute path. Remove them with `git worktree remove`. |
| `.claude/memory/.pr-review-passed`. In `.claude/metrics/`: `review-verdicts*`, `boundary-events.jsonl` and `gate-bypass-audit.jsonl`. | The review gate file and the ledgers. A moved copy can make a planted file into a trusted one. |
| `.claude/agent-memory`, `.claude/agent-memory-local`, `.claude/settings*.json`, `CLAUDE.md` | Claude Code uses them. |
| `.claude/skills`, `commands`, `rules`, `plugins` and `projects` | Claude Code uses them. |

The autocompact percent in the `env` of `.claude/settings.json` no longer applies. Run `/setup` again, or set `autocompactPct` in `.pi/dev-team.json`. An old `claudeShim` key still works as `cliShim`.

## Update

```bash
pi update git:github.com/sanjit-roopra/pi-dev-team
```

To install for one project only, run `pi install -l git:github.com/sanjit-roopra/pi-dev-team`. `/dev-team` shows the installed version.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `dev-team: python >= 3.10 not found — hook guards are disabled.` | pi found no Python 3.10 or later. | Install Python 3.10+, then restart pi. |
| `/dev-team doctor` shows `NO AUTH (/login)` | A tier names a model of a provider that you did not log in to. | Run `/login`, or set that tier to `inherit`. |
| `/dev-team doctor` shows `UNKNOWN MODEL` | A tier names a model that is not in the catalog of pi. | Run `/dev-team models` and pick a preset again. |
| `gh pr create` is blocked | No code review passed for this change. | Run `/code-review` first, or use `/pr`. |
| An agent result says `timed out after 3600s` | The agent ran longer than `subagentTimeoutSec`. | Make the task smaller, or raise `subagentTimeoutSec`. |

## More information

- [docs/architecture.md](docs/architecture.md): how the extension, the hooks and the agents work together.
- [docs/review-profiles.md](docs/review-profiles.md): the review profiles and the example check in detail, with all measured runs.
- [CONTRIBUTING.md](CONTRIBUTING.md): tests and changes to the package.
- [CHANGELOG.md](CHANGELOG.md): the changes in each version.

## License

MIT. See [LICENSE](LICENSE). pi-dev-team is not part of the pi project.
