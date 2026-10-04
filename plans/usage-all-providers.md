# Plan: `/dev-team usage` for every provider

## Goal

`/dev-team usage` shows all spend, not only GitHub Copilot. A user who mixes providers (for example the main session on OpenAI and the agents on Copilot) sees the USD cost of everything, the AI credits of the Copilot part, and how the spend divides between providers, models and agents.

## Decisions (user, 2026-10-04)

- Bars and shares measure USD, because every provider reports it. A row that Copilot served also shows its AI credits. With only Copilot, the ranking is the same as before.
- A third view, By provider. A provider split bar above the thread split. Each agent row names its provider; an agent that ran on two providers has one row for each.
- A run that cost $0 (a local model, or a provider with no price in pi's catalog) still shows, with its token count. It ranks after the paid rows and has a 0% share.

## Acceptance criteria

1. The overlay and the text summary count runs from every provider. A run counts when it has a cost or tokens.
2. The header shows the USD total. It adds the AI credits total when Copilot served any run.
3. Views: By model, By provider, By agent. `Tab` and `Shift+Tab` walk them.
4. Each row shows USD, the AI credits when Copilot served it, and the share of the view's USD total. When any row in the view cost $0, every row also shows its tokens.
5. Model rows name the provider (`openai/gpt-5.5`), because two providers can serve models with the same name.
6. Agent rows are one per agent and provider: `software-engineer · github-copilot`.
7. The provider split bar shows each provider's share of the USD total. The thread split bar shows main, subagents and overhead in USD.
8. The empty state says "No usage in this session" (or "this month").
9. The status line `GitHub Copilot: N AI credits` does not change.
10. The text summary carries the same totals, splits and ranked sections.

## Slices

1. Breakdown: totals of USD, credits and tokens per model, provider, agent and provider, and thread, for every provider. Formatters for USD and tokens.
2. Chart: rows carry USD, credits and tokens; optional credits and tokens columns. The split bar takes any segment list.
3. Overlay, state and text summary: the provider view, both split bars, header, empty state, theme colours.
4. README and PORTING.

## Risks

- USD for a subscription provider (Copilot, a ChatGPT or Claude plan) is pi's catalog price, not what the plan bills. The README says so.
- A subagent run that switched models mid-run is booked to its last model, as before.
