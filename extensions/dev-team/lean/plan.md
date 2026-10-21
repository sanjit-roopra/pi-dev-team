## Review profile: lean (read first)

The user started this session with `DEV_TEAM_REVIEW=lean`. This section overrides step 5 where they differ; every other step runs as written.

- **Plan critics at most the standard tier.** Classify the tier in 5a as written, then dispatch at most the `standard` reviewer set: a `complex` plan gets the Acceptance Test Critic and the Design & Architecture Critic, plus the UX Critic and the Parallelization Critic under the standard tier's own conditions. Record it in the Plan Review Summary, for example `Plan tier: complex (lean profile: standard reviewers)`.
- **One revision round.** When a reviewer returns `needs-revision`, revise the plan for its `blocker` issues once and re-run only the reviewers that flagged blockers, once. If a blocker remains, list it under `## Risks & Open Questions` and go on to step 6, which presents it at the approval gate.
- When the plan reaches `/build`, the same profile applies there: one implementer dispatch and one review panel per slice.
