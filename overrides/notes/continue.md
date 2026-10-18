## pi port notes (read first)

- Find the resume point in this order, and stop at the first hit. Do not search the tree, and skip step 1's glob list.
  1. `.claude/memory/build-phase.json`, whatever its age: its `plan_path` and `step` name the plan and the next step. Run `grep -n` for that step in the plan (`## Build Progress` and the step's heading) and read only those lines.
  2. Otherwise the newest `.claude/memory/*.md` handoff, plus `git status -sb`.
- Step 4: do not ask "Resume from here?" and do not wait for an answer. Print `Resuming Step N.M of <plan>` and go on. When the arguments name a goal, resume that. When the state is unclear, for example two plans in progress, take the most recent one and name the other in one line, so the user can steer later.
