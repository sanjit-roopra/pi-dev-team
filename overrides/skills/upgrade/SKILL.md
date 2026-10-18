---
name: upgrade
description: >-
  Check for and apply pi-dev-team package updates using pi's package manager.
user-invocable: true
allowed-tools: Read, Bash
---

# Upgrade

Role: worker. Updates the pi-dev-team package through pi's own package
mechanism. Never hand-edit installed package files.

You have been invoked with the `/upgrade` command. Arguments: none.

## Steps

1. Report the current version: run the `/version` command's script
   (`${CLAUDE_PLUGIN_ROOT}/package.json` and `UPSTREAM.json`).
2. Find how the package is installed: `pi list` (look for `pi-dev-team`).
   - **git or npm source** → run `pi update <source>` to update that package,
     regardless of whether it is installed globally or in project settings.
     Report the version delta afterwards.
   - **local path** (e.g. `./pi-dev-team`) → pi does not update local packages.
     Tell the user to pull the package directory (`git -C <path> pull`) or, when
     it is a sync of upstream, to run
     `python3 <path>/sync/sync_upstream.py --upstream <agentic-dev-team checkout>`.
3. Tell the user to run `/reload` (or restart pi) so the new extension code,
   skills and agents load.

**Be concise.** Report version deltas only.
