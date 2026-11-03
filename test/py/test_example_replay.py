"""scripts/example_replay.py runs a request's examples as acceptance tests and checks the case file against the request."""
import io
import json
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path

from _loader import ROOT, load_module

replay = load_module("example_replay_under_test", ROOT / "scripts" / "example_replay.py")

SERVER = r'''
import json, sys, uuid
from http.server import BaseHTTPRequestHandler, HTTPServer
STAMP = sys.argv[2]
ITEMS = {}
class H(BaseHTTPRequestHandler):
    def log_message(self, *a): sys.stderr.write("x" * 2048 + "\n")
    def reply(self, code, obj):
        out = json.dumps(obj).encode()
        self.send_response(code); self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(out))); self.end_headers(); self.wfile.write(out)
    def do_POST(self):
        n = int(self.headers.get("Content-Length") or 0)
        body = json.loads(self.rfile.read(n) or b"{}")
        item = {"created_at": STAMP, "name": body.get("name"), "id": str(uuid.uuid4())}
        ITEMS[item["id"]] = item
        self.reply(201, item)
    def do_GET(self):
        item = ITEMS.get(self.path.rsplit("/", 1)[-1])
        self.reply(200, item) if item else self.reply(404, {"error": "not found"})
HTTPServer(("127.0.0.1", int(sys.argv[1])), H).serve_forever()
'''

REQUEST = """Implement the tool.

## Example 1

```
$ greet --name Ada
{"greeting": "Hello, Ada", "at": "2025-10-12T14:03:22Z"}
```

Create an item:

```
POST /items {"name": "a"}
201 {"id": "2f6d1f7c-7a71-4d8e-a2ae-2b7a5b3d6c44", "name": "a", "created_at": "2025-10-12T14:03:22Z"}
GET /items/2f6d1f7c-7a71-4d8e-a2ae-2b7a5b3d6c44
200 {"id": "2f6d1f7c-7a71-4d8e-a2ae-2b7a5b3d6c44", "name": "a"}
```

Events (excerpt):

```
{"event": "START", "n": 2}
... (more events) ...
{"event": "END"}
```

Schema:

```
item := {id, name, created_at}
```
"""

GREET = 'import json,sys; print(json.dumps({"at": sys.argv[1], "greeting": "Hello, Ada"}))'


class Project:
    """A temporary project root with a saved request, a case file and helper programs."""

    def __init__(self, request=REQUEST):
        self.root = Path(tempfile.mkdtemp(prefix="dt-examples-")).resolve()
        (self.root / ".claude/memory/requests").mkdir(parents=True)
        (self.root / ".claude/memory/requests/request-1.md").write_text(request)
        (self.root / "greet.py").write_text(GREET)
        (self.root / "server.py").write_text(SERVER)

    def write_cases(self, cases, skipped=()):
        (self.root / ".dev-team").mkdir(exist_ok=True)
        (self.root / ".dev-team/examples.json").write_text(json.dumps({"cases": cases, "skipped": list(skipped)}))

    def run(self, *extra):
        out = io.StringIO()
        with redirect_stdout(out):
            code = replay.main(["--root", str(self.root), *extra])
        return code, out.getvalue()


def greet_case(stamp, vary=("at",)):
    return {
        "id": "greet",
        "source": '$ greet --name Ada\n{"greeting": "Hello, Ada", "at": "2025-10-12T14:03:22Z"}',
        "steps": [{"run": f"{sys.executable} {{root}}/greet.py {stamp}", "exit": 0,
                   "stdout": '{"greeting": "Hello, Ada", "at": "2025-10-12T14:03:22Z"}', "vary": list(vary)}],
    }


UID = "2f6d1f7c-7a71-4d8e-a2ae-2b7a5b3d6c44"


def item_case(stamp, gets=1):
    get = {"http": "GET /items/{item}", "status": 200, "response": {"id": "{item}", "name": "a"}, "match": "subset",
           "why": "Events (excerpt):"}
    return {
        "id": "create-item",
        "source": f'POST /items {{"name": "a"}}\n201 {{"id": "{UID}", "name": "a", "created_at": "2025-10-12T14:03:22Z"}}\nGET /items/{UID}\n200 {{"id": "{UID}", "name": "a"}}',
        "server": f"{sys.executable} {{root}}/server.py {{port}} {stamp}",
        "steps": [{"http": "POST /items", "body": {"name": "a"}, "status": 201, "save": {"item": "id"},
                   "response": {"id": UID, "name": "a", "created_at": "2025-10-12T14:03:22Z"}, "vary": ["id", "created_at"]}]
        + [get] * gets,
    }


def excerpt_case(lines):
    return {"id": "events", "source": '{"event": "START", "n": 2} ... (more events) ... {"event": "END"}',
            "steps": [{"run": [sys.executable, "-c", f"print({lines!r})"], "match": "excerpt",
                       "stdout": '{"event": "START", "n": 2}\n... (more events) ...\n{"event": "END"}'}]}


SCHEMA_SKIP = [{"block": "item := {id, name, created_at}", "reason": "schema, not an example"}]


class Shape(unittest.TestCase):
    def test_uuid_and_hex_shape(self):
        self.assertTrue(replay.same_shape(UID, "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d"))
        self.assertFalse(replay.same_shape(UID, "item-1"))
        self.assertTrue(replay.same_shape("run_ab12cd", "run_9f00e1"))

    def test_placeholder_matches_any_value(self):
        self.assertIsNone(replay.compare({"id": "<uuid>"}, '{"id": "abc"}', {}))
        self.assertIsNotNone(replay.compare({"id": "<uuid>"}, '{"id": ""}', {}))

    def test_timestamp_shape(self):
        self.assertTrue(replay.same_shape("2025-10-12T14:03:22Z", "2026-11-02T10:15:07Z"))
        self.assertFalse(replay.same_shape("2025-10-12T14:03:22Z", "2026-11-02T10:15:07.148842Z"))
        self.assertFalse(replay.same_shape("2025-10-12T14:03:22Z", "2026-11-02T10:15:07+00:00"))

    def test_number_and_type_shape(self):
        self.assertTrue(replay.same_shape(1, 42))
        self.assertFalse(replay.same_shape(1, 1.5))
        self.assertFalse(replay.same_shape(True, 1))
        self.assertTrue(replay.same_shape("job-7", "job-123"))
        self.assertFalse(replay.same_shape("job-7", "task-7"))


class Compare(unittest.TestCase):
    def test_json_ignores_key_order(self):
        self.assertIsNone(replay.compare('{"a": 1, "b": [1, 2]}', '{"b": [1, 2], "a": 1.0}', {}))

    def test_json_lines(self):
        self.assertIsNone(replay.compare('[{"e": 1}, {"e": 2}]', '{"e": 1}\n{"e": 2}\n', {}))
        self.assertIn("$[1].e", replay.compare('[{"e": 1}, {"e": 2}]', '{"e": 1}\n{"e": 3}\n', {}))

    def test_json_extra_key_fails_unless_subset(self):
        self.assertIn("unexpected keys", replay.compare('{"a": 1}', '{"a": 1, "b": 2}', {}))
        self.assertIsNone(replay.compare('{"a": 1}', '{"a": 1, "b": 2}', {"match": "subset"}))

    def test_unordered(self):
        self.assertIsNotNone(replay.compare("[1, 2]", "[2, 1]", {}))
        self.assertIsNone(replay.compare("[1, 2]", "[2, 1]", {"unordered": True}))

    def test_exact_text_ignores_trailing_whitespace_only(self):
        self.assertIsNone(replay.compare("a\nb", "a  \r\nb\n", {}))
        self.assertIn("line 2", replay.compare("a\nb", "a\nc", {}))

    def test_shape_text(self):
        self.assertIsNone(replay.compare("took 12 ms", "took 7 ms", {"match": "shape"}))
        self.assertIsNotNone(replay.compare("took 12 ms", "took 7.5 ms", {"match": "shape"}))


GOOD_EVENTS = '{"event": "START", "n": 2}\n{"event": "FILE"}\n{"event": "END", "extra": 1}'


def all_cases(stamp="2026-11-02T10:15:07Z", events=GOOD_EVENTS, gets=1):
    return [greet_case(stamp), item_case(stamp, gets), excerpt_case(events)]


class Runs(unittest.TestCase):
    def test_passing_cli_and_http_cases(self):
        p = Project()
        p.write_cases(all_cases(), SCHEMA_SKIP)
        code, out = p.run()
        self.assertEqual(code, 0, out)
        self.assertIn("3/3 cases pass", out)

    def test_fractional_seconds_fail(self):
        p = Project()
        p.write_cases([greet_case("2026-11-02T10:15:07.148842Z"), item_case("2026-11-02T10:15:07+00:00"), excerpt_case(GOOD_EVENTS)], SCHEMA_SKIP)
        code, out = p.run()
        self.assertEqual(code, 1)
        self.assertIn("case greet: FAIL step 1: stdout: $.at", out)
        self.assertIn("case create-item: FAIL step 1: response: $.created_at", out)

    def test_value_without_vary_must_be_equal(self):
        p = Project()
        p.write_cases([greet_case("2026-11-02T10:15:07Z", vary=())], SCHEMA_SKIP)
        code, out = p.run("--only", "greet")
        self.assertEqual(code, 1)
        self.assertIn("expected '2025-10-12T14:03:22Z'", out)

    def test_noisy_server_and_saved_ids_over_many_steps(self):
        p = Project()
        p.write_cases(all_cases(gets=60), SCHEMA_SKIP)
        code, out = p.run()
        self.assertEqual(code, 0, out)

    def test_excerpt_order_and_missing_line(self):
        p = Project()
        p.write_cases(all_cases(events='{"event": "END"}\n{"event": "START", "n": 2}'), SCHEMA_SKIP)
        code, out = p.run("--only", "events")
        self.assertEqual(code, 1)
        self.assertIn("not found in order", out)

    def test_jsonl_expected(self):
        self.assertIsNone(replay.compare('{"e": 1}\n{"e": 2}', '{"e": 1}\n{"e": 2}\n', {}))
        self.assertIn("$[1].e", replay.compare('{"e": 1}\n{"e": 2}', '{"e": 1}\n{"e": 3}\n', {}))

    def test_disputed_step_reports_without_failing(self):
        p = Project(request=REQUEST + "\nGreetings never include a time.\n")
        case = greet_case("2026-11-02T10:15:07.1Z")
        case["steps"][0]["disputed"] = "Greetings never include a time."
        p.write_cases([case, item_case("2026-11-02T10:15:07Z"), excerpt_case(GOOD_EVENTS)], SCHEMA_SKIP)
        code, out = p.run()
        self.assertEqual(code, 0, out)
        self.assertIn("case greet: DISPUTED", out)

    def test_files_and_exit(self):
        p = Project(request="```\n$ touch out/w.txt\n(empty line)\n```\n")
        case = {"id": "w", "source": "$ touch out/w.txt", "files": {"out/.keep": ""},
                "steps": [{"run": "printf '\\n' > out/w.txt", "exit": 0}, {"files": {"out/w.txt": ""}}]}
        p.write_cases([case], [{"block": "$ touch", "reason": "covered"}])
        self.assertEqual(p.run()[0], 0)


class Honesty(unittest.TestCase):
    def test_edited_expectation_is_reported(self):
        p = Project()
        case = greet_case("2026-11-02T10:15:07.148842Z")
        case["steps"][0]["stdout"] = '{"greeting": "Hello, Ada", "at": "2025-10-12T14:03:22.000000Z"}'
        p.write_cases([case, item_case("2026-11-02T10:15:07Z"), excerpt_case(GOOD_EVENTS)], SCHEMA_SKIP)
        code, out = p.run()
        self.assertEqual(code, 1)
        self.assertIn("which its `source` does not show", out)

    def test_truncated_value_is_not_in_source(self):
        case = greet_case("x")
        case["steps"][0]["stdout"] = '{"greeting": "Hello, Ada", "at": "2025-10-12T14:03:22"}'
        problems = replay.source_problems(case, replay.collapse(REQUEST))
        self.assertTrue(any("2025-10-12T14:03:22" in p for p in problems), problems)

    def test_subset_needs_an_elision_or_a_quote(self):
        case = item_case("x")
        case["steps"][1].pop("why")
        problems = replay.source_problems(case, replay.collapse(REQUEST))
        self.assertTrue(any("needs '...'" in p for p in problems), problems)

    def test_ambiguous_skip_is_reported(self):
        p = Project(request="```\n{\n\"a\": 1\n}\n```\n```\n{\n\"b\": 2\n}\n```\n")
        p.write_cases([], [{"block": "{", "reason": "schema"}])
        code, out = p.run()
        self.assertEqual(code, 1)
        self.assertIn("matches 2 blocks", out)

    def test_source_miss_says_where(self):
        case = greet_case("x")
        case["source"] = case["source"].replace("Ada", "Bob")
        problems = replay.source_problems(case, replay.collapse(REQUEST))
        self.assertIn("where the request has", problems[0])

    def test_source_must_be_in_a_request(self):
        p = Project()
        case = greet_case("2026-11-02T10:15:07Z")
        case["source"] = case["source"].replace("Ada", "Bob")
        p.write_cases([case, item_case("2026-11-02T10:15:07Z"), excerpt_case(GOOD_EVENTS)], SCHEMA_SKIP)
        self.assertIn("not word for word", p.run()[1])

    def test_uncovered_block_is_reported(self):
        p = Project()
        p.write_cases([greet_case("2026-11-02T10:15:07Z")])
        code, out = p.run()
        self.assertEqual(code, 1)
        self.assertIn("block starting 'POST /items", out)
        self.assertIn("block starting '{\"event\": \"START\"", out)
        self.assertIn("block starting 'item := {id, name, created_at}'", out)

    def test_missing_case_file_with_examples_fails(self):
        code, out = Project().run()
        self.assertEqual(code, 1)
        self.assertIn("0/0 cases pass, 4 problem(s)", out)

    def test_no_requests_no_cases_passes(self):
        p = Project(request="no examples here")
        self.assertEqual(p.run()[0], 0)

    def test_superseded_case_stops_running_only_with_a_quote(self):
        p = Project()
        (p.root / ".claude/memory/requests/request-2.md").write_text("From now on greetings say Hi instead of Hello.\n")
        case = greet_case("2026-11-02T10:15:07Z")
        case["steps"][0]["run"] = f"{sys.executable} -c 'print(1)'"
        case["superseded_by"] = "greetings say Hi instead of Hello"
        p.write_cases([case, item_case("2026-11-02T10:15:07Z"), excerpt_case(GOOD_EVENTS)], SCHEMA_SKIP)
        self.assertEqual(p.run()[0], 0)
        case["superseded_by"] = "greetings changed"
        p.write_cases([case, item_case("2026-11-02T10:15:07Z"), excerpt_case(GOOD_EVENTS)], SCHEMA_SKIP)
        self.assertIn("`superseded_by` is not word for word", p.run()[1])

    def test_one_sentence_cannot_retire_several_cases(self):
        older = "```\n$ greet --name Ada\nHello, Ada\n```\n```\n$ greet --name Bob\nHello, Bob\n```\n"
        p = Project(request=older)
        (p.root / ".claude/memory/requests/request-2.md").write_text("The `--name` field is now required.")
        cases = [{"id": n, "source": f"$ greet --name {n}\nHello, {n}", "superseded_by": "The `--name` field is now required.",
                  "steps": [{"run": f"{sys.executable} -c 'print(\"Hello, {n}\")'", "stdout": f"Hello, {n}"}]} for n in ("Ada", "Bob")]
        p.write_cases(cases)
        code, out = p.run()
        self.assertEqual(code, 1)
        self.assertIn("stop running on one sentence", out)
        cases[1].pop("superseded_by")
        p.write_cases(cases)
        self.assertEqual(p.run()[0], 0)

    def test_superseded_case_still_runs_and_shows_failure(self):
        p = Project(request="```\n$ greet\nHello\n```\n")
        (p.root / ".claude/memory/requests/request-2.md").write_text("Greetings now say Hi.")
        case = {"id": "g", "source": "$ greet\nHello", "superseded_by": "Greetings now say Hi.",
                "steps": [{"run": f"{sys.executable} -c 'print(1)'", "stdout": "Hello"}]}
        p.write_cases([case])
        code, out = p.run()
        self.assertEqual(code, 0, out)
        self.assertIn("SUPERSEDED, now fails", out)

    def test_superseded_case_whose_input_is_now_rejected_still_fails(self):
        p = Project(request="```\n$ greet\nHello\n```\n")
        (p.root / ".claude/memory/requests/request-2.md").write_text("Greetings now say Hi.")
        case = {"id": "g", "source": "$ greet\nHello", "superseded_by": "Greetings now say Hi.",
                "steps": [{"run": f"{sys.executable} -c 'import sys; sys.exit(\"bad input\")' {{root}}", "stdout": "Hello"}]}
        p.write_cases([case])
        code, out = p.run()
        self.assertEqual(code, 1, out)
        self.assertIn("now rejects the input", out)

    def test_changed_example_input_is_reported(self):
        source = "jobs:\n  - id: a\n    destination: ignored://sink\n$ run\nok"
        case = {"id": "c", "source": source, "files": {"s.yaml": "jobs:\n  - id: a\n    destination: backup://\n    extra: 1"},
                "steps": [{"run": "true", "stdout": "ok"}]}
        problems = replay.source_problems(case, replay.collapse(source))
        self.assertEqual(len(problems), 1, problems)
        self.assertIn("destination: backup://", problems[0])

    def test_superseding_quote_must_be_newer(self):
        p = Project(request="```\n$ greet\nHello\n```\nGreetings now say Hi.\n")
        case = {"id": "g", "source": "$ greet\nHello", "superseded_by": "Greetings now say Hi.",
                "steps": [{"run": "true", "stdout": "Hello"}]}
        p.write_cases([case])
        self.assertIn("must quote a request newer", p.run()[1])

    def test_elided_object_allows_other_keys(self):
        self.assertIsNone(replay.compare({"a": 1, "...": "..."}, '{"a": 1, "b": 2}', {}))
        self.assertIsNotNone(replay.compare({"a": 1}, '{"a": 1, "b": 2}', {}))

    def test_failing_setup_command_fails(self):
        p = Project(request="```\n$ x\nok\n```\n")
        case = {"id": "s", "source": "$ x\nok", "steps": [{"run": "false"}, {"run": f"{sys.executable} -c 'print(\"ok\")'", "stdout": "ok"}]}
        p.write_cases([case])
        self.assertIn("exit 1, expected 0", p.run()[1])

    def test_duplicate_ids_are_unusable(self):
        p = Project()
        p.write_cases([greet_case("x"), greet_case("y")])
        self.assertEqual(p.run()[0], 2)


if __name__ == "__main__":
    unittest.main()
