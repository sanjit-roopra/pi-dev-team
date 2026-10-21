## Review profile: lean (read first)

The user started this session with `DEV_TEAM_REVIEW=lean`. `/plan`, `/build` and `/code-review` each carry their own lean section; follow them in steps 3, 4 and 5. Step 5 runs as written: `ship_review_gate.py` first, and when it does not skip, `/code-review`, whose ledger-scoped dispatch reviews only what the build's slice checkpoints did not pass, with the lean fix loop (errors only, one iteration). Name the lean profile in the step 7 report.
