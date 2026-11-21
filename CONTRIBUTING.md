# Contributing

To use the package without changing it, read [README.md](README.md). To learn how the package works inside, read [docs/architecture.md](docs/architecture.md).

## Before you open a pull request

1. Run `npm test` and `npm run e2e`. Before the first run, run `./test/link-deps.sh` one time.
2. Run the type check: `npx -y -p typescript@5.9.3 tsc -p .`
3. If you changed a file of the default flow, measure the change. See [Measure a change to the default flow](#measure-a-change-to-the-default-flow).

Result: the checks that CI runs pass on your branch. For the details, see [Run the tests](#run-the-tests).

## Run the tests

Do step 1 one time only. It links the pi packages that you installed globally, so the tests can import them.

1. Link the pi packages: `./test/link-deps.sh`
2. Run the unit tests and the Python tests: `npm test`
3. Run the end-to-end tests: `npm run e2e`
4. Run the type check: `npx -y -p typescript@5.9.3 tsc -p .`

Result: the same checks that CI runs. CI uses Node 24, Python 3.12 and pi 1.3.0.

The end-to-end tests run the real `pi` binary with an offline scripted model. They call no model provider and cost nothing. They test the commands, the guards and the agents. They also test the worktrees, the review-verdict ledgers and the cost meter. Last, they test the run helper and the installed package. To run only some scenarios, give part of the name: `node test/e2e/run.mjs subagent`.

### Run the Python tests in a container

`test/py/test_example_replay.py` opens ports on `127.0.0.1`. If a sandbox blocks localhost, use two steps:

1. Run the unit tests on the host: `node --test test/unit/*.test.ts`
2. Run the Python tests in a container with Python 3.10 or later and `git` (some tests run `git`):

   ```bash
   docker run --rm --user $(id -u):$(id -g) -e HOME=/tmp -v "$PWD":/w -w /w/test/py \
     --entrypoint python3 <image> -m unittest discover -p 'test_*.py'
   ```

## Find your way around

A prompt file is text that the model reads. Code is the TypeScript, Python and shell that pi and the skills run. For each part of the package and what uses it, see [Package parts](docs/architecture.md#package-parts).

### Prompt files

| Path | What the model reads |
|---|---|
| `agents/*.md` | One prompt for each agent that the team can dispatch |
| `skills/**/*.md` | The skills (most are `/commands`), and their reference files, examples and other text |
| `knowledge/*.md` | Reference text that agents and skills read by path |
| `templates/` | Files that skills copy into a project, for example the agent templates that `/setup` activates |
| `extensions/dev-team/gate/*.md`, `extensions/dev-team/lean/*.md` | The sections that the gate or lean review profile adds to `/plan`, `/build`, `/code-review` and `/ship`, and the `/specs` examples step |

Some prompt text is inside TypeScript:

- `QUALITY_BAR`, `EXAMPLE_BAR` and the profile notes in `extensions/dev-team/lib/review-profile.ts`.
- `GITHUB_STYLE_GUIDE` in `extensions/dev-team/lib/github-style.ts`.
- The shared guide that `extensions/dev-team/index.ts` puts in the system prompt of every session.

`knowledge/index.json` is generated. Do not edit it by hand. See [Rebuild the knowledge index](#rebuild-the-knowledge-index).

### Folders only in the repository

The npm package does not ship these folders (see `"files"` in `package.json`):

- `test/`: unit tests (`test/unit/`), Python tests (`test/py/`), end-to-end tests (`test/e2e/`) and their fixtures.
- `devtools/`: maintainer scripts. The release uses `devtools/changelog.py`.
- `.agents/skills/`: maintainer skills. pi loads them when you run pi in this repository and trust the project.
- `plans/`: design plans.
- `.github/`: the CI and Publish workflows.

## Change a prompt file

Change only what you measured. The model reads every word of a prompt file, and a wording change can move benchmark results. A name that code also uses is not wording, for example a path, an environment variable or a marker. If you change such a name, change the prompt and the code in one commit, then run the tests. See [Keep the cross-language contracts](#keep-the-cross-language-contracts).

### Measure a change to the default flow

If you change a file in the table below, measure the change:

1. Run the SlopCodeBench checkpoints on the current text. The maintainer chose the current default on 52 of them (10 problems, one run each).
2. Make the change.
3. Run the same checkpoints with the same model on the new text.
4. Compare the hidden-test pass rate, the code shape (structural erosion and the highest cyclomatic complexity) and the cost.
5. Put both sets of numbers in the pull request.

Result: a change with a measured effect. A SlopCodeBench checkpoint is one spec version of a problem, not a `/build` checkpoint (see [Benchmark terms](docs/review-profiles.md#benchmark-terms)). For the numbers behind the current default, see [Measured results](docs/review-profiles.md#measured-results).

The default flow runs when `DEV_TEAM_REVIEW` is unset or `gate`, and `DEV_TEAM_EXAMPLES` is not an off value. It is the gate review profile plus the example check (see [docs/review-profiles.md](docs/review-profiles.md)). These files are the default flow:

| Group | Files |
|---|---|
| Profile text | `extensions/dev-team/gate/*.md` |
| Prompt text in TypeScript | In `extensions/dev-team/lib/review-profile.ts`: `QUALITY_BAR`, `EXAMPLE_BAR`, `LIZARD_COMMAND`, the gate text of `reviewProfileGuideLine` and of `reviewProfileAgentNote` (`GATE_NOTE_HEADING`, `GATE_ENGINEER_EXTRA`, `TEST_BUDGET`). Also `LEAN_PRELOADED_SKILLS` and `BACKSTOP_SKIP_FLAG` (the `--backstop-review=skip` argument added to `/build`). The dev-team guide in `extensions/dev-team/index.ts`. |
| Example check text | The `dev_team_approve_examples` tool text and replies in `extensions/dev-team/lib/approve-examples.ts`. `REQUEST_DIR_BLOCK` in `extensions/dev-team/lib/request-guard.ts`. `FORMAT` in `scripts/example_replay.py`, which `--format` prints. |
| Agents | `agents/software-engineer.md`, `agents/spec-compliance-review.md`, `agents/correctness-review.md`, `agents/refactor-opportunity-review.md`, `agents/security-review.md` |
| Skills | `skills/specs/`, `skills/plan/`, `skills/build/`, `skills/code-review/`, `skills/ship/`. Also `skills/quality-gate-pipeline/` and `skills/systematic-debugging/`, which gate inlines into `software-engineer`. |

Between benchmark runs, the session report gives a cheaper comparison of cost and skill steps. See [Debug a recorded session](#debug-a-recorded-session).

### Rebuild the knowledge index

Rebuild the index after you change a file that it lists. The index (`knowledge/index.json`) holds each section of the knowledge files and skills, with a one-line summary and its anchor.

1. Edit `knowledge/*.md`, `skills/*/SKILL.md` or a reference file that a `SKILL.md` includes.
2. Run `npm run index`.
3. Commit `knowledge/index.json` with your edit.

A reference file is in the index only when a `SKILL.md` pulls it in with `<!-- include: references/<name>.md -->`. Today only `skills/test-improve` does that.

If you forget step 2, a Python test fails. The test runs `python3 hooks/lib/build_knowledge_index.py --check`, which compares a fresh build with the file on disk.

### Keep the pi notes and farley markers

Do not remove or rename these markers or the `## pi notes` heading. Code finds prompt text by them.

Thirteen skills have a `## pi notes` section between two `<!-- pi-notes -->` markers. A pi notes section holds the rules that this package adds to the skill's steps. The review profile section goes after the last marker (see [Gate profile](docs/review-profiles.md#gate-profile-default)).

If you must rename the marker or the heading, change these in one commit:

- All 13 skills.
- `PI_NOTES_MARKER` in `extensions/dev-team/lib/review-profile.ts`.
- `NOTES_MARKER` in `test/py/test_package_layout.py`.
- `extensions/dev-team/gate/build.md` and `extensions/dev-team/lean/build.md`, which point to "the pi notes above".

Both `build.md` files also hold a `<!-- farley:on -->` block and a `<!-- farley:off -->` block. Each block ends with `<!-- /farley:on -->` or `<!-- /farley:off -->`. `FARLEY_BLOCK` in `review-profile.ts` keeps one block and drops the other, by `DEV_TEAM_FARLEY`. If an edit breaks a farley marker, the regular expression does not match that block. Then the prompt keeps it in both states, so it can get both blocks.

## Change code

### TypeScript extension

1. Edit `extensions/dev-team/index.ts` or a module in `extensions/dev-team/lib/`.
2. Add or change a test in `test/unit/<module>.test.ts`.
3. Run `node --test test/unit/<module>.test.ts`.
4. Run the type check (see [Run the tests](#run-the-tests)).

### Python hooks and scripts

1. Add or change a test in `test/py/`.
2. Run `python3 -m unittest discover -s test/py -p 'test_*.py'`.

A hook is a Python script that runs around a pi event or a tool call. `hooks/hooks.json` names only the script and the matcher of each hook. `extensions/dev-team/lib/hooks.ts` runs the last `hooks/<name>.py` of each command with its own Python 3.10 or later, without arguments. So `py.sh`, arguments and environment in the command have no effect.

A matcher is a regular expression that must match the whole hook-protocol tool name, for example `Bash`, `Write`, `Edit` or `Agent`. It does not match the pi tool name.

Do not change the event names, the tool names in the `matcher` fields or the payload field names. Every hook reads them. For the payload, the exit codes and the tool-name mapping, see [Hook bridge](docs/architecture.md#hook-bridge).

### Keep the cross-language contracts

A cross-language contract is a name that TypeScript and Python both use. If you change one side, change the other side in the same commit.

| Contract | Value | TypeScript | Python |
|---|---|---|---|
| State folder | `.pi/dev-team` | `STATE_DIR` in `lib/state-dir.ts` | `STATE_DIR` in `hooks/lib/artifact_paths.py` |
| Request folder | `.pi/dev-team/memory/requests/` | `REQUEST_DIR` in `lib/skills.ts`, and the write guard in `lib/request-guard.ts` | `REQUESTS_DEFAULT` in `scripts/example_replay.py` |
| Autocompact sources | See [Autocompact](docs/architecture.md#autocompact) | `lib/autocompact.ts`, `lib/config.ts` | `hooks/lib/autocompact_config.py`, `scripts/set_autocompact_env.py` |
| Telemetry consent | `<agentDir>/dev-team/telemetry.json` with `{"enabled": true}` | `lib/metrics.ts` | `hooks/lib/telemetry_consent.py` |
| Version | `"version"` in `package.json` | The `/dev-team` status line `pi-dev-team <version>` in `index.ts`. The `port` field of agent usage entries (`usageEntryOf` in `lib/subagent.ts`, read by `devtools/pi_session_report.py`). | `hooks/lib/plugin_version.py` and the callers of its `shipped_version()`, `hooks/telemetry.py`, `hooks/pre_pr_review.py`. `hooks/lib/review_verdicts.py` skips verdict rows from older versions. |
| Run helper | `bin/dev-team-run` | `index.ts` puts `bin/` on `PATH` when `cliShim` is `true` | Every caller that runs `dev-team-run` |

The TypeScript paths are relative to `extensions/dev-team/`. `<agentDir>` is `PI_CODING_AGENT_DIR`, or `~/.pi/agent` when that variable is not set. The extension also exports environment variables that Python reads. See [Environment that the extension sets](docs/architecture.md#environment-that-the-extension-sets).

Details for four of the contracts:

- State folder: always join `.pi` and `dev-team`, never `.pi` alone. `.pi/agents`, `.pi/skills` and `.pi/dev-team.json` are configuration, not state. See [State on disk](docs/architecture.md#state-on-disk).
- Request folder: `extensions/dev-team/gate/specs-examples.md`, `test/py/test_example_replay.py` and `test/unit/request-guard.test.ts` also name the folder.
- Autocompact: both sides read the same sources in the same order, with the same labels (`process env` first). When no source sets `autocompactPct`, percent autocompact is off. `/setup` proposes 40 (`DEFAULT_PCT`).
- Autocompact trust: the TypeScript side reads the two project files only when pi trusts the project. Python `detect()` reads them in every project. So in a project that pi does not trust, `autocompact_setup_nudge.py` and `/setup` can report a value that the extension does not apply.
- Run helper: the mutation scripts read `DEV_TEAM_RUN_BIN` (default `dev-team-run`). `mutation_kill_retry.py` looks up `mutation_kill_shared.run_headless` and `resolve_fallback_model` by name at call time. `mutation_kill_headless.py` and `mutation_kill_loop_python.py` import `headless_cli_available` and `DEV_TEAM_RUN_BIN` from `mutation_kill_shared.py`, and each defines its own `MISSING_CLI_MESSAGE`. `agents/mutation-kill.md` names `run_headless`, `resolve_fallback_model`, `headless_cli_available` and `DEV_TEAM_RUN_BIN`.

## Debug a recorded session

Run `devtools/pi_session_report.py` from the repository root. It reads the session logs that pi writes and reports what pi-dev-team did:

```bash
python3 devtools/pi_session_report.py projects
python3 devtools/pi_session_report.py timeline latest -p <project>
python3 devtools/pi_session_report.py steps -p <project> -s build --outputs build_jobs.py
python3 devtools/pi_session_report.py code -p <project> --since 2026-10-01
```

| Subcommand | What it reports |
|---|---|
| `projects`, `sessions` | Which projects used pi-dev-team, and one row per session with cost, failed dispatches and hook blocks |
| `timeline` | The events of one session, in order |
| `skills`, `tools` | Which skills and tool outputs filled the context, and for how long |
| `steps` | Which steps of a skill ran: scripts, reference files, agents |
| `code` | Output tokens, and the code, docs and test lines that each session committed |

The script only reads. It reads the logs, plus `git log` for `code`. It looks for logs in `--sessions-dir`, then `$PI_CODING_AGENT_DIR/sessions`, then `~/.pi/agent/sessions`. Every subcommand takes `--json`.

The `debug-pi-session` skill in `.agents/skills/` tells an agent how to use the script and how to read the numbers. The report quotes untrusted session text. It masks common secret shapes, but read it before you paste it into a pull request.

## Release a new version

### Set up trusted publishing (one time)

1. On npmjs.com, open the "Settings" of the package page.
2. Add a trusted publisher for GitHub Actions: repository `sanjit-roopra/pi-dev-team`, workflow `publish.yml`.
3. Leave "Allow npm publish" unchecked.

Result: the workflow can only stage a version.

### Prepare and publish

Prepare the version:

1. Bump the version: `npm version patch` (or `minor`, `major`). This changes `package.json`, adds a `CHANGELOG.md` section, makes a commit and makes a tag.
2. Read the new section in `CHANGELOG.md`.
3. If you edit the text, run `git add CHANGELOG.md && git commit --amend --no-edit`.
4. If you amended, move the tag: `git tag -fa v<version> -m <version>`.

Publish it:

1. Push the commit and the tag: `git push --follow-tags`
2. Wait until the Publish workflow passes on GitHub. Its `release` job makes the GitHub Release from the `CHANGELOG.md` section.
3. Approve the staged version on npmjs.com. Or run `npm stage list pi-dev-team`, then `npm stage approve <stage-id>`.

Result: the version is live on npm, with a GitHub Release.

The `version` script in `package.json` runs `devtools/changelog.py`. It lists the commits on the main line since the last tag, and a merged pull request shows as its title with a link. Two warnings:

- Do not run `devtools/changelog.py` again after a hand edit. It writes the section again and drops your edit.
- Do not run `python3 devtools/changelog.py --rebuild` unless you want to lose hand edits. It writes the whole `CHANGELOG.md` again from the release tags (`v<version>`).

`.github/workflows/publish.yml` stages the package on npm when you push a `v*` tag. It uses npm trusted publishing, so the repository has no npm token. A staged version is not live until a maintainer approves it with two-factor authentication (2FA), so a stolen GitHub login alone cannot publish.

The `test` job of Publish runs only `npm test`, against the latest pi, not pi 1.3.0. It runs no end-to-end tests and no type check. So a commit that passes CI can still fail at publish.

### Fix a failed release

| Symptom | Cause | Fix |
|---|---|---|
| No Publish run starts after the push | A lightweight tag (from `git tag -f` without `-a`). `git push --follow-tags` pushes only annotated tags. | Run `git tag -fa v<version> -m <version>`, or push the tag by name: `git push origin main v<version>` |
| `Tag <tag> does not match package.json v<version>` | The tag is not the version in `package.json` | On the commit that `npm version` made, run `git tag -fa v<version> -m <version>`. Then run `git push -f origin v<version>`. |
| The step "Check CHANGELOG.md has a section for this version" or `npm test` fails | `CHANGELOG.md` has no section for the version, or a test fails against the latest pi | Push a commit with the fix. Run `git tag -fa v<version> -m <version>`, then `git push -f origin v<version>`. |
| You decide not to approve the staged version | The `release` job made the GitHub Release at staging, before approval | Delete the release: `gh release delete v<version> --cleanup-tag` |
| A job failed after staging | `publish` staged the version, and staging the same version two times fails | Use "Re-run failed jobs" on GitHub, for the `release` job only. A release that already exists is kept. |

## Write docs, pull requests and issues

For `README.md`, `CONTRIBUTING.md` and `docs/*.md`, follow [docs/writing-style.md](docs/writing-style.md).

For pull request and issue text, follow the rules that the extension gives the model (`GITHUB_STYLE_GUIDE` in `extensions/dev-team/lib/github-style.ts`):

- Title: 69 characters or fewer, in the imperative ("Add rate limit to /login"). The title of a merged pull request becomes its line in `CHANGELOG.md`.
- First line of the body: one sentence that says what changes and why.
- Body: 250 words or fewer (comment: 150). Code, URLs, HTML comments, tables, headings and `<details>` blocks do not count.
- Sentences: 25 words or fewer. Lists: 5 items or fewer. Put long evidence in one `<details>` block at the end.
- No em-dashes, bold, emoji or filler words. Use `can`, `will` and `must`, not `should`, `may` or `might`.

The extension tests that text before a `gh pr` or `gh issue` command (`create`, `edit` or `comment`) sends it. With `githubStyle` set to `"block"` (the default), it blocks a command that breaks a rule one time. The same command a second time runs. It does not check text that the shell builds at run time (`--body "$BODY"`). For the `warn` and `off` modes, see [Pull request and issue text](README.md#pull-request-and-issue-text). For how the check works, see [GitHub text style check](docs/architecture.md#github-text-style-check).
