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
import json, sys
from http.server import BaseHTTPRequestHandler, HTTPServer
STAMP = sys.argv[2]
class H(BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def do_POST(self):
        n = int(self.headers.get("Content-Length") or 0)
        body = json.loads(self.rfile.read(n) or b"{}")
        out = json.dumps({"created_at": STAMP, "name": body.get("name"), "id": "17"}).encode()
        self.send_response(201); self.send_header("Content-Type", "application/json"); self.end_headers()
        self.wfile.write(out)
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
201 {"id": "1", "name": "a", "created_at": "2025-10-12T14:03:22Z"}
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


def item_case(stamp):
    return {
        "id": "create-item",
        "source": 'POST /items {"name": "a"}\n201 {"id": "1", "name": "a", "created_at": "2025-10-12T14:03:22Z"}',
        "server": f"{sys.executable} {{root}}/server.py {{port}} {stamp}",
        "steps": [{"http": "POST /items", "body": {"name": "a"}, "status": 201,
                   "response": {"id": "1", "name": "a", "created_at": "2025-10-12T14:03:22Z"}, "vary": ["id", "created_at"]}],
    }


SCHEMA_SKIP = [{"block": "item := {id, name, created_at}", "reason": "schema, not an example"}]


class Shape(unittest.TestCase):
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


class Runs(unittest.TestCase):
    def test_passing_cli_and_http_cases(self):
        p = Project()
        p.write_cases([greet_case("2026-11-02T10:15:07Z"), item_case("2026-11-02T10:15:07Z")], SCHEMA_SKIP)
        code, out = p.run()
        self.assertEqual(code, 0, out)
        self.assertIn("2/2 cases pass", out)

    def test_fractional_seconds_fail(self):
        p = Project()
        p.write_cases([greet_case("2026-11-02T10:15:07.148842Z"), item_case("2026-11-02T10:15:07+00:00")], SCHEMA_SKIP)
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
        p.write_cases([case, item_case("2026-11-02T10:15:07Z")], SCHEMA_SKIP)
        code, out = p.run()
        self.assertEqual(code, 1)
        self.assertIn("which its `source` does not show", out)

    def test_source_must_be_in_a_request(self):
        p = Project()
        case = greet_case("2026-11-02T10:15:07Z")
        case["source"] = case["source"].replace("Ada", "Bob")
        p.write_cases([case, item_case("2026-11-02T10:15:07Z")], SCHEMA_SKIP)
        self.assertIn("not word for word", p.run()[1])

    def test_uncovered_block_is_reported(self):
        p = Project()
        p.write_cases([greet_case("2026-11-02T10:15:07Z")])
        code, out = p.run()
        self.assertEqual(code, 1)
        self.assertIn("block starting 'POST /items", out)
        self.assertIn("block starting 'item := {id, name, created_at}'", out)

    def test_missing_case_file_with_examples_fails(self):
        code, out = Project().run()
        self.assertEqual(code, 1)
        self.assertIn("0/0 cases pass, 3 problem(s)", out)

    def test_no_requests_no_cases_passes(self):
        p = Project(request="no examples here")
        self.assertEqual(p.run()[0], 0)

    def test_superseded_case_stops_running_only_with_a_quote(self):
        request = REQUEST + "\nFrom now on greetings say Hi instead of Hello.\n"
        p = Project(request=request)
        case = greet_case("2026-11-02T10:15:07Z")
        case["steps"][0]["run"] = f"{sys.executable} -c 'print(1)'"
        case["superseded_by"] = "greetings say Hi instead of Hello"
        p.write_cases([case, item_case("2026-11-02T10:15:07Z")], SCHEMA_SKIP)
        self.assertEqual(p.run()[0], 0)
        case["superseded_by"] = "greetings changed"
        p.write_cases([case, item_case("2026-11-02T10:15:07Z")], SCHEMA_SKIP)
        self.assertIn("`superseded_by` is not word for word", p.run()[1])

    def test_duplicate_ids_are_unusable(self):
        p = Project()
        p.write_cases([greet_case("x"), greet_case("y")])
        self.assertEqual(p.run()[0], 2)


if __name__ == "__main__":
    unittest.main()
