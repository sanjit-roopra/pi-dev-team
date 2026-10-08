"""Tests for devtools/session_report.py. Run: python3 -m unittest discover -s test/py"""
import contextlib
import importlib.machinery
import importlib.util
import io
import json
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
loader = importlib.machinery.SourceFileLoader("session_report", str(ROOT / "devtools" / "session_report.py"))
spec = importlib.util.spec_from_loader("session_report", loader)
assert spec is not None
report = importlib.util.module_from_spec(spec)
sys.modules["session_report"] = report  # dataclasses look their module up here
loader.exec_module(report)


def msg(id_, parent, role, content, **extra):
    return {"type": "message", "id": id_, "parentId": parent, "timestamp": "2026-10-07T14:00:00Z", "message": {"role": role, "content": content, **extra}}


def call(id_, name, args):
    return {"type": "toolCall", "id": id_, "name": name, "arguments": args}


def assistant(id_, parent, calls=(), cost=0.0):
    return msg(id_, parent, "assistant", list(calls), usage={"cost": {"total": cost}})


def result(id_, parent, call_id, tool, text, error=False):
    return msg(id_, parent, "toolResult", [{"type": "text", "text": text}], toolCallId=call_id, toolName=tool, isError=error)


SKILL_TEXT = "x" * 4000  # ~1000 tokens


def build_session():
    """A /build run: slash load, a skill load, a script, a dispatch, a compaction that drops the loads, and an abandoned branch."""
    return [
        {"type": "session", "version": 3, "id": "s", "timestamp": "2026-10-07T14:00:00Z", "cwd": "/p"},
        msg("u1", None, "user", '<skill name="build" location="/x/pi-dev-team/skills/build/SKILL.md">' + SKILL_TEXT),
        assistant("a1", "u1", [call("c1", "skill", {"name": "/dev-team:code-review", "args": "--since main"})], cost=0.5),
        result("r1", "a1", "c1", "skill", SKILL_TEXT),
        assistant("a2", "r1", [call("c2", "bash", {"command": "python3 $R/scripts/build_jobs.py --wave-width 1"})], cost=0.25),
        result("r2", "a2", "c2", "bash", "unset"),
        assistant("a3", "r2", [call("c3", "dev_team_subagent", {"tasks": [{"agent": "doc-review"}, {"agent": "naming-review"}]})]),
        result("r3", "a3", "c3", "dev_team_subagent", "done\n\ndev-team hook feedback (must address):\nrun the tests"),
        {"type": "custom", "customType": "dev-team-subagent-usage", "id": "x1", "parentId": "r3", "data": {"agent": "doc-review", "ok": False, "usage": {"cost": 0.125}}},
        {"type": "compaction", "id": "k1", "parentId": "x1", "firstKeptEntryId": "k1", "tokensBefore": 9000},
        assistant("a4", "k1", cost=0.125),
        # Abandoned branch off a1: paid for, but not on the active path.
        assistant("b1", "a1", [call("c9", "read", {"path": "/x/skills/build/references/escalation.md"})], cost=1.0),
        # The active leaf is the last entry in the file.
        assistant("a5", "a4"),
    ]


class SessionReport(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        project = self.root / "--Users-me-git-shop--"
        project.mkdir()
        self.file = project / "2026-10-07T14-00-00-000Z_01a116b1-1a46-74a8-b1ec-ad520b3c6ee8.jsonl"
        self.file.write_text("\n".join(json.dumps(e) for e in build_session()) + "\nnot json\n")
        (self.root / "--Users-me-git-shopfront--").mkdir()
        self.session = report.load_session(self.file)

    def tearDown(self):
        self.tmp.cleanup()

    def run_cli(self, *argv):
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            report.main([*argv, "--sessions-dir", str(self.root), "--json"])
        return json.loads(out.getvalue())

    def test_active_path_skips_abandoned_branch(self):
        ids = [e["id"] for e in self.session.active]
        self.assertEqual(ids[0], "u1")
        self.assertEqual(ids[-1], "a5")
        self.assertNotIn("b1", ids)

    def test_skill_loads_from_slash_and_tool(self):
        loads = [(l.name, l.via, l.tokens) for l in self.session.loads]
        self.assertEqual(loads[0][:2], ("build", "slash"))
        self.assertEqual(loads[1], ("code-review", "tool", 1000))

    def test_skill_name_prefers_resolved_name_then_strips_prefixes(self):
        resolved = report.Call(0, "skill", {"name": "cr"}, details={"skill": "code-review"})
        aliased = report.Call(0, "skill", {"skill": "dev-team:build"})
        self.assertEqual(report.skill_name(resolved), "code-review")
        self.assertEqual(report.skill_name(aliased), "build")

    def test_compaction_ends_residency(self):
        # a2 and a3 come after the code-review load; the compaction keeps nothing before it, so a4/a5 do not count.
        code_review = next(l for l in self.session.loads if l.name == "code-review")
        self.assertEqual(code_review.turns_in_context, 2)

    def test_compaction_keeps_entries_from_first_kept(self):
        active = [
            msg("l", None, "user", "load"),
            assistant("a", "l"),
            {"type": "compaction", "id": "k", "parentId": "a", "firstKeptEntryId": "l"},
            assistant("b", "k"),
        ]
        self.assertEqual(report.turns_in_context(active, 0), 2)

    def test_sessions_costs_include_abandoned_branch(self):
        row = self.run_cli("sessions", "-p", "shop--")[0]
        self.assertEqual(row["session"], "ad520b3c6ee8")
        self.assertEqual(row["mainCostUsd"], 1.875)
        self.assertEqual(row["subagentCostUsd"], 0.125)
        self.assertEqual((row["dispatches"], row["failedDispatches"], row["hookBlocks"], row["compactions"]), (1, 1, 1, 1))

    def test_branches_counts_scripts_and_parallel_agents(self):
        data = self.run_cli("branches", "-p", "Users-me-git-shop", "-s", "code-review", "--outputs", "build_jobs")
        markers = {m["marker"]: m["runs"] for m in data["markers"]}
        self.assertEqual(data["runs"], 1)
        self.assertEqual(markers["script build_jobs.py"], 1)
        self.assertEqual(markers["dispatch doc-review"], 1)
        self.assertEqual(markers["dispatch naming-review"], 1)
        self.assertEqual(data["perRun"][0]["outputs"][0]["output"], "unset")

    def test_build_run_ends_at_next_workflow_skill(self):
        # The /build run ends where code-review loads, so the script after it belongs to code-review.
        data = self.run_cli("branches", "-p", "Users-me-git-shop", "-s", "build")
        self.assertEqual(data["runs"], 1)
        self.assertEqual(data["markers"], [])

    def test_timeline_shows_blocks_and_agent_results(self):
        events = self.run_cli("timeline", "latest", "-p", "Users-me-git-shop")
        kinds = [e["kind"] for e in events]
        self.assertIn("hook-block", kinds)
        self.assertIn("compaction", kinds)
        self.assertTrue(any(e["kind"] == "agent-done" and "FAILED" in e["text"] for e in events))

    def test_ambiguous_project_lists_candidates(self):
        with self.assertRaises(SystemExit) as ctx:
            report.pick_project(self.root, "shop")
        self.assertIn("several projects", str(ctx.exception))
        self.assertIn("Users-me-git-shopfront", str(ctx.exception))


if __name__ == "__main__":
    unittest.main()
