# Review profiles and the example check

A review profile sets how much review `/plan`, `/build`, `/code-review` and `/ship` run. The default profile is `gate`. Under `gate`, the example check is also on by default. The example check runs the examples in your request as acceptance tests.

## Choose a profile

Set the profile in the shell that starts pi:

```bash
pi                          # gate profile, example check on
DEV_TEAM_EXAMPLES=off pi    # gate profile, example check off
DEV_TEAM_REVIEW=lean pi     # lean profile
DEV_TEAM_REVIEW=full pi     # full profile: every skill step as written
DEV_TEAM_FARLEY=on pi       # gate or lean, with the Farley Score at the end of /build
```

| Setting | Values | Effect |
|---|---|---|
| `DEV_TEAM_REVIEW` | `gate` (default), `lean`, `full` | How much review the four commands run |
| `DEV_TEAM_EXAMPLES` | On by default. `off`, `0`, `false` or `no` turns it off. | Under `gate` only: the [example check](#example-check) |
| `DEV_TEAM_FARLEY` | `off` (default), `on` | Under `gate` and `lean`: the step 7 Farley Score of `/build` |

Result: the extension reads these values once, when it loads. To change the profile, restart pi with another value.

### Only your shell sets the profile

The profile decides how much review runs. A cloned repository must not be able to turn review down. These rules apply:

- The extension reads `DEV_TEAM_REVIEW`, `DEV_TEAM_EXAMPLES` and `DEV_TEAM_FARLEY` before it applies the `env` of any configuration file.
- `DEV_TEAM_REVIEW` is not in `PROJECT_ENV_SETTINGS` (`lib/config.ts`), so a project configuration file cannot set it.
- The session writes the chosen profile (`applyReviewProfileEnv`) and the example setting (`applyExamplesEnv`, `on` or `off`) into the environment. That is its own environment, and that of each child agent and each hook script. So a value from a configuration file never reaches a tool, a hook or a dispatched agent. A child never drops the request guard of its parent.
- The extension ignores case and spaces. An unknown `DEV_TEAM_REVIEW` value selects `gate`, and the top session shows one warning.

## Terms

| Term | Meaning |
|---|---|
| Slice | A group of plan steps that `/build` reviews together |
| Checkpoint | In `/build`: a review point (sub-step 4 after a step, sub-step 6 after a slice). In SlopCodeBench: one spec version of a problem. The text says "SlopCodeBench checkpoint" for the second meaning. |
| Lens | A review agent for one concern, for example `correctness-review` |
| Finding | A lens result with a severity: `error`, `warning` or `suggestion` |
| Dispatch | One run of an agent with a task |
| SlopCodeBench | A benchmark of coding problems in SlopCodeBench checkpoints, scored by hidden tests that the agent never sees |
| Erosion, CC | Code-shape scores: structural erosion, and the highest cyclomatic complexity of one function |
| Strict, isolated, core | SlopCodeBench solve rates, as the share of SlopCodeBench checkpoints. Strict: all tests pass. Isolated: all tests except the regression tests pass. Core: all core tests pass. |
| Smoke run | A short trial run on a few problems |
| pi-gate | A benchmark arm: plain pi with only the quality bar and `ruff` in its prompt |

## Gate profile (default)

Gate puts the quality bar in every session and removes review steps that measured nothing. The bar is in the dev-team guide (`QUALITY_BAR` in `extensions/dev-team/lib/review-profile.ts`). So it binds the session itself (plain requests, `/fix`, fix rounds) as well as the implementer of `/build`.

The skill sections are in `extensions/dev-team/gate/<skill>.md`, for `plan`, `build`, `code-review` and `ship`. When one of these skills expands, the extension inserts its section after the last `<!-- pi-notes -->` marker of the skill. Without a marker, the section goes after the first `# ` heading.

Why the bar: four critiques of the file_merger session logs (runs r3-r5) found one cause of good code shape. Two ablation runs (runs with one rule removed) found the same cause. The cause is the instruction to keep every function at a CC of 10 or less, run `lizard` and fix. That instruction took erosion from 0.40-0.54 to 0 and the highest CC from 17-18 to at most 10.

The full profile has plan critics, Gherkin scenarios, test-first steps and the full review panel (every selected lens), but no such instruction. It scored like plain pi (erosion 0.44, CC 17). pi-gate matched the lean profile on every code-shape metric and on hidden tests. pi-gate took 31 minutes and $1.70. The lean profile took 106 minutes and $13.67.

Gate is the default because it matched pi-gate on `etl_pipeline` and `execution_server`: strict 27.3%, isolated 72.7%, core 100%, erosion 0, and the same failed tests.

### The quality bar

The bar has five rules:

1. Every function has a cyclomatic complexity of at most 10, at most 60 lines and at most 5 parameters. The project linter (`ruff check` for Python) reports nothing on changed files.
2. Before the agent reports code work done, it runs the linter and `lizard -w -C 10 -L 60 -a 5 <changed source files>`. It installs `lizard` into the project environment when it is missing. It fixes every finding and runs both again until they are clean.
3. The agent writes the least code that works. It uses what the codebase, the standard library or an installed dependency already has. It writes no speculative options, no wrapper, factory or layer used once, and no duplicated logic: "fewer lines, never denser lines". It never cuts input validation or error handling at a real boundary to save lines. The [lean production code](#lean-production-code-all-profiles) rules give the details.
4. Every test command runs under `timeout 600` (or the platform equivalent). In run 9ea0b54, one hung test held a fix round for 17 of its 21 minutes.
5. Where the spec is silent, the agent follows the established standard for the interface. The bar names JSON Pointer error locations, RFC 9457 error bodies, RFC 9110 status codes and ISO 8601 times. Where the spec is explicit, the spec wins.

Rule 5 is experimental. On SlopCodeBench `etl_pipeline`, pi-gate and the gate profile both reported coarse error paths (`steps[1].columns`). The hidden tests expect the exact value (`steps[1].columns[1]`), as JSON Schema `instanceLocation`, JSON:API `source.pointer` and Google `FieldViolation.field` do.

In the first run with rule 5 (`etl_pipeline` SlopCodeBench checkpoints 1 to 3), the agent still reported the coarse paths. The likely cause: the example of the spec (`pipeline.steps[2].columns`) reads as explicit, so "the spec wins" applied. The [example check](#example-check) narrows rule 5: where the request has an example on a point, the example decides.

### Gate rules for `/plan`

| Rule | Measured reason |
|---|---|
| No plan critics. The plan says `Plan review: skipped (gate profile)`, and the session writes each open question under `## Risks & Open Questions`. | No blocker that the critics raised changed a test result. The design, UX and parallelization critics approved every plan. |
| Gherkin scenarios only for behavior that the request states or that an example shows. Each TEST line names only its scenarios and the request rules that no scenario covers. | See the [test budget](#gate-rules-for-the-implementer). |
| A short plan: only the sections `/build` reads, one line for each criterion, step part and open question, three to five lines for each scenario. | In run file_merger 6e89570, the main session spent 20k output tokens on writing plans. |

### Gate rules for review in `/build`

| Rule | Measured reason |
|---|---|
| At every checkpoint, only `spec-compliance-review` and `correctness-review`. At the last slice checkpoint, also `refactor-opportunity-review` over every production file that the build changed, and `security-review` when the resolver selected it. The other lenses are recorded as `skipped (gate profile)`. | The nine other lenses (structure, test, test-smell, naming, arch, domain, doc, performance, concurrency) found 0 errors in 53 dispatches over three runs. Gate fixes only errors. The `lizard` pre-pass covers what `structure-review` measures. |
| `trivial` and `standard` steps defer review to the slice checkpoint. `complex` steps keep their sub-step 4 review. All selected lenses go out at once. | Part of one review panel for each slice. The cost of review panels is in the next row. |
| Fix only `error` findings, in one round. One exception: after a round that fixed a `spec-compliance-review` error, `spec-compliance-review` runs once more in verification mode. An error still open after the round goes in the build report. It stops the build only when tests or lint are red. | Review panels were 47-53% of the dollar cost, and the review-fix implementer 13-21% of wall time. Review fixes changed no hidden-test result. |
| `lizard` (and `jscpd`, when installed) runs at every checkpoint, through `skills/static-analysis-integration/adapters/lizard-adapter.py`. Each threshold breach and each clone in a changed file is an `error`. | `lizard` runs only in `/code-review` step 2b, not in the static self-heal lanes of `/build`. Gate skips the step 6 backstop that ran it. |
| Every lens task names a scoped diff file, `.pi/dev-team/memory/reviews/diff-<slice>.patch`. | Lenses have no shell. In run file_merger 5076bf3, lenses reported 9 findings that only said the diff was unavailable. |

The step 6 backstop review does not run. `reviewProfileArgs` appends `--backstop-review=skip` to the `/build` arguments, so the flag logic of the skill applies. The gate slice checkpoints are the enclosing review that the flag requires. Files that no checkpoint reviewed still get `/code-review --internal`.

### Gate rules for the implementer

| Rule | Measured reason |
|---|---|
| One `software-engineer` dispatch for each slice. It works one step at a time: implement, write the tests, run only that step's tests once, refactor once. | In run file_merger af34311, the implementer took 63% of wall time. Each behavior ran its tests two or three times. |
| Lint, type-check, `lizard` and the full suite run once, in one bash call, at the end of the task. The implementer fixes each `lizard` breach itself. | In run af34311, one full-suite run took about 3 minutes in the container. In run 6e89570, a breach found at the checkpoint cost a separate 5-minute implementer dispatch. |
| Test budget: one test for each Gherkin scenario, plus one for each request rule that no scenario covers. No tests of internal helpers, resource or memory bounds, signals, injected filesystem failures or permutation matrices, unless the request asks. `test-review` and `test-smell-review` get the same budget. | In run af34311, the team wrote 465 subprocess tests in 7,144 lines for 1,808 program lines. Plain pi wrote 59 tests, with the same hidden-test score. |
| The Farley Score (a `qa-engineer` dispatch at step 7) runs only with `DEV_TEAM_FARLEY=on` (`farleyEnabled`). `extensions/dev-team/gate/build.md` holds both versions of item 6 between `<!-- farley:on -->` and `<!-- farley:off -->` markers. | In run af34311, the four dispatches took 12 minutes and $1.25 and scored 8.76-8.93 at every SlopCodeBench checkpoint. No file changed after any of them. The score never gates `/pr`. |
| The skills `quality-gate-pipeline` and `systematic-debugging` are inlined into the `software-engineer` prompt (`reviewProfilePreloadedSkills`, `preloadedSkillText` in `lib/subagent.ts`). | Each new dispatch otherwise read them again. |

### Gate rules for turns and tokens

| Rule | Measured reason |
|---|---|
| A dispatch task has about 150 words. It names the plan path, the slice and step ids, the files, the diff or findings file and the constraints. A fix-round task lists each error in one line: `lens: file:line: what to fix`. | In run 6e89570, each model call took about 2-3 seconds plus about 15 seconds for each thousand output tokens. Tools took under 5% of the implementer's time. The main session spent 28k output tokens on restating the plan in dispatch tasks. |
| The implementer chains each `build_phase.py` marker onto a neighboring bash call, and commits once for each task. | The same run: model time was the whole cost. |
| No report files. The final message of an agent is its report, at most 300 words for `software-engineer`. | Report files cost about 21k output tokens in each run, and nobody read them. |
| With `DEV_TEAM_INTERACTIVE` unset, `/build` skips the Feedback & Learning step. | The step was a no-op in every headless run. |

### What still runs under gate

Gate removes review layers, not checks. These still run, and their errors are fixed:

- The step 3 `spec-compliance-review` check, and `spec-compliance-review` and `correctness-review` at every checkpoint.
- The static self-heal pass (lint, format and type-check lanes, such as `ruff` and `mypy`) and the per-step lint and type-check self-verification.
- Runtime verification (sub-step 4.9), invariants (sub-step 4.10) and the step 5 full-suite run.
- `/code-review` run by itself: the step 2b static pre-pass and the full panel that the resolver selects. Its fix loop fixes only errors, in one iteration.
- `/ship` step 5: `ship_review_gate.py` first, then `/code-review` over only the changed files that no `/build` checkpoint reviewed. The step 2b static pre-pass runs over every changed file.

`/ship` does not run the full panel again over reviewed files. The checkpoints leave `warning` findings unfixed and record them in the ledger as `findings`. So `ship_review_gate.py` does not clear those (lens, file) pairs. A second panel reviews them again and adds nothing.

## Example check

The example check makes the examples that a request shows into its acceptance tests. It works only under the gate profile, and it is on by default. To turn it off, start pi with `DEV_TEAM_EXAMPLES=off`.

Why a command and not a rule: a failure analysis looked at three full SlopCodeBench runs of 196 SlopCodeBench checkpoints each. Two of them were plain pi and the gate profile. The largest losses were outputs that differed from an example in the spec. In `trajectory_api`, each GPT run lost 126 hidden tests. In `file_backup`, the loss was 70 tests. A rule that asked for the form of the example was already in the quality bar.

Two cases from that analysis:

- Every `trajectory_api` example shows `2025-10-12T14:03:22Z`. Both GPT runs wrote microseconds, and each lost 126 hidden tests.
- In `file_backup`, the "ISO 8601" sentence of the quality bar produced `+00:00`. The examples show `Z`. That lost 70 tests.

A rule that the model applies by judgment missed. The `lizard` bar, a command with an exit code, held at every SlopCodeBench checkpoint. So the example check is a command too.

### What the model does

With the check on, the gate guide gets `EXAMPLE_BAR` after the quality bar. It tells the model to do these steps:

1. Before you write code, run `python3 ${DEV_TEAM_ROOT}/scripts/example_replay.py --format` to see the case format.
2. Copy every input-to-output example of the request into `.dev-team/examples.json` as a case.
3. Before you report code work done, run `python3 ${DEV_TEAM_ROOT}/scripts/example_replay.py` under `timeout 600`.
4. For each failure, fix the program, not the case.
5. Run the script again until it exits 0.

`example_replay.py` is stdlib Python. Exit codes: 0 means that every check holds and every case passes. 1 means that a check or a case failed. 2 means that the case file is unusable.

| Flag | Default | Effect |
|---|---|---|
| `--cases FILE` | `.dev-team/examples.json` | The case file |
| `--requests DIR` | `.pi/dev-team/memory/requests` | The saved requests |
| `--root DIR` | `.` | The project root |
| `--only ID` | all cases | Run only this case id. You can repeat it. |
| `--timeout SECONDS` | `30` | The limit for each step and for the server start |

### Saved requests

The extension saves every typed request that is not a `/command`, word for word, as `.pi/dev-team/memory/requests/request-<time>.md` (`saveDirectRequest` in `lib/skills.ts`). `/plan`, `/specs` and `/ship` save their text as `<command>-<time>.md` (see [the request as the spec](#the-request-as-the-spec)).

- A file holds what the user typed, so the files are owner-only (0600). A folder that the extension creates is 0700. An existing folder keeps its mode.
- The folder gets a `.gitignore` of `*`. So the requests stay out of Git, also in a repository where `/setup` never ran. `example_replay.py` skips dot files.
- Nothing is written through a symlinked folder, and the `wx` flag never overwrites a file.

Do not commit `.dev-team/examples.json` without its requests. Its cases quote the saved requests, so cases committed alone fail the check on a new clone. Keep both out of Git, or commit both: remove the `.gitignore` in the requests folder and un-ignore `.pi/dev-team/memory/` if `/setup` ignored it.

### The case file

Each case runs in a new temporary directory. The script writes the `files`, starts the optional `server` on a free port, then runs the `steps` in order.

| Field | Meaning |
|---|---|
| `id`, `source` | The case name, and the example copied character for character from a saved request |
| `files`, `server` | Input files for the case directory, and an optional server command |
| `steps` | `run` steps (`stdin`, `stdout`, `stderr`, `exit`), `http` steps (`body`, `headers`, `status`, `response`) and `files` steps |
| `vary`, `save` | Generated values compared by shape, and values stored for later steps |
| `superseded_by`, `disputed` | A quote that retires a case, or a quote that disputes one step |

Placeholders: `{root}` is the project root, `{tmp}` the case directory, `{port}` a free port, and `{name}` each value that a step saved. A `run` command without `{root}` is setup and must exit 0 unless it names `exit`. A step checks only what it names, and a case must check something. A top-level `skipped` list holds code blocks that are not examples, each with a `block` and a `reason`.

| Match mode | Rule |
|---|---|
| `exact` | The text must be equal. The check ignores line endings and trailing whitespace. This is the default for text. |
| `json` | The JSON must be equal. The check ignores key order and compares numbers by value. JSON lines compare as a list. This is the default when the expected value is JSON. |
| `subset` | The check works like `json`, but objects can have keys that the example omits. |
| `excerpt` | The shown lines must appear in the output in order. `...` lines stand for omitted lines. |
| `shape` | The text must have the same shape, as for `vary`. |

`subset` and `excerpt` need `...` in the source, or a `why` quote of request text that says the example is partial. `unordered: true` compares JSON arrays as multisets, only where the request says that the order is unspecified.

Shape rules for `vary` values:

- A run of digits matches any digits.
- A hex run matches any hex of the same case. A hex run has 4 or more characters, with a digit and a letter, as in a UUID or a hash.
- An expected value written as `<description>` matches any non-empty string.
- Every other character must be equal. So `2025-10-12T14:03:22Z` rejects `2025-10-12T14:03:22.148842Z` and `2025-10-12T14:03:22+00:00`.

A value that the request defines (a count, a sum, a status, a name) never goes under `vary`.

### Source and coverage checks

The script also compares the case file with the saved requests, so the model cannot make a case fit the code:

- The `source` of each case must be word for word in a saved request. Whitespace can differ.
- Every expected value must appear whole in that source.
- Every fenced code block of every saved request must be covered by a case source or skipped with a reason.
- An input file line (`key: value`) is reported when the source shows that key with another value.

Setup steps that state no expected output need no source.

### Cases across requests

Cases persist across requests. A later change that breaks an earlier example fails the check. A case stops counting only when `superseded_by` quotes request text.

| Rule | Why |
|---|---|
| The quote must come from a request newer than the source of the case. One sentence cannot retire several cases. A superseded case still runs, and its failure is shown, not counted. | In a first smoke run (four problems, 21 SlopCodeBench checkpoints), the model added a validation that rejected the inputs of earlier examples. It retired all three earlier cases with one sentence that did not change them. The sentence was "The `destination` field is now required." The run lost 90 hidden regression tests. |
| A superseded case still fails when the program now rejects its input (non-zero exit, 4xx or 5xx status). | In the next smoke run, the model quoted slightly different text for each case. |
| An input line whose key the source shows with another value is reported. | In the smoke run after that, the model copied the earlier cases again. It left out the line that its new validation made invalid. It added its own value (`destination: backup://`). This check does not catch that run: the copied example had no such line. |

`disputed` on a step quotes request text, word for word, that contradicts the example of that step. A disputed step that fails is reported and does not fail the run. It is not for a format, precision or suffix that the text leaves open: there the example decides.

`example_replay.py` orders the saved files by the time in their names. So `approved-`, `request-`, `plan-`, `specs-` and `ship-` files interleave. An approval can supersede the example of an older request, not of a newer one.

### Approved examples in `/specs`

A vague request shows no examples, so the check passes with 0 cases. The spec that `/specs` writes is the model's own text and is never saved, so its examples cannot be sources. Approved examples fill that gap.

With the check on, `/specs` gets one step after Step C, from `extensions/dev-team/gate/specs-examples.md`. `examplesSpecsNote` adds it when the skill expands, by command or by the `skill` tool. For each criterion that the request shows no example for, the model proposes small input-to-output examples. It then calls `dev_team_approve_examples` (`lib/approve-examples.ts`), and pi asks "Are these the right examples?".

| Answer | What the extension saves | `source` returned |
|---|---|---|
| Approve | The exact `examples` string that the dialog showed | `user`, with the path |
| Edit them first | The text from the editor (`ctx.ui.editor`) | `user`, with the path |
| Reject | Nothing | `user`, with `rejected` |
| `Esc`, or an empty editor | Nothing | `skipped` |
| No answer in time | Nothing. The extension sends the `notify` message. | `timeout` |
| No human attached | Nothing | `no human` |

A saved answer goes to `.pi/dev-team/memory/requests/approved-<iso time>.md` (`saveApprovedExamples` in `lib/skills.ts`), with no header. So a case `source` matches it character for character, and its fenced blocks fall under the coverage check. The spec records each saved file as `**Approved examples**: <path>`.

Without a saved answer, the spec logs `assumed (...)` in the Decision Log and lists the examples under `## Decide these`. They are never case sources.

"No human" means that `humanAttached` is false: there is no UI, or `DEV_TEAM_INTERACTIVE` is not `1`. That is true for a dispatched agent, a headless run, and `askTimeoutSec: 0` in timeout mode.

Design reasons:

- Code saves the file, not the model. A model that writes the file writes the oracle that grades it, which is the cheat the source check stops.
- A timeout does not count. Other questions take the recommended answer, because there the default is a reversible choice. Here, a timeout default makes an unread proposal into a test that the program must pass.

The tool refuses input that the dialog cannot show as saved:

- More than 40 lines or 4000 characters of examples. The dialog shows every line at once.
- A `criteria` line over 300 characters, or with a line break.
- Control, format (bidi, zero-width, soft hyphen, tags), private-use, unassigned and separator characters, and the Hangul blank fillers. Tab and newline are allowed.

The approval dialog is not measured. Benchmark runs are headless, so the dialog saves nothing there.

### The request guard

`lib/request-guard.ts` stops the model from writing the saved requests. It runs in the `tool_call` event right after the pi-subagents block, before the brief gate and the hook bridge, only while the check is on. It blocks:

- `write` and `edit` paths in the requests folder, or in a folder above it in the project (`.pi`, `.pi/dev-team`, `.pi/dev-team/memory`). Symlinks are resolved, and case is folded on macOS and Windows.
- Bash writes that it can see (`bashCommands` in `lib/brief.ts`), for example redirects, `>|`, `cp`, `mv`, `tee`, `ln`, `touch`, `rm` or `sed -i`. The scan also sees them behind `timeout`, backticks and `$(...)`. Each target resolves against every folder that the line enters with `cd` or `pushd`.
- A computed target on a line that names the folder. Also any command on that line that is not a known read, for example `cat`, `ls`, `grep` or `example_replay.py`. Joined parts such as `'memory', 'requests'` also name it. The same applies after a `cd` into the folder or above it. So even `cp` out of the folder is blocked, because `cp -t` makes its first path the destination.
- A computed target on a line that names `.pi/dev-team` or `.pi` itself, also after a short flag (`-C.pi/dev-team`). Also any write after a `cd` that the scan cannot follow, on a line that names `.pi/dev-team`, `.pi` itself, `memory` or `requests`. Other pi files such as `.pi/settings.json`, `.pi/agents` or `~/.pi/agent` do not count.
- Any `powershell` line that names the folder. `example_replay.py` counts as a read only as the script argument, never after `-c` or `-m`.

If the guard blocks a call, the call fails. The message starts: "Saved requests are written by dev-team code only (the example check takes them as the human's own words)." The cause is a write, move or delete in the requests folder. To fix it, show the examples to the human with `dev_team_approve_examples`.

### Nested sessions

A pi session that another session started does not save its prompt. Each session sets `DEV_TEAM_NESTED` to its own process id in the environment that its tools inherit. A session that finds another process id there at load was started by a bash call (`pi -p`, or `dev-team-run`). So its prompt is model text, not a request.

The same process id means `/reload` in the same process, which is still the top session. A top-level `pi -p`, as in the benchmark, still saves.

### Limits and known gaps

These limits apply to the check itself:

- Examples given only in prose are not made into cases.
- Behavior that the request neither states nor shows is not checked.
- Where hidden tests contradict an example of the request, following the example still loses.
- A vague request shows no examples, so the check passes with 0 cases. Approved examples target this limit.
- The check runs over the model's own case file. It catches drift from the examples, but not a rule that the model invents and that no example input exercises.

These limits apply to approval:

- A human who approves without reading makes the model grade itself again. The step keeps rounds short and asks for exact outputs, so reading is cheap, but nothing enforces it.
- pi's editor takes no timeout or abort signal. The tool races both and saves nothing on either, but the editor stays open until the human closes it.

The guard is a static scan, not a sandbox. These writes get past it:

- A program that builds the path at run time. Examples: `python -c` that joins strings, or a shell variable on a line that never names `.pi`.
- `example_replay.py --requests DIR`, which points the check at a folder that the model wrote. No per-file hash records which files code saved.
- A delete or a writer that never names the folder, or takes it as a folder argument: `find . -name 'request-*' -delete`, `git clean -fdx`, `tar -C .pi/dev-team/memory`, `find ... -exec`.
- Unquoted globs, `cd --` or `CDPATH` targets, names split by quotes inside `bash -c`, and hard links to a saved file.
- Writes from a child agent in its own worktree. Its guard protects the folder of its own worktree, not of the main checkout.

The guard also blocks too much in two cases:

- A reply inside a running flow is saved like a new request. A fenced block pasted there needs a case or a skip reason.
- The `memory`/`requests` name match blocks a command that is not a read when its text only mentions both words, for example `pytest tests/test_memory_requests.py`.

## The request as the spec

`/plan`, `/specs` and `/ship` save the text after the command word for word to `.pi/dev-team/memory/requests/` (`saveRequest` in `lib/skills.ts`). Without this file, a `/plan` with no spec artifact writes its own acceptance criteria and Gherkin. Every later check (plan critics, `spec-compliance-review`, the runtime check of the build) then checks against them. A requirement that the plan rewords, such as an exact output format, passes every review.

### What is saved

The extension saves the text only when it holds words beyond flags, issue numbers, URLs and paths (`hasRequestText`). `/ship 123`, `/ship --issues 4,5` and `/specs docs/spec.md` point at a request somewhere else. A saved bare reference outranks the issue body or the document, so the extension does not save it.

Code writes the file, so a model that shortens the text, or calls the skill again with a summary, cannot replace it. The extension never edits your `.gitignore`. `/setup` step 11 ignores `.pi/dev-team/memory/` in your project, and the folder has its own `.gitignore` of `*`.

### How each phase uses it

| Phase | Rule |
|---|---|
| `/ship` | Passes the path to its `/specs` and `/plan` calls. With no saved file, the issue body is the request. |
| `/specs` | Records the path in the spec. `/plan` copies it from there. |
| `/plan` | Makes the file the spec artifact (`**Source request**: <path>`) and copies the output examples of the request into the Gherkin unchanged. |
| `/build` | Passes the path to `spec-compliance-review` at step 3 and at every checkpoint. Sub-step 4.9 runs each request example that the slice can produce and diffs the full output. |
| `spec-compliance-review` | A difference from an output example of the request is an unmet criterion (`error`), even when the plan records it as a decision. |

### Open questions stay open

An unclear point is an open question, not a decision. In a SlopCodeBench `file_backup` run on Sol, the plan settled two unclear points wrongly as criteria, and every reviewer honored them.

In the Opus run, the plan chose the right reading for one of them and listed the doubt. But `spec-compliance-review` at the acceptance-criteria check of the build read a sort rule and "for each" wording as the other reading. The build switched to it. Both failures are a guess presented as settled: once by the plan, once by a reviewer.

The rules that follow from this:

- `/plan` cites an example only when its output differs between the readings. It computes both. Otherwise it plans the reading under which every input the request defines changes some output.
- `/plan` lists the other reading under `## Risks & Open Questions` and never marks the choice "Plan decision". It asks the question when the human approves the plan.
- `spec-compliance-review` checks open choices even when the dispatch calls them settled. It reports an `error` only on explicit evidence: an example that separates the readings, or a sentence that states the behavior.
- A reading inferred from wording is a `suggestion`, which the build checkpoint loop logs and does not chase. Answers from the user (Ambiguity Log source `user`, plan approval) are settled.
- `/build` changes code only on such an `error`, and tells `software-engineer` that the request overrides that plan choice.

The aim is to stop reviewers from overturning points that the request does not decide, not to give them more reasons to.

`/plan` also gives each stated observable rule (bound, default, order, count, format) its own Gherkin scenario. A rule that depends on an open question is tested only on inputs where all readings agree. This rule is a guess too. It is not shown to fix the `file_backup` SlopCodeBench checkpoint 1 window tests until a checkpoint 1 run passes them.

The `file_backup` SlopCodeBench checkpoint 2 `total_size` and pack-boundary failures are not targeted. There the hidden tests contradict the text of the spec and its Example 2, so following the examples causes them.

## Lean production code (all profiles)

These rules are in the agent and skill files, so they apply in every profile. Without them, the team writes more code than a task needs, and the review loop grows it. Most lenses propose more structure, and no lens takes code away. The rules apply to production code only. Test scope stays with the Gherkin scenarios.

### The reuse ladder

`software-engineer` walks this ladder before it writes code and stops at the first rung that holds:

| Rung | Question | If yes |
|---|---|---|
| 1 | Does it need to exist? | If nothing asks for it, no scenario needs it and the design does not imply it, do not write it. |
| 2 | Does the codebase already have it? | Call it. |
| 3, 4 | Does the standard library, or the platform or framework, do it? | Use it. |
| 5 | Does an installed dependency do it? | Use it. Never add a dependency to save a few lines. Security primitives always come from the standard library or a vetted library. |
| 6 | None of the above | Write the minimum: no speculative options, no single-use abstraction, no configuration that nobody asked for. |

Other rules for `software-engineer`:

- "Fewer lines, never denser lines": no nested ternaries, no clever one-liners.
- Never cut input validation, error handling at a real boundary, security, synchronization, idempotency, transactions, retries or cleanup on error paths.
- A deliberate shortcut gets a `shortcut:` comment, so `grep -rn "shortcut:"` lists the debt.
- The final message ends with one `Skipped:` line: what the agent left out or did not check.

### The simplify lens

`refactor-opportunity-review` is a deletion-only simplify lens. Each finding must leave the slice with fewer production lines and the same behavior. It has `Scope: on-demand`, so the `/code-review` per-diff panel never dispatches it.

- `/build` dispatches it once for each slice at the sub-step 6 checkpoint. Under gate, it runs only at the last slice checkpoint.
- An `error` is a mechanical removal that keeps behavior. A `suggestion` is a removal that needs judgment. It never reports a `warning`, because a fix loop applies warnings automatically.
- Categories: `not-needed`, `single-use-abstraction`, `already-exists`, `dead-code`, `redundant-code`.

Extraction and duplication findings belong to `structure-review`. It applies the rule of three. It injects only what the blocker table in `knowledge/internal-collaborator-doubling.md` allows a test to double (B1 out-of-process handles, B2 ambient state, B3 prohibitive cost).

The per-diff panel of `/code-review` has no deletion lens. Speculative and reinvented code is caught only at the slice checkpoint of `/build`.

### The lean fix rule

The lean fix rule is in `structure-review`, `quality-reviewer` and the `/code-review` core (step 5b). A `warning` whose fix restructures code and adds more production lines than it removes counts as a `suggestion` with confidence `none`. It is reported, never applied automatically, and kept out of the fix loop.

Restructuring means to extract a function, split a module, or add a type, interface, parameter object, wrapper or layer. `error` findings are not affected. These are exempt:

- Every finding from `security-review`, `concurrency-review` or `correctness-review`.
- Fixes that correct behavior: a bug, a race, a missing check or cleanup, a security or accessibility gap.
- A seam for a collaborator that the blocker table (B1-B3) allows a test to double.
- Test files, fixtures and test helpers.

### Plans

`/plan` names the reuse of each step that adds production code: an existing function, the standard library, a platform feature or an installed dependency. When nothing fits, the step says `new:` and why. `plan-review-strategic` makes sure that each step names its reuse, and proposes at least one cut (`proposed_cut`).

## Speed-ups (all profiles)

A SlopCodeBench run with the lean profile on Copilot spent 44 model turns, 855 s, only on writing `.pi/dev-team/memory/build-phase.json`, one heredoc for each phase change. It also ran the final verification and the Farley Score one after the other. Three changes cut that time. Every check, gate and guard still runs.

### 1. `build_phase.py` writes the phase record

`scripts/build_phase.py` writes the `/build` phase record in one command:

| Command | Effect |
|---|---|
| `build_phase.py implement\|test\|between-steps <N.M> [--plan <path>]` | Writes the record for that phase and step |
| `build_phase.py refactor <N.M> [--plan <path>] [--stage <test file> ...]` | Writes the `refactor` record. `--stage` runs `git add` on the test files and records them in `test_files_staged`. |
| `build_phase.py clear` | Deletes the record |

The record has the five keys in the order that `RECORD_KEYS` in `hooks/lib/build_state.py` reads: `phase`, `step`, `written_at`, `test_files_staged`, `plan_path`. `written_at` is the current UTC time. `plan_path` comes from `--plan`, else from the current record. The record lands at `STATE_RELPATH` under the git root of the cwd: `.pi/dev-team/memory/build-phase.json`, the path that the guards read.

The script exits 0 on success, 1 when staging or writing fails, and 2 on bad arguments. When `git add` fails, it still writes the `refactor` record, because the freeze guards need no git.

Marker rules (`skills/build/SKILL.md`, `agents/software-engineer.md`):

- Never spend a turn on a marker alone. IMPLEMENT, TEST and `between-steps` markers can go out as a parallel call, because no guard reads them.
- Enter REFACTOR with `set -o pipefail; <test command> && python3 "${DEV_TEAM_ROOT}/scripts/build_phase.py" refactor <N.M> --stage <test files>`. So the record exists only on green and matches the index.
- Leave REFACTOR the same way, chained onto the green test run after the refactor. Never chain it onto a command that runs no tests, and never send it beside edits.
- `set -o pipefail` is required in both chains. `&&` sees only the exit status of the last command of a pipeline. Without `pipefail`, a red run piped into `tail` still writes the marker.

The tests-frozen guards (`refactor_test_freeze_guard.py`, `refactor_test_bash_guard.py`, `refactor_test_revert_guard.py`) act only when `phase` is `refactor`. While the record says `refactor`, the revert guard restores test files after every bash call. `test/py/test_build_phase.py` runs the helper against the readers and the three guards.

### 2. Final verification and Farley Score in parallel

In `/build` step 5, the session first resolves step 7 sub-steps 1-2 only: the branch base and the changed test files. Then one message sends two calls, so they run at the same time:

1. One bash call: `build_phase.py clear`, the full suite, and the lint, type-check and complexity tools that the build ran. An `echo "<TOOL>_EXIT=$?"` tag follows each tool. The exit status of the call is only that of the last tool.
2. When step 7 found changed test files, a `qa-engineer` dispatch loads the `farley-score` skill and computes the Farley Score.

Step 7 sub-step 4 presents that result and calls `farley-score` only when step 5 did not dispatch it. The session dispatches the score again after the fix when the suite is red. It also does so when step 6 or a later fix changes or adds a test file. In the full profile, a step 6 fix to a test file costs a second Farley dispatch. Under gate and lean, item 6 of the profile section says the same.

### 3. Review lenses think at medium effort

Review lenses and plan critics think at `effort: medium` (`--thinking medium`), set in the frontmatter of each agent:

| Group | Agents at `medium` |
|---|---|
| Architecture and design | `arch-review`, `component-architecture-review`, `domain-review`, `structure-review`, `refactor-opportunity-review` |
| Code concerns | `ai-provenance-review`, `concurrency-review`, `naming-review`, `performance-review`, `security-review`, `token-efficiency-review` |
| Tests | `test-review`, `test-smell-review` |
| Plan critics | `plan-review-design`, `plan-review-parallelization`, `plan-review-strategic`, `plan-review-ux` |
| Also `medium` | `spec-compliance-review`, `a11y-review`, `doc-review`, `js-fp-review`, `angular-reactivity-review`, `react-reactivity-review`, `vue-reactivity-review` |

`correctness-review`, `plan-review-acceptance`, `software-engineer` and `qa-engineer` stay at `high`.

The frontmatter carries the level, not the dispatch. The `/code-review` core forbids overrides for each call. The `thinking` table in `dev-team.json` remaps every agent at a level, not one agent.

The frontmatter alone did not hold. In a SlopCodeBench run, the main session passed `thinking: "high"` on most dispatches. So `security-review` and most `spec-compliance-review` calls still ran at `high`. Now `resolveThinking` (`lib/agents.ts`) lets a dispatch `thinking` lower the `effort` of an agent, but never raise it. An agent with no `effort`, or a level outside the known order (`off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`), takes the override as given.

## Lean profile (`DEV_TEAM_REVIEW=lean`)

Lean shares most process rules with gate. It adds plan critics and more lenses, and it has no quality bar. Its sections are in `extensions/dev-team/lean/<skill>.md`. Measured runs kept their hidden-test score under lean, with less time and cost than the full profile (see [Measured results](#measured-results)).

Lean and gate share these rules. The gate sections above give the measured reason for each.

| Area | Shared rules |
|---|---|
| Implementer | One dispatch for each slice, the test budget, the inlined skills |
| Review | Only `error` findings fixed, in one round. `lizard` at every checkpoint, the diff file, no step 6 backstop. |
| Cost | The Farley Score off unless `DEV_TEAM_FARLEY=on`, short dispatch tasks, short plans |
| `/ship`, `/code-review` | The same `/ship` step 5 change, and the same fix loop: only errors, one iteration |

| Area | Lean | Gate |
|---|---|---|
| Dev-team guide | A profile line, no quality bar, no example check | A profile line, `QUALITY_BAR`, and `EXAMPLE_BAR` when the check is on |
| Plan critics | At most the `standard` tier, one revision round, the plan path passed to each critic | None |
| Lenses before the last slice | `spec-compliance-review`, `correctness-review`, `structure-review`, `test-review` | `spec-compliance-review`, `correctness-review` |
| Last slice checkpoint | Every selected lens over every production and test file that the build changed | The two lenses, plus `refactor-opportunity-review` and `security-review` when selected |
| Report files, Feedback & Learning | As the skill says | No report files. Feedback & Learning skipped with no human. |

Under lean, a `complex` plan gets `plan-review-acceptance` and `plan-review-design`. `plan-review-ux` and `plan-review-parallelization` join under the conditions of the standard tier.

Why core lenses before the last slice: look at the run file_merger 5076bf3, with four SlopCodeBench checkpoints. There the nine other lenses took about a third of the agent spend, over 11 rounds each. They returned no issue in 63-82% of their runs. The last slice checkpoint still runs every selected lens once over every file.

## Full profile (`DEV_TEAM_REVIEW=full`)

The full profile adds nothing to the skill text. The skill text, the guide and every agent prompt run as written in `skills/` and `agents/`. In code, the full profile gets no section (`reviewProfileNote`), no guide line (`reviewProfileGuideLine`), unchanged arguments (`reviewProfileArgs`), no agent note and no inlined skills.

Full runs every review step that the skills describe, for example the plan critics of each tier and the step 6 backstop review. It always runs the Farley Score. The rules that live in the agent and skill files still apply: [the request as the spec](#the-request-as-the-spec), [lean production code](#lean-production-code-all-profiles) and the [speed-ups](#speed-ups-all-profiles).

## Measured results

All runs are SlopCodeBench runs. Commits and harness names identify each run.

### Review profiles

| Run | Result |
|---|---|
| Runs with the full profile | Review panels: 47-53% of the dollar cost. Review-fix implementer: 13-21% of wall time. Review fixes changed no hidden-test result. |
| file_merger 5076bf3, 4 SlopCodeBench checkpoints | Nine non-core lenses: about a third of the agent spend, 11 rounds each. They found no issue in 63-82% of runs. 9 findings only said the diff was unavailable. |
| file_merger af34311 | Implementer: 63% of wall time. 465 subprocess tests in 7,144 lines for 1,808 program lines (plain pi: 59 tests, same hidden-test score). One full-suite run: about 3 minutes. Farley: 4 dispatches, 12 minutes, $1.25, scores 8.76-8.93, no file changed. |
| file_merger 6e89570 | Each call: about 2-3 s plus about 15 s for each thousand output tokens. Tools: under 5% of implementer time. Main session: 28k output tokens restating the plan, 20k writing plans. One checkpoint breach: a 5-minute implementer dispatch. |
| file_merger r3-r5, critiques and ablations | Quality bar: erosion 0.40-0.54 to 0, CC 17-18 to at most 10. Full profile without the bar: erosion 0.44, CC 17. pi-gate matched lean on code shape and hidden tests: 31 minutes and $1.70 against 106 minutes and $13.67. |
| Three runs | Nine lenses (structure, test, test-smell, naming, arch, domain, doc, performance, concurrency): 0 errors in 53 dispatches. |
| Report files | About 21k output tokens in each run, read by nobody. |
| 9ea0b54 | One hung test held a fix round for 17 of its 21 minutes. |
| `etl_pipeline`, `execution_server`, gate against pi-gate | Strict 27.3%, isolated 72.7%, core 100%, erosion 0, the same failed tests. |
| Lean on Copilot | 44 model turns, 855 s, only on writing the phase record. |

### Example check

Both measured versions ran on the same 52 SlopCodeBench checkpoints (10 problems, one run each, GPT 6.1 Sol). The baseline is the gate profile without the check: 70.3% of hidden tests.

| Version | Hidden tests | Core / strict SlopCodeBench checkpoints | Code shape | Cost against gate |
|---|---|---|---|---|
| Gate without the check | 70.3% | 20 / 4 | erosion 0.002 | baseline |
| First version (`bbc791c`, harness `1.4.0-pdtbbc791c-examples`) | 77.3% | 28 / 6 | erosion 0.003, CC 9.9 | about 15% more |
| Current version (`2004010`, harness `pidt-gate-examples5`) | 78.2% | 29 / 6 | erosion 0.001 | about 10% more |

An earlier reading of 58% more cost for the first version came from that run reporting prices at half rate.

Split by problem:

| Problems | First version | Current version | Gate without the check |
|---|---|---|---|
| Four tuned problems (`trajectory_api`, `file_backup`, `layered_config_synthesizer`, `recli`) | The gain came from these four | 77.8% and 77.1% (two runs) | 61.9% |
| Six held-out problems | Tied (+6 of 2,959 tests) | 78.6% | 78.4% |

The check helps where requests show concrete examples, and otherwise costs little. The hardening (newer-request superseding, rejected inputs that still fail, the input-line check) and the approved examples were in the current version that scored 78.2%.

Variants measured and not used:

| Variant | Result |
|---|---|
| A frozen executable spec with a separate scenario author | 67.5%, about twice the cost. Frozen cases that contradicted later requests cost 608 tests. |
| Two versions with more derived-case and wording rules | 78.6%, one run, about 35% more cost, and structural erosion above 0 |

Measurements that shaped the check:

| Run | Result |
|---|---|
| Failure analysis: three full runs, 196 SlopCodeBench checkpoints each | `trajectory_api`: 126 hidden tests lost to microseconds in each GPT run. `file_backup`: 70 tests lost to `+00:00`. |
| First smoke run: four problems, 21 SlopCodeBench checkpoints | 90 hidden regression tests lost to cases retired by one sentence |
