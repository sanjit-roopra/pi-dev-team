# Contributing

This file is for people who change the package. To use the package, read [README.md](README.md).

## How the package is built

The package is a compatibility runtime, not a rewrite. A compatibility runtime gives the upstream files the environment that they expect, so the files can stay the same.

- `sync/sync_upstream.py` copies the agents, skills, hooks, scripts, and knowledge from upstream.
- The Python code and the knowledge files stay byte-identical to upstream.
- The sync then copies pi-specific files from `overrides/` over the upstream files.
- Last, it applies a short list of text patches. The list is `PATCHES` in `sync/sync_upstream.py`.
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

If a patch no longer matches the upstream text, the sync stops with an error. Update that entry in `PATCHES`, then run the sync again.

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

## Release a new version

A GitHub Actions workflow (`.github/workflows/publish.yml`) publishes the package to npm when you push a `v*` tag. The workflow uses npm trusted publishing, so the repository has no npm token.

1. Bump the version. This changes `package.json`, makes a commit and makes a tag: `npm version patch` (or `minor`, `major`).
2. Push the commit and the tag: `git push --follow-tags`

The workflow stops if the tag is not the same as the version in `package.json`. It also stops if `npm test` fails.

To set up trusted publishing one time, go to the package settings on npmjs.com. Add a trusted publisher for GitHub Actions with the repository `sanjit-roopra/pi-dev-team` and the workflow `publish.yml`.
