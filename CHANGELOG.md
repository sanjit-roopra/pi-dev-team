# Changelog

All notable changes to this package. Each entry is the subject of a commit on the main line, written by `devtools/changelog.py` when the version is bumped. A pull request shows as its title with a link.

## [0.6.0] - 2026-11-22

- Name the model tiers by size instead of after Claude models ([#68](https://github.com/sanjit-roopra/pi-dev-team/pull/68))
- Say in the README that /specs asks for examples ([#67](https://github.com/sanjit-roopra/pi-dev-team/pull/67))
- Bring the docs in line with the code and make them shorter ([#66](https://github.com/sanjit-roopra/pi-dev-team/pull/66))
- Make pi-dev-team its own package for pi ([#65](https://github.com/sanjit-roopra/pi-dev-team/pull/65))
- Example check v5, on by default ([#64](https://github.com/sanjit-roopra/pi-dev-team/pull/64))
- Add an opt-in example check to the gate profile ([#62](https://github.com/sanjit-roopra/pi-dev-team/pull/62))
- Make gate the default review profile ([#61](https://github.com/sanjit-roopra/pi-dev-team/pull/61))
- Add an opt-in gate review profile ([#60](https://github.com/sanjit-roopra/pi-dev-team/pull/60))
- Make lean the default and trim lean turns ([#58](https://github.com/sanjit-roopra/pi-dev-team/pull/58))
- Cap lean tests, coarsen the lean cadence and make the Farley Score opt-in ([#57](https://github.com/sanjit-roopra/pi-dev-team/pull/57))
- Run only the core lenses until the last lean slice ([#56](https://github.com/sanjit-roopra/pi-dev-team/pull/56))
- Let a dispatch lower an agent's effort but never raise it ([#55](https://github.com/sanjit-roopra/pi-dev-team/pull/55))
- docs: add spend dashboard screenshot to README ([#29](https://github.com/sanjit-roopra/pi-dev-team/pull/29))
- Keep the user's request as the spec, add a lean review profile and faster builds ([#54](https://github.com/sanjit-roopra/pi-dev-team/pull/54))
- Show a brief before plain requests change files ([#53](https://github.com/sanjit-roopra/pi-dev-team/pull/53))
- Never wait on the user: time out questions and confirm CAUTION commands first ([#51](https://github.com/sanjit-roopra/pi-dev-team/pull/51))
- Keep agent rows single-line and send noticed problems to issues ([#48](https://github.com/sanjit-roopra/pi-dev-team/pull/48))
- Warn when a writer shares its directory with agents running at once ([#42](https://github.com/sanjit-roopra/pi-dev-team/pull/42))
- Stop the port from silently advertising or dropping things it does not have ([#45](https://github.com/sanjit-roopra/pi-dev-team/pull/45))
- Treat external content as data, cap web_fetch, and fix qa-engineer's bash scope ([#38](https://github.com/sanjit-roopra/pi-dev-team/pull/38))
- Save every subagent output and dispatch the review roster once ([#49](https://github.com/sanjit-roopra/pi-dev-team/pull/49))
- Count a subagent as ok only when it really finished ([#47](https://github.com/sanjit-roopra/pi-dev-team/pull/47))
- Warn when a hook guard fails instead of skipping it silently ([#50](https://github.com/sanjit-roopra/pi-dev-team/pull/50))
- Split docs from code in the session report and record the port version ([#52](https://github.com/sanjit-roopra/pi-dev-team/pull/52))
- Drop the mutation-gate claim, ship no fixture node_modules, test the watchdog ([#44](https://github.com/sanjit-roopra/pi-dev-team/pull/44))
- Make /continue resume from the build-phase record without asking ([#40](https://github.com/sanjit-roopra/pi-dev-team/pull/40))
- Stop loading the context and metrics skills on every task ([#43](https://github.com/sanjit-roopra/pi-dev-team/pull/43))
- Drop the false worktree baseRef warning from /build ([#39](https://github.com/sanjit-roopra/pi-dev-team/pull/39))
- Drop stale numbers and the finished plan from PORTING.md ([#41](https://github.com/sanjit-roopra/pi-dev-team/pull/41))
- Keep the plan file as current state, not a log ([#35](https://github.com/sanjit-roopra/pi-dev-team/pull/35))
- Keep port-side skill fixes from being reverted by the next sync ([#46](https://github.com/sanjit-roopra/pi-dev-team/pull/46))
- Put a mid-line review scope marker on its own line before dispatch ([#36](https://github.com/sanjit-roopra/pi-dev-team/pull/36))
- Run the tests and a typecheck on every PR and push to main ([#37](https://github.com/sanjit-roopra/pi-dev-team/pull/37))
- Block pi-subagents in dev-team sessions and stop runaway tool-call streams ([#30](https://github.com/sanjit-roopra/pi-dev-team/pull/30))
- Frame the /spend overlay and draw the month as daily bars ([#28](https://github.com/sanjit-roopra/pi-dev-team/pull/28))
- Make /spend a small dashboard: daily trend, agent models, colours ([#27](https://github.com/sanjit-roopra/pi-dev-team/pull/27))
- Keep live subagent progress rows steady while agents work ([#26](https://github.com/sanjit-roopra/pi-dev-team/pull/26))
- Halve the README and point it at /spend for spend ([#25](https://github.com/sanjit-roopra/pi-dev-team/pull/25))

## [0.5.0] - 2026-10-15

- Split /spend into its own extension so it runs without dev-team ([#24](https://github.com/sanjit-roopra/pi-dev-team/pull/24))
- Generate CHANGELOG.md on version bump and publish it as the GitHub Release ([#23](https://github.com/sanjit-roopra/pi-dev-team/pull/23))

## [0.4.0] - 2026-10-10

- Write less production code: reuse ladder, simplify lens, lean fix rule ([#22](https://github.com/sanjit-roopra/pi-dev-team/pull/22))
- Report output tokens and committed lines per pi session ([#21](https://github.com/sanjit-roopra/pi-dev-team/pull/21))
- Slim /code-review: short core, full upstream text in references ([#20](https://github.com/sanjit-roopra/pi-dev-team/pull/20))
- Add a pi session report tool and a skill to debug pi-dev-team sessions ([#19](https://github.com/sanjit-roopra/pi-dev-team/pull/19))
- Retry a stuck /build step once on the next stronger tier ([#18](https://github.com/sanjit-roopra/pi-dev-team/pull/18))
- Suggest a cheaper model preset in /dev-team doctor ([#17](https://github.com/sanjit-roopra/pi-dev-team/pull/17))
- Show live progress while dev-team agents run ([#16](https://github.com/sanjit-roopra/pi-dev-team/pull/16))

## [0.3.0] - 2026-10-07

- Share cached prompt prefixes across agents, skip repeated reads ([#15](https://github.com/sanjit-roopra/pi-dev-team/pull/15))
- Keep command-running skills out of the orchestrator agent ([#14](https://github.com/sanjit-roopra/pi-dev-team/pull/14))

## [0.2.2] - 2026-10-06

- Stop the sensitive-file guard from blocking harmless files ([#13](https://github.com/sanjit-roopra/pi-dev-team/pull/13))
- Cut token spend: compact at 200k tokens, slimmer subagent prompts ([#12](https://github.com/sanjit-roopra/pi-dev-team/pull/12))
- Show live progress of agents that subagents dispatch ([#10](https://github.com/sanjit-roopra/pi-dev-team/pull/10))
- Match the e2e usage tests to the all-providers message ([#11](https://github.com/sanjit-roopra/pi-dev-team/pull/11))

## [0.2.1] - 2026-10-06

- Publish to npm from GitHub Actions on version tags ([#9](https://github.com/sanjit-roopra/pi-dev-team/pull/9))
- Add npm metadata for the pi package gallery ([#8](https://github.com/sanjit-roopra/pi-dev-team/pull/8))
- Show every provider in /dev-team usage ([#7](https://github.com/sanjit-roopra/pi-dev-team/pull/7))
- Keep pull request and issue text short and plain ([#6](https://github.com/sanjit-roopra/pi-dev-team/pull/6))
- Add /dev-team usage: graphical Copilot AI credits overlay ([#5](https://github.com/sanjit-roopra/pi-dev-team/pull/5))
- Show GitHub Copilot AI credits next to the USD cost ([#4](https://github.com/sanjit-roopra/pi-dev-team/pull/4))
- Fix pi package update instructions
- Rewrite the README for first-time users ([#3](https://github.com/sanjit-roopra/pi-dev-team/pull/3))
- Follow pi 1.0 extension best practices ([#2](https://github.com/sanjit-roopra/pi-dev-team/pull/2))
- Sync upstream dev-team v14.0.0 and align subagents with pi ([#1](https://github.com/sanjit-roopra/pi-dev-team/pull/1))
- Fix coexistence with pi-subagents by namespacing dev-team dispatch
- Initial pi-dev-team port with local artifact exclusions
