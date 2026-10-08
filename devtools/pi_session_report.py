#!/usr/bin/env python3
"""Report how dev-team ran in recorded pi sessions.

Usage:
  python3 devtools/pi_session_report.py projects
  python3 devtools/pi_session_report.py sessions -p dstm [--since 2026-10-01] [--until 2026-10-08]
  python3 devtools/pi_session_report.py timeline latest -p dstm [--tools]
  python3 devtools/pi_session_report.py tools -p dstm [--large-output-tokens 3500]
  python3 devtools/pi_session_report.py skills -p dstm
  python3 devtools/pi_session_report.py steps -p dstm -s code-review [--outputs dispatch_reconcile.py]
  python3 devtools/pi_session_report.py code -p dstm [--since 2026-10-01]

Every subcommand takes --json and --sessions-dir. sessions, tools, skills,
steps and code also take --since/--until (session start, ISO date or date-time prefix)
and --all-sessions (include sessions that did not use dev-team).

pi stores each session as JSONL under <agent dir>/sessions/<project dir>/. The
format is documented in docs/session-format.md of the installed
@earendil-works/pi-coding-agent package (read against session version 3); a pi
upgrade can change it. Entries form a tree through id/parentId; this script
follows the active branch, the path from the last entry back to the root, which
is what the model saw. Costs are summed over every entry in the file, because
abandoned branches were paid for too.

Subagents run with --no-session, so their own transcripts are not stored. The
parent session keeps one `dev-team-subagent-usage` entry per dispatch (agent,
model, tier, ok, duration, the child's own usage, and `nested` for the agents
the child dispatched itself). Subagent cost counts both, the same rule as the
extension's creditedRuns(). That entry is all this script can say about a child.

The wire strings below are copied from extensions/dev-team; a test checks that
they still appear there. Token counts are estimates: characters / 4, except
`code`, which sums the output tokens the model reported.

`code` counts the lines committed in the session's cwd between its first and
last entry (`git log --all --numstat`), split into test and production files by
path. Commits GitHub made (squash merges, committer noreply@github.com) are
skipped so merged work is not counted twice. Uncommitted work is not counted,
and two sessions open at once in one repository both count the same commits.
Stdlib only, read-only.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import statistics
import subprocess
import sys
from collections import Counter
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path
from typing import Any, Callable, Iterable, Iterator

# Wire strings owned by extensions/dev-team (checked by test_pi_session_report.py).
USAGE_ENTRY = "dev-team-subagent-usage"  # custom entry (pi.appendEntry), one per dispatch
SESSION_START_MESSAGE = "dev-team-session-start"  # custom message, not an entry
SUBAGENT_TOOL = "dev_team_subagent"
SKILL_TOOL = "skill"
HOOK_FEEDBACK_HEADER = "dev-team hook feedback (must address)"  # PostToolUse block, appended to an error result
# PreToolUse blocks. A hook from hooks/hooks.json blocks with an error result "[<hook>] <reason>" (hooks.ts);
# the GitHub style gate blocks with its own feedback text; a hook on an agent dispatch blocks inside the
# dev_team_subagent result (subagent.ts), which writes no usage entry.
HOOK_BLOCK_RE = re.compile(r"^\[([\w.-]+)\] ")  # stored as the bare reason; seen in real sessions
GITHUB_STYLE_BLOCK_PREFIX = "dev-team GitHub style:"
DISPATCH_BLOCK_MARKER = "Dispatch blocked by hook:"
# Where subagent.ts formats a failed task's error: one task, or a section of a parallel call.
DISPATCH_BLOCK_TEXT_RE = re.compile(r"(?m)(?:^Agent \S+ failed: |^Error: )" + re.escape(DISPATCH_BLOCK_MARKER))
HOOKS_JSON = Path(__file__).resolve().parent.parent / "hooks" / "hooks.json"
HOOK_SCRIPT_RE = re.compile(r"hooks/([\w.-]+)\.py")
DEV_TEAM_SIGNATURES = (USAGE_ENTRY, SESSION_START_MESSAGE, "pi-dev-team/skills/")

BASH_TOOL = "bash"
READ_TOOL = "read"
EDIT_TOOLS = {"edit", "write"}
ROLE_USER, ROLE_ASSISTANT, ROLE_TOOL_RESULT = "user", "assistant", "toolResult"
OVERHEAD_ENTRY_TYPES = {"usage", "compaction", "branch_summary"}

# A run of one skill ends where this skill or one of these workflow skills is loaded again.
WORKFLOW_SKILLS = {
    "specs", "plan", "build", "pr", "ship", "code-review", "fix", "triage", "continue",
    "design-doc", "systematic-debugging", "branch-workflow", "autoship", "test-improve",
}
SLASH_SKILL_TAG_RE = re.compile(r'^\s*<skill name="([^"]+)"')
SLASH_INVOCATION_RE = re.compile(r"The user invoked `/\S+(?: ([^`]*))?`")
# dev-team scripts live under scripts/, skills/<name>/scripts/ and hooks/(lib/).
DEV_TEAM_SCRIPT_RE = re.compile(r"(?<![\w-])(?:scripts|hooks)/(?:lib/)?([\w-]+\.py)\b")

LOAD_VIA_SLASH, LOAD_VIA_TOOL = "slash", "tool"
EVENT_SKILL, EVENT_USER, EVENT_DISPATCH, EVENT_AGENT_DONE = "skill", "user", "dispatch", "agent-done"
EVENT_HOOK_BLOCK, EVENT_ERROR, EVENT_COMPACTION, EVENT_MODEL = "hook-block", "error", "compaction", "model"

# Session text is untrusted. Printed text loses terminal control characters and bidi overrides,
# and common secret shapes are masked.
CONTROL_CHARS_RE = re.compile("[\x00-\x1f\x7f-\x9f\u200b-\u200f\u202a-\u202e\u2066-\u2069]")
SECRET_RE = re.compile(
    r"(?i)(bearer\s+)\S+|\b(gh[pousr]_|github_pat_|sk-|xox[bp]-|AKIA)[\w-]{8,}"
    r"|((?:token|secret|password|api[_-]?key)\s*[=:]\s*)\S+"
)

CHARS_PER_TOKEN = 4
LARGE_OUTPUT_TOKENS = 3500
SHORT_ID_LENGTH = 12
TEXT_WIDTH, PROMPT_WIDTH, ARGS_WIDTH, COMMAND_WIDTH, OUTPUT_WIDTH, MAX_COLUMN_WIDTH = 100, 70, 60, 80, 200, 60
KIND_COLUMN_WIDTH = 11

# Test files by path: a test directory, a test_ prefix, a .test/.spec/_test suffix, or a *Test(s) class file.
TEST_PATH_RE = re.compile(r"(^|/)(tests?|__tests__|specs?|features)/|(^|/)test_[^/]*$|[._-](test|spec)\.\w+$|Tests?\.(cs|java|kt)$")
GITHUB_COMMITTER = "noreply@github.com"
GIT_TIMEOUT_SECONDS = 30


def estimate_tokens(text: str) -> int:
    return len(text) // CHARS_PER_TOKEN


def sessions_root() -> Path:
    agent_dir = os.environ.get("PI_CODING_AGENT_DIR")
    return Path(agent_dir).expanduser() / "sessions" if agent_dir else Path.home() / ".pi" / "agent" / "sessions"


def project_label(dir_name: str) -> str:
    return dir_name.strip("-")


def text_of(content: Any) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "\n".join(c.get("text", "") for c in content if isinstance(c, dict) and c.get("type", "text") == "text")
    return ""


def safe(text: Any) -> str:
    """Untrusted text with terminal control characters and bidi overrides replaced (no folding or truncation)."""
    return CONTROL_CHARS_RE.sub("\ufffd", str(text))


def mentions_dev_team(line: str) -> bool:
    return any(s in line for s in DEV_TEAM_SIGNATURES)


@lru_cache(maxsize=1)
def known_hook_names() -> frozenset[str]:
    """Hook names as hooks.ts derives them (hooks/<name>.py). Empty when hooks.json cannot be read."""
    try:
        return frozenset(HOOK_SCRIPT_RE.findall(HOOKS_JSON.read_text(encoding="utf-8")))
    except OSError:
        return frozenset()


def mask_secret(match: re.Match) -> str:
    prefix = match.group(1) or match.group(3)
    return f"{prefix}***" if prefix else f"{match.group(2)}***"


def one_line(text: str, width: int = TEXT_WIDTH) -> str:
    """Untrusted text as one safe line: whitespace folded, control characters replaced, secrets masked, truncated."""
    text = SECRET_RE.sub(mask_secret, CONTROL_CHARS_RE.sub("\ufffd", " ".join(text.split())))
    return text if len(text) <= width else text[: width - 1] + "…"


def cost_of(usage: Any) -> float:
    """A usage's cost: pi's {cost: {total}} on messages, a plain number on dev-team usage entries."""
    cost = (usage or {}).get("cost") if isinstance(usage, dict) else None
    if isinstance(cost, dict):
        cost = cost.get("total")
    return float(cost) if isinstance(cost, (int, float)) else 0.0


def credited_runs(record: dict) -> list[dict]:
    """The child's own run plus every nested run it dispatched; mirrors creditedRuns() in subagent-types.ts."""
    own = [{"agent": record.get("agent"), "usage": record["usage"]}] if record.get("usage") else []
    return own + [n for n in record.get("nested") or [] if isinstance(n, dict)]


def credited_cost(record: dict) -> float:
    return sum(cost_of(run.get("usage")) for run in credited_runs(record))


@dataclass
class ToolCall:
    """One tool call on the active branch, with its result."""

    entry_index: int  # index of the result entry on the active path
    name: str
    args: dict
    result: str
    is_error: bool
    details: dict

    @property
    def post_hook_feedback(self) -> str | None:
        """The PostToolUse feedback the extension appended last to an error result, else None."""
        if not self.is_error or HOOK_FEEDBACK_HEADER not in self.result:
            return None
        return self.result.rsplit(HOOK_FEEDBACK_HEADER, 1)[1].lstrip(":").strip()

    @property
    def guard_blocked(self) -> bool:
        """Stopped before it ran by a PreToolUse hook, the GitHub style gate, or a hook on an agent dispatch."""
        if self.name == SUBAGENT_TOOL:
            return self.dispatch_blocked
        if not self.is_error:
            return False
        if self.result.startswith(GITHUB_STYLE_BLOCK_PREFIX):
            return True
        hook = HOOK_BLOCK_RE.match(self.result)
        return bool(hook) and (hook.group(1) in known_hook_names() or not known_hook_names())

    @property
    def dispatch_blocked(self) -> bool:
        """A hook stopped at least one task of this dispatch; never the agent's own output quoting the marker."""
        results = self.details.get("results")
        if isinstance(results, list) and results:
            return any(isinstance(r, dict) and str(r.get("error") or "").startswith(DISPATCH_BLOCK_MARKER) for r in results)
        return bool(DISPATCH_BLOCK_TEXT_RE.search(self.result))

    @property
    def blocked(self) -> bool:
        return self.post_hook_feedback is not None or self.guard_blocked


@dataclass
class SkillLoad:
    entry_index: int
    name: str
    args_text: str
    estimated_tokens: int
    via: str  # LOAD_VIA_SLASH or LOAD_VIA_TOOL
    turns_in_context: int


@dataclass
class Session:
    path: Path
    header: dict
    entries: list[dict]  # every entry, in file order
    active: list[dict]  # active branch, root first
    calls: list[ToolCall]
    loads: list[SkillLoad]
    uses_dev_team: bool

    @property
    def id(self) -> str:
        return self.path.stem

    @property
    def short_id(self) -> str:
        return self.path.stem.rsplit("_", 1)[-1][-SHORT_ID_LENGTH:]

    @property
    def started(self) -> str:
        return started_of(self.header)


def started_of(header: dict) -> str:
    return str(header.get("timestamp", ""))[:16].replace("T", " ")


def read_entries(path: Path) -> tuple[list[dict], bool]:
    """Parse a session file line by line; skip lines that are not JSON objects. Also report whether dev-team ran."""
    entries, uses_dev_team = [], False
    with path.open(encoding="utf-8", errors="replace") as f:
        for line in f:
            uses_dev_team = uses_dev_team or mentions_dev_team(line)
            try:
                entry = json.loads(line)
            except json.JSONDecodeError:
                continue
            if isinstance(entry, dict):
                entries.append(entry)
    return entries, uses_dev_team


def load_session(path: Path) -> Session:
    entries, uses_dev_team = read_entries(path)
    header = next((e for e in entries if e.get("type") == "session"), {})
    active = active_path(entries)
    calls = tool_calls(active)
    return Session(path, header, entries, active, calls, skill_loads(active, calls), uses_dev_team)


def active_path(entries: list[dict]) -> list[dict]:
    by_id = {e["id"]: e for e in entries if e.get("id") and e.get("type") != "session"}
    leaf = next((e for e in reversed(entries) if e.get("id") in by_id), None)
    path, seen = [], set()
    while leaf is not None and leaf["id"] not in seen:
        seen.add(leaf["id"])
        path.append(leaf)
        leaf = by_id.get(leaf.get("parentId"))
    return path[::-1]


def message_of(entry: dict) -> dict:
    m = entry.get("message") if entry.get("type") == "message" else None
    return m if isinstance(m, dict) else {}


def tool_calls(active: list[dict]) -> list[ToolCall]:
    pending: dict[str, tuple[str, dict]] = {}
    calls = []
    for index, entry in enumerate(active):
        msg = message_of(entry)
        if msg.get("role") == ROLE_ASSISTANT:
            for block in msg.get("content") or []:
                if isinstance(block, dict) and block.get("type") == "toolCall":
                    pending[str(block.get("id", ""))] = (block.get("name", ""), block.get("arguments") or {})
        elif msg.get("role") == ROLE_TOOL_RESULT:
            name, args = pending.pop(str(msg.get("toolCallId", "")), (msg.get("toolName", ""), {}))
            raw_details = msg.get("details")
            details = raw_details if isinstance(raw_details, dict) else {}
            calls.append(ToolCall(index, name, args, text_of(msg.get("content")), bool(msg.get("isError")), details))
    return calls


def slash_skill(msg: dict) -> tuple[str, str] | None:
    """(name, args) when a user message is a skill started by a slash command (skills.ts commandText)."""
    if msg.get("role") != ROLE_USER:
        return None
    text = text_of(msg.get("content"))
    tag = SLASH_SKILL_TAG_RE.match(text)
    if not tag:
        return None
    invocation = SLASH_INVOCATION_RE.search(text)
    return tag.group(1), (invocation.group(1) or "") if invocation else ""


def skill_name(call: ToolCall) -> str:
    """The resolved name the skill tool reports, else its argument without the accepted `/` or `dev-team:` prefix."""
    resolved = call.details.get("skill")
    if resolved:
        return str(resolved)
    raw = str(call.args.get("name") or call.args.get("skill") or call.args.get("command") or "?")
    return raw.lstrip("/").removeprefix("dev-team:")


def skill_loads(active: list[dict], calls: list[ToolCall]) -> list[SkillLoad]:
    call_at = {c.entry_index: c for c in calls}
    position_by_id = index_by_entry_id(active)
    loads = []
    for index, entry in enumerate(active):
        slash = slash_skill(message_of(entry))
        text = text_of(message_of(entry).get("content"))
        if slash:
            loads.append(SkillLoad(index, slash[0], slash[1], estimate_tokens(text), LOAD_VIA_SLASH, 0))
        call = call_at.get(index)
        if call and call.name == SKILL_TOOL and not call.is_error:
            args_text = str(call.args.get("args") or call.args.get("arguments") or "")
            loads.append(SkillLoad(index, skill_name(call), args_text, estimate_tokens(call.result), LOAD_VIA_TOOL, 0))
    for load in loads:
        load.turns_in_context = turns_in_context(active, load.entry_index, position_by_id)
    return loads


def index_by_entry_id(active: list[dict]) -> dict[str, int]:
    return {e.get("id"): i for i, e in enumerate(active)}


def turns_in_context(active: list[dict], index: int, position_by_id: dict) -> int:
    """Assistant turns after `index` until a compaction drops it (a compaction keeps entries from firstKeptEntryId on)."""
    turns = 0
    for i in range(index + 1, len(active)):
        entry = active[i]
        if entry.get("type") == "compaction" and index < position_by_id.get(entry.get("firstKeptEntryId"), i):
            break
        if message_of(entry).get("role") == ROLE_ASSISTANT:
            turns += 1
    return turns


def is_usage_entry(entry: dict) -> bool:
    return entry.get("type") == "custom" and entry.get("customType") == USAGE_ENTRY


def dispatch_records(s: Session) -> list[dict]:
    return [e.get("data") or {} for e in s.entries if is_usage_entry(e)]


def parent_cost(s: Session) -> float:
    return sum(cost_of(message_of(e).get("usage")) for e in s.entries if message_of(e).get("role") == ROLE_ASSISTANT)


def overhead_cost(s: Session) -> float:
    """Spend outside assistant turns: usage entries (for example cache_warm), compaction and branch summaries."""
    return sum(cost_of(e.get("usage")) for e in s.entries if e.get("type") in OVERHEAD_ENTRY_TYPES)


def first_prompt(s: Session) -> str:
    for entry in s.active:
        msg = message_of(entry)
        if msg.get("role") == ROLE_USER:
            slash = slash_skill(msg)
            return one_line(f"/{slash[0]} {slash[1]}", PROMPT_WIDTH) if slash else one_line(text_of(msg.get("content")), PROMPT_WIDTH)
    return ""


def dispatched_agents(args: dict) -> list[str]:
    """Agent names of one dispatch call; the tool accepts Claude's subagent_type for agent (subagent.ts)."""
    tasks = args.get("tasks")
    items = [t for t in tasks if isinstance(t, dict)] if isinstance(tasks, list) else [args]
    return [str(t.get("agent") or t.get("subagent_type") or "?") for t in items]


def dispatch_label(args: dict) -> str:
    return f"{', '.join(dispatched_agents(args))}: {args.get('description') or args.get('task') or args.get('prompt') or ''}"


# ---------------------------------------------------------------- selection


def project_dirs(root: Path) -> list[Path]:
    return sorted(p for p in root.iterdir() if p.is_dir()) if root.is_dir() else []


def pick_project(root: Path, query: str) -> Path:
    dirs = project_dirs(root)
    exact = [d for d in dirs if project_label(d.name) == query.strip("-")]
    hits = exact or [d for d in dirs if query.lower() in d.name.lower()]
    if len(hits) == 1:
        return hits[0]
    names = "\n  ".join(project_label(d.name) for d in (hits or dirs))
    raise SystemExit(f"{'several' if hits else 'no'} projects match {query!r}:\n  {names}")


def session_files(project: Path) -> list[Path]:
    return sorted(project.rglob("*.jsonl"))


def pick_session(root: Path, query: str, project: str | None) -> Path:
    if Path(query).expanduser().is_file():
        return Path(query).expanduser()
    files = session_files(pick_project(root, project)) if project else [f for d in project_dirs(root) for f in session_files(d)]
    if query == "latest":
        if not files:
            raise SystemExit("no sessions found")
        return max(files, key=lambda f: f.name)
    hits = [f for f in files if query in f.name]
    if len(hits) == 1:
        return hits[0]
    raise SystemExit(f"{len(hits)} sessions match {query!r}; give more of the id, or -p PROJECT with 'latest'")


def normalize_bound(bound: str | None) -> str | None:
    return bound.replace(" ", "T").removesuffix("Z") if bound else None


def in_window(timestamp: str, since: str | None, until: str | None) -> bool:
    """`timestamp` is the header's ISO start ('...T14:07:47.782Z'). Bounds are ISO date or date-time prefixes
    ('T' or a space, optional 'Z'), compared at the bound's own precision; both are inclusive."""
    stamp, since, until = normalize_bound(timestamp) or "", normalize_bound(since), normalize_bound(until)
    return (not since or stamp[: len(since)] >= since) and (not until or stamp[: len(until)] <= until)


def project_sessions(root: Path, query: str, dev_team_only: bool = True, since: str | None = None, until: str | None = None) -> Iterator[Session]:
    for path in session_files(pick_project(root, query)):
        header, uses_dev_team = scan_header(path)
        if (not dev_team_only or uses_dev_team) and in_window(str(header.get("timestamp", "")), since, until):
            yield load_session(path)


# ---------------------------------------------------------------- reports


def report_projects(root: Path) -> list[dict]:
    rows = []
    for d in project_dirs(root):
        starts, dev_team = [], 0
        for path in session_files(d):
            header, uses_dev_team = scan_header(path)
            starts.append(started_of(header))
            dev_team += uses_dev_team
        if starts:
            rows.append({"project": project_label(d.name), "sessions": len(starts), "devTeamSessions": dev_team,
                         "firstStarted": min(starts), "lastStarted": max(starts)})
    return rows


def scan_header(path: Path) -> tuple[dict, bool]:
    """The session header and whether dev-team ran, without building the session."""
    header: dict = {}
    uses_dev_team = False
    with path.open(encoding="utf-8", errors="replace") as f:
        for i, line in enumerate(f):
            if i == 0:
                try:
                    parsed = json.loads(line)
                    header = parsed if isinstance(parsed, dict) else {}
                except json.JSONDecodeError:
                    pass
            if mentions_dev_team(line):
                uses_dev_team = True
                break
    return header, uses_dev_team


def report_sessions(sessions: Iterable[Session]) -> list[dict]:
    rows = []
    for s in sessions:
        records = dispatch_records(s)
        rows.append({
            "session": s.short_id,
            "started": s.started,
            "firstPrompt": first_prompt(s),
            "turns": sum(1 for e in s.active if message_of(e).get("role") == ROLE_ASSISTANT),
            "compactions": sum(1 for e in s.active if e.get("type") == "compaction"),
            "skillsLoaded": [load.name for load in s.loads],
            "dispatches": sum(len(credited_runs(r)) for r in records),
            "failedDispatches": sum(1 for r in records if not r.get("ok", True)),
            "toolErrors": sum(1 for c in s.calls if c.is_error and not c.blocked),
            "hookBlocks": sum(1 for c in s.calls if c.blocked),
            "parentCostUsd": round(parent_cost(s), 4),
            "subagentCostUsd": round(sum(credited_cost(r) for r in records), 4),
            "overheadCostUsd": round(overhead_cost(s), 4),
        })
    return rows


def output_tokens(usage: Any) -> int:
    return int(usage.get("output") or 0) if isinstance(usage, dict) else 0


def session_output_tokens(s: Session) -> int:
    """Output tokens the model reported: parent turns plus every credited subagent run."""
    parent = sum(output_tokens(message_of(e).get("usage")) for e in s.entries if message_of(e).get("role") == ROLE_ASSISTANT)
    return parent + sum(output_tokens(run.get("usage")) for r in dispatch_records(s) for run in credited_runs(r))


def committed_lines(cwd: str, since: str, until: str) -> Counter | None:
    """Commits and test/prod lines added and removed in cwd's repository in the window; None when git fails."""
    command = ["git", "-C", cwd, "log", "--all", "--no-merges", "--no-ext-diff", "--no-textconv",
               f"--since={since}", f"--until={until}", "--numstat", "--format=commit %ce"]
    try:
        out = subprocess.run(command, capture_output=True, text=True, check=True, timeout=GIT_TIMEOUT_SECONDS).stdout
    except (OSError, subprocess.SubprocessError):
        return None
    counts: Counter = Counter(commits=0)
    skipping = False
    for line in out.splitlines():
        if line.startswith("commit "):
            skipping = line == f"commit {GITHUB_COMMITTER}"
            counts["commits"] += not skipping
            continue
        parts = line.split("\t")
        if skipping or len(parts) != 3 or not parts[0].isdigit():  # blank separator lines; "-" for binary files
            continue
        kind = "test" if TEST_PATH_RE.search(parts[2]) else "prod"
        counts[f"{kind}Added"] += int(parts[0])
        counts[f"{kind}Removed"] += int(parts[1])
    return counts


def report_code(sessions: Iterable[Session]) -> list[dict]:
    rows = []
    for s in sessions:
        timestamps = [str(e["timestamp"]) for e in s.entries if e.get("timestamp")]
        lines = committed_lines(str(s.header.get("cwd", "")), min(timestamps), max(timestamps)) if timestamps else None
        row = {"session": s.short_id, "started": s.started, "firstPrompt": first_prompt(s), "outputTokens": session_output_tokens(s)}
        for key in ("commits", "prodAdded", "prodRemoved", "testAdded", "testRemoved"):
            row[key] = None if lines is None else lines[key]
        rows.append(row)
    return rows


def call_event(call: ToolCall, is_load: bool, all_tools: bool) -> list[tuple[str, str]]:
    events = []
    if call.name == SUBAGENT_TOOL:
        events.append((EVENT_DISPATCH, one_line(dispatch_label(call.args))))
    feedback = call.post_hook_feedback
    if feedback is not None:
        events.append((EVENT_HOOK_BLOCK, f"{call.name}: {one_line(feedback)}"))
    elif call.guard_blocked:
        events.append((EVENT_HOOK_BLOCK, f"{call.name}: {one_line(call.result)}"))
    elif call.is_error:
        events.append((EVENT_ERROR, f"{call.name}: {one_line(call.result)}"))
    elif all_tools and not is_load and call.name != SUBAGENT_TOOL:
        target = call.args.get("command") or call.args.get("path") or call.args.get("pattern") or ""
        events.append((call.name, f"{one_line(str(target), COMMAND_WIDTH)} -> ~{estimate_tokens(call.result)} tok"))
    return events


def entry_event(entry: dict) -> tuple[str, str] | None:
    entry_type = entry.get("type")
    if entry_type == "compaction":
        return EVENT_COMPACTION, f"tokensBefore {entry.get('tokensBefore')}"
    if entry_type == "model_change":
        return EVENT_MODEL, f"{entry.get('provider')}/{entry.get('modelId')}"
    if is_usage_entry(entry):
        record = entry.get("data") or {}
        nested = len(record.get("nested") or [])
        seconds = int(record.get("durationMs") or 0) // 1000
        status = "ok" if record.get("ok", True) else "FAILED"
        text = f"{record.get('agent')} {status} {record.get('model')} tier {record.get('tier')} ${credited_cost(record):.3f} {seconds}s"
        return EVENT_AGENT_DONE, text + (f" (+{nested} nested)" if nested else "")
    return None


def report_timeline(s: Session, all_tools: bool) -> list[dict]:
    call_at = {c.entry_index: c for c in s.calls}
    load_at = {load.entry_index: load for load in s.loads}
    events = []
    for index, entry in enumerate(s.active):
        found: list[tuple[str, str]] = []
        load = load_at.get(index)
        if load:
            args = f" {one_line(load.args_text, ARGS_WIDTH)}" if load.args_text else ""
            found.append((EVENT_SKILL, f"{load.name} via {load.via}, ~{load.estimated_tokens} tok, {load.turns_in_context} turns in context{args}"))
        elif message_of(entry).get("role") == ROLE_USER:
            found.append((EVENT_USER, one_line(text_of(message_of(entry).get("content")))))
        call = call_at.get(index)
        if call:
            found += call_event(call, load is not None, all_tools)
        other = entry_event(entry)
        if other:
            found.append(other)
        time = str(entry.get("timestamp", ""))[11:19]
        events += [{"time": time, "kind": kind, "text": text} for kind, text in found]
    return events


def report_tools(sessions: Iterable[Session], large_output_tokens: int) -> list[dict]:
    tokens_by_tool, calls_by_tool, large_tokens_by_tool, large_calls_by_tool = Counter(), Counter(), Counter(), Counter()
    for s in sessions:
        for c in s.calls:
            output_tokens = estimate_tokens(c.result)
            tokens_by_tool[c.name] += output_tokens
            calls_by_tool[c.name] += 1
            if output_tokens >= large_output_tokens:
                large_tokens_by_tool[c.name] += output_tokens
                large_calls_by_tool[c.name] += 1
    return [
        {"tool": name, "tokens": tokens, "calls": calls_by_tool[name],
         "largeCalls": large_calls_by_tool[name], "largeTokens": large_tokens_by_tool[name]}
        for name, tokens in tokens_by_tool.most_common()
    ]


def report_skills(sessions: Iterable[Session]) -> list[dict]:
    by_name: dict[str, list[SkillLoad]] = {}
    for s in sessions:
        for load in s.loads:
            by_name.setdefault(load.name, []).append(load)
    rows = []
    for name, loads in by_name.items():
        rows.append({
            "skill": name,
            "loads": len(loads),
            "avgTokens": sum(load.estimated_tokens for load in loads) // len(loads),
            "medianTurnsInContext": statistics.median(load.turns_in_context for load in loads),
            "tokensTimesTurns": sum(load.estimated_tokens * load.turns_in_context for load in loads),
        })
    return sorted(rows, key=lambda r: -r["tokensTimesTurns"])


def skill_runs(s: Session, skill: str) -> list[tuple[SkillLoad, list[ToolCall]]]:
    """Each load of `skill` with the tool calls up to the next load of it or of a workflow skill (or the session end)."""
    bounds = sorted(load.entry_index for load in s.loads if load.name in WORKFLOW_SKILLS | {skill})
    runs = []
    for load in (x for x in s.loads if x.name == skill):
        end = next((b for b in bounds if b > load.entry_index), len(s.active))
        runs.append((load, [c for c in s.calls if load.entry_index < c.entry_index < end]))
    return runs


def run_activity(skill: str, calls: list[ToolCall]) -> Counter:
    """What happened inside one run: dev-team scripts, reference reads, dispatches, skill loads, edits, errors."""
    found: Counter = Counter()
    reference_prefix = f"skills/{skill}/"
    for c in calls:
        if c.name == BASH_TOOL:
            for script in set(DEV_TEAM_SCRIPT_RE.findall(str(c.args.get("command", "")))):
                found[f"script {script}"] += 1
        elif c.name == READ_TOOL:
            path = str(c.args.get("path", ""))
            if reference_prefix in path and not path.endswith("/SKILL.md"):
                found[f"read {path.split(reference_prefix, 1)[1]}"] += 1
        elif c.name == SUBAGENT_TOOL:
            for agent in dispatched_agents(c.args):
                found[f"dispatch {agent}"] += 1
        elif c.name == SKILL_TOOL and not c.is_error:
            found[f"skill {skill_name(c)}"] += 1
        elif c.name in EDIT_TOOLS:
            found["edit/write"] += 1
        if c.blocked:
            found[f"blocked {c.name}"] += 1
        elif c.is_error:
            found[f"error {c.name}"] += 1
    return found


def report_steps(sessions: Iterable[Session], skill: str, outputs: list[str]) -> dict:
    runs, runs_with, totals = [], Counter(), Counter()
    for s in sessions:
        for load, calls in skill_runs(s, skill):
            found = run_activity(skill, calls)
            runs_with.update(found.keys())
            totals.update(found)
            run: dict = {"session": s.short_id, "started": s.started, "args": one_line(load.args_text), "activity": dict(found)}
            if outputs:
                run["outputs"] = [
                    {"command": one_line(str(c.args.get("command")), COMMAND_WIDTH), "output": one_line(c.result, OUTPUT_WIDTH)}
                    for c in calls
                    if c.name == BASH_TOOL and any(o in str(c.args.get("command", "")) for o in outputs)
                ]
            runs.append(run)
    return {
        "skill": skill,
        "runs": len(runs),
        "activity": [{"activity": k, "runs": v, "total": totals[k]} for k, v in runs_with.most_common()],
        "perRun": runs,
    }


# ---------------------------------------------------------------- output


def print_table(rows: list[dict]) -> None:
    if not rows:
        print("(nothing)")
        return
    cols = list(rows[0])
    cells = [[safe(", ".join(map(str, v)) if isinstance(v, list) else v) for v in (r[c] for c in cols)] for r in rows]
    widths = [min(MAX_COLUMN_WIDTH, max(len(c), *(len(row[i]) for row in cells))) for i, c in enumerate(cols)]
    print("  ".join(c.ljust(w) for c, w in zip(cols, widths)))  # column names are ours
    for row in cells:
        print("  ".join(one_line(v, w).ljust(w) for v, w in zip(row, widths)))


# Every field printed below comes from the session file, so it passes through safe() here.


def print_steps(data: dict) -> None:
    print(f"{safe(data['skill'])}: {data['runs']} runs")
    for a in data["activity"]:
        print(f"  {a['runs']:3d}/{data['runs']} runs  total {a['total']:4d}  {safe(a['activity'])}")
    for run in data["perRun"]:
        print(f"- {safe(run['started'])} {safe(run['session'])}  {safe(run['args'])}")
        for o in run.get("outputs", []):
            print(f"    $ {safe(o['command'])}\n      {safe(o['output'])}")


def print_timeline(events: list[dict]) -> None:
    for ev in events:
        print(f"{safe(ev['time'])}  {safe(ev['kind']):<{KIND_COLUMN_WIDTH}} {safe(ev['text'])}")


def build_parser() -> argparse.ArgumentParser:
    common = argparse.ArgumentParser(add_help=False)
    common.add_argument("--sessions-dir", type=Path, default=None, help="default: $PI_CODING_AGENT_DIR/sessions or ~/.pi/agent/sessions")
    common.add_argument("--json", action="store_true", help="print JSON instead of tables")
    selection = argparse.ArgumentParser(add_help=False)
    selection.add_argument("-p", "--project", required=True, help="project directory name or a unique part of it")
    selection.add_argument("--all-sessions", action="store_true", help="include sessions that did not use dev-team")
    selection.add_argument("--since", help="only sessions started at or after this ISO date or date-time")
    selection.add_argument("--until", help="only sessions started up to this ISO date or date-time (inclusive)")

    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("projects", parents=[common], help="projects with sessions, and how many used dev-team")
    sub.add_parser("sessions", parents=[common, selection], help="one row per session")
    p = sub.add_parser("tools", parents=[common, selection], help="tool-output tokens by tool")
    p.add_argument("--large-output-tokens", type=int, default=LARGE_OUTPUT_TOKENS, help=f"estimated tokens from which an output counts as large (default {LARGE_OUTPUT_TOKENS})")
    sub.add_parser("skills", parents=[common, selection], help="skill loads: size and turns in context")
    p = sub.add_parser("steps", parents=[common, selection], help="what ran inside each run of one skill")
    p.add_argument("-s", "--skill", required=True, help="skill name, for example code-review or build")
    p.add_argument("--outputs", action="append", default=[], metavar="TEXT", help="show output of bash calls whose command contains TEXT (repeatable)")
    sub.add_parser("code", parents=[common, selection], help="output tokens and lines committed (test vs production) per session")
    p = sub.add_parser("timeline", parents=[common], help="ordered events of one session")
    p.add_argument("session", help="session file, a unique part of its id, or 'latest'")
    p.add_argument("-p", "--project", help="limit the session search to this project")
    p.add_argument("--tools", action="store_true", help="list every tool call, not only errors, blocks and dispatches")
    return ap


def selected(args: argparse.Namespace, root: Path) -> Iterator[Session]:
    return project_sessions(root, args.project, not args.all_sessions, args.since, args.until)


# Subcommand -> (build the report, print it as text).
COMMANDS: dict[str, tuple[Callable[[argparse.Namespace, Path], Any], Callable[[Any], None]]] = {
    "projects": (lambda _, root: report_projects(root), print_table),
    "sessions": (lambda a, root: report_sessions(selected(a, root)), print_table),
    "tools": (lambda a, root: report_tools(selected(a, root), a.large_output_tokens), print_table),
    "skills": (lambda a, root: report_skills(selected(a, root)), print_table),
    "steps": (lambda a, root: report_steps(selected(a, root), a.skill, a.outputs), print_steps),
    "code": (lambda a, root: report_code(selected(a, root)), print_table),
    "timeline": (lambda a, root: report_timeline(load_session(pick_session(root, a.session, a.project)), a.tools), print_timeline),
}


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    build, render = COMMANDS[args.cmd]
    data = build(args, args.sessions_dir or sessions_root())
    if args.json:
        print(json.dumps(data, indent=2))
    else:
        render(data)
    return 0


if __name__ == "__main__":
    sys.exit(main())
