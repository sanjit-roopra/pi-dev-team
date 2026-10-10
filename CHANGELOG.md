# Changelog

All notable changes to this package. Each entry is a pull request title, written by `devtools/changelog.py` when the version is bumped.

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
