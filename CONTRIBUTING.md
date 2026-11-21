# Contributing

To use the package without changing it, read [README.md](README.md).

This repository is the only source of the package. Edit each file where it is. No step copies files into the tree from another place.

## Find your way around

The repository holds two kinds of files. A prompt file is text that the model reads. Code is the TypeScript and Python that pi and the skills run.

### Prompt files

| Path | What the model reads |
|---|---|
| `agents/*.md` | One prompt for each agent that the team can dispatch |
| `skills/*/SKILL.md`, `skills/*/references/*.md` | The `/command` skills, and the reference files that a skill reads when it needs them |
| `knowledge/*.md` | Reference text that agents and skills read by path |
| `templates/` | Files that skills copy into a project, for example the agent templates that `/setup` activates |
| `extensions/dev-team/gate/*.md`, `extensions/dev-team/lean/*.md` | The sections that the gate or lean review profile adds to `/plan`, `/build`, `/code-review` and `/ship`, and the `/specs` examples step |

Some prompt text is inside TypeScript:

- `QUALITY_BAR`, `EXAMPLE_BAR` and the profile notes in `extensions/dev-team/lib/review-profile.ts`.
- `GITHUB_STYLE_GUIDE` in `extensions/dev-team/lib/github-style.ts`.
- The shared guide that `extensions/dev-team/index.ts` puts in the system prompt of every session.

`knowledge/index.json` is generated. Do not edit it by hand. See [Rebuild the knowledge index](#rebuild-the-knowledge-index).

### Code

| Path | What it is |
|---|---|
| `extensions/dev-team/` | The pi extension: `index.ts` and its modules in `lib/` |
| `extensions/spend/`, `extensions/shared/` | The `/spend` extension, which also runs without the dev-team extension, and code that both extensions use |
| `hooks/` | Python hooks, wired by `hooks/hooks.json`, and the guard configuration in `hooks/guards.json` |
| `scripts/`, `skills/*/scripts/`, `tools/` | Python scripts that skills and agents run |
| `bin/dev-team-run` | The run helper (a command that Python scripts call to start a pi run) |

These folders are not in the npm package:

- `test/`: unit tests (`test/unit/`), Python tests (`test/py/`), end-to-end tests (`test/e2e/`) and their fixtures.
- `devtools/`: maintainer scripts. The release uses `devtools/changelog.py`.
- `.agents/skills/`: maintainer skills. pi loads them when you run pi in this repository and trust the project.

## Change a prompt file

Rule: change only what you measured. The model reads every word of a prompt file, and a wording change can move benchmark results.

A name that code also uses is not wording. Examples are a path, an environment variable and a marker. If you change such a name, change the prompt and the code together, then run the tests. See [Keep the cross-language contracts](#keep-the-cross-language-contracts).

### Measure a change to the default flow

The default flow is what runs when the user sets neither `DEV_TEAM_REVIEW` nor `DEV_TEAM_EXAMPLES`. It is the gate review profile plus the example check. The example check (`scripts/example_replay.py`) runs each input-to-output example of the request against the program.

These files are the default flow:

| Group | Files |
|---|---|
| Profile text | `extensions/dev-team/gate/*.md` |
| Prompt text in TypeScript | In `extensions/dev-team/lib/review-profile.ts`: `QUALITY_BAR`, `EXAMPLE_BAR`, `LIZARD_COMMAND`, the gate text of `reviewProfileGuideLine` and of `reviewProfileAgentNote` (`GATE_NOTE_HEADING`, `GATE_ENGINEER_EXTRA`, `TEST_BUDGET`). The dev-team guide in `extensions/dev-team/index.ts`. |
| Agents | `agents/software-engineer.md`, `agents/spec-compliance-review.md`, `agents/correctness-review.md`, `agents/refactor-opportunity-review.md`, `agents/security-review.md` |
| Skills | `skills/specs/`, `skills/plan/`, `skills/build/`, `skills/code-review/`, `skills/ship/` |

A SlopCodeBench checkpoint is one spec version of a problem. It is not a `/build` checkpoint.

To change one of these files:

1. Run the SlopCodeBench checkpoints on the current text. The maintainer chose the current default on 52 SlopCodeBench checkpoints (10 problems, one run each).
2. Make the change.
3. Run the same checkpoints with the same model on the new text.
4. Compare the hidden-test pass rate, the code shape (structural erosion and the highest cyclomatic complexity) and the cost.
5. Put both sets of numbers in the pull request.

Result: a change with a measured effect. The current default stays the default because later variants scored the same or worse at a higher cost.

Between benchmark runs, the session report gives a cheaper comparison of cost and skill steps. See [Debug a recorded session](#debug-a-recorded-session).

### Rebuild the knowledge index

The knowledge index (`knowledge/index.json`) lists each section of the knowledge files and skills, with a one-line summary and its anchor. `agents/orchestrator.md` tells agents to find a cited section in the index, then read only that section.

1. Edit `knowledge/*.md`, `skills/*/SKILL.md` or `skills/*/references/*.md`.
2. Run `npm run index`.
3. Commit `knowledge/index.json` with your edit.

If you forget step 2, a Python test fails. The test runs `python3 hooks/lib/build_knowledge_index.py --check`, which compares a fresh build with the file on disk.

### Keep the pi notes markers

Thirteen skills have a `## pi notes` section between two `<!-- pi-notes -->` markers. The code in `extensions/dev-team/lib/review-profile.ts` (`PI_NOTES_MARKER`) puts the review profile note after the last marker. `extensions/dev-team/gate/build.md` and `extensions/dev-team/lean/build.md` point to "the pi notes above".

Do not remove or rename a marker or the heading. If you must rename one, change all 13 skills, the TypeScript constant and both `build.md` files in one commit.

## Change code

### TypeScript extension

1. Edit `extensions/dev-team/index.ts` or a module in `extensions/dev-team/lib/`.
2. Add or change a test in `test/unit/<module>.test.ts`.
3. Run `node --test test/unit/<module>.test.ts`.
4. Run the type check (see [Run the tests](#run-the-tests)).

### Python hooks and scripts

A hook is a Python script that runs around a pi event or a tool call. `extensions/dev-team/lib/hooks.ts` runs each hook in `hooks/hooks.json` with Python 3.10 or later.

The hook protocol:

- Input: one JSON object on stdin with `hook_event_name`, `session_id`, `cwd`, `transcript_path`, `tool_name`, `tool_input`, `tool_response` and `prompt`.
- Exit 2: the extension blocks the call. The reason is stdout plus stderr.
- Exit 0 with JSON on stdout: the extension reads `hookSpecificOutput`, `decision`, `permissionDecision` and `systemMessage`.
- Any other exit, or a timeout: the extension does not block the call, and it shows the user a warning. The default timeout is 60 seconds (`hooks.timeoutSec`).

Do not change the event names, the tool names in the `matcher` fields or the field names. Every hook reads them.

To test a change, add a test in `test/py/`. Then run `python3 -m unittest discover -s test/py -p 'test_*.py'`.

### Keep the cross-language contracts

A cross-language contract is a name that TypeScript and Python both use. If you change one side, change the other side in the same commit.

| Contract | Value | TypeScript | Python |
|---|---|---|---|
| State folder | `.pi/dev-team` | `STATE_DIR` in `lib/state-dir.ts` | `STATE_DIR` in `hooks/lib/artifact_paths.py` |
| Request folder | `.pi/dev-team/memory/requests/` | `REQUEST_DIR` in `lib/skills.ts`, and the write guard in `lib/request-guard.ts` | `REQUESTS_DEFAULT` in `scripts/example_replay.py` |
| Autocompact sources | see the list below | `lib/autocompact.ts`, `lib/config.ts` | `hooks/lib/autocompact_config.py`, `scripts/set_autocompact_env.py` |
| Telemetry consent | `<agentDir>/dev-team/telemetry.json` with `{"enabled": true}` | `lib/metrics.ts` | `hooks/lib/telemetry_consent.py` |
| Version | `"version"` in `package.json` | the `/dev-team` status line `pi-dev-team <version>` in `index.ts` | `hooks/lib/plugin_version.py`, `hooks/telemetry.py`, `hooks/pre_pr_review.py` |
| Run helper | `bin/dev-team-run` | `index.ts` puts `bin/` on `PATH` when `cliShim` is `true` | every caller that runs `dev-team-run` |

The TypeScript paths are relative to `extensions/dev-team/`. `<agentDir>` is `PI_CODING_AGENT_DIR`, or `~/.pi/agent` when that variable is not set.

Details for four of the contracts:

- State folder: always join `.pi` and `dev-team`, never `.pi` alone. `.pi/agents`, `.pi/skills` and `.pi/dev-team.json` are not state.
- Request folder: `extensions/dev-team/gate/specs-examples.md`, `test/py/test_example_replay.py` and `test/unit/request-guard.test.ts` also name the folder.
- Autocompact: `DEV_TEAM_AUTOCOMPACT_PCT` comes first. Then the readers look for the key `autocompactPct` in `.pi/dev-team.local.json`, `.pi/dev-team.json` and `<agentDir>/dev-team.json`, in that order. Both sides label these sources "dev-team.local.json", "dev-team.json" and "user dev-team.json". `scripts/set_autocompact_env.py` writes `autocompactPct` into `.pi/dev-team.json`. The default is 40.
- Autocompact trust: the two sides differ in one case. The TypeScript side reads the two project files only when pi trusts the project. Python `detect()` in `hooks/lib/autocompact_config.py` reads them even when pi does not trust the project. So in a project that pi does not trust, `autocompact_setup_nudge.py` and `/setup` can report a value that the extension does not apply.
- Run helper: the mutation scripts read `DEV_TEAM_RUN_BIN` (default `dev-team-run`). `mutation_kill_retry.py` looks up `mutation_kill_shared.run_headless` and `resolve_fallback_model` by name at call time. `mutation_kill_headless.py` and `mutation_kill_loop_python.py` import `headless_cli_available` and `DEV_TEAM_RUN_BIN` from `mutation_kill_shared.py`, and each defines its own `MISSING_CLI_MESSAGE`. `agents/mutation-kill.md` names `run_headless`, `resolve_fallback_model`, `headless_cli_available` and `DEV_TEAM_RUN_BIN`.

The extension also exports `DEV_TEAM_ROOT` (the package folder), `DEV_TEAM_PROJECT_DIR` and `DEV_TEAM_SESSION_ID` to the hooks and the bash calls. Python code reads these names.

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

The `debug-pi-session` skill in `.agents/skills/` tells an agent how to use the script and how to read the numbers. The report quotes session content as it is. Read the report text before you paste it into a pull request.

## Release a new version

### Set up trusted publishing (one time)

1. On npmjs.com, open the "Settings" of the package page.
2. Add a trusted publisher for GitHub Actions: repository `sanjit-roopra/pi-dev-team`, workflow `publish.yml`.
3. Leave "Allow npm publish" unchecked.

Result: the workflow can only stage a version.

### Release

Prepare the version:

1. Bump the version: `npm version patch` (or `minor`, `major`). This changes `package.json`, adds a new section to `CHANGELOG.md`, makes a commit and makes a tag.
2. Read the new section in `CHANGELOG.md`.
3. If you edit the text, run `git commit --amend`.
4. If you amended, move the tag: `git tag -f v<version>`.

Publish it:

1. Push the commit and the tag: `git push --follow-tags`
2. Wait until the Publish workflow passes on GitHub. Its `release` job makes the GitHub Release from the `CHANGELOG.md` section of that version.
3. Approve the staged version on npmjs.com. Or run `npm stage list pi-dev-team`, then `npm stage approve <stage-id>`.

Result: the version is live on npm, with a GitHub Release.

About the changelog section:

- It lists the commits on the main line since the last tag. A merged pull request shows as its title with a link.
- `devtools/changelog.py` writes it. The `version` script in `package.json` runs that script.
- Do not run the script again after a hand edit. It writes the section again and drops your edit.
- `python3 devtools/changelog.py --rebuild` writes the whole `CHANGELOG.md` again from the release tags (`v<version>`). It drops every hand edit.

About the Publish workflow:

- A GitHub Actions workflow (`.github/workflows/publish.yml`) stages the package on npm when you push a `v*` tag. It uses npm trusted publishing, so the repository has no npm token.
- A staged version is not live until a maintainer approves it with two-factor authentication (2FA). So a stolen GitHub login or a bad workflow change cannot put a version live without that approval.
- The workflow stops before anything is staged if the tag is not the same as the version in `package.json`. It also stops if `CHANGELOG.md` has no section for the version, or if `npm test` fails.
- The GitHub Release appears when the version is staged, before you approve it on npm. If you decide not to approve, delete the release too: `gh release delete v<version> --cleanup-tag`.
- To run the workflow again after a failure, use "Re-run failed jobs" on GitHub. A release that already exists is kept. If `publish` already staged the version, re-run only the `release` job. Staging the same version two times fails.

## Write docs, pull requests and issues

For `README.md`, `CONTRIBUTING.md` and `docs/*.md`, follow [docs/writing-style.md](docs/writing-style.md).

For pull request and issue text, follow the rules that the extension gives the model:

- Title: 69 characters or fewer, in the imperative ("Add rate limit to /login"). The title of a merged pull request becomes its line in `CHANGELOG.md`.
- First line of the body: one sentence that says what changes and why.
- Body: 250 words or fewer (comment: 150). Code, URLs, HTML comments, tables, headings and `<details>` blocks do not count.
- Sentences: 25 words or fewer. Lists: 5 items or fewer. Put long evidence in one `<details>` block at the end.
- No em-dashes, bold, emoji or filler words. Use `can`, `will` and `must`, not `should`, `may` or `might`.

Before a `gh pr` or `gh issue` command (`create`, `edit` or `comment`) sends text, the extension tests it. It counts the title length, the words, the sentence length and the list length. It also looks for em-dashes, bold, `should`, `may`, `might` and the filler words.

The `githubStyle` key in the dev-team configuration controls the check:

- `"block"` (the default): the extension blocks a command that breaks a rule one time and tells the agent what to fix. The same command a second time runs.
- `"warn"`: the extension only warns.
- `"off"`: the model gets no rules, and the extension does not check.

The extension does not check text that the shell builds at run time (`--body "$BODY"`). The full rules are `GITHUB_STYLE_GUIDE` in `extensions/dev-team/lib/github-style.ts`.
