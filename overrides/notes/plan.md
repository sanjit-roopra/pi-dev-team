## pi port notes (read first)

**Name the reuse.** In step 3, every step that adds production code says what it reuses: an existing function (by name), the standard library, a platform feature, or an already-installed dependency. When nothing fits, the step says `new:` and why. Size each step to the smallest change that satisfies its Gherkin scenario; options, configuration and abstractions nothing asks for stay out of the plan. Test steps are exempt: test scope comes from the Gherkin scenarios and the mutation gate.
