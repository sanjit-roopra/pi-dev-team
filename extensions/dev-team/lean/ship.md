## Review profile: lean (read first)

The user started this session with `DEV_TEAM_REVIEW=lean`. `/plan`, `/build` and `/code-review` each carry their own lean section; follow them in steps 3, 4 and 5. This section overrides step 5 where they differ:

- Run `ship_review_gate.py` first, as written. When it skips, skip the pass.
- When it does not skip and step 4's `/build` ran its lean slice checkpoints, do not run the full `/code-review` panel again: the lean checkpoints leave `warning` findings unfixed and record them as `findings`, so the gate does not clear those (lens, file) pairs, and re-reviewing them is the second panel lean removes. Instead run `/code-review` over only the branch's changed files that no `/build` checkpoint reviewed (from `/build`'s checkpoint records), if any, and run the step 2b static-analysis pre-pass (lint, type-check, `lizard`, `jscpd` when installed) over every changed file; fix its errors with the lean fix loop (errors only, one iteration). Say in the step 7 report which pass ran and why.
- When step 4 did not run `/build` with lean checkpoints in this `/ship` (for example a resumed or skipped build), run step 5 as written, with the lean fix loop.

Name the lean profile in the step 7 report.
