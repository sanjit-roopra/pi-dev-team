## Review profile: gate (read first)

This session runs the gate review profile (the user set `DEV_TEAM_REVIEW=gate`). This section overrides step 6a, and the reference it points to, where they differ. Steps 1 to 6 and 7 to 9 run as written: the step 2b static-analysis pre-pass, the full panel the resolver selects (with `spec-compliance-review` and `structure-review`), and the ledger-scoped dispatch, which skips (file, lens) pairs a `/build` checkpoint already passed.

- **Fix only errors.** In the fix loop, fix only `error` findings. `warning` and `suggestion` findings go in the report and the correction prompts, not in the loop. A lint, type-check or complexity failure from step 2b is an error.
- **One fix iteration.** Apply the error fixes once, then run the test suite and the step 2b tools (revert a fix that breaks the tests, as the loop says). Do not re-dispatch agents to verify and do not run the closing pass, with one exception: when the iteration fixed a `spec-compliance-review` error, re-dispatch `spec-compliance-review` once in verification mode. Do not start a second iteration. An error still open after it is an escalation for steps 7 and 9, as the loop says.
