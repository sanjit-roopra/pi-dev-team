<!-- step 4 (dispatch-capability gate and dispatch waves). Upstream text of skills/code-review/SKILL.md, unchanged; the pi core SKILL.md summarizes it. Everything below the marker is verbatim. -->
<!-- verbatim-below -->
### 4. Run each enabled agent

**Dispatch-capability gate (re-confirm here, not just at the top of this file — issue #1461).** Before spawning anything below, re-verify the `Agent`/`Task` tool is present in this toolset. If it is not, STOP per the Orchestrator constraints above — do not fall back to reviewing the files yourself, inline, as a stand-in for the panel; report the missing capability and halt the run before any agent is spawned.

**Dispatch batching — bounded dispatch waves (issue #1752).** A real run that spawned all 16 eligible agents as parallel `Agent` calls in one message lost its last 6 to `[Tool result missing due to internal error]` — see `dispatch_waves.py`'s module docstring for the full incident account; not restated here to avoid two copies drifting apart. Before spawning, compute the wave split deterministically instead of guessing a safe batch size by eye:

```bash
sh "$CLAUDE_PLUGIN_ROOT/hooks/py.sh" "$CLAUDE_PLUGIN_ROOT/skills/code-review/scripts/dispatch_waves.py" --agents "<comma-separated eligible agent names, cheap-first order as select_lenses.py returned them, filtered by the change-shape/change-size/change-impact gates but not re-sorted>"
```

Prints `{"maxParallel": N, "waves": [[...], [...]]}` — `maxParallel` defaults to **10**, overridable with `DEV_TEAM_MAX_PARALLEL_REVIEW_AGENTS` (see the script's own docstring for the exact fallback rule; don't re-derive it here). Dispatch **exactly the waves the script printed, in that order** as parallel subagents in a single message per wave using the Agent tool — exactly as before, just bounded per message — waiting for each wave to fully return before dispatching the next, and for the last wave before aggregating. A roster no larger than `maxParallel` is always a single wave; nothing changes from today's behavior in that case.

