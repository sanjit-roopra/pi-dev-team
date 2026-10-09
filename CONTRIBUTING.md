# Contributing

This file is for people who change the package. To use the package, read [README.md](README.md).

## How the package is built

The package is a compatibility runtime, not a rewrite. A compatibility runtime gives the upstream files the environment that they expect, so the files can stay the same.

- `sync/sync_upstream.py` copies the agents, skills, hooks, scripts, and knowledge from upstream.
- The Python code and the knowledge files stay byte-identical to upstream.
- The sync then copies pi-specific files from `overrides/` over the upstream files. For a slim skill (see below), `overrides/` also holds the upstream text of that skill, unchanged, split into reference files.
- Last, it applies a short list of text patches. The lists are `PATCHES` and `LEAN_PATCHES` (lean production code) in `sync/sync_upstream.py`.
- The TypeScript extension in `extensions/dev-team/` gives that content the Claude Code functions that it expects.

[PORTING.md](PORTING.md) has the full analysis: the concept mapping, what is not ported and why, and the known differences.

## Update to a new upstream release

1. Get the upstream repository next to this one:

   ```bash
   git clone https://github.com/bdfinst/agentic-dev-team ../agentic-dev-team
   ```

   If you already have it, run `git pull` in `../agentic-dev-team`.
2. Run the sync:

   ```bash
   python3 sync/sync_upstream.py --upstream ../agentic-dev-team
   ```

3. Run all tests (see below).

If a patch no longer matches the upstream text, the sync stops with an error. Update that entry in `PATCHES` or `LEAN_PATCHES`, whichever holds it, then run the sync again.

If upstream changed a file that this package overrides, the sync also stops and names the file. For an agent or hook override (`overrides/agents/`, `overrides/hooks/`):

1. Read the upstream change: `git -C ../agentic-dev-team diff <commit in UPSTREAM.json> HEAD -- plugins/dev-team/<file>`.
2. Carry it into the override.
3. Put the new upstream sha256 (`shasum -a 256 ../agentic-dev-team/plugins/dev-team/<file>`) in `OVERRIDE_BASES`, then run the sync and the tests.

A new override of an upstream agent needs an `OVERRIDE_BASES` entry too; `test_every_upstream_agent_override_is_pinned_and_shipped` fails without it. Prefer a `PATCHES` or `LEAN_PATCHES` entry when the change is a few anchored lines: upstream changes elsewhere in the file then still flow through.

For `skills/code-review/SKILL.md`, the slim core:

1. Regenerate the reference files from the new upstream text: `python3 sync/split_skill_references.py code-review --upstream ../agentic-dev-team`. If upstream renamed a heading the split starts at, the script stops before it writes anything; update `SPLITS` in that script. On success it prints the `OVERRIDE_BASES` line with the new sha256.
2. Read the upstream diff of that file and carry every change in a command, a rule or a pinned phrase into `overrides/skills/code-review/SKILL.md`. Copy the upstream frontmatter into the core unchanged: the references do not store it, so the byte-for-byte check rebuilds upstream from the core's frontmatter. Recheck the core's named exceptions to upstream text (today: step 9 under `--json`, and the lean fix rule) and drop any that upstream fixed; `test_json_step_9_exception_still_matches_upstream` fails when that text changes.
3. Put the printed sha256 in `OVERRIDE_BASES` in `sync/sync_upstream.py`.
4. Run the sync again, then the tests. `test/py/test_slim_skills.py` fails when a reference is missing or changed, when a core command differs from upstream's, when the core drops a command, a reference or a read trigger, or when it loses a phrase that upstream's content tests pin.

## Run the tests

Do step 1 one time only. It links the pi packages that you installed globally, so the unit tests can import them.

1. Link the pi packages: `./test/link-deps.sh`
2. Run the unit tests and the Python tests: `npm test`
3. Run the end-to-end tests: `npm run e2e`

The end-to-end tests run the real `pi` binary with an offline scripted model. They do not call a model provider and cost nothing. They test the commands, the guards, the subagents, the worktrees, the ledgers, the cost meter, the `claude` shim, and the installed package.

### Run the upstream Python tests

You can also run the upstream Python test suite against the files of this package. This needs [uv](https://docs.astral.sh/uv/).

1. Copy the package directories into `plugins/dev-team` of an `agentic-dev-team` checkout.
2. In that checkout, run:

   ```bash
   uv run --no-project --with pytest --with pytest-asyncio --with hypothesis --with pytest-xdist \
     --with jsonschema --with pyyaml python -m pytest -n 8 plugins/dev-team/tests/{hooks,scripts,lib}
   ```

## Debug a recorded session

`devtools/pi_session_report.py` reads the session logs that pi writes and reports what dev-team did in them: each session's cost, failed dispatches and blocks, the timeline of one session, which skills filled the context and for how long, which steps of a skill actually ran, and how many output tokens and committed lines (test and production) each session produced. It only reads the logs, plus `git log` for the committed lines. It looks in `--sessions-dir`, else `$PI_CODING_AGENT_DIR/sessions`, else `~/.pi/agent/sessions`.

```bash
python3 devtools/pi_session_report.py projects
python3 devtools/pi_session_report.py timeline latest -p <project>
python3 devtools/pi_session_report.py steps -p <project> -s build --outputs build_jobs.py
python3 devtools/pi_session_report.py code -p <project> --since 2026-10-01
```

The `debug-pi-session` skill (`.agents/skills/`, linked into `.claude/skills/` for Claude Code) tells an agent how to use it and how to read the numbers. The script lives in `devtools/` because the sync replaces `scripts/` (which also has an unrelated upstream `session_report.py`), and it is not part of the npm package.

## Release a new version

A GitHub Actions workflow (`.github/workflows/publish.yml`) stages the package on npm when you push a `v*` tag. The workflow uses npm trusted publishing, so the repository has no npm token. A staged version is not live until a maintainer approves it with 2FA. So a stolen GitHub login or a bad workflow change cannot put a version live by itself.

1. Bump the version. This changes `package.json`, makes a commit and makes a tag: `npm version patch` (or `minor`, `major`).
2. Push the commit and the tag: `git push --follow-tags`
3. Wait for the Publish workflow to pass on GitHub.
4. Approve the staged version. On npmjs.com, open the package and approve the staged version. Or run `npm stage list pi-dev-team`, then `npm stage approve <stage-id>`.

The workflow stops if the tag is not the same as the version in `package.json`. It also stops if `npm test` fails.

To set up trusted publishing one time, go to the package settings on npmjs.com. Add a trusted publisher for GitHub Actions with the repository `sanjit-roopra/pi-dev-team` and the workflow `publish.yml`. Leave "Allow npm publish" unchecked, so the workflow can only stage.
