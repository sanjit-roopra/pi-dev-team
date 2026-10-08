#!/usr/bin/env python3
"""Report how dev-team ran in recorded pi sessions.

Usage:
  python3 devtools/session_report.py projects
  python3 devtools/session_report.py sessions -p dstm
  python3 devtools/session_report.py timeline latest -p dstm [--tools]
  python3 devtools/session_report.py tools -p dstm [--big 3500]
  python3 devtools/session_report.py skills -p dstm
  python3 devtools/session_report.py branches -p dstm -s code-review [--outputs dispatch_reconcile.py]

Every subcommand takes --json for machine-readable output.

pi stores each session as JSONL under <agent dir>/sessions/<project dir>/ (pi's
docs/session-format.md). Entries form a tree through id/parentId; this script
follows the active branch, the path from the last entry back to the root, which
is what the model saw. Costs are summed over every entry in the file, because
abandoned branches were paid for too.

Subagents run with --no-session, so their own transcripts are not stored. The
parent session keeps one `dev-team-subagent-usage` entry per dispatch (agent,
model, tier, ok, cost); that is all this script can say about a child.

Token counts are estimates: characters / 4. Stdlib only, read-only.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
from collections import Counter
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

USAGE_ENTRY = "dev-team-subagent-usage"
SESSION_START_ENTRY = "dev-team-session-start"
SUBAGENT_TOOL = "dev_team_subagent"
HOOK_BLOCK = "dev-team hook feedback (must address)"
DEV_TEAM_MARKERS = (USAGE_ENTRY, SESSION_START_ENTRY, "pi-dev-team/skills/")
# A run of one skill ends where the next of these workflow skills is loaded.
WORKFLOW_SKILLS = {
    "specs", "plan", "build", "pr", "ship", "code-review", "fix", "triage", "continue",
    "design-doc", "systematic-debugging", "branch-workflow", "autoship", "test-improve",
}
SLASH_SKILL = re.compile(r'^\s*<skill name="([^"]+)"')
SCRIPT = re.compile(r"([\w-]+\.py)\b")


def tokens(text: str) -> int:
    return len(text) // 4


def sessions_root() -> Path:
    agent_dir = os.environ.get("PI_CODING_AGENT_DIR")
    return Path(agent_dir).expanduser() / "sessions" if agent_dir else Path.home() / ".pi" / "agent" / "sessions"


def project_label(dir_name: str) -> str:
    return dir_name.strip("-")


def text_of(content) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "\n".join(c.get("text", "") for c in content if isinstance(c, dict) and c.get("type", "text") == "text")
    return ""


def one_line(text: str, width: int = 100) -> str:
    text = " ".join(text.split())
    return text if len(text) <= width else text[: width - 1] + "…"


@dataclass
class Call:
    """One tool call on the active branch, with its result."""

    pos: int  # index of the result entry on the active path
    name: str
    args: dict
    result: str = ""
    is_error: bool = False
    details: dict = field(default_factory=dict)


@dataclass
class SkillLoad:
    pos: int
    name: str
    args: str
    tokens: int
    via: str  # "tool" or "slash"
    turns_in_context: int = 0


@dataclass
class Session:
    path: Path
    header: dict
    entries: list[dict]  # every line, in file order
    active: list[dict]  # active branch, root first
    calls: list[Call] = field(default_factory=list)
    loads: list[SkillLoad] = field(default_factory=list)

    @property
    def id(self) -> str:
        return self.path.stem

    @property
    def short_id(self) -> str:
        return self.path.stem.rsplit("_", 1)[-1][-12:]

    @property
    def started(self) -> str:
        return str(self.header.get("timestamp", ""))[:16].replace("T", " ")

    @property
    def uses_dev_team(self) -> bool:
        return any(m in json.dumps(e) for e in self.entries for m in DEV_TEAM_MARKERS)


def load_session(path: Path) -> Session:
    entries: list[dict] = []
    for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
        try:
            entries.append(json.loads(line))
        except json.JSONDecodeError:
            continue
    header = next((e for e in entries if e.get("type") == "session"), {})
    s = Session(path, header, entries, active_path(entries))
    index_calls(s)
    index_loads(s)
    return s


def active_path(entries: list[dict]) -> list[dict]:
    by_id = {e["id"]: e for e in entries if e.get("id") and e.get("type") != "session"}
    leaf = next((e for e in reversed(entries) if e.get("id") in by_id), None)
    path, seen = [], set()
    while leaf is not None and leaf["id"] not in seen:
        seen.add(leaf["id"])
        path.append(leaf)
        leaf = by_id.get(leaf.get("parentId"))
    return path[::-1]


def message(entry: dict) -> dict:
    m = entry.get("message") if entry.get("type") == "message" else None
    return m if isinstance(m, dict) else {}


def index_calls(s: Session) -> None:
    pending: dict[str, tuple[str, dict]] = {}
    for pos, e in enumerate(s.active):
        m = message(e)
        if m.get("role") == "assistant":
            for c in m.get("content") or []:
                if isinstance(c, dict) and c.get("type") == "toolCall":
                    pending[str(c.get("id", ""))] = (c.get("name", ""), c.get("arguments") or {})
        elif m.get("role") == "toolResult":
            name, args = pending.pop(str(m.get("toolCallId", "")), (m.get("toolName", ""), {}))
            details = m.get("details") if isinstance(m.get("details"), dict) else {}
            s.calls.append(Call(pos, name, args, text_of(m.get("content")), bool(m.get("isError")), details))


def index_loads(s: Session) -> None:
    calls_at = {c.pos: c for c in s.calls}
    for pos, e in enumerate(s.active):
        m = message(e)
        if m.get("role") == "user":
            text = text_of(m.get("content"))
            hit = SLASH_SKILL.match(text)
            if hit:
                s.loads.append(SkillLoad(pos, hit.group(1), "", tokens(text), "slash"))
        call = calls_at.get(pos)
        if call and call.name == "skill" and not call.is_error:
            s.loads.append(SkillLoad(pos, skill_name(call), str(call.args.get("args") or call.args.get("arguments") or ""), tokens(call.result), "tool"))
    for load in s.loads:
        load.turns_in_context = turns_in_context(s.active, load.pos)


def skill_name(call: Call) -> str:
    """The resolved name the skill tool reports, else its argument without the accepted `/` or `dev-team:` prefix."""
    resolved = call.details.get("skill")
    if resolved:
        return str(resolved)
    raw = str(call.args.get("name") or call.args.get("skill") or call.args.get("command") or "?")
    return raw.lstrip("/").removeprefix("dev-team:")


def turns_in_context(active: list[dict], pos: int) -> int:
    """Assistant turns after `pos` until a compaction drops it (a compaction keeps entries from firstKeptEntryId on)."""
    index = {e.get("id"): i for i, e in enumerate(active)}
    turns = 0
    for i in range(pos + 1, len(active)):
        e = active[i]
        if e.get("type") == "compaction" and pos < index.get(e.get("firstKeptEntryId"), i):
            break
        if message(e).get("role") == "assistant":
            turns += 1
    return turns


def subagent_usage(s: Session) -> list[dict]:
    return [e.get("data") or {} for e in s.entries if e.get("type") == "custom" and e.get("customType") == USAGE_ENTRY]


def main_cost(s: Session) -> float:
    total = 0.0
    for e in s.entries:
        m = message(e)
        if m.get("role") == "assistant":
            total += float(((m.get("usage") or {}).get("cost") or {}).get("total") or 0)
    return total


def first_prompt(s: Session) -> str:
    for e in s.active:
        m = message(e)
        if m.get("role") == "user":
            text = text_of(m.get("content"))
            hit = SLASH_SKILL.match(text)
            return f"/{hit.group(1)}" if hit else one_line(text, 70)
    return ""


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


def project_sessions(root: Path, query: str, dev_team_only: bool = True) -> list[Session]:
    sessions = [load_session(f) for f in session_files(pick_project(root, query))]
    return [s for s in sessions if s.uses_dev_team or not dev_team_only]


# ---------------------------------------------------------------- reports


def report_projects(root: Path) -> list[dict]:
    rows = []
    for d in project_dirs(root):
        sessions = [load_session(f) for f in session_files(d)]
        if not sessions:
            continue
        dev = [s for s in sessions if s.uses_dev_team]
        rows.append({
            "project": project_label(d.name),
            "sessions": len(sessions),
            "devTeamSessions": len(dev),
            "first": min(s.started for s in sessions),
            "last": max(s.started for s in sessions),
        })
    return rows


def report_sessions(sessions: list[Session]) -> list[dict]:
    rows = []
    for s in sessions:
        usage = subagent_usage(s)
        rows.append({
            "session": s.short_id,
            "started": s.started,
            "firstPrompt": first_prompt(s),
            "turns": sum(1 for e in s.active if message(e).get("role") == "assistant"),
            "compactions": sum(1 for e in s.active if e.get("type") == "compaction"),
            "skillLoads": [l.name for l in s.loads],
            "dispatches": len(usage),
            "failedDispatches": sum(1 for u in usage if not u.get("ok", True)),
            "toolErrors": sum(1 for c in s.calls if c.is_error),
            "hookBlocks": sum(1 for c in s.calls if HOOK_BLOCK in c.result),
            "mainCostUsd": round(main_cost(s), 4),
            "subagentCostUsd": round(sum(float((u.get("usage") or {}).get("cost") or 0) for u in usage), 4),
        })
    return rows


def report_timeline(s: Session, all_tools: bool) -> list[dict]:
    calls_at = {c.pos: c for c in s.calls}
    loads_at = {l.pos: l for l in s.loads}
    events = []

    def add(e: dict, kind: str, text: str) -> None:
        events.append({"time": str(e.get("timestamp", ""))[11:19], "kind": kind, "text": text})

    for pos, e in enumerate(s.active):
        m, t = message(e), e.get("type")
        load = loads_at.get(pos)
        if load:
            add(e, "skill", f"{load.name} via {load.via}, ~{load.tokens} tok, {load.turns_in_context} turns in context {one_line(load.args, 60)}".rstrip())
        elif m.get("role") == "user":
            add(e, "user", one_line(text_of(m.get("content"))))
        call = calls_at.get(pos)
        if call and call.name != "skill":
            if HOOK_BLOCK in call.result:
                add(e, "hook-block", f"{call.name}: {one_line(call.result.split(HOOK_BLOCK, 1)[1])}")
            elif call.is_error:
                add(e, "error", f"{call.name}: {one_line(call.result)}")
            elif call.name == SUBAGENT_TOOL:
                add(e, "dispatch", one_line(f"{', '.join(dispatched_agents(call.args))}: {call.args.get('description') or call.args.get('task') or ''}"))
            elif all_tools:
                arg = call.args.get("command") or call.args.get("path") or call.args.get("pattern") or ""
                add(e, call.name, f"{one_line(str(arg), 80)} -> ~{tokens(call.result)} tok")
        if t == "compaction":
            add(e, "compaction", f"tokensBefore {e.get('tokensBefore')}")
        elif t == "model_change":
            add(e, "model", f"{e.get('provider')}/{e.get('modelId')}")
        elif t == "custom" and e.get("customType") == USAGE_ENTRY:
            u = e.get("data") or {}
            cost = float((u.get("usage") or {}).get("cost") or 0)
            add(e, "agent-done", f"{u.get('agent')} {'ok' if u.get('ok', True) else 'FAILED'} {u.get('model')} tier {u.get('tier')} ${cost:.3f} {int(u.get('durationMs') or 0) // 1000}s")
    return events


def report_tools(sessions: list[Session], big: int) -> list[dict]:
    total, calls, big_tok, big_calls = Counter(), Counter(), Counter(), Counter()
    for s in sessions:
        for c in s.calls:
            t = tokens(c.result)
            total[c.name] += t
            calls[c.name] += 1
            if t >= big:
                big_tok[c.name] += t
                big_calls[c.name] += 1
    return [
        {"tool": name, "tokens": tok, "calls": calls[name], f"callsOver{big}": big_calls[name], f"tokensOver{big}": big_tok[name]}
        for name, tok in total.most_common()
    ]


def report_skills(sessions: list[Session]) -> list[dict]:
    by_name: dict[str, list[SkillLoad]] = {}
    for s in sessions:
        for load in s.loads:
            by_name.setdefault(load.name, []).append(load)
    rows = []
    for name, loads in by_name.items():
        turns = sorted(l.turns_in_context for l in loads)
        rows.append({
            "skill": name,
            "loads": len(loads),
            "avgTokens": sum(l.tokens for l in loads) // len(loads),
            "medianTurnsInContext": turns[len(turns) // 2],
            "tokenTurns": sum(l.tokens * l.turns_in_context for l in loads),
        })
    return sorted(rows, key=lambda r: -r["tokenTurns"])


def skill_runs(s: Session, skill: str) -> list[tuple[SkillLoad, list[Call]]]:
    """Each load of `skill` with the tool calls up to the next workflow-skill load (or the session end)."""
    bounds = sorted(l.pos for l in s.loads if l.name in WORKFLOW_SKILLS | {skill})
    runs = []
    for load in (l for l in s.loads if l.name == skill):
        end = next((b for b in bounds if b > load.pos), len(s.active))
        runs.append((load, [c for c in s.calls if load.pos < c.pos < end]))
    return runs


def dispatched_agents(args: dict) -> list[str]:
    tasks = args.get("tasks")
    if isinstance(tasks, list):
        return [str(t.get("agent", "?")) for t in tasks if isinstance(t, dict)]
    return [str(args.get("agent", "?"))]


def markers(skill: str, calls: list[Call]) -> Counter:
    found: Counter = Counter()
    for c in calls:
        if c.name == "bash":
            for script in set(SCRIPT.findall(str(c.args.get("command", "")))):
                found[f"script {script}"] += 1
        elif c.name == "read" and f"skills/{skill}/" in str(c.args.get("path", "")) and not str(c.args.get("path")).endswith("/SKILL.md"):
            found[f"read {str(c.args['path']).split(f'skills/{skill}/', 1)[1]}"] += 1
        elif c.name == SUBAGENT_TOOL:
            for agent in dispatched_agents(c.args):
                found[f"dispatch {agent}"] += 1
        elif c.name == "skill":
            found[f"skill {c.args.get('name')}"] += 1
        elif c.name in ("edit", "write"):
            found["edit/write"] += 1
        if c.is_error:
            found[f"error {c.name}"] += 1
    return found


def report_branches(sessions: list[Session], skill: str, outputs: list[str]) -> dict:
    runs, in_runs, totals = [], Counter(), Counter()
    for s in sessions:
        for load, calls in skill_runs(s, skill):
            found = markers(skill, calls)
            in_runs.update(found.keys())
            totals.update(found)
            run = {"session": s.short_id, "started": s.started, "args": one_line(load.args, 100), "markers": dict(found)}
            if outputs:
                run["outputs"] = [
                    {"command": one_line(str(c.args.get("command")), 80), "output": one_line(c.result, 200)}
                    for c in calls
                    if c.name == "bash" and any(o in str(c.args.get("command", "")) for o in outputs)
                ]
            runs.append(run)
    return {
        "skill": skill,
        "runs": len(runs),
        "markers": [{"marker": k, "runs": v, "total": totals[k]} for k, v in in_runs.most_common()],
        "perRun": runs,
    }


# ---------------------------------------------------------------- output


def print_table(rows: list[dict]) -> None:
    if not rows:
        print("(nothing)")
        return
    cols = list(rows[0])
    cells = [[", ".join(map(str, v)) if isinstance(v, list) else str(v) for v in (r[c] for c in cols)] for r in rows]
    widths = [min(60, max(len(c), *(len(row[i]) for row in cells))) for i, c in enumerate(cols)]
    print("  ".join(c.ljust(w) for c, w in zip(cols, widths)))
    for row in cells:
        print("  ".join(one_line(v, w).ljust(w) for v, w in zip(row, widths)))


def print_branches(data: dict) -> None:
    print(f"{data['skill']}: {data['runs']} runs")
    for m in data["markers"]:
        print(f"  {m['runs']:3d}/{data['runs']} runs  total {m['total']:4d}  {m['marker']}")
    for run in data["perRun"]:
        print(f"- {run['started']} {run['session']}  {run['args']}")
        for o in run.get("outputs", []):
            print(f"    $ {o['command']}\n      {o['output']}")


def main(argv: list[str] | None = None) -> int:
    common = argparse.ArgumentParser(add_help=False)
    common.add_argument("--sessions-dir", type=Path, default=None, help="default: $PI_CODING_AGENT_DIR/sessions or ~/.pi/agent/sessions")
    common.add_argument("--json", action="store_true", help="print JSON instead of tables")
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("projects", parents=[common], help="projects with sessions, and how many used dev-team")
    for name, help_text in (("sessions", "one row per dev-team session"), ("tools", "tool-output tokens by tool"), ("skills", "skill loads: size and turns in context")):
        p = sub.add_parser(name, parents=[common], help=help_text)
        p.add_argument("-p", "--project", required=True, help="project directory name or a unique part of it")
        p.add_argument("--all-sessions", action="store_true", help="include sessions that did not use dev-team")
        if name == "tools":
            p.add_argument("--big", type=int, default=3500, help="token size that counts as a large output (default 3500)")
    p = sub.add_parser("timeline", parents=[common], help="ordered events of one session")
    p.add_argument("session", help="session file, a unique part of its id, or 'latest'")
    p.add_argument("-p", "--project", help="limit the session search to this project")
    p.add_argument("--tools", action="store_true", help="list every tool call, not only errors, blocks and dispatches")
    p = sub.add_parser("branches", parents=[common], help="what ran inside each run of one skill")
    p.add_argument("-p", "--project", required=True)
    p.add_argument("-s", "--skill", required=True, help="skill name, for example code-review or build")
    p.add_argument("--outputs", action="append", default=[], metavar="TEXT", help="show output of bash calls whose command contains TEXT (repeatable)")
    args = ap.parse_args(argv)

    root = args.sessions_dir or sessions_root()
    data: Any
    if args.cmd == "projects":
        data = report_projects(root)
    elif args.cmd == "timeline":
        data = report_timeline(load_session(pick_session(root, args.session, args.project)), args.tools)
    else:
        sessions = project_sessions(root, args.project, not getattr(args, "all_sessions", False))
        if args.cmd == "sessions":
            data = report_sessions(sessions)
        elif args.cmd == "tools":
            data = report_tools(sessions, args.big)
        elif args.cmd == "skills":
            data = report_skills(sessions)
        else:
            data = report_branches(sessions, args.skill, args.outputs)

    if args.json:
        print(json.dumps(data, indent=2))
    elif args.cmd == "branches":
        print_branches(data)
    elif args.cmd == "timeline":
        for ev in data:
            print(f"{ev['time']}  {ev['kind']:<11} {ev['text']}")
    else:
        print_table(data)
    return 0


if __name__ == "__main__":
    sys.exit(main())
