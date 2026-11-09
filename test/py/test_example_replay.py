"""scripts/example_replay.py runs a request's examples as acceptance tests and checks the case file against the request."""
import io
import json
import os
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path

from _loader import ROOT, load_module

replay = load_module("example_replay_under_test", ROOT / "scripts" / "example_replay.py")
os.environ.pop("DEV_TEAM_EXAMPLES", None)  # the mode comes from each test, not from the shell running them
os.environ["DEV_TEAM_FREEZE_DIR"] = tempfile.mkdtemp(prefix="dt-freeze-copies-")  # never the user's pi folder

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
        (self.root / ".dev-team/requests").mkdir(parents=True)
        (self.root / ".dev-team/requests/request-1.md").write_text(request)
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
        (p.root / ".dev-team/requests/request-2.md").write_text("From now on greetings say Hi instead of Hello.\n")
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
        (p.root / ".dev-team/requests/request-2.md").write_text("The `--name` field is now required.")
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
        (p.root / ".dev-team/requests/request-2.md").write_text("Greetings now say Hi.")
        case = {"id": "g", "source": "$ greet\nHello", "superseded_by": "Greetings now say Hi.",
                "steps": [{"run": f"{sys.executable} -c 'print(1)'", "stdout": "Hello"}]}
        p.write_cases([case])
        code, out = p.run()
        self.assertEqual(code, 0, out)
        self.assertIn("SUPERSEDED, now fails", out)

    def test_superseded_case_whose_input_is_now_rejected_still_fails(self):
        p = Project(request="```\n$ greet\nHello\n```\n")
        (p.root / ".dev-team/requests/request-2.md").write_text("Greetings now say Hi.")
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

    def test_requests_are_ordered_by_their_saved_time_not_their_kind(self):
        d = Path(tempfile.mkdtemp(prefix="dt-requests-"))
        for name in ("request-2026-11-04T10-00-00-000Z.md", "approved-2026-11-04T09-00-00-000Z.md",
                     "plan-2026-11-04T11-00-00-000Z.md", "approved-2026-11-04T12-00-00-000Z.md", "notes.md"):
            (d / name).write_text(name)
        self.assertEqual([n for n, _ in replay.load_requests(d)], [
            "notes.md", "approved-2026-11-04T09-00-00-000Z.md", "request-2026-11-04T10-00-00-000Z.md",
            "plan-2026-11-04T11-00-00-000Z.md", "approved-2026-11-04T12-00-00-000Z.md"])

    def test_newer_approved_examples_may_supersede_an_older_request(self):
        p = Project(request="no examples here")
        requests = p.root / ".dev-team/requests"
        (requests / "request-1.md").unlink()
        (requests / "request-2026-11-04T10-00-00-000Z.md").write_text("```\n$ greet\nHello\n```\n")
        (requests / "approved-2026-11-04T11-00-00-000Z.md").write_text("```\n$ greet\nHi\n```\n")
        old = {"id": "old", "source": "$ greet\nHello", "superseded_by": "$ greet\nHi",
               "steps": [{"run": f"{sys.executable} -c 'print(\"Hi\")'", "stdout": "Hello"}]}
        new = {"id": "new", "source": "$ greet\nHi", "steps": [{"run": f"{sys.executable} -c 'print(\"Hi\")'", "stdout": "Hi"}]}
        p.write_cases([old, new])
        code, out = p.run()
        self.assertEqual(code, 0, out)
        (requests / "approved-2026-11-04T11-00-00-000Z.md").rename(requests / "approved-2026-11-04T09-00-00-000Z.md")
        self.assertIn("must quote a request newer", p.run()[1])

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


SPEC_REQUEST = """Build the counter.

Rules:

- The `count` command prints the number of lines in the
  file it is given, as a bare integer.
- An empty file counts as zero lines, not one.
- Exits with status 3 when the file does not exist at all.

```
- this list item is inside a code block and is not a rule
```

```
$ count a.txt
3
```
"""

COUNT = "import sys, os\np = sys.argv[1]\nif not os.path.exists(p): sys.exit(3)\nprint(len(open(p).read().splitlines()))\n"


FENCED_ITEM_SKIP = {"block": "- this list item", "reason": "not an example"}


def count_cases(count="{root}/count.py"):
    run = f"{sys.executable} {count}"
    return [
        {"id": "example-count", "source": "$ count a.txt\n3", "files": {"a.txt": "x\ny\nz\n"},
         "steps": [{"run": f"{run} a.txt", "stdout": "3"}]},
        {"id": "rule-lines", "derived": True,
         "source": "The `count` command prints the number of lines in the file it is given, as a bare integer.",
         "files": {"b.txt": "1\n2\n3\n4\n5\n"}, "steps": [{"run": f"{run} b.txt", "stdout": "5"}]},
        {"id": "rule-empty", "derived": True, "source": "An empty file counts as zero lines, not one.",
         "files": {"e.txt": ""}, "steps": [{"run": f"{run} e.txt", "stdout": "0"}]},
        {"id": "rule-missing", "derived": True,
         "source": "Exits with status 3 when the file does not exist at all.",
         "steps": [{"run": f"{run} nope.txt", "exit": 3}]},
    ]


class SpecProject(Project):
    def __init__(self, request=SPEC_REQUEST, program=True):
        super().__init__(request=request)
        if program:
            (self.root / "count.py").write_text(COUNT)

    def write_cases(self, cases, skipped=()):
        super().write_cases(cases, [FENCED_ITEM_SKIP, *skipped])

    def static(self):
        data = replay.load_cases(self.root / ".dev-team/examples.json")
        return replay.static_problems(data, replay.load_requests(self.root / ".dev-team/requests"), spec=True)

    def frozen_path(self):
        return self.root / ".dev-team/requests/.frozen.json"

    def red(self, *extra):
        code, out = self.run("--red", "--json", "--mode", "spec", *extra)
        return code, json.loads(out)

    def freeze(self, cases_json):
        entries = {i: {"hash": c["hash"], "red": not c["passed"], "frozen_at": "2026-11-09T00:00:00Z"}
                   for i, c in cases_json["cases"].items()}
        self.frozen_path().write_text(json.dumps({"version": 1, "cases": entries}))


class DerivedCases(unittest.TestCase):
    def test_derived_case_values_need_not_be_in_source(self):
        p = SpecProject()
        p.write_cases(count_cases())
        self.assertEqual(p.static(), [])
        p.freeze(p.red()[1])
        code, out = p.run("--mode", "spec")
        self.assertEqual(code, 0, out)
        self.assertIn("4/4 cases pass", out)
        self.assertIn("3 derived", out)

    def test_derived_source_must_be_in_a_request_and_quote_eight_words(self):
        p = SpecProject()
        cases = count_cases()
        cases[1]["source"] = "The count command prints lines"
        cases[2]["source"] = "An empty file counts"
        p.write_cases(cases)
        out = "\n".join(p.static())
        self.assertIn("case rule-lines: `source` is not word for word", out)
        self.assertIn("case rule-empty: derived `source` must quote the rule it instances: at least 8 words", out)

    def test_derived_case_skips_input_line_check(self):
        case = {"id": "d", "derived": True, "source": "every job has a destination: a sink the job writes to always",
                "files": {"s.yaml": "destination: other"}, "steps": [{"run": "true", "stdout": "x"}]}
        text = replay.collapse(case["source"])
        self.assertEqual(replay.source_problems(case, text, spec=True), [])
        self.assertTrue(replay.source_problems(case, text, spec=False))

    def test_derived_failure_is_labelled(self):
        p = SpecProject()
        cases = count_cases()
        cases[2]["steps"][0]["stdout"] = "1"
        p.write_cases(cases)
        p.freeze(p.red()[1])
        code, out = p.run("--mode", "spec")
        self.assertEqual(code, 1)
        self.assertIn("case rule-empty: FAIL derived step 1: stdout", out)

    def test_on_mode_ignores_derived(self):
        p = SpecProject()
        p.write_cases(count_cases())
        code, out = p.run()
        self.assertEqual(code, 1)
        self.assertIn("case rule-lines: expected stdout has '5', which its `source` does not show whole", out)
        self.assertNotIn("rule not covered", out)
        self.assertNotIn("spec mode", out)


class RuleCoverage(unittest.TestCase):
    def rules(self, text):
        return [r for _, r in replay.rules([("r.md", text)])]

    def test_list_items_outside_fences_with_continuations(self):
        self.assertEqual(self.rules(SPEC_REQUEST), [
            "The `count` command prints the number of lines in the file it is given, as a bare integer.",
            "An empty file counts as zero lines, not one.",
            "Exits with status 3 when the file does not exist at all."])

    def test_numbered_items_and_short_items(self):
        text = "1. first rule has five words\n2) second rule also here\n* too short item\n+ plus items count too\n"
        self.assertEqual(self.rules(text), ["first rule has five words", "second rule also here",
                                            "plus items count too"])

    def test_uncovered_rule_is_reported(self):
        p = SpecProject()
        p.write_cases(count_cases()[:3])
        out = "\n".join(p.static())
        self.assertIn('rule not covered: "Exits with status 3 when the file does not exist at all." (request-1.md)', out)

    def test_eight_consecutive_words_cover_a_long_rule(self):
        cases = count_cases()
        cases[1]["source"] = "prints the number of lines in the file it"
        padded = [" " + replay.collapse(c["source"]) + " " for c in cases]
        self.assertTrue(replay.rule_covered(self.rules(SPEC_REQUEST)[0], padded))
        self.assertFalse(replay.rule_covered(self.rules(SPEC_REQUEST)[0], [" prints the number of lines in "]))

    def test_short_rule_needs_the_whole_item(self):
        self.assertTrue(replay.rule_covered("A short rule is here.", [" - A short rule is here. And more "]))
        self.assertFalse(replay.rule_covered("A short rule is here.", [" A short rule is "]))

    def test_skipped_rule(self):
        p = SpecProject()
        p.write_cases(count_cases()[:3], [{"rule": "Exits with status 3", "reason": "not observable"}])
        self.assertEqual(p.static(), [])
        p.freeze(p.red()[1])
        code, out = p.run()
        self.assertEqual(code, 0, out)
        self.assertIn("1 rule(s) skipped", out)
        self.assertIn("1 block(s) skipped", out)  # FENCED_ITEM_SKIP only, not the rule entry

    def test_ambiguous_or_reasonless_rule_skip(self):
        p = SpecProject()
        p.write_cases(count_cases()[:2], [{"rule": "An empty file"}])
        out = "\n".join(p.static())
        self.assertIn("skip rule 'An empty file': needs `rule` and `reason`", out)
        self.assertIn('rule not covered: "An empty file', out)
        _, problems = replay.rule_skip_targets([{"rule": "Ex", "reason": "x"}], {"Exits a", "Exits b", "Other c"})
        self.assertEqual(problems, ["skip rule 'Ex' matches 2 rules: quote enough of the item to match exactly one"])

    def test_rule_skip_in_on_mode_is_a_skip_without_a_block_as_in_v6(self):
        p = Project(request="```\n$ x\nok\n```\n")
        p.write_cases([{"id": "s", "source": "$ x\nok", "steps": [{"run": f"{sys.executable} -c 'print(\"ok\")'", "stdout": "ok"}]}],
                      [{"rule": "anything", "reason": "x"}])
        code, out = p.run()
        self.assertEqual(code, 1, out)
        self.assertIn("skip '': needs `block` and `reason`", out)
        self.assertIn("1 block(s) skipped", out)

    def test_full_item_text_skips_that_item_even_when_a_longer_item_starts_with_it(self):
        found = {"Reject empty names with error", "Reject empty names with error code 2 and a message"}
        covered, problems = replay.rule_skip_targets([{"rule": "Reject empty names with error", "reason": "covered by d2"}], found)
        self.assertEqual((covered, problems), ({"Reject empty names with error"}, []))
        _, problems = replay.rule_skip_targets([{"rule": "Reject empty names", "reason": "x"}], found)
        self.assertEqual(len(problems), 1)


class DotfilesAndModes(unittest.TestCase):
    def test_dotfiles_are_not_requests(self):
        d = Path(tempfile.mkdtemp(prefix="dt-requests-"))
        (d / "request-1.md").write_text("r")
        (d / ".frozen.json").write_text("{}")
        (d / ".notes.md").write_text("n")
        self.assertEqual([n for n, _ in replay.load_requests(d)], ["request-1.md"])

    def test_mode_from_flag_env_and_freeze_file(self):
        d = Path(tempfile.mkdtemp(prefix="dt-mode-"))
        frozen = d / ".frozen.json"
        self.assertEqual(replay.resolve_mode(None, frozen, {}), "on")
        self.assertEqual(replay.resolve_mode(None, frozen, {"DEV_TEAM_EXAMPLES": "on"}), "on")
        self.assertEqual(replay.resolve_mode(None, frozen, {"DEV_TEAM_EXAMPLES": "spec"}), "spec")
        self.assertEqual(replay.resolve_mode("spec", frozen, {}), "spec")
        self.assertEqual(replay.resolve_mode("on", frozen, {}), "on")
        # --mode on cannot turn the freeze check off.
        self.assertEqual(replay.resolve_mode("on", frozen, {"DEV_TEAM_EXAMPLES": "spec"}), "spec")
        # The value is read as the extension reads it (review-profile.ts examplesMode).
        for value in ("Spec", "spec ", " SPEC\n"):
            self.assertEqual(replay.resolve_mode(None, frozen, {"DEV_TEAM_EXAMPLES": value}), "spec", value)
        copy = d / "copy.frozen.json"
        copy.write_text("{}")
        self.assertEqual(replay.resolve_mode("on", frozen, {}, copy), "spec")
        copy.unlink()
        frozen.write_text("{}")
        self.assertEqual(replay.resolve_mode(None, frozen, {}), "spec")
        self.assertEqual(replay.resolve_mode("on", frozen, {}), "spec")

    def test_env_selects_spec_mode_in_main(self):
        p = SpecProject()
        p.write_cases(count_cases())
        os.environ["DEV_TEAM_EXAMPLES"] = "spec"
        try:
            out = p.run()[1]
        finally:
            os.environ.pop("DEV_TEAM_EXAMPLES")
        self.assertIn("case example-count is not frozen", out)

    def test_freeze_file_selects_spec_mode(self):
        p = SpecProject()
        p.write_cases(count_cases())
        p.frozen_path().write_text(json.dumps({"version": 1, "cases": {}}))
        out = p.run()[1]
        self.assertIn("case rule-lines is not frozen", out)
        self.assertNotIn("does not show whole", out)

    def test_format_mentions_spec_fields_only_in_spec_mode(self):
        p = SpecProject()
        on = p.run("--format")[1]
        spec = p.run("--format", "--mode", "spec")[1]
        self.assertEqual(on, replay.FORMAT + "\n")
        self.assertNotIn("derived", on)
        for word in ("derived: true", "already_passing", '{"rule":', "--red", ".frozen.json"):
            self.assertIn(word, spec)


class RedRunAndFreeze(unittest.TestCase):
    def test_red_json_before_the_program_exists(self):
        p = SpecProject(program=False)
        p.write_cases(count_cases())
        code, data = p.red()
        self.assertEqual(code, 0)
        self.assertEqual(data["static_problems"], [])
        self.assertEqual(sorted(data["cases"]), ["example-count", "rule-empty", "rule-lines", "rule-missing"])
        for case_id, c in data["cases"].items():
            self.assertFalse(c["passed"], case_id)
            self.assertEqual(c["derived"], case_id.startswith("rule-"))
            self.assertFalse(c["already_passing"])
            self.assertRegex(c["hash"], r"^[0-9a-f]{64}$")

    def test_red_with_static_problems_runs_nothing(self):
        p = SpecProject(program=False)
        p.write_cases(count_cases()[:3])
        code, data = p.red()
        self.assertEqual(code, 1)
        self.assertEqual(data["cases"], {})
        self.assertTrue(any("rule not covered" in x for x in data["static_problems"]))
        code, out = p.run("--red", "--mode", "spec")
        self.assertEqual(code, 1)
        self.assertIn("no case ran", out)

    def test_red_text_output_and_already_passing(self):
        p = SpecProject()
        (p.root / ".dev-team/requests/request-2.md").write_text("Also print a total line.\n")
        cases = count_cases()
        cases[3]["already_passing"] = "exit codes were built for an earlier request"
        p.write_cases(cases)
        code, data = p.red()
        self.assertEqual(code, 0)
        self.assertTrue(data["cases"]["rule-missing"]["passed"])
        self.assertTrue(data["cases"]["rule-missing"]["already_passing"])
        code, out = p.run("--red", "--mode", "spec")
        self.assertEqual(code, 0)
        self.assertIn("case rule-missing: GREEN derived (already_passing)", out)
        self.assertIn("case example-count: GREEN: passes before implementation", out)

    def test_already_passing_needs_a_reason(self):
        p = SpecProject()
        cases = count_cases()
        cases[0]["already_passing"] = ""
        p.write_cases(cases)
        self.assertIn("case example-count: `already_passing` needs a reason", p.run("--mode", "spec")[1])

    def test_hash_is_stable_and_ignores_superseded_by(self):
        case = count_cases()[1]
        h = replay.case_hash(case)
        self.assertEqual(h, replay.case_hash(json.loads(json.dumps(case))))
        self.assertEqual(h, replay.case_hash(dict(reversed(list(case.items())))))
        self.assertEqual(h, replay.case_hash({**case, "superseded_by": "newer text"}))
        self.assertNotEqual(h, replay.case_hash({**case, "source": case["source"] + " "}))
        import hashlib
        body = json.dumps(case, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
        self.assertEqual(h, hashlib.sha256(body.encode()).hexdigest())

    def test_frozen_cases_pass_after_implementation(self):
        p = SpecProject(program=False)
        p.write_cases(count_cases())
        p.freeze(p.red()[1])
        (p.root / "count.py").write_text(COUNT)
        code, out = p.run()
        self.assertEqual(code, 0, out)
        self.assertIn("4/4 cases pass", out)
        self.assertIn("4 frozen", out)

    def test_unfrozen_changed_and_removed_cases(self):
        p = SpecProject()
        cases = count_cases()
        p.write_cases(cases)
        p.freeze(p.red()[1])
        cases[2]["steps"][0]["stdout"] = "zero"
        extra = {"id": "new", "derived": True, "source": "An empty file counts as zero lines, not one.",
                 "files": {"e.txt": ""}, "steps": [{"run": f"{sys.executable} {{root}}/count.py e.txt", "stdout": "0"}]}
        p.write_cases([cases[0], cases[1], cases[2], extra])
        code, out = p.run()
        self.assertEqual(code, 1)
        self.assertIn("case new is not frozen: call dev_team_freeze_cases before you implement it", out)
        self.assertIn("case rule-empty changed after it was frozen: restore it; a changed spec needs superseded_by and a new case", out)
        self.assertIn("frozen case rule-missing was removed: keep it; use superseded_by", out)

    def test_superseding_a_frozen_case_keeps_it_frozen(self):
        p = SpecProject()
        cases = count_cases()
        p.write_cases(cases)
        p.freeze(p.red()[1])
        (p.root / ".dev-team/requests/request-2.md").write_text("An empty file now counts as one line.\n")
        cases[2]["superseded_by"] = "An empty file now counts as one line."
        p.write_cases(cases)
        out = p.run()[1]
        self.assertNotIn("rule-empty changed", out)
        self.assertNotIn("is not frozen", out)

    def test_bad_freeze_file_is_unusable(self):
        p = SpecProject()
        p.write_cases(count_cases())
        p.frozen_path().write_text("not json")
        self.assertEqual(p.run()[0], 2)

    def test_on_mode_without_freeze_file_does_no_freeze_checks(self):
        p = SpecProject()
        p.write_cases(count_cases()[:1])
        code, out = p.run()
        self.assertEqual(code, 0, out)
        self.assertNotIn("frozen", out)


def frozen_entries(cases_json):
    return {i: {"hash": c["hash"], "red": not c["passed"], "frozen_at": "2026-11-09T00:00:00Z"}
            for i, c in cases_json["cases"].items()}


class SpecFixes(unittest.TestCase):
    """Regressions from the v7 review: dead ends for an honest session, and ways around the freeze."""

    def frozen_project(self, cases=None, program=True, copy=False):
        p = SpecProject(program=program)
        p.write_cases(cases or count_cases())
        data = {"version": 1, "cases": frozen_entries(p.red()[1])}
        p.frozen_path().write_text(json.dumps(data))
        if copy:
            path = replay.freeze_copy_path(p.root)
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(json.dumps(data))
        return p

    def test_disputing_a_frozen_step_keeps_the_hash_and_the_run_can_pass(self):
        cases = count_cases()
        cases[2]["steps"][0]["stdout"] = "1"  # the author got the rule wrong
        p = self.frozen_project(cases)
        self.assertEqual(p.run()[0], 1)
        cases[2]["steps"][0]["disputed"] = "An empty file counts as zero lines, not one."
        p.write_cases(cases)
        code, out = p.run()
        self.assertEqual(code, 0, out)
        self.assertNotIn("changed after it was frozen", out)
        self.assertIn("DISPUTED FROZEN CASES: rule-empty", out)
        self.assertEqual(replay.case_hash(count_cases()[2]),
                         replay.case_hash({**count_cases()[2], "steps": [{**count_cases()[2]["steps"][0], "disputed": "x"}]}))

    def test_already_passing_needs_an_earlier_request_and_a_source_from_one(self):
        p = SpecProject()
        cases = count_cases()
        cases[3]["already_passing"] = "done earlier"
        p.write_cases(cases)
        self.assertTrue(any("there is only one saved request" in x for x in p.static()))
        (p.root / ".dev-team/requests/request-2.md").write_text("- Exits with status 3 when the file does not exist at all, too.\n")
        cases[3]["source"] = "Exits with status 3 when the file does not exist at all, too."
        p.write_cases(cases)
        self.assertTrue(any("source comes from the newest request (request-2.md)" in x for x in p.static()))
        cases[3]["source"] = "Exits with status 3 when the file does not exist at all."
        p.write_cases(cases, [{"rule": "Exits with status 3 when the file does not exist at all, too", "reason": "covered by rule-missing"}])
        self.assertEqual(p.static(), [])

    def test_a_superseded_case_needs_a_replacement_with_the_same_input(self):
        p = self.frozen_project()
        (p.root / ".dev-team/requests/request-2.md").write_text("The tool should also support a verbose flag for debugging output.\n")
        cases = count_cases()
        cases[0]["superseded_by"] = "The tool should also support a verbose flag for debugging output."
        p.write_cases(cases)
        code, out = p.run()
        self.assertEqual(code, 1)
        self.assertIn("case example-count: superseded, but no case replaces it", out)

    def test_a_newer_rule_that_makes_a_frozen_input_invalid_retires_it_through_its_replacement(self):
        add = 'import sys\nif "--base" not in sys.argv: sys.exit(2)\nprint(4)\n'
        req1 = "- The add command prints the sum of its two integer arguments.\n"
        req2 = "- The add command requires the --base option; without it, exit with code 2.\n"
        p = SpecProject(request=req1, program=False)
        run = f"{sys.executable} {{root}}/add.py add 2 2"
        d1 = {"id": "d1", "derived": True, "source": "The add command prints the sum of its two integer arguments.",
              "steps": [{"run": run, "stdout": "4"}]}
        Project.write_cases(p, [d1])  # no fenced block to skip
        p.frozen_path().write_text(json.dumps({"version": 1, "cases": frozen_entries(p.red()[1])}))
        (p.root / ".dev-team/requests/request-2.md").write_text(req2)
        d2 = {"id": "d2", "derived": True, "source": "The add command requires the --base option; without it, exit with code 2.",
              "steps": [{"run": run, "exit": 2}]}
        Project.write_cases(p, [{**d1, "superseded_by": d2["source"]}, d2])
        red = p.red()[1]
        self.assertEqual(red["static_problems"], [])
        self.assertTrue(red["cases"]["d2"].get("vacuous"), red)  # add.py does not exist yet
        entries = json.loads(p.frozen_path().read_text())["cases"]
        entries["d2"] = frozen_entries(red)["d2"]
        p.frozen_path().write_text(json.dumps({"version": 1, "cases": entries}))
        (p.root / "add.py").write_text(add)
        code, out = p.run()
        self.assertEqual(code, 0, out)
        self.assertIn("case d1: SUPERSEDED by d2, now rejects the input", out)

    def test_one_sentence_may_supersede_several_cases_each_with_its_replacement(self):
        req2 = "Every response now includes a version field set to 2.\n"
        cases = count_cases()
        p = self.frozen_project(cases)
        (p.root / ".dev-team/requests/request-2.md").write_text(req2)
        quote = req2.strip()
        olds = [{**c, "superseded_by": quote} for c in cases[:2]]
        news = [{**c, "id": c["id"] + "-v2", "derived": True, "source": quote} for c in cases[:2]]
        p.write_cases(olds + cases[2:] + news)
        self.assertEqual(p.static(), [])
        p.write_cases(olds + cases[2:] + news[:1])
        self.assertTrue(any("stop running on one sentence" in x for x in p.static()))

    def test_a_case_that_cannot_run_is_a_static_problem_so_it_is_never_frozen(self):
        p = SpecProject()
        cases = count_cases()
        cases[1]["steps"] = [{"stdout": "5"}]
        cases[2]["steps"][0]["match"] = "regexx"
        cases[3]["steps"][0]["exit"] = "3"
        p.write_cases(cases)
        code, data = p.red()
        self.assertEqual(code, 1)
        self.assertEqual(data["cases"], {})
        problems = "\n".join(data["static_problems"])
        self.assertIn("case rule-lines: step 1: has no `run`, `http` or `files`", problems)
        self.assertIn("case rule-empty: step 1: unknown match 'regexx'", problems)
        self.assertIn("case rule-missing: step 1: `exit` must be an integer", problems)

    def test_an_error_case_that_passes_on_a_missing_program_is_red(self):
        p = SpecProject(program=False)
        cases = count_cases()
        cases[3]["steps"][0]["exit"] = 2  # what python exits with when count.py is not there
        p.write_cases(cases)
        code, data = p.red()
        self.assertEqual(code, 0)
        self.assertFalse(data["cases"]["rule-missing"]["passed"])
        self.assertTrue(data["cases"]["rule-missing"]["vacuous"])
        self.assertNotIn("vacuous", data["cases"]["example-count"])
        self.assertIn("passes only because", p.run("--red", "--mode", "spec")[1])

    def test_only_with_an_unknown_or_partial_selection_fails_in_spec_mode(self):
        p = self.frozen_project()
        code, out = p.run("--only", "nosuch")
        self.assertEqual(code, 1)
        self.assertIn("--only nosuch: no such case", out)
        code, out = p.run("--only", "rule-empty")
        self.assertEqual(code, 1)
        self.assertIn("partial run: --only ran 1 of 4 active cases", out)
        self.assertEqual(p.run()[0], 0)

    def test_mode_on_and_another_requests_folder_do_not_turn_the_freeze_check_off(self):
        p = self.frozen_project()
        p.write_cases(count_cases()[:3])
        code, out = p.run("--mode", "on")
        self.assertEqual(code, 1)
        self.assertIn("frozen case rule-missing was removed", out)
        other = p.root / "r2"
        other.mkdir()
        (other / "request-1.md").write_text(SPEC_REQUEST)
        code, out = p.run("--requests", "r2")
        self.assertEqual(code, 1)
        self.assertIn("--requests r2: in spec mode the saved requests are .dev-team/requests", out)

    def test_deleting_the_freeze_file_is_caught_by_its_copy(self):
        cases = count_cases()
        cases[2]["steps"][0]["stdout"] = "1"
        p = self.frozen_project(cases, copy=True)
        self.assertEqual(p.run()[0], 1)
        p.frozen_path().unlink()  # `find .dev-team -name .frozen.json -delete`
        code, out = p.run()
        self.assertEqual(code, 1)
        self.assertIn("frozen case rule-empty is missing from .frozen.json", out)
        p.frozen_path().write_text(json.dumps({"version": 1, "cases": {"forged": {"hash": "0" * 64, "red": True}}}))
        out = p.run()[1]
        self.assertIn(".frozen.json names case forged, which dev_team_freeze_cases never froze", out)


if __name__ == "__main__":
    unittest.main()
