"""Tests for devtools/pi_session_report.py. Run: python3 -m unittest discover -s test/py"""
import contextlib
import importlib.machinery
import importlib.util
import io
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from typing import Any
from unittest import mock

ROOT = Path(__file__).resolve().parents[2]
loader = importlib.machinery.SourceFileLoader("pi_session_report", str(ROOT / "devtools" / "pi_session_report.py"))
spec = importlib.util.spec_from_loader("pi_session_report", loader)
assert spec is not None
report = importlib.util.module_from_spec(spec)
sys.modules["pi_session_report"] = report  # dataclasses look their module up here
loader.exec_module(report)

SESSION_ID = "01a116b1-1a46-74a8-b1ec-ad520b3c6ee8"
SESSION_FILE = f"2026-10-07T14-00-00-000Z_{SESSION_ID}.jsonl"
SKILL_TEXT = "x" * 4000
SKILL_TOKENS = 1000  # 4000 characters at the documented 4 characters per token

# Costs in the main fixture.
ACTIVE_TURN_COSTS = [0.5, 0.25, 0.125]
ABANDONED_BRANCH_COST = 1.0
CHILD_OWN_COST = 0.125
NESTED_CHILD_COST = 0.0625  # costs are reported to 4 decimals
CACHE_WARM_COST = 0.03


# ---------------------------------------------------------------- entry builders


def header_entry(timestamp="2026-10-07T14:00:00Z"):
    return {"type": "session", "version": 3, "id": "s", "timestamp": timestamp, "cwd": "/p"}


def message_entry(entry_id, parent, role, content, **extra):
    return {"type": "message", "id": entry_id, "parentId": parent, "timestamp": "2026-10-07T14:00:00Z",
            "message": {"role": role, "content": content, **extra}}


def tool_call_block(call_id, name, args):
    return {"type": "toolCall", "id": call_id, "name": name, "arguments": args}


def assistant_entry(entry_id, parent, calls=(), cost=0.0):
    return message_entry(entry_id, parent, "assistant", list(calls), usage={"cost": {"total": cost}})


def tool_result_entry(entry_id, parent, call_id, tool, text, is_error=False, details=None):
    extra = {"details": details} if details else {}
    return message_entry(entry_id, parent, "toolResult", [{"type": "text", "text": text}],
                         toolCallId=call_id, toolName=tool, isError=is_error, **extra)


def usage_entry(entry_id, parent, agent, ok=True, cost=0.0, nested=()):
    data = {"agent": agent, "model": "m", "tier": "haiku", "ok": ok, "durationMs": 2000, "usage": {"cost": cost}}
    if nested:
        data["nested"] = list(nested)
    return {"type": "custom", "customType": report.USAGE_ENTRY, "id": entry_id, "parentId": parent, "data": data}


def slash_skill_text(name, args=""):
    invocation = f"/{name} {args}".strip()
    return f'<skill name="{name}" location="/x/pi-dev-team/skills/{name}/SKILL.md">\n{SKILL_TEXT}\n</skill>\n\nThe user invoked `{invocation}`. Follow the skill above.'


def main_session():
    """/build by slash, then code-review by tool, with scripts, a reference read, dispatches, blocks and a compaction."""
    return [
        header_entry(),
        message_entry("u1", None, "user", slash_skill_text("build", "plans/x.md")),
        assistant_entry("a1", "u1", [tool_call_block("c1", "skill", {"name": "/dev-team:code-review", "args": "--since main"})], cost=ACTIVE_TURN_COSTS[0]),
        tool_result_entry("r1", "a1", "c1", "skill", SKILL_TEXT, details={"skill": "code-review"}),
        assistant_entry("a2", "r1", [
            tool_call_block("c2", "bash", {"command": "python3 $R/skills/code-review/scripts/dispatch_waves.py --agents x && pytest tests/foo.py"}),
            tool_call_block("c3", "read", {"path": "/x/skills/code-review/references/since-mode.md"}),
            tool_call_block("c4", "edit", {"path": "app.py"}),
        ], cost=ACTIVE_TURN_COSTS[1]),
        tool_result_entry("r2", "a2", "c2", "bash", "build-jobs: requested=(unset) max=1 wave_width=1 -> effective=1"),
        tool_result_entry("r3", "r2", "c3", "read", "reference text"),
        tool_result_entry("r4", "r3", "c4", "edit", "ok"),
        assistant_entry("a3", "r4", [
            tool_call_block("c5", "dev_team_subagent", {"tasks": [{"agent": "doc-review"}, {"subagent_type": "naming-review"}], "description": "panel"}),
            tool_call_block("c6", "bash", {"command": "gh pr create"}),
            tool_call_block("c7", "skill", {"name": "nope"}),
        ]),
        tool_result_entry("r5", "a3", "c5", "dev_team_subagent", f"done\n\n{report.HOOK_FEEDBACK_HEADER}:\nrun the tests", is_error=True),
        tool_result_entry("r6", "r5", "c6", "bash", "[pre_pr_review] BLOCKED: Code review required", is_error=True),
        tool_result_entry("r7", "r6", "c7", "skill", 'Unknown skill "nope"', is_error=True),
        usage_entry("x1", "r7", "doc-review", ok=False, cost=CHILD_OWN_COST, nested=[{"agent": "deep", "usage": {"cost": NESTED_CHILD_COST}}]),
        {"type": "usage", "id": "w1", "parentId": "x1", "kind": "cache_warm", "usage": {"cost": {"total": CACHE_WARM_COST}}},
        {"type": "model_change", "id": "m1", "parentId": "w1", "provider": "openai", "modelId": "gpt-6.1-sol"},
        {"type": "compaction", "id": "k1", "parentId": "m1", "firstKeptEntryId": "k1", "tokensBefore": 9000},
        assistant_entry("a4", "k1", cost=ACTIVE_TURN_COSTS[2]),
        # Abandoned branch off a1, with a result, so only the active-path walk can exclude it.
        assistant_entry("b1", "a1", [tool_call_block("c9", "read", {"path": "/x/skills/code-review/references/abandoned.md"})], cost=ABANDONED_BRANCH_COST),
        tool_result_entry("b2", "b1", "c9", "read", "abandoned"),
        # The active leaf is the last entry in the file.
        assistant_entry("a5", "a4"),
    ]


def write_session(root, project, entries, name=SESSION_FILE, extra_lines=()):
    folder = root / f"--Users-me-git-{project}--"
    folder.mkdir(exist_ok=True)
    path = folder / name
    path.write_text("\n".join([*(json.dumps(e) for e in entries), *extra_lines]) + "\n")
    return path


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def run_cli(self, *argv, as_json=True) -> Any:
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            report.main([*argv, "--sessions-dir", str(self.root), *(["--json"] if as_json else [])])
        return json.loads(out.getvalue()) if as_json else out.getvalue()


class SessionModel(Base):
    def setUp(self):
        super().setUp()
        self.session = report.load_session(write_session(self.root, "shop", main_session()))

    def test_active_path_skips_abandoned_branch(self):
        ids = [e["id"] for e in self.session.active]
        self.assertEqual((ids[0], ids[-1]), ("u1", "a5"))
        self.assertNotIn("b1", ids)
        self.assertNotIn("b2", ids)

    def test_slash_load_keeps_invocation_args(self):
        build = next(load for load in self.session.loads if load.name == "build")
        self.assertEqual((build.via, build.args_text), (report.LOAD_VIA_SLASH, "plans/x.md"))

    def test_tool_load_uses_resolved_name(self):
        code_review = next(load for load in self.session.loads if load.name == "code-review")
        self.assertEqual((code_review.via, code_review.args_text, code_review.estimated_tokens), (report.LOAD_VIA_TOOL, "--since main", SKILL_TOKENS))

    def test_failed_skill_call_is_not_a_load(self):
        self.assertNotIn("nope", [load.name for load in self.session.loads])

    def test_compaction_ends_residency(self):
        # a2 and a3 follow the code-review load; the compaction keeps nothing before it, so a4 and a5 do not count.
        code_review = next(load for load in self.session.loads if load.name == "code-review")
        self.assertEqual(code_review.turns_in_context, 2)

    def test_compaction_keeps_entries_from_first_kept(self):
        active = [message_entry("l", None, "user", "load"), assistant_entry("a", "l"),
                  {"type": "compaction", "id": "k", "parentId": "a", "firstKeptEntryId": "l"}, assistant_entry("b", "k")]
        self.assertEqual(report.turns_in_context(active, 0, report.positions(active)), 2)

    def test_skill_name_prefers_resolved_name_then_strips_prefixes(self):
        resolved = report.ToolCall(0, "skill", {"name": "cr"}, "", False, {"skill": "code-review"})
        aliased = report.ToolCall(0, "skill", {"skill": "dev-team:build"}, "", False, {})
        self.assertEqual(report.skill_name(resolved), "code-review")
        self.assertEqual(report.skill_name(aliased), "build")

    def test_loader_skips_lines_that_are_not_json_objects(self):
        path = write_session(self.root, "odd", [header_entry(), assistant_entry("a", None)], extra_lines=["not json", "42", "[]"])
        self.assertEqual([e["type"] for e in report.load_session(path).entries], ["session", "message"])


class SessionsReport(Base):
    def setUp(self):
        super().setUp()
        write_session(self.root, "shop", main_session())
        self.row = self.run_cli("sessions", "-p", "shop")[0]

    def test_short_id_is_the_id_tail(self):
        self.assertEqual(self.row["session"], "ad520b3c6ee8")

    def test_start_first_prompt_and_active_turns(self):
        self.assertEqual(self.row["started"], "2026-10-07 14:00")
        self.assertEqual(self.row["firstPrompt"], "/build plans/x.md")
        self.assertEqual(self.row["turns"], 5)  # a1-a5; the abandoned b1 is not on the active path

    def test_parent_cost_includes_abandoned_branch(self):
        self.assertAlmostEqual(self.row["parentCostUsd"], sum(ACTIVE_TURN_COSTS) + ABANDONED_BRANCH_COST)

    def test_subagent_cost_includes_nested_runs(self):
        self.assertAlmostEqual(self.row["subagentCostUsd"], CHILD_OWN_COST + NESTED_CHILD_COST)

    def test_overhead_cost_counts_usage_entries(self):
        self.assertAlmostEqual(self.row["overheadCostUsd"], CACHE_WARM_COST)

    def test_dispatches_count_child_and_nested_runs(self):
        self.assertEqual(self.row["dispatches"], 2)
        self.assertEqual(self.row["failedDispatches"], 1)

    def test_blocks_and_errors_are_separate(self):
        self.assertEqual(self.row["hookBlocks"], 2)  # PostToolUse feedback on the dispatch, PreToolUse guard on gh
        self.assertEqual(self.row["toolErrors"], 1)  # the unknown skill

    def test_compactions_and_skills(self):
        self.assertEqual(self.row["compactions"], 1)
        self.assertEqual(self.row["skillsLoaded"], ["build", "code-review"])

    def test_dev_team_filter_and_all_sessions(self):
        write_session(self.root, "shop", [header_entry("2026-10-08T09:00:00Z"), message_entry("u", None, "user", "hello")], name="2026-10-08T09-00-00-000Z_plain.jsonl")
        self.assertEqual(len(self.run_cli("sessions", "-p", "shop")), 1)
        self.assertEqual(len(self.run_cli("sessions", "-p", "shop", "--all-sessions")), 2)

    def test_since_and_until_filter_on_session_start(self):
        count = lambda *bounds: len(self.run_cli("sessions", "-p", "shop", *bounds))
        self.assertEqual(count("--since", "2026-10-08"), 0)
        self.assertEqual(count("--until", "2026-10-07"), 1)
        self.assertEqual(count("--until", "2026-10-06"), 0)

    def test_window_bounds_use_seconds_and_accept_a_space(self):
        count = lambda *bounds: len(self.run_cli("sessions", "-p", "shop", *bounds))
        self.assertEqual(count("--since", "2026-10-07T14:00:00"), 1)  # session starts 14:00:00Z
        self.assertEqual(count("--since", "2026-10-07T14:00:30"), 0)
        self.assertEqual(count("--since", "2026-10-07 14:00"), 1)
        self.assertEqual(count("--until", "2026-10-07 13:59"), 0)

    def test_window_applies_to_skills_and_steps(self):
        self.assertEqual(self.run_cli("skills", "-p", "shop", "--since", "2026-10-08"), [])
        self.assertEqual(self.run_cli("steps", "-p", "shop", "-s", "code-review", "--until", "2026-10-06")["runs"], 0)

    def test_text_output_has_header_and_row(self):
        lines = self.run_cli("sessions", "-p", "shop", as_json=False).splitlines()
        self.assertTrue(lines[0].startswith("session"))
        self.assertIn("ad520b3c6ee8", lines[1])


class StepsReport(Base):
    def setUp(self):
        super().setUp()
        write_session(self.root, "shop", main_session())
        self.data = self.run_cli("steps", "-p", "shop", "-s", "code-review", "--outputs", "dispatch_waves")
        self.activity = {a["activity"]: a["runs"] for a in self.data["activity"]}

    def test_counts_only_dev_team_scripts(self):
        self.assertEqual(self.activity["script dispatch_waves.py"], 1)
        self.assertNotIn("script foo.py", self.activity)

    def test_reference_read_and_edit(self):
        self.assertEqual(self.activity["read references/since-mode.md"], 1)
        self.assertNotIn("read references/abandoned.md", self.activity)
        self.assertEqual(self.activity["edit/write"], 1)

    def test_parallel_dispatch_with_aliases(self):
        self.assertEqual(self.activity["dispatch doc-review"], 1)
        self.assertEqual(self.activity["dispatch naming-review"], 1)

    def test_blocks_and_errors(self):
        self.assertEqual(self.activity["blocked dev_team_subagent"], 1)
        self.assertEqual(self.activity["blocked bash"], 1)
        self.assertEqual(self.activity["error skill"], 1)
        self.assertNotIn("skill nope", self.activity)

    def test_outputs_capture(self):
        self.assertEqual(self.data["perRun"][0]["outputs"][0]["output"], "build-jobs: requested=(unset) max=1 wave_width=1 -> effective=1")

    def test_text_output(self):
        text = self.run_cli("steps", "-p", "shop", "-s", "code-review", "--outputs", "dispatch_waves", as_json=False)
        self.assertIn("code-review: 1 runs", text)
        self.assertIn("    $ python3 $R/skills/code-review/scripts/dispatch_waves.py", text)

    def test_build_run_ends_where_code_review_loads(self):
        data = self.run_cli("steps", "-p", "shop", "-s", "build")
        self.assertEqual((data["runs"], data["activity"]), (1, []))

    def test_second_load_of_same_skill_starts_a_new_run(self):
        entries = [
            header_entry(),
            message_entry("u1", None, "user", slash_skill_text("pr")),
            assistant_entry("a1", "u1", [tool_call_block("c1", "bash", {"command": "python3 scripts/one.py"})]),
            tool_result_entry("r1", "a1", "c1", "bash", "1"),
            message_entry("u2", "r1", "user", slash_skill_text("pr")),
            assistant_entry("a2", "u2", [tool_call_block("c2", "bash", {"command": "python3 scripts/two.py"})]),
            tool_result_entry("r2", "a2", "c2", "bash", "2"),
        ]
        write_session(self.root, "repeat", entries)
        runs = self.run_cli("steps", "-p", "repeat", "-s", "pr")["perRun"]
        self.assertEqual([list(r["activity"]) for r in runs], [["script one.py"], ["script two.py"]])


class TimelineReport(Base):
    def setUp(self):
        super().setUp()
        write_session(self.root, "shop", main_session())
        self.events = self.run_cli("timeline", "latest", "-p", "shop")

    def texts(self, kind):
        return [e["text"] for e in self.events if e["kind"] == kind]

    def test_blocked_dispatch_shows_dispatch_and_block(self):
        self.assertEqual(self.texts(report.EVENT_DISPATCH), ["doc-review, naming-review: panel"])
        self.assertIn("dev_team_subagent: run the tests", self.texts(report.EVENT_HOOK_BLOCK))
        self.assertIn("bash: [pre_pr_review] BLOCKED: Code review required", self.texts(report.EVENT_HOOK_BLOCK))

    def test_failed_skill_call_is_an_error(self):
        self.assertEqual(self.texts(report.EVENT_ERROR), ['skill: Unknown skill "nope"'])

    def test_agent_done_model_and_compaction(self):
        self.assertEqual(self.texts(report.EVENT_AGENT_DONE), ["doc-review FAILED m tier haiku $0.188 2s (+1 nested)"])
        self.assertEqual(self.texts(report.EVENT_MODEL), ["openai/gpt-6.1-sol"])
        self.assertEqual(self.texts(report.EVENT_COMPACTION), ["tokensBefore 9000"])

    def test_tools_flag_lists_every_call(self):
        events = self.run_cli("timeline", "latest", "-p", "shop", "--tools")
        self.assertIn("app.py -> ~0 tok", [e["text"] for e in events if e["kind"] == "edit"])

    def test_untrusted_text_loses_control_characters(self):
        entries = [header_entry(), message_entry("u", None, "user", "hi \x1b]52;c;evil\x07 \u202e"),
                   {"type": "model_change", "id": "m", "parentId": "u", "provider": "x\x1b[2J", "modelId": "y"}]
        write_session(self.root, "esc", entries)
        text = self.run_cli("timeline", "latest", "-p", "esc", as_json=False)
        for char in ("\x1b", "\x07", "\u202e"):
            self.assertNotIn(char, text)

    def test_secret_shapes_are_masked(self):
        cases = {
            "Authorization: Bearer abc.def.ghi": ("abc.def.ghi", "Bearer ***"),
            "push with ghp_ABCDEFGHIJKLMNOPQRST": ("ABCDEFGHIJKLMNOPQRST", "ghp_***"),
            "key sk-proj1234567890abcd": ("proj1234567890abcd", "sk-***"),
            "token=abc123 and password: hunter2": ("abc123", "token=***"),
        }
        for text, (secret, masked) in cases.items():
            with self.subTest(text=text):
                line = report.one_line(text)
                self.assertNotIn(secret, line)
                self.assertIn(masked, line)
        self.assertNotIn("hunter2", report.one_line("password: hunter2"))


class AggregateReports(Base):
    def setUp(self):
        super().setUp()
        write_session(self.root, "shop", main_session())

    def test_skills(self):
        rows = {r["skill"]: r for r in self.run_cli("skills", "-p", "shop")}
        self.assertEqual(rows["code-review"], {"skill": "code-review", "loads": 1, "avgTokens": SKILL_TOKENS,
                                               "medianTurnsInContext": 2, "tokensTimesTurns": SKILL_TOKENS * 2})

    def test_tools_large_output_boundary(self):
        rows = {r["tool"]: r for r in self.run_cli("tools", "-p", "shop", "--large-output-tokens", str(SKILL_TOKENS))}
        self.assertEqual((rows["skill"]["largeCalls"], rows["skill"]["largeTokens"]), (1, SKILL_TOKENS))
        rows = {r["tool"]: r for r in self.run_cli("tools", "-p", "shop", "--large-output-tokens", str(SKILL_TOKENS + 1))}
        self.assertEqual(rows["skill"]["largeCalls"], 0)

    def test_projects(self):
        write_session(self.root, "plain", [header_entry("2026-09-01T10:00:00Z"), message_entry("u", None, "user", "hello")])
        rows = {r["project"]: r for r in self.run_cli("projects")}
        self.assertEqual((rows["Users-me-git-shop"]["devTeamSessions"], rows["Users-me-git-plain"]["devTeamSessions"]), (1, 0))
        self.assertEqual(rows["Users-me-git-plain"]["firstStarted"], "2026-09-01 10:00")


class BlockDetection(unittest.TestCase):
    def call(self, name, result, is_error=True):
        return report.ToolCall(0, name, {}, result, is_error, {})

    def test_known_hook_block(self):
        self.assertTrue(self.call("bash", "[pre_pr_review] BLOCKED: review first").blocked)

    def test_bracketed_tool_output_is_not_a_block(self):
        self.assertFalse(self.call("bash", "[ERROR] build failed").blocked)

    def test_github_style_block(self):
        self.assertTrue(self.call("bash", f"{report.GITHUB_STYLE_BLOCK_PREFIX} rewrite the text").blocked)

    def test_blocked_dispatch_without_error_flag(self):
        self.assertTrue(self.call("dev_team_subagent", f"doc-review: {report.DISPATCH_BLOCK_MARKER}\n[x] no", is_error=False).blocked)

    def test_feedback_header_in_successful_output_is_not_a_block(self):
        read = self.call("read", f"docs mention {report.HOOK_FEEDBACK_HEADER} here", is_error=False)
        self.assertIsNone(read.post_hook_feedback)
        self.assertFalse(read.blocked)

    def test_feedback_comes_from_the_last_header(self):
        call = self.call("bash", f"quoted {report.HOOK_FEEDBACK_HEADER} text\n\n{report.HOOK_FEEDBACK_HEADER}:\nreal")
        self.assertEqual(call.post_hook_feedback, "real")


class Selection(Base):
    def setUp(self):
        super().setUp()
        self.path = write_session(self.root, "shop", main_session())
        (self.root / "--Users-me-git-shopfront--").mkdir()

    def test_pick_session_by_id_part_and_path(self):
        self.assertEqual(report.pick_session(self.root, "ad520b3c", None), self.path)
        self.assertEqual(report.pick_session(self.root, str(self.path), None), self.path)

    def test_pick_session_rejects_unknown_id(self):
        with self.assertRaisesRegex(SystemExit, "0 sessions match"):
            report.pick_session(self.root, "zzz", None)

    def test_latest_in_empty_project(self):
        with self.assertRaisesRegex(SystemExit, "no sessions found"):
            report.pick_session(self.root, "latest", "shopfront")

    def test_ambiguous_and_unknown_project(self):
        with self.assertRaisesRegex(SystemExit, "several projects"):
            report.pick_project(self.root, "shop")
        with self.assertRaisesRegex(SystemExit, "no projects"):
            report.pick_project(self.root, "nothing")

    def test_sessions_root_honors_agent_dir(self):
        with mock.patch.dict(os.environ, {"PI_CODING_AGENT_DIR": "/tmp/agent"}):
            self.assertEqual(report.sessions_root(), Path("/tmp/agent/sessions"))


class ExtensionContract(unittest.TestCase):
    """The script copies these wire strings from the extension; fail when the extension renames one."""

    def test_wire_strings_still_in_extension(self):
        types = (ROOT / "extensions/dev-team/lib/subagent-types.ts").read_text()
        agents = (ROOT / "extensions/dev-team/lib/agents.ts").read_text()
        index = (ROOT / "extensions/dev-team/index.ts").read_text()
        skills = (ROOT / "extensions/dev-team/lib/skills.ts").read_text()
        self.assertIn(f'SUBAGENT_USAGE_ENTRY = "{report.USAGE_ENTRY}"', types)
        self.assertIn(f'DEV_TEAM_SUBAGENT_TOOL = "{report.SUBAGENT_TOOL}"', agents)
        self.assertIn(f'customType: "{report.SESSION_START_MESSAGE}"', index)
        self.assertIn(report.HOOK_FEEDBACK_HEADER, index)
        self.assertIn(report.GITHUB_STYLE_BLOCK_PREFIX, (ROOT / "extensions/dev-team/lib/github-style.ts").read_text())
        self.assertIn(report.DISPATCH_BLOCK_MARKER, (ROOT / "extensions/dev-team/lib/subagent.ts").read_text())
        self.assertIn("pre_pr_review", report.known_hook_names())
        self.assertIn(f'name: "{report.SKILL_TOOL}"', index)
        self.assertIn("The user invoked", skills)
        for field in ("ok: boolean", "tier?: string", "durationMs: number", "usage: UsageTotals", "nested?: NestedUsage[]"):
            self.assertIn(field, types)


if __name__ == "__main__":
    unittest.main()
