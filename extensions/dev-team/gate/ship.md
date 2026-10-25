## Review profile: gate (read first)

This session runs the gate review profile, the default (the user did not set `DEV_TEAM_REVIEW` to `lean` or `full`). `/plan`, `/build` and `/code-review` each carry their own gate section; follow them in steps 3, 4 and 5. This section overrides step 5 where they differ:

- Run `ship_review_gate.py` first, as written. When it skips, skip the pass.
- When it does not skip and step 4's `/build` ran its gate slice checkpoints, do not run the full `/code-review` panel again: the gate checkpoints leave `warning` findings unfixed and record them as `findings`, so the gate does not clear those (lens, file) pairs, and re-reviewing them is the second panel gate removes. Instead run `/code-review` over only the branch's changed files that no `/build` checkpoint reviewed (from `/build`'s checkpoint records), if any, and run the step 2b static-analysis pre-pass (lint, type-check, `lizard`, `jscpd` when installed) over every changed file; fix its errors with the gate fix loop (errors only, one iteration). Say in the step 7 report which pass ran and why.
- When step 4 did not run `/build` with gate checkpoints in this `/ship` (for example a resumed or skipped build), run step 5 as written, with the gate fix loop.

Name the gate profile in the step 7 report.
