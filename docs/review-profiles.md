# Review profiles and the example check

A review profile sets how much review `/plan`, `/build`, `/code-review` and `/ship` run. The default profile is `gate`, with the [example check](#example-check) on.

Some rules apply in every profile: the request as the spec, lean production code, the phase record helper and the effort of each agent. See [Rules in the prompt files](architecture.md#rules-in-the-prompt-files) and [Frontmatter in the agent process](architecture.md#frontmatter-in-the-agent-process). The runs behind two of these rules are [`file_backup` on Sol and on Opus](#run-file-backup-sol-opus) (open questions stay open) and [Lean on Copilot](#run-lean-copilot) (the phase record helper).

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

A cloned repository must not be able to turn review down. These rules apply:

- A configuration file's `env` cannot set `DEV_TEAM_REVIEW` or `DEV_TEAM_EXAMPLES`. The extension takes them from the shell and writes them again into the session, each child agent and each hook.
- A project configuration file cannot set `DEV_TEAM_FARLEY`. The extension reads it from the shell at the first load only. If your own `~/.pi/agent/dev-team.json` sets it in `env`, a `/reload` and each child session read that value.
- The extension ignores case and spaces. An unknown `DEV_TEAM_REVIEW` value selects `gate`, and the top session shows one warning.

How the extension writes these variables: [Environment that the extension sets](architecture.md#environment-that-the-extension-sets).

## Compare the profiles

| Area | Gate (default) | Lean | Full |
|---|---|---|---|
| Dev-team guide | A profile line, the [quality bar](#the-quality-bar), and the example check rules when the check is on | A profile line, no quality bar | Unchanged |
| Example check | On by default | Off | Off |
| Plan critics | None | At most the `standard` tier, one revision round, the plan path passed to each critic | Every tier, as the skill says |
| Lenses before the last [slice](#terms) | `spec-compliance-review`, `correctness-review` | Those two, `structure-review` and `test-review` | Every selected lens, as the skill says |
| Last slice [checkpoint](#terms) | The two lenses, plus `refactor-opportunity-review`, and `security-review` when selected | Every selected lens over every production and test file that the build changed | As the skill says |
| Fixes | Only `error` findings, in one round | Only `error` findings, in one round | As the skill says |
| Step 6 backstop review | Skipped (`--backstop-review=skip`) | Skipped (`--backstop-review=skip`) | Runs |
| Implementer | One dispatch for each slice, the test budget, short tasks | One dispatch for each slice, the test budget, short tasks | As the skill says |
| `/ship` step 5 | `/code-review` only over the files that no `/build` checkpoint reviewed | The same as gate | As the skill says |
| Farley Score | Only with `DEV_TEAM_FARLEY=on` | Only with `DEV_TEAM_FARLEY=on` | When the branch changed test files |
| Report files, Feedback & Learning | No report files. Feedback & Learning skipped when no human is attached. | As the skill says | As the skill says |

Only the skills of this package get a profile section. A project skill with the same name, for example a project `build` skill, runs as written, with unchanged arguments.

## Gate profile (default)

Gate puts the quality bar in every session and removes review steps that measured nothing. The bar is in the dev-team guide (`QUALITY_BAR` in `extensions/dev-team/lib/review-profile.ts`). So it binds the session itself (plain requests, `/fix`, fix rounds) as well as the implementer of `/build`.

The extension adds a gate section to `/plan`, `/build`, `/code-review` and `/ship` when each skill expands (see [Expansion and arguments](architecture.md#expansion-and-arguments)). For the runs that made gate the default, see [gate against pi-gate](#run-gate-vs-pi-gate) and [r3-r5](#run-r3-r5).

### The quality bar

The bar has five rules:

1. Every function has a cyclomatic complexity of at most 10, at most 60 lines and at most 5 parameters. The project linter (`ruff check` for Python) reports nothing on changed files.
2. Before the agent reports code work done, it runs the linter and `lizard -w -C 10 -L 60 -a 5 <changed source files>`. It installs `lizard` into the project environment when it is missing. It fixes every finding and runs both again until they are clean.
3. The agent writes the least code that works. It uses what the codebase, the standard library or an installed dependency already has. It writes no speculative options, no wrapper, factory or layer used once, and no duplicated logic: "fewer lines, never denser lines". It never cuts input validation or error handling at a real boundary to save lines. The [rules in the prompt files](architecture.md#rules-in-the-prompt-files) give the details.
4. Every test command runs under `timeout 600` (or the platform equivalent). So a hung test fails after 600 seconds ([9ea0b54](#run-9ea0b54)).
5. Where the spec is silent, the agent follows the established standard for the interface. The bar names JSON Pointer error locations, RFC 9457 error bodies, RFC 9110 status codes and ISO 8601 times. Where the spec is explicit, the spec wins.

Rule 5 is experimental, and its first run showed no change ([rule 5 run](#run-rule-5)). Where the request has an example on a point, the example decides (see the [example check](#example-check)).

### What gate changes

Each rule links to the run that measured it.

| Command | Gate rule | Evidence |
|---|---|---|
| `/plan` | No plan critics. The plan says `Plan review: skipped (gate profile)`, and the session writes each open question under `## Risks & Open Questions`. | [Plan critics](#run-plan-critics) |
| `/plan` | Gherkin scenarios only for behavior that the request states or that an example shows. Each TEST line names only its scenarios and the request rules that no scenario covers. | [af34311](#run-af34311) |
| `/plan` | A short plan with only the sections that `/build` reads. Each criterion, step part and open question gets one line, and each scenario three to five lines. | [6e89570](#run-6e89570) |
| `/build` review | At every checkpoint, only `spec-compliance-review` and `correctness-review`. At the last slice checkpoint, also `refactor-opportunity-review` over every production file that the build changed, and `security-review` when the resolver selected it. The other lenses are recorded as `skipped (gate profile)`. | [Nine lenses](#run-nine-lenses) |
| `/build` review | `trivial` and `standard` steps defer review to the slice checkpoint. `complex` steps keep their sub-step 4 review. All selected lenses go out at once. | [Full profile runs](#run-full-profile) |
| `/build` review | Fix only `error` findings, in one round. After a round that fixed a `spec-compliance-review` error, `spec-compliance-review` runs once more in verification mode. An error still open after the round goes in the build report. It stops the build only when tests or lint are red. | [Full profile runs](#run-full-profile) |
| `/build` review | `lizard` (and `jscpd`, when installed) runs at every checkpoint, through `skills/static-analysis-integration/adapters/lizard-adapter.py`. Each threshold breach and each clone in a changed file is an `error`. Without this rule, `lizard` runs only in the step 6 backstop, which gate skips. | [r3-r5](#run-r3-r5) |
| `/build` review | Every lens task names a scoped diff file, `.pi/dev-team/memory/reviews/diff-<slice>.patch`, because lenses have no shell. | [5076bf3](#run-5076bf3) |
| `/build` review | No step 6 backstop review: `/build` runs with `--backstop-review=skip`. The gate slice checkpoints are the enclosing review that the flag requires. Files that no checkpoint reviewed still get `/code-review --internal`. | [Full profile runs](#run-full-profile) |
| `/build` implementer | One `software-engineer` dispatch for each slice. It works one step at a time: implement, write the tests, run only that step's tests once, refactor once. | [af34311](#run-af34311) |
| `/build` implementer | Lint, type-check, `lizard` and the full suite run once, in one bash call, at the end of the task. The implementer fixes each `lizard` breach itself. | [af34311](#run-af34311), [6e89570](#run-6e89570) |
| `/build` implementer | Test budget: one test for each Gherkin scenario, plus one for each request rule that no scenario covers. No tests of internal helpers, resource or memory bounds, signals, injected filesystem failures or permutation matrices, unless the request asks. `test-review` and `test-smell-review` get the same budget. | [af34311](#run-af34311) |
| `/build` implementer | The Farley Score (a `qa-engineer` dispatch at step 7) runs only with `DEV_TEAM_FARLEY=on`. The score never gates `/pr`. | [af34311](#run-af34311) |
| `/build` implementer | The skills `quality-gate-pipeline` and `systematic-debugging` are part of the `software-engineer` prompt, so a new dispatch does not read them again. | None |
| `/build` tasks | A dispatch task has about 150 words. It names the plan path, the slice and step ids, the files, the diff or findings file and the constraints. A fix-round task lists each error in one line: `lens: file:line: what to fix`. | [6e89570](#run-6e89570) |
| `/build` tasks | The implementer chains each `build_phase.py` marker onto a neighboring bash call, and commits once for each task. | [6e89570](#run-6e89570) |
| `/build` tasks | No report files. The final message of an agent is its report, at most 300 words for `software-engineer`. | [Report files](#run-report-files) |
| `/build` tasks | With `DEV_TEAM_INTERACTIVE` unset, `/build` skips the Feedback & Learning step. | [Headless runs](#run-headless) |

To change one of these rules, see [Measure a change to the default flow](../CONTRIBUTING.md#measure-a-change-to-the-default-flow).

### What still runs under gate

Gate removes review layers, not checks. These still run, and their errors are fixed:

- The step 3 `spec-compliance-review` check, and `spec-compliance-review` and `correctness-review` at every checkpoint.
- The static self-heal pass (lint, format and type-check lanes, such as `ruff` and `mypy`) and the per-step lint and type-check self-verification.
- Runtime verification (sub-step 4.9), invariants (sub-step 4.10) and the step 5 full-suite run.
- `/code-review` run by itself: the step 2b static pre-pass and the full panel that the resolver selects. Its fix loop fixes only errors, in one iteration.
- `/ship` step 5: `ship_review_gate.py` first, then `/code-review` over only the changed files that no `/build` checkpoint reviewed. The step 2b static pre-pass runs over every changed file.

`/ship` does not run the full panel again over reviewed files. The checkpoints record unfixed `warning` findings as `findings`, so `ship_review_gate.py` does not clear those (lens, file) pairs. A second panel reviews them again and adds nothing.

## Lean profile

Start pi with `DEV_TEAM_REVIEW=lean`. Lean shares most process rules with gate (see [Compare the profiles](#compare-the-profiles)). It adds plan critics and more lenses, and it has no quality bar and no example check. Its sections are in `extensions/dev-team/lean/<skill>.md`.

Under lean, a `complex` plan gets `plan-review-acceptance` and `plan-review-design`. `plan-review-ux` and `plan-review-parallelization` join under the conditions of the standard tier.

Before the last slice, lean runs only four core lenses, because the nine other lenses returned no issue in 63-82% of their runs ([5076bf3](#run-5076bf3)). The last slice checkpoint still runs every selected lens once over every file. Measured runs kept their hidden-test score under lean, with less time and cost than the full profile (see [Review profile runs](#review-profile-runs)).

## Full profile

Start pi with `DEV_TEAM_REVIEW=full`. The skills, the guide and every agent prompt run as written in `skills/` and `agents/`. Full adds no profile section, no guide line, no agent note and no inlined skills, and it leaves the arguments unchanged.

So full runs every review step that the skills describe, for example the plan critics of each tier and the step 6 backstop review. It runs the Farley Score whenever the branch changed test files, whatever `DEV_TEAM_FARLEY` is. The [rules in the prompt files](architecture.md#rules-in-the-prompt-files) still apply.

## Example check

The example check is on by default under gate. To turn it off, start pi with `DEV_TEAM_EXAMPLES=off`. It does not run under lean or full.

The check makes the examples that a request shows into its acceptance tests. A rule that the model applied by judgment missed. Outputs that differed from an example lost 126 hidden tests on `trajectory_api` and 70 on `file_backup` ([failure analysis](#run-failure-analysis)). The `lizard` bar, a command with an exit code, held. So the example check is a command too.

### What the model does

The gate guide tells the model these steps. They are a summary of `EXAMPLE_BAR` in `lib/review-profile.ts`.

1. Before you write code, run `python3 ${DEV_TEAM_ROOT}/scripts/example_replay.py --format` to see the case format.
2. Copy every input-to-output example of the request into `.dev-team/examples.json` as a case.
3. Before you report code work done, run `python3 ${DEV_TEAM_ROOT}/scripts/example_replay.py` under `timeout 600`.
4. For each failure, fix the program, not the case.
5. Run the script again until it exits 0.

The guide also sets these rules for the cases:

- Copy each expected output exactly as shown. Never change an input that the example shows. Only add what it leaves out.
- The request can say that the caller prepares something, for example that an output directory exists. Then the program creates or tolerates it when it is missing, unless the request names an error for that case.
- Keep the cases of earlier requests (see [Cases across requests](#cases-across-requests)).

`example_replay.py` is stdlib Python. Exit codes: 0 means that every check holds and every case passes. 1 means that a check or a case failed. 2 means that the case file is unusable.

| Flag | Default | Effect |
|---|---|---|
| `--cases FILE` | `.dev-team/examples.json` | The case file |
| `--requests DIR` | `.pi/dev-team/memory/requests` | The saved requests |
| `--root DIR` | `.` | The project root |
| `--only ID` | all cases | Run only this case id. You can repeat it. |
| `--timeout SECONDS` | `30` | The limit for each step and for the server start |
| `--format` | Off | Print the case format and exit 0 |

The `--cases` and `--requests` paths are relative to `--root`. A missing case file runs 0 cases, but the source and coverage checks still run.

### Which requests are saved

A case source must quote a saved request. The extension saves these files in `.pi/dev-team/memory/requests/`:

| What you type | Saved as | When |
|---|---|---|
| `/plan`, `/specs` or `/ship` with request text | `<command>-<time>.md` | In every profile, also in a session that another session started |
| A request that is not a command | `request-<time>.md` | Only under the example check, in a session that you started (also a top-level `pi -p`), while the agent is idle |
| Examples that you approve in `/specs` | `approved-<time>.md` | After you approve or edit them (see [Approved examples](#approved-examples-in-specs)) |

The extension saves nothing for text that holds only flags, issue numbers, URLs or paths, for example `/ship 123`. It saves nothing for a message that you send while the agent runs, or in a dispatched agent. How it writes the files: [Saved requests and the request-folder guard](architecture.md#saved-requests-and-the-request-folder-guard).

Do not commit `.dev-team/examples.json` without its requests. Its cases quote them, so cases committed alone fail on a new clone. See [Keep state out of Git](../README.md#keep-state-out-of-git).

### Write a case file

Each case runs in a new temporary directory. The script writes the `files`, starts the optional `server` on a free port, then runs the `steps` in order. A case stops at its first failing step that is not `disputed`.

| Field | Meaning |
|---|---|
| `id`, `source` | The case name, and the example copied character for character from a saved request |
| `files`, `server` | Input files for the case directory, and an optional server command |
| `steps` | `run` steps (`stdin`, `stdout`, `stderr`, `exit`), `http` steps (`body`, `headers`, `status`, `response`) and `files` steps |
| `vary`, `save` | Generated values compared by shape, and values stored for later steps |
| `superseded_by`, `disputed` | A quote that retires a case, or a quote that disputes one step |

| Placeholder | Value |
|---|---|
| `{root}` | The project root |
| `{tmp}` | The case directory |
| `{port}` | A free port |
| `{name}` | Each value that a step saved |

Other rules for a case:

- A `run` command without `{root}` is setup. It must exit 0 unless it names `exit`.
- A step checks only what it names, and a case must check something.
- A top-level `skipped` list holds code blocks that are not examples, each with a `block` and a `reason`.

| Match mode | Rule |
|---|---|
| `exact` | The text must be equal. The check ignores line endings and trailing whitespace. This is the default for text. |
| `json` | The JSON must be equal. The check ignores key order and compares numbers by value. JSON lines compare as a list. This is the default when the expected value is JSON. |
| `subset` | The check works like `json`, but objects can have keys that the example omits. |
| `excerpt` | The shown lines must appear in the output in order. `...` lines stand for omitted lines. Use it for an example that leaves out lines with `...`. |
| `shape` | The text must have the same shape, as for `vary`. |

`subset` and `excerpt` need `...` in the source, or a `why` quote of request text that says the example is partial. `unordered: true` compares JSON arrays as multisets, only where the request says that the order is unspecified.

Put only values that the program generates (ids, timestamps, random tokens) under `vary`. A value that the request defines (a count, a sum, a status, a name) never goes there. `save` an id that a later example reuses. Shape rules for `vary` values:

- A run of digits matches any digits.
- A hex run matches any hex of the same case. A hex run has 4 or more characters, with a digit and a letter, as in a UUID or a hash.
- An expected value written as `<description>` matches any non-empty string.
- Every other character must be equal. So `2025-10-12T14:03:22Z` rejects `2025-10-12T14:03:22.148842Z` and `2025-10-12T14:03:22+00:00`.

### Source and coverage checks

The script also compares the case file with the saved requests, so the model cannot make a case fit the code:

- The `source` of each case must be word for word in a saved request. Whitespace can differ.
- Every expected value must appear whole in that source.
- Every fenced code block of every saved request must be covered by a case source or skipped with a reason.
- An input file line (`key: value`) is reported when the source shows that key with another value.

Setup steps that state no expected output need no source.

### Cases across requests

Cases persist across requests. A later change that breaks an earlier example fails the check. These rules decide when a case stops counting:

- A case stops counting only when `superseded_by` quotes text from a request newer than the source of the case. One sentence cannot retire several cases.
- A superseded case still runs, and its failure is shown, not counted. It still fails when the program now rejects its input (non-zero exit, 4xx or 5xx status).
- An input line whose key the source shows with another value is reported.

Each rule closes a gap that a smoke run found (see [smoke runs](#run-smoke-runs)).

`disputed` on a step quotes request text, word for word, that contradicts the example of that step. A disputed step that fails is reported and does not fail the run. It is not for a format, precision or suffix that the text leaves open: there the example decides.

`example_replay.py` orders the saved files by the time in their names. So `approved-`, `request-`, `plan-`, `specs-` and `ship-` files interleave. An approval can supersede the example of an older request, not of a newer one.

### Approved examples in /specs

A vague request shows no examples, so the check passes with 0 cases. The spec that `/specs` writes is the model's own text and is never saved, so its examples cannot be sources. Approved examples fill that gap.

With the check on, `/specs` gets one step after Step C, from `extensions/dev-team/gate/specs-examples.md`. For each criterion that the request shows no example for, the model proposes small input-to-output examples. It then calls `dev_team_approve_examples`, and pi asks "Are these the right examples?".

| Answer | What the extension saves | `source` returned |
|---|---|---|
| Approve | The exact `examples` string that the dialog showed | `user`, with the path |
| Edit them first | The text from the editor | `user`, with the path |
| Reject | Nothing | `user`, with `rejected` |
| `Esc`, or an empty editor | Nothing | `skipped` |
| No answer in time | Nothing. When `notify` is set, the extension sends the away message to it. | `timeout` |
| No human attached (`DEV_TEAM_INTERACTIVE` is not `1`, see [Environment that the extension sets](architecture.md#environment-that-the-extension-sets)) | Nothing | `no human` |

In wait mode, the dialog never times out.

A saved answer goes to `.pi/dev-team/memory/requests/approved-<iso time>.md`, with no header. So a case `source` matches it character for character, and its fenced blocks fall under the coverage check. The spec records each saved file as `**Approved examples**: <path>`.

Without a saved answer, the spec logs `assumed (...)` in the Decision Log and lists the examples under `## Decide these`. They are never case sources. Code saves the file, so the model cannot write the tests that grade it. A timeout saves nothing, because a default answer here makes an unread proposal into a test that the program must pass.

The tool refuses input that the dialog cannot show as saved:

- More than 40 lines or 4000 characters of examples. The dialog shows every line at once.
- A `criteria` line over 300 characters, or with a line break.
- Control, format (bidi, zero-width, soft hyphen, tags), private-use and unassigned characters, line and paragraph separators, and blank fillers such as the Hangul fillers. Tab and newline are allowed.

Benchmark runs are headless, so the dialog is not measured.

### If the request guard blocks a call

While the example check is on, the request guard (`lib/request-guard.ts`) blocks the model's own writes to the saved requests.

- Symptom: a call fails with "Saved requests are written by dev-team code only (the example check takes them as the human's own words)."
- Cause: the call writes, moves or deletes something in `.pi/dev-team/memory/requests/`, or in a folder above it.
- Fix: show the examples to the human with `dev_team_approve_examples`. An approval saves them there.

What the guard blocks, and what gets past it: [The guard](architecture.md#the-guard).

### Limits

| Limit | Effect |
|---|---|
| Examples given only in prose | They are not made into cases. |
| Behavior that the request neither states nor shows | It is not checked. |
| Hidden tests that contradict an example of the request | Following the example still loses. |
| A vague request | It shows no examples, so the check passes with 0 cases. [Approved examples](#approved-examples-in-specs) target this limit. |
| The model writes its own case file | The check catches drift from the examples, but not a rule that the model invents and that no example input exercises. |
| A human who approves without reading | The model grades itself again. Short rounds and exact outputs make reading cheap, but nothing enforces it. |
| pi's editor takes no timeout or abort signal | The tool saves nothing on either, but the editor stays open until the human closes it. |
| A reply that you type after the agent stops, inside a flow | It is saved like a new request. A fenced block pasted there needs a case or a skip reason. A message sent while the agent runs is not saved. |
| `/plan`, `/specs` or `/ship` in a session that another session started (`pi -p`, `dev-team-run`) | The command saves the model's arguments as a request, and that file is a valid case source. |
| `example_replay.py --requests DIR` | It points the check at a folder that the model wrote. No hash records which files code saved. |
| The guard is a static scan, not a sandbox | A program that builds the path at run time gets past it. A command that is not a read is blocked when its text names both `memory` and `requests`. See [The guard](architecture.md#the-guard). |

## Measured results

All runs are SlopCodeBench runs. Commits and harness names identify each run.

### Benchmark terms

| Term | Meaning |
|---|---|
| SlopCodeBench | A benchmark of coding problems, scored by hidden tests that the agent never sees |
| SlopCodeBench checkpoint | One spec version of a problem. Not the same as a `/build` [checkpoint](#terms). |
| Erosion, CC | Code-shape scores: structural erosion, and the highest cyclomatic complexity of one function |
| Strict, isolated, core | Solve rates, as the share of SlopCodeBench checkpoints. Strict: all tests pass. Isolated: all tests except the regression tests pass. Core: all core tests pass. |
| Smoke run, ablation run | A short trial run on a few problems, and a run with one rule removed |
| pi-gate | A benchmark arm: plain pi with only the quality bar and `ruff` in its prompt |

### Review profile runs

| Run | Result |
|---|---|
| <a id="run-full-profile"></a>Runs with the full profile | Review panels: 47-53% of the dollar cost. Review-fix implementer: 13-21% of wall time. Review fixes changed no hidden-test result. |
| <a id="run-plan-critics"></a>Runs with plan critics | No blocker that the critics raised changed a test result. The design, UX and parallelization critics approved every plan. |
| <a id="run-nine-lenses"></a>Three runs | Nine lenses (structure, test, test-smell, naming, arch, domain, doc, performance, concurrency): 0 errors in 53 dispatches. |
| <a id="run-5076bf3"></a>file_merger 5076bf3, 4 SlopCodeBench checkpoints | Nine non-core lenses: about a third of the agent spend, 11 rounds each. They found no issue in 63-82% of runs. 9 findings only said the diff was unavailable. |
| <a id="run-af34311"></a>file_merger af34311 | Implementer: 63% of wall time. Each behavior ran its tests two or three times. 465 subprocess tests in 7,144 lines for 1,808 program lines (plain pi: 59 tests, same hidden-test score). One full-suite run: about 3 minutes. Farley: 4 dispatches, 12 minutes, $1.25, scores 8.76-8.93, no file changed. |
| <a id="run-6e89570"></a>file_merger 6e89570 | Each call: about 2-3 s plus about 15 s for each thousand output tokens. Tools: under 5% of implementer time. Main session: 28k output tokens restating the plan, 20k writing plans. One checkpoint breach: a 5-minute implementer dispatch. |
| <a id="run-r3-r5"></a>file_merger r3-r5, four critiques and two ablation runs | One cause of good code shape: keep every function at a CC of 10 or less, run `lizard` and fix. Quality bar: erosion 0.40-0.54 to 0, CC 17-18 to at most 10. Full profile without the bar: erosion 0.44, CC 17. pi-gate matched lean on code shape and hidden tests: 31 minutes and $1.70 against 106 minutes and $13.67. |
| <a id="run-gate-vs-pi-gate"></a>`etl_pipeline`, `execution_server`, gate against pi-gate | Strict 27.3%, isolated 72.7%, core 100%, erosion 0, the same failed tests. |
| <a id="run-rule-5"></a>`etl_pipeline` SlopCodeBench checkpoints 1 to 3, first run with rule 5 | Before rule 5, pi-gate and gate both reported coarse error paths (`steps[1].columns`). The hidden tests expect `steps[1].columns[1]`. With rule 5, the agent still reported the coarse paths. Likely cause: the spec example `pipeline.steps[2].columns` reads as explicit, so "the spec wins" applied. |
| <a id="run-report-files"></a>Report files | About 21k output tokens in each run, read by nobody. |
| <a id="run-headless"></a>Headless runs | The Feedback & Learning step was a no-op in every run. |
| <a id="run-9ea0b54"></a>9ea0b54 | One hung test held a fix round for 17 of its 21 minutes. |
| <a id="run-lean-copilot"></a>Lean on Copilot | 44 model turns, 855 s, only on writing the phase record. |
| <a id="run-file-backup-sol-opus"></a>`file_backup` on Sol and on Opus | Sol: the plan settled two unclear points wrongly as criteria, and every reviewer honored them. Opus: the plan chose the right reading for one and listed the doubt, but `spec-compliance-review` switched the build to the other reading. Checkpoint 2 `total_size` and pack-boundary failures are not targeted: the hidden tests contradict the spec text and its Example 2. |

### Example check runs

Both measured versions ran on the same 52 SlopCodeBench checkpoints (10 problems, one run each, GPT 6.1 Sol). The baseline is the gate profile without the check: 70.3% of hidden tests.

| Version | Hidden tests | Core / strict SlopCodeBench checkpoints | Code shape | Cost against gate |
|---|---|---|---|---|
| Gate without the check | 70.3% | 20 / 4 | erosion 0.002 | baseline |
| First version (`bbc791c`, harness `1.4.0-pdtbbc791c-examples`) | 77.3% | 28 / 6 | erosion 0.003, CC 9.9 | about 15% more (an earlier reading of 58% came from prices at half rate) |
| Current version (`2004010`, harness `pidt-gate-examples5`) | 78.2% | 29 / 6 | erosion 0.001 | about 10% more |

Split by problem:

| Problems | First version | Current version | Gate without the check |
|---|---|---|---|
| Four tuned problems (`trajectory_api`, `file_backup`, `layered_config_synthesizer`, `recli`) | The gain came from these four | 77.8% and 77.1% (two runs) | 61.9% |
| Six held-out problems | Tied (+6 of 2,959 tests) | 78.6% | 78.4% |

The check helps where requests show concrete examples, and otherwise costs little. The current version that scored 78.2% had the hardening (newer-request superseding, rejected inputs that still fail, the input-line check) and the approved examples.

Variants measured and not used:

| Variant | Result |
|---|---|
| A frozen executable spec with a separate scenario author | 67.5%, about twice the cost. Frozen cases that contradicted later requests cost 608 tests. |
| Two versions with more derived-case and wording rules | 78.6%, one run, about 35% more cost, and structural erosion above 0 |

Runs that shaped the check:

| Run | Result |
|---|---|
| <a id="run-failure-analysis"></a>Failure analysis: three full runs (two of them plain pi and the gate profile), 196 SlopCodeBench checkpoints each | The largest losses were outputs that differed from a spec example. Every `trajectory_api` example shows `2025-10-12T14:03:22Z`. Both GPT runs wrote microseconds, and each lost 126 hidden tests. In `file_backup`, the "ISO 8601" sentence of the quality bar produced `+00:00` where the examples show `Z`. That lost 70 tests. |
| <a id="run-smoke-runs"></a>First smoke run: four problems, 21 SlopCodeBench checkpoints | The model added a validation that rejected the inputs of earlier examples. It retired all three earlier cases with one sentence that did not change them: "The `destination` field is now required." The run lost 90 hidden regression tests. |
| Second smoke run | The model quoted slightly different text for each case. Fix: a superseded case still fails when the program rejects its input. |
| Third smoke run | The model copied the earlier cases again, left out the line that its new validation made invalid, and added its own value (`destination: backup://`). The input-line check does not catch this run, because the copied example had no such line. |

## Terms

| Term | Meaning |
|---|---|
| Slice | A group of plan steps that `/build` reviews together |
| Checkpoint | In `/build`: a review point (sub-step 4 after a step, sub-step 6 after a slice). For the benchmark meaning, see [Benchmark terms](#benchmark-terms). |
| Lens | A review agent for one concern, for example `correctness-review` |
| Finding | A lens result with a severity: `error`, `warning` or `suggestion` |
| Dispatch | One run of an agent with a task |
