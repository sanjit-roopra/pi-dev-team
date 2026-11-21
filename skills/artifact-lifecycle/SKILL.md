---
name: artifact-lifecycle
description: >-
  Report on skill and agent usage data from metrics/artifact-usage.json in the
  dev-team folder of the pi agent directory (~/.pi/agent/dev-team/ by default),
  classifying each artifact as active, stale (>= 30 days unused), or an archive
  candidate (>= 90 days unused). Proposes AGENTS.md overrides for stale artifacts
  and exclusions for archive candidates. Pinned skills are always exempt.
  Use when the user asks to "review artifact lifecycle", "find stale skills",
  or "/artifact-lifecycle".
user-invocable: true
allowed-tools: Read, Glob, Bash(date *), Write
---

# Artifact Lifecycle Management

Role: worker. Reads `metrics/artifact-usage.json` in the dev-team folder in your pi
agent directory (`~/.pi/agent/dev-team/` by default), classifies each tracked
artifact by recency, and proposes lifecycle transitions. **Never modifies files
under `${DEV_TEAM_ROOT}`** — changes land exclusively in the project `AGENTS.md`.

You have been invoked with the `/artifact-lifecycle` command.

## Steps

### 1. Check for usage data

Read `${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/dev-team/metrics/artifact-usage.json` (user-scoped — never a project-scoped path).

If the file does not exist, output:

> No usage data available — enable telemetry to begin tracking (see /telemetry)

Then stop. Do not produce a report.

### 2. Load pinned skills

Read the project `AGENTS.md`. Extract the list of skill
names under the `## Pinned Skills` section (if present). These names are exempt
from all lifecycle transitions regardless of `last_used_at`.

### 3. Classify artifacts

Get the current date:

```bash
date -u +%Y-%m-%d
```

For each entry in `artifact-usage.json`, compute `days_since_used` as the
number of calendar days between `last_used_at` and today:

```bash
today=$(date -u +%s)
last=$(date -u -d "<last_used_at>" +%s 2>/dev/null \
  || python3 -c "import datetime; print(int(datetime.datetime.fromisoformat('<last_used_at>'.replace('Z','+00:00')).timestamp()))")
days_since_used=$(( (today - last) / 86400 ))
```

Apply thresholds (both are inclusive):

| Threshold | Classification |
|-----------|----------------|
| `days_since_used < 30` | **active** |
| `days_since_used >= 30` and `< 90` | **stale** |
| `days_since_used >= 90` | **archive candidate** |

Skip any artifact whose name appears in the Pinned Skills list.

### 4. Produce report

#### All active

If every artifact has `days_since_used < 30` (and none are stale or archived):

> All tracked artifacts are active — no lifecycle changes needed.

Stop.

#### Stale and archive sections

Otherwise, produce a report with the following sections (only include sections
that have entries):

```markdown
## Stale Skills (>= 30 days unused)

These skills have not been observed in telemetry for 30 or more days.
Proposal: add each to `## Disabled Skills` in AGENTS.md to stop loading them
until re-enabled.

| Skill | Last used | Days since used |
|-------|-----------|----------------|
| <name> | <last_used_at> | <n> |

## Archive Candidates (>= 90 days unused)

These skills have not been observed for 90 or more days and are candidates for
permanent removal from the active set.

| Skill | Last used | Days since used |
|-------|-----------|----------------|
| <name> | <last_used_at> | <n> |
```

### 5. Propose AGENTS.md changes (interactive)

For each Stale Skill, offer to add it to the `## Disabled Skills` section in
the project `AGENTS.md`. Show the proposed edit as a diff before applying.

Do **not** remove or modify any files under `${DEV_TEAM_ROOT}` (the installed package).
All writes go exclusively to the project `AGENTS.md`.

For Archive Candidates, present the list for human decision — do not auto-apply.

### Pinned skills note

If any artifacts were skipped because they appear in `## Pinned Skills`, note
them separately:

> Pinned (excluded from all lifecycle transitions): <names>

## Constraints

- **Never delete or modify** files under `${DEV_TEAM_ROOT}` during or after execution.
  All lifecycle changes land exclusively in the project `AGENTS.md`.
- Report is advisory; no configuration change is applied without user approval.
- If `artifact-usage.json` contains entries with missing or unparseable
  `last_used_at`, log a warning and skip those entries.
