## pi port notes (read first)

**Name the reuse.** In step 3, every step that adds production code says what it reuses: an existing function (by name), the standard library, a platform feature, or an already-installed dependency. When nothing fits, the step says `new:` and why. Size each step to the smallest change that satisfies its Gherkin scenario; options, configuration and abstractions nothing asks for stay out of the plan. The test part of each step is exempt: test scope comes from the Gherkin scenarios and the mutation gate.

**No approval section in the plan.** In step 6 non-interactive, skip the `## Approval` section: the `config-changelog.jsonl` entry is the audit record, and its `description` states the trigger.
