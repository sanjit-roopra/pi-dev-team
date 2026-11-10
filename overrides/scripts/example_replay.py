#!/usr/bin/env python3
"""Run the examples a request shows as acceptance tests for the program.

A request (issue, spec, ticket) that shows an example (a command and its output, an HTTP call and its
response) makes that example a contract. This script reads a case file (default `.dev-team/examples.json`)
in which each example is copied from the request, runs every case against the program, and compares the
output. It also checks that the case file is honest and complete against the saved requests (default
`.dev-team/requests/`):

- every case quotes its example (`source`) word for word from a saved request, and every expected value
  appears whole in that quote, so a case cannot be edited to match the code;
- every fenced code block in a saved request is covered by case sources or skipped with a reason.

Cases are kept across requests, so a later change that breaks an earlier example fails here. A case stops
running only when `superseded_by` quotes text from a saved request that changes the behaviour.

    example_replay.py [--cases FILE] [--requests DIR] [--root DIR] [--only ID] [--timeout SECONDS] [--mode on|spec]
    example_replay.py --red [--json]  checks the case file, then runs every case before the code exists (red run)
    example_replay.py --format        prints the case file format

Spec mode (env DEV_TEAM_EXAMPLES=spec, or once `<requests dir>/.frozen.json` exists, or --mode spec) also accepts
derived cases (a rule's concrete instance), checks that every rule (list item) in a saved request is covered by a
case or skipped, and checks every case against the freeze file, so a frozen case cannot be edited to match the code.

Exit 0: every check holds and every case passes. 1: a check or case failed (each is listed). 2: the case file
is unusable.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import signal
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path

FORMAT = """\
Case file (JSON), default .dev-team/examples.json:

{
  "cases": [
    {
      "id": "example-1-relative-paths",
      "source": "<the example from the request, copied character for character: its input and its output>",
      "files": {"files/A/B/C/D.py": "", "schedule.yaml": "..."},
      "server": "python {root}/server.py --port {port}",
      "steps": [
        {"run": "python {root}/main.py --mount files", "stdin": "...",
         "stdout": "<expected output>", "exit": 0, "match": "json", "vary": ["now_local"]},
        {"http": "POST /items", "body": {"name": "a"}, "headers": {"X-Key": "k"},
         "status": 201, "response": {"id": "2f6d1f7c-7a71-4d8e-a2ae-2b7a5b3d6c44", "created_at": "2025-10-12T14:03:22Z"},
         "vary": ["id", "created_at"], "save": {"item": "id"}},
        {"http": "GET /items/{item}", "status": 200},
        {"files": {"out/warnings.txt": "\\n"}}
      ],
      "superseded_by": "<optional: text from a newer request that changes this behaviour; the case then stops running>"
    }
  ],
  "skipped": [{"block": "<the code block's text, or enough of its start to match only that block>", "reason": "schema / grammar / not runnable"}]
}

Each case runs in a fresh temporary directory (the working directory) after `files` are written there.
Placeholders: {root} the project root, {tmp} the case directory, {port} a free port, and {name} for each value a
step saved. `server`, when set, is started before the steps and stopped after them; `http` steps go to it.
`save` stores values from a JSON response or stdout ({"name": "dotted.path", e.g. "items.0.id"}) for later
steps: use it where an example reuses an id the program generated.
A step checks only what it names: `stdout`, `stderr`, `exit` for `run` (a command without {root} is setup and
must exit 0 unless it names `exit`); `status`, `response` for `http`;
`files` compares files in the case directory after the earlier steps. A case must check something.
`source` must be word for word in a saved request (whitespace may differ), and every expected value must
appear whole in it. Setup steps that state no expected output need no source.

match (per step):
  exact    text equal (line endings and trailing whitespace ignored); the default for text
  json     JSON equal, key order ignored; the default when the expected value is JSON. JSON lines (one value
           per line) compare as a list. Numbers compare by value.
  subset   like json, but objects may have keys the example omits (an object with a "..." key in the example
           already allows other keys)
  excerpt  the example shows some lines of the output, in order, with "..." lines for the omitted ones; each
           shown line must appear in the output in that order (JSON lines compare as JSON, with subset objects)
  shape    text with the same shape (see vary)
  subset and excerpt need "..." in the source, or "why": a word-for-word quote of request text that says the
  example is partial.
vary: keys whose values the program generates (ids, timestamps, random tokens). The actual value must have the
  example's shape: digit runs match any digits, hex runs (as in a UUID or hash) match any hex of that case,
  every other character must be equal. 2025-10-12T14:03:22Z does not match 2025-10-12T14:03:22.148842Z or
  2025-10-12T14:03:22+00:00. An expected value written as <description> matches any non-empty string.
  Never put a value the request defines (a count, a sum, a status, a name) under vary.
unordered: true compares JSON arrays as multisets, only when the request says the order is unspecified.
superseded_by: a case stops counting only on text from a newer request that changes that example's output for
  its input; each superseded case needs its own quote, and it still runs (a failure is shown, not counted). If
  the program now rejects the case's input (non-zero exit, 4xx/5xx status), the case still fails.
Inputs (files, run, stdin, body) come from the example too: never change an input the example shows, only add
what it leaves out.
derived: true on a case whose output the request states in prose, not in an example: a configuration or data
  block the request shows (run the program on that block as written), or the first-run or empty state of an
  output the request shows. Expected values are the exact output the request's text implies through the
  program's real interface (the CLI command or HTTP call the request defines). `source` is still word for word
  in a saved request, quotes the block or the text that states the outcome, and has at least 8 words. Expected
  values and inputs need not appear in it. Never mark an example that shows its own output as derived.
disputed: "<quote>" on a step whose example contradicts the request's own text: the quote is the contradicting
  text, word for word. A disputed step that fails is reported and does not fail the run. Not for a format,
  precision or suffix the text leaves open: there the example decides.

Copy expected values exactly as the request shows them. When the program disagrees with an example, fix the
program, not the case.
"""

SPEC_FORMAT = """\

Spec mode (DEV_TEAM_EXAMPLES=spec): the rules of a request become cases too, written before the code.

derived: true (see above) is also how every listed rule becomes a case here: small inputs you choose, and the
  exact output the rule implies through the program's real interface.
already_passing: "<reason>" on a case that passes before you implement anything, because an earlier request
  already built that behaviour: not with only one saved request, and not on a case whose source comes from the
  newest one. Any other case must fail on its red run. A case that passes only because the program file it
  runs ({root}/...) does not exist yet counts as red (vacuous). An error case that the current program already
  rejects for another reason (an unknown option, say) passes too: add a first step that uses the new behaviour
  successfully, or check the error text the request states, so the case fails until the feature exists.
skipped also takes {"rule": "<the list item's text, or enough of its start to match only that item>",
  "reason": "not observable / covered by <case id> / ..."}.
Rule coverage: every list item (-, *, +, 1. or 1)) with at least 4 words, outside code blocks, in a saved
  request is a rule. A case covers it when its `source` holds 8 consecutive words of the item (the whole item if
  it is shorter), else skip it with a reason.
Red run: example_replay.py --red [--json] checks the case file and runs every case; failures are expected there.
  dev_team_freeze_cases records each case's hash in .dev-team/requests/.frozen.json (and a copy outside the
  project). A frozen case must not change (superseded_by and a step's `disputed` excepted) and must not be
  removed. A step's structure (run/http/files, match, exit, status) is checked before anything runs.
superseded_by (spec mode): the case needs a replacement, an active case whose source comes from the superseding
  request (or a newer one) and whose first run/http step has the same input. One sentence may then supersede
  several cases, each with its own replacement. When the newer text makes the old input invalid, the old case
  stops failing on the rejection: its replacement expects it.
Normal run (spec mode): --mode on does not turn the freeze check off, --requests must be the default folder, and
  --only fails on an unknown id or a partial run: run without --only before you report done.
"""

CASES_DEFAULT = ".dev-team/examples.json"
REQUESTS_DEFAULT = ".dev-team/requests"
FROZEN_NAME = ".frozen.json"
MODES = ("on", "spec")
FENCE = re.compile(r"^([ \t]*)(`{3,}|~{3,})[^\n]*\n(.*?)^[ \t]*\2[ \t]*$", re.M | re.S)
TOKEN = re.compile(r"[A-Za-z0-9]+")
UUID = re.compile(r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\Z")
PLACEHOLDER = re.compile(r"<[^<>\n]+>\Z")
ELISION = re.compile(r"^\s*(\.\.\.|…)")
BRACKETS_ONLY = re.compile(r"^[\s\[\]{}(),]*$")
ELIDED_KEYS = ("...", "…")
CHECK_KEYS = ("stdout", "stderr", "exit", "status", "response", "files")
MISSING = object()


class CaseFileError(Exception):
    pass


def collapse(text) -> str:
    return " ".join(str(text).split())


# --- Shapes ----------------------------------------------------------------------


def token_pattern(token: str) -> str:
    """A run of letters and digits: hex runs (with a digit and a letter) match any hex of that case; else digit
    runs match any digits and letters stay literal."""
    has_digit = any(c.isdigit() for c in token)
    if has_digit and len(token) >= 4 and re.fullmatch(r"[0-9a-f]*[a-f][0-9a-f]*", token):
        return "[0-9a-f]+"
    if has_digit and len(token) >= 4 and re.fullmatch(r"[0-9A-F]*[A-F][0-9A-F]*", token):
        return "[0-9A-F]+"
    return "".join("[0-9]+" if part.isdigit() else re.escape(part) for part in re.split(r"([0-9]+)", token) if part)


def shape_pattern(example: str) -> re.Pattern:
    if UUID.match(example):
        return re.compile(UUID.pattern)
    out, at = [], 0
    for match in TOKEN.finditer(example):
        out.append(re.escape(example[at:match.start()]))
        out.append(token_pattern(match.group()))
        at = match.end()
    out.append(re.escape(example[at:]))
    return re.compile("".join(out) + r"\Z")


def same_shape(expected, actual) -> bool:
    if isinstance(expected, bool) or isinstance(actual, bool):
        return type(expected) is type(actual)
    if isinstance(expected, (int, float)):
        return isinstance(actual, (int, float)) and isinstance(expected, int) == isinstance(actual, int)
    if isinstance(expected, str):
        return isinstance(actual, str) and bool(shape_pattern(expected).match(actual))
    return type(expected) is type(actual)


# --- JSON comparison ---------------------------------------------------------------


def parse_json_output(text: str):
    """One JSON value, else JSON lines as a list; MISSING when neither parses."""
    try:
        return json.loads(text)
    except ValueError:
        pass
    lines = [line for line in str(text).splitlines() if line.strip()]
    try:
        return [json.loads(line) for line in lines] if lines else MISSING
    except ValueError:
        return MISSING


def leaf_equal(expected, actual) -> bool:
    if isinstance(expected, bool) or isinstance(actual, bool):
        return expected is actual
    if isinstance(expected, (int, float)) and isinstance(actual, (int, float)):
        return expected == actual
    return type(expected) is type(actual) and expected == actual


class JsonDiff:
    def __init__(self, vary, subset: bool, unordered: bool):
        self.vary = set(vary or ())
        self.subset = subset
        self.unordered = unordered

    def first(self, expected, actual, path="$", key=None):
        """The first difference as 'path: reason', or None."""
        if isinstance(expected, str) and PLACEHOLDER.match(expected):
            return None if isinstance(actual, str) and actual else f"{path}: expected a value for {expected}, got {actual!r}"
        if key in self.vary and not isinstance(expected, (dict, list)):
            return None if same_shape(expected, actual) else f"{path}: {actual!r} does not have the shape of {expected!r}"
        if isinstance(expected, dict):
            return self._dict(expected, actual, path)
        if isinstance(expected, list):
            return self._list(expected, actual, path)
        return None if leaf_equal(expected, actual) else f"{path}: expected {expected!r}, got {actual!r}"

    def _dict(self, expected, actual, path):
        if not isinstance(actual, dict):
            return f"{path}: expected an object, got {type(actual).__name__}"
        elided = any(k in ELIDED_KEYS for k in expected)  # {"...": "..."} in an example: other keys may follow
        for k, value in expected.items():
            if k in ELIDED_KEYS:
                continue
            if k not in actual:
                return f"{path}.{k}: missing"
            diff = self.first(value, actual[k], f"{path}.{k}", k)
            if diff:
                return diff
        extra = sorted(set(actual) - set(expected))
        return None if self.subset or elided or not extra else f"{path}: unexpected keys {extra}"

    def _list(self, expected, actual, path):
        if not isinstance(actual, list):
            return f"{path}: expected an array, got {type(actual).__name__}"
        if len(expected) != len(actual):
            return f"{path}: expected {len(expected)} items, got {len(actual)}"
        if self.unordered:
            return self._unordered(expected, actual, path)
        for i, (e, a) in enumerate(zip(expected, actual)):
            diff = self.first(e, a, f"{path}[{i}]")
            if diff:
                return diff
        return None

    def _unordered(self, expected, actual, path):
        left = list(actual)
        for i, e in enumerate(expected):
            hit = next((j for j, a in enumerate(left) if self.first(e, a) is None), None)
            if hit is None:
                return f"{path}[{i}]: no matching item for {json.dumps(e)[:200]}"
            left.pop(hit)
        return None


# --- Text comparison ---------------------------------------------------------------


def normalize_text(text) -> str:
    lines = str(text).replace("\r\n", "\n").split("\n")
    return "\n".join(line.rstrip() for line in lines).rstrip()


def first_line_diff(expected: str, actual: str) -> str:
    e_lines, a_lines = expected.split("\n"), actual.split("\n")
    for i in range(max(len(e_lines), len(a_lines))):
        e = e_lines[i] if i < len(e_lines) else "<end>"
        a = a_lines[i] if i < len(a_lines) else "<end>"
        if e != a:
            return f"line {i + 1}: expected {e!r}, got {a!r}"
    return "outputs differ"


def line_matches(expected: str, actual: str, diff: JsonDiff) -> bool:
    e, a = parse_json_output(expected), parse_json_output(actual)
    if isinstance(e, (dict, list)) and isinstance(a, (dict, list)):
        return diff.first(e, a) is None
    return expected.strip() == actual.strip()


def excerpt_diff(expected: str, actual: str, step: dict):
    """Each shown line of `expected` (lines starting with ... dropped) appears in `actual`, in order."""
    diff = JsonDiff(step.get("vary"), True, bool(step.get("unordered")))
    lines = [line for line in actual.splitlines() if line.strip()]
    at = 0
    for n, want in enumerate(line for line in expected.splitlines() if line.strip() and not ELISION.match(line)):
        hit = next((i for i in range(at, len(lines)) if line_matches(want, lines[i], diff)), None)
        if hit is None:
            return f"shown line {n + 1} {want.strip()[:120]!r} not found in order after output line {at}"
        at = hit + 1
    return None


def json_value(expected, mode: str):
    want = parse_json_output(expected) if isinstance(expected, str) else expected
    if want is MISSING:
        raise CaseFileError(f"expected value is not JSON (match {mode})")
    return want


def compare(expected, actual_text: str, step: dict):
    """None when `actual_text` matches `expected` under the step's match mode, else the reason."""
    mode = step.get("match") or default_mode(expected)
    if mode in ("json", "subset"):
        want = json_value(expected, mode)
        got = parse_json_output(actual_text)
        if got is MISSING:
            return f"output is not JSON: {actual_text[:200]!r}"
        return JsonDiff(step.get("vary"), mode == "subset", bool(step.get("unordered"))).first(want, got)
    if mode == "excerpt":
        return excerpt_diff(json_text(expected), actual_text, step)
    want, got = normalize_text(json_text(expected)), normalize_text(actual_text)
    if mode == "shape":
        return None if shape_pattern(want).match(got) else "shape differs: " + first_line_diff(want, got)
    if mode != "exact":
        raise CaseFileError(f"unknown match {mode!r}")
    return None if want == got else first_line_diff(want, got)


def default_mode(expected) -> str:
    if isinstance(expected, (dict, list)):
        return "json"
    text = str(expected).strip()
    return "json" if text[:1] in ("[", "{") and parse_json_output(text) is not MISSING else "exact"


def json_text(value) -> str:
    return value if isinstance(value, str) else json.dumps(value)


# --- Requests: source and coverage checks --------------------------------------------


REQUEST_STAMP = re.compile(r"^[a-z]+-(\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d-\d{3}Z)\.md$")


def request_order(path: Path) -> tuple[str, str]:
    """Oldest first by the time in the saved name (`<kind>-<ISO time>.md`), whatever the kind: `approved-`,
    `plan-`, `request-` and `specs-` files interleave by time. A name without a time sorts first, by name."""
    match = REQUEST_STAMP.match(path.name)
    return (match.group(1) if match else "", path.name)


def load_requests(directory: Path) -> list[tuple[str, str]]:
    """The saved requests, oldest first (`request_order`), as (file name, text). Dotfiles (the freeze file) are
    not requests."""
    if not directory.is_dir():
        return []
    files = sorted((p for p in directory.iterdir() if p.is_file() and not p.name.startswith(".")), key=request_order)
    return [(p.name, p.read_text(encoding="utf-8", errors="replace")) for p in files]


def expected_values(case: dict):
    """Every expected output a case states, for the source check."""
    for step in case.get("steps", []):
        for key in ("stdout", "stderr", "response"):
            if key in step:
                yield key, step[key]
        for name, content in (step.get("files") or {}).items():
            yield f"file {name}", content


def scalar_leaves(value):
    if isinstance(value, dict):
        for k, v in value.items():
            yield k
            yield from scalar_leaves(v)
    elif isinstance(value, list):
        for v in value:
            yield from scalar_leaves(v)
    elif value is not None:
        yield value


def whole_in(piece: str, source: str) -> bool:
    """`piece` occurs in `source` not as part of a longer token (so 14:03:22 is not in 14:03:22Z)."""
    if not piece:
        return True
    edge = r"[\w.:+\-]"
    return re.search(rf"(?<!{edge}){re.escape(piece)}(?!{edge})", source) is not None or (
        not re.match(edge, piece[0]) and not re.match(edge, piece[-1]) and piece in source)


def leaf_in_source(leaf, source: str) -> bool:
    if isinstance(leaf, str) and PLACEHOLDER.match(leaf):
        return leaf in source
    if not isinstance(leaf, str):
        return whole_in(json.dumps(leaf), source)
    quoted = collapse(json.dumps(leaf)), collapse(json.dumps(leaf, ensure_ascii=False))
    return any(q in source for q in quoted) or whole_in(collapse(leaf), source)


def line_in_source(line: str, source: str, saved: set[str]) -> bool:
    """A text line, where a saved value's {name} stands for any value the source shows there."""
    names = [n for n in saved if n in line]
    if not names:
        return whole_in(line, source)
    parts = re.split("|".join(re.escape(n) for n in names), line)
    return re.search(r"\S+".join(re.escape(part) for part in parts), source) is not None


def value_in_source(value, source: str, saved: set[str] = frozenset()):
    """The first piece of `value` the source does not show whole, or None. {name} of a saved value stands for
    the value the program generated, which the example shows as a literal."""
    parsed = value if isinstance(value, (dict, list)) else parse_json_output(str(value))
    if isinstance(parsed, (dict, list)):
        leaves = (leaf for leaf in scalar_leaves(parsed) if leaf not in saved)
        return next((json_text(leaf) for leaf in leaves if not leaf_in_source(leaf, source)), None)
    lines = [collapse(line) for line in str(value).splitlines() if collapse(line) and not ELISION.match(line)]
    return next((line for line in lines if not line_in_source(line, source, saved)), None)


def located_miss(source: str, requests_text: str) -> str:
    """Where a source stops matching the requests: the longest prefix found, and what follows it."""
    lo, hi = 0, len(source)
    while lo < hi:
        mid = (lo + hi + 1) // 2
        if source[:mid] in requests_text:
            lo = mid
        else:
            hi = mid - 1
    at = requests_text.find(source[:lo]) + lo if lo else -1
    found = repr(requests_text[at:at + 40]) if at >= 0 else "nothing"
    return f"matches for {lo} of {len(source)} characters, then the case has {source[lo:lo + 40]!r} where the request has {found}"


KEY_VALUE = re.compile(r"^\s*-?\s*([\w.-]+)\s*[:=]\s*\S")


def input_problems(case: dict, source: str) -> list[str]:
    """Input lines (key: value) whose key the example shows with another value: the case changed the example's
    input, e.g. to get past a validation the program added."""
    problems = []
    for name, content in (case.get("files") or {}).items():
        for line in json_text(content).splitlines():
            match = KEY_VALUE.match(line)
            if not match or collapse(line) in source:
                continue
            key = match.group(1)
            if re.search(rf"(?<![\w.-]){re.escape(key)}\s*[:=]", source):
                problems.append(f"input file {name} has {collapse(line)[:80]!r}, but its `source` shows `{key}` with "
                                "another value: never change an input the example shows")
    return problems


def partial_ok(case: dict, step: dict, requests_text: str) -> bool:
    if step.get("match") not in ("subset", "excerpt"):
        return True
    if "..." in case.get("source", "") or "…" in case.get("source", ""):
        return True
    return bool(step.get("why")) and collapse(step["why"]) in requests_text


def step_problems(case: dict, requests_text: str) -> list[str]:
    problems = []
    for i, step in enumerate(case.get("steps", []), 1):
        if not partial_ok(case, step, requests_text):
            problems.append(f"step {i}: match {step['match']} needs '...' in the source or a `why` quoted from the request")
        if step.get("disputed") is not None and collapse(step["disputed"]) not in requests_text:
            problems.append(f"step {i}: `disputed` is not word for word in any saved request")
    if not any(k in step for step in case.get("steps", []) for k in CHECK_KEYS):
        problems.append("checks nothing: no step names stdout, stderr, exit, status, response or files")
    return problems


DERIVED_MIN_WORDS = 8


def is_derived(case: dict, spec: bool) -> bool:
    """A derived case states output the request gives in prose; `on` mode allows it too, spec mode also requires
    one per listed rule (rule coverage)."""
    return case.get("derived") is True


def source_problems(case: dict, requests_text: str, spec: bool = False) -> list[str]:
    source = collapse(case.get("source", ""))
    if not source:
        return ["has no `source` (the example copied from the request)"]
    if source not in requests_text:
        return ["`source` is not word for word in any saved request: " + located_miss(source, requests_text)]
    if is_derived(case, spec):  # the author's instance of a prose rule: its values are not in the quote
        short = len(source.split()) < DERIVED_MIN_WORDS
        return ([f"derived `source` must quote the text it instances: at least {DERIVED_MIN_WORDS} words"] if short else []) \
            + step_problems(case, requests_text)
    problems = []
    saved = {"{" + name + "}" for step in case.get("steps", []) for name in (step.get("save") or {})}
    for where, value in expected_values(case):
        missing = value_in_source(value, source, saved)
        if missing is not None:
            problems.append(f"expected {where} has {missing[:80]!r}, which its `source` does not show whole")
    return problems + input_problems(case, source) + step_problems(case, requests_text)


def request_index(text: str, requests: list[tuple[str, str]]) -> int:
    """The index of the first saved request (oldest first) that holds `text`, or -1."""
    return next((i for i, (_, body) in enumerate(requests) if text and text in collapse(body)), -1)


def first_input(case: dict) -> str | None:
    """The first `run` or `http` step's input (command, stdin, body), as comparable text; None without one."""
    for step in case.get("steps") or []:
        if isinstance(step, dict) and ("run" in step or "http" in step):
            return json.dumps([step.get("run"), step.get("http"), step.get("stdin"), step.get("body")], sort_keys=True)
    return None


def replacement(case: dict, cases: list[dict], requests: list[tuple[str, str]]) -> str | None:
    """Spec mode: the id of an active case that takes over a superseded one: its source comes from the request
    that holds the `superseded_by` quote, or a newer one, and its first run/http step has the same input."""
    at = request_index(collapse(case.get("superseded_by") or ""), requests)
    key = first_input(case)
    if at < 0 or key is None:
        return None
    return next((c["id"] for c in cases if c is not case and c.get("superseded_by") is None and first_input(c) == key
                 and request_index(collapse(c.get("source", "")), requests) >= at), None)


def superseding_problems(cases: list[dict], requests: list[tuple[str, str]], spec: bool = False) -> list[str]:
    """A case stops running only on newer request text, and one sentence does not retire several examples. In
    spec mode each superseded case also needs a replacement (see `replacement`); one sentence may then retire
    several cases, each with its own replacement (a change to every output, say)."""
    problems, by_quote = [], {}
    for case in cases:
        if case.get("superseded_by") is None:
            continue
        quote = collapse(case["superseded_by"])
        at = request_index(quote, requests)
        if at < 0:
            problems.append(f"case {case['id']}: `superseded_by` is not word for word in any saved request")
        elif at <= request_index(collapse(case.get("source", "")), requests):
            problems.append(f"case {case['id']}: `superseded_by` must quote a request newer than the one its source comes from")
        elif spec and replacement(case, cases, requests) is None:
            problems.append(f"case {case['id']}: superseded, but no case replaces it: add a case whose source quotes the "
                            "superseding request (or a newer one) and whose first run/http step has the same input "
                            "(command, stdin, body), expecting what the newer text says")
        by_quote.setdefault(quote, []).append(case)
    for quote, group in by_quote.items():
        ids = [c["id"] for c in group]
        if spec and all(replacement(c, cases, requests) for c in group):
            continue
        if len(ids) > 1:
            problems.append(f"cases {', '.join(ids)} stop running on one sentence {quote[:100]!r}: superseding is for newer "
                            "text or an example that shows a different output for the same input. A new rule that makes your "
                            "program reject an earlier example's input is a regression unless the new text names that input "
                            "as invalid: keep the cases and fix the program, or give each case its own quote that changes it.")
    return problems


def fenced_blocks(requests: list[tuple[str, str]]):
    """(request name, line number, collapsed text, first line) for each non-empty fenced block."""
    for name, text in requests:
        for match in FENCE.finditer(text):
            body = match.group(3)
            if collapse(body):
                first = next(line.strip() for line in body.splitlines() if line.strip())
                yield name, text.count("\n", 0, match.start()) + 1, collapse(body), first


def block_covered(block_text: str, body_lines: list[str], sources: list[str]) -> bool:
    if any(block_text in s for s in sources):
        return True
    joined = " \n ".join(sources)
    lines = [line for line in body_lines if not BRACKETS_ONLY.match(line)]
    return bool(lines) and all(line in joined for line in lines)


def skip_targets(skipped: list[dict], distinct_blocks: set[str], spec: bool = False) -> tuple[set[str], list[str]]:
    """The blocks the skips name, and problems with skips that name no block or more than one. A rule skip is
    checked by rule_coverage_problems in spec mode; in on mode it is a skip without a block, as in v6."""
    covered, problems = set(), []
    for skip in skipped:
        if spec and "rule" in skip and "block" not in skip:
            continue
        start = collapse(skip.get("block", ""))
        if not start or not skip.get("reason"):
            problems.append(f"skip {start[:60]!r}: needs `block` and `reason`")
            continue
        hits = [b for b in distinct_blocks if b.startswith(start)]
        if len(hits) != 1:
            problems.append(f"skip {start[:60]!r} matches {len(hits)} blocks: quote enough of the block to match exactly one")
        covered.update(hits if len(hits) == 1 else [])
    return covered, problems


def coverage_problems(requests: list[tuple[str, str]], cases: list[dict], skipped: list[dict],
                      spec: bool = False) -> list[str]:
    sources = [collapse(c.get("source", "")) for c in cases if collapse(c.get("source", ""))]
    blocks = list(fenced_blocks(requests))
    skipped_blocks, problems = skip_targets(skipped, {b[2] for b in blocks}, spec)
    body_lines = {}
    for name, text in requests:
        for match in FENCE.finditer(text):
            body_lines[collapse(match.group(3))] = [collapse(line) for line in match.group(3).splitlines() if collapse(line)]
    for name, line, block, first in blocks:
        if block in skipped_blocks or block_covered(block, body_lines.get(block, []), sources):
            continue
        problems.append(f"not covered by case sources or skipped with a reason: {name}:{line} block starting {first[:80]!r}")
    return problems


LIST_ITEM = re.compile(r"^[ \t]*(?:[-*+]|\d{1,9}[.)])[ \t]+(\S.*)$")
RULE_MIN_WORDS = 4
RULE_WINDOW = 8


def without_fences(text: str) -> str:
    """`text` with each fenced block's lines blanked, so line numbers stay."""
    return FENCE.sub(lambda m: "\n" * m.group(0).count("\n"), text)


def list_items(text: str) -> list[str]:
    """The collapsed text of each markdown list item outside fenced blocks, with its continuation lines (a
    non-blank line that follows an item and does not start a new item, heading or block)."""
    items, current = [], None
    for line in without_fences(text).splitlines():
        match = LIST_ITEM.match(line)
        if match:
            if current is not None:
                items.append(current)
            current = match.group(1)
        elif current is not None and line.strip() and not line.lstrip().startswith(("#", "```", "~~~", "|", ">")):
            current += " " + line.strip()
        elif current is not None:
            items.append(current)
            current = None
    if current is not None:
        items.append(current)
    return [collapse(item) for item in items]


def rules(requests: list[tuple[str, str]]):
    """(request name, rule text) for each list item with at least RULE_MIN_WORDS words."""
    for name, text in requests:
        for item in list_items(text):
            if len(item.split()) >= RULE_MIN_WORDS:
                yield name, item


def rule_covered(rule: str, padded_sources: list[str]) -> bool:
    words = rule.split()
    size = min(RULE_WINDOW, len(words))
    windows = {" " + " ".join(words[i:i + size]) + " " for i in range(len(words) - size + 1)}
    return any(w in s for s in padded_sources for w in windows)


def rule_skip_targets(skipped: list[dict], distinct_rules: set[str]) -> tuple[set[str], list[str]]:
    covered, problems = set(), []
    for skip in skipped:
        if "rule" not in skip:
            continue
        start = collapse(skip.get("rule", ""))
        if not start or not skip.get("reason"):
            problems.append(f"skip rule {start[:60]!r}: needs `rule` and `reason`")
            continue
        # The whole text of an item names that item, even when it is also the start of a longer one.
        hits = [start] if start in distinct_rules else [r for r in distinct_rules if r.startswith(start)]
        if len(hits) != 1:
            problems.append(f"skip rule {start[:60]!r} matches {len(hits)} rules: quote enough of the item to match exactly one")
        covered.update(hits if len(hits) == 1 else [])
    return covered, problems


def rule_coverage_problems(requests: list[tuple[str, str]], cases: list[dict], skipped: list[dict]) -> list[str]:
    """Spec mode: every rule (list item) is quoted by some case source or skipped with a reason."""
    padded = [" " + collapse(c.get("source", "")) + " " for c in cases if collapse(c.get("source", ""))]
    found = list(rules(requests))
    skipped_rules, problems = rule_skip_targets(skipped, {r for _, r in found})
    seen = set()
    for name, rule in found:
        if rule in skipped_rules or (rule, name) in seen or rule_covered(rule, padded):
            continue
        seen.add((rule, name))
        problems.append(f'rule not covered: "{rule[:80]}" ({name}): add a case (derived: true, see '
                        "example_replay.py --format --mode spec) whose source quotes it, or skip it with a reason")
    return problems


# --- Freeze file -------------------------------------------------------------------------


def case_hash(case: dict) -> str:
    """sha256 of the case without `superseded_by` and without each step's `disputed`, so superseding a frozen
    case or disputing one of its steps later keeps its hash (both are how a frozen case is answered, not edits)."""
    body = {k: v for k, v in case.items() if k != "superseded_by"}
    if isinstance(body.get("steps"), list):
        body["steps"] = [{k: v for k, v in step.items() if k != "disputed"} if isinstance(step, dict) else step
                         for step in body["steps"]]
    text = json.dumps(body, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def load_frozen(path: Path) -> dict:
    """The freeze file's `cases` ({id: {hash, red, frozen_at}}); empty when there is none."""
    if not path.is_file():
        return {}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except ValueError as err:
        raise CaseFileError(f"{path}: not valid JSON: {err}") from err
    if not isinstance(data, dict) or not isinstance(data.get("cases", {}), dict):
        raise CaseFileError(f"{path}: expected an object with a `cases` object")
    return data.get("cases", {})


def freeze_problems(cases: list[dict], frozen: dict) -> list[str]:
    problems = []
    by_id = {c["id"]: c for c in cases}
    for case in cases:
        entry = frozen.get(case["id"])
        if entry is None:
            if case.get("superseded_by") is None:
                problems.append(f"case {case['id']} is not frozen: call dev_team_freeze_cases before you implement it")
        elif not isinstance(entry, dict) or entry.get("hash") != case_hash(case):
            problems.append(f"case {case['id']} changed after it was frozen: restore it; a changed spec needs "
                            "superseded_by and a new case")
    for case_id in frozen:
        if case_id not in by_id:
            problems.append(f"frozen case {case_id} was removed: keep it; use superseded_by")
    return problems


def freeze_copy_path(root: Path, env=None) -> Path:
    """The copy of the freeze file that dev_team_freeze_cases keeps outside the project (freeze-cases.ts,
    freezeCopyPath): `$DEV_TEAM_FREEZE_DIR`, else `$PI_CODING_AGENT_DIR/dev-team-frozen` (pi's agent folder,
    `~/.pi/agent` by default), named by the project's real path. Deleting or editing the freeze file in the
    project then shows up as a difference from it."""
    env = os.environ if env is None else env
    agent = env.get("PI_CODING_AGENT_DIR") or str(Path.home() / ".pi" / "agent")
    base = Path(env.get("DEV_TEAM_FREEZE_DIR") or Path(agent) / "dev-team-frozen")
    key = hashlib.sha256(os.path.realpath(root).encode("utf-8")).hexdigest()[:16]
    return base / f"{key}.frozen.json"


def load_freeze(frozen_path: Path, copy_path: Path | None) -> tuple[dict, list[str]]:
    """The frozen cases and the problems with the freeze file. When the copy outside the project exists it is
    the record (only the tool writes both), and every difference of the project's file from it is a problem."""
    disk = load_frozen(frozen_path)
    if copy_path is None or not copy_path.is_file():
        return disk, []
    copy = load_frozen(copy_path)
    problems = []
    for case_id, entry in copy.items():
        if case_id not in disk:
            problems.append(f"frozen case {case_id} is missing from {FROZEN_NAME}: only dev_team_freeze_cases writes the "
                            "freeze file; call it to restore the file from its copy")
        elif not isinstance(disk[case_id], dict) or not isinstance(entry, dict) or disk[case_id].get("hash") != entry.get("hash"):
            problems.append(f"frozen case {case_id} has another hash in {FROZEN_NAME} than dev_team_freeze_cases recorded")
    for case_id in disk:
        if case_id not in copy:
            problems.append(f"{FROZEN_NAME} names case {case_id}, which dev_team_freeze_cases never froze")
    return copy, problems


def env_spec(env) -> bool:
    """DEV_TEAM_EXAMPLES=spec, case and spaces ignored (as review-profile.ts examplesMode reads it)."""
    return (env.get("DEV_TEAM_EXAMPLES") or "").strip().lower() == "spec"


def resolve_mode(flag: str | None, frozen_path: Path, env=None, copy_path: Path | None = None) -> str:
    """spec when DEV_TEAM_EXAMPLES=spec or the freeze file (or its copy outside the project) exists, whatever
    --mode says: `--mode on` cannot turn the freeze check off. Otherwise --mode (for tests), else on."""
    env = os.environ if env is None else env
    if env_spec(env) or frozen_path.is_file() or (copy_path is not None and copy_path.is_file()):
        return "spec"
    return flag or "on"


# --- Running cases ---------------------------------------------------------------------


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *_args, **_kwargs):
        return None


OPENER = urllib.request.build_opener(NoRedirect)


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def fill(text: str, ctx: dict) -> str:
    for key, value in ctx.items():
        text = text.replace("{" + key + "}", str(value))
    return text


def write_files(base: Path, files: dict | None, ctx: dict) -> None:
    for name, content in (files or {}).items():
        path = base / fill(name, ctx)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(fill(json_text(content), ctx), encoding="utf-8")


def server_log_tail(ctx: dict) -> str:
    log = Path(ctx["tmp"]) / ".server.log"
    return log.read_bytes()[-400:].decode("utf-8", "replace") if log.is_file() else ""


def start_server(command: str, ctx: dict, timeout: float):
    log = open(Path(ctx["tmp"]) / ".server.log", "wb")  # a file never fills up and blocks the server
    proc = subprocess.Popen(fill(command, ctx), shell=True, cwd=ctx["tmp"], stdout=log, stderr=subprocess.STDOUT,
                            start_new_session=True)
    log.close()
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if proc.poll() is not None:
            return proc, f"server exited with {proc.returncode}: {server_log_tail(ctx)}"
        try:
            socket.create_connection(("127.0.0.1", ctx["port"]), timeout=0.5).close()
            return proc, None
        except OSError:
            time.sleep(0.1)
    return proc, f"server did not listen on port {ctx['port']} within {timeout:.0f}s: {server_log_tail(ctx)}"


def stop_server(proc) -> None:
    if proc is None or proc.poll() is not None:
        return
    try:
        os.killpg(proc.pid, signal.SIGTERM)
        proc.wait(timeout=5)
    except (ProcessLookupError, subprocess.TimeoutExpired):
        try:
            os.killpg(proc.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass


def dig(value, path: str):
    for part in path.split(".") if path else []:
        if isinstance(value, list) and part.isdigit() and int(part) < len(value):
            value = value[int(part)]
        elif isinstance(value, dict) and part in value:
            value = value[part]
        else:
            return MISSING
    return value


def save_values(step: dict, text: str, ctx: dict) -> list[str]:
    if not step.get("save"):
        return []
    data = parse_json_output(text)
    problems = []
    for name, path in step["save"].items():
        value = dig(data, path) if data is not MISSING else MISSING
        if value is MISSING:
            problems.append(f"save {name}: {path!r} not in the output")
        else:
            ctx[name] = value
    return problems


def run_command(step: dict, ctx: dict, timeout: float) -> list[str]:
    command = step["run"]
    args = [fill(a, ctx) for a in command] if isinstance(command, list) else fill(command, ctx)
    try:
        done = subprocess.run(args, shell=isinstance(args, str), cwd=ctx["tmp"], input=fill(step.get("stdin", ""), ctx),
                              capture_output=True, text=True, errors="replace", timeout=timeout)
    except subprocess.TimeoutExpired:
        return [f"timed out after {timeout:.0f}s"]
    problems = []
    text = " ".join(command) if isinstance(command, list) else command
    want = step.get("exit", None if "{root}" in text else 0)  # a setup command must succeed
    if want is not None and done.returncode != want:
        problems.append(f"exit {done.returncode}, expected {want}; stderr: {done.stderr[-300:]!r}")
    if done.returncode != 0 and step.get("exit", 0) == 0:
        ctx["_rejected"] = f"exit {done.returncode}: {done.stderr.strip()[-200:]!r}"
    if done.returncode != 0 and "_absent" not in ctx:
        absent = absent_program(text, ctx)
        if absent:
            ctx["_absent"] = absent
    for stream in ("stdout", "stderr"):
        if stream in step:
            diff = compare(fill_expected(step[stream], ctx), getattr(done, stream), step)
            if diff:
                problems.append(f"{stream}: {diff}")
    return problems + save_values(step, done.stdout, ctx)


ROOT_PATH = re.compile(r"\{root\}(/[^\s'\"`;&|<>()]+)")


def absent_program(command: str, ctx: dict) -> str | None:
    """A path under {root} that the command names and that does not exist: the program is not written yet, so
    a failing exit proves nothing (python exits 2 on a missing script, a shell 127)."""
    for rel in ROOT_PATH.findall(command):
        path = Path(str(ctx["root"]) + fill(rel, ctx))
        if not path.exists():
            return str(path)
    return None


def fill_expected(expected, ctx: dict):
    """Saved values replace their {name} in expected output, so a later step checks the id it was given."""
    saved = {k: v for k, v in ctx.items() if k not in ("root", "tmp", "port") and not k.startswith("_")}
    if not saved:
        return expected
    text = fill(json_text(expected), {k: v if isinstance(expected, str) else json_text(v).strip('"') for k, v in saved.items()})
    return text if isinstance(expected, str) else json.loads(text)


def http_call(step: dict, ctx: dict, timeout: float):
    method, _, target = fill(step["http"], ctx).partition(" ")
    body = step.get("body")
    data = None if body is None else fill(json_text(body), ctx).encode()
    headers = {"Content-Type": "application/json"} if isinstance(body, (dict, list)) else {}
    headers.update({k: fill(str(v), ctx) for k, v in (step.get("headers") or {}).items()})
    request = urllib.request.Request(f"http://127.0.0.1:{ctx['port']}{target.strip()}", data=data,
                                     headers=headers, method=method.upper())
    try:
        with OPENER.open(request, timeout=timeout) as response:
            return response.status, response.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as err:
        return err.code, err.read().decode("utf-8", "replace")


def run_http(step: dict, ctx: dict, timeout: float) -> list[str]:
    try:
        status, text = http_call(step, ctx, timeout)
    except (OSError, ValueError, http_client_errors()) as err:
        return [f"request failed: {err!r}"]
    problems = []
    if "status" in step and status != step["status"]:
        problems.append(f"status {status}, expected {step['status']}; body: {text[:300]!r}")
    if status >= 400 and step.get("status", 200) < 400:
        ctx["_rejected"] = f"status {status}: {text[:200]!r}"
    if "response" in step:
        diff = compare(fill_expected(step["response"], ctx), text, step)
        if diff:
            problems.append(f"response: {diff}")
    return problems + save_values(step, text, ctx)


def http_client_errors():
    import http.client

    return http.client.HTTPException


def check_files(step: dict, ctx: dict) -> list[str]:
    problems = []
    for name, content in step["files"].items():
        path = Path(ctx["tmp"]) / fill(name, ctx)
        if not path.is_file():
            problems.append(f"file {name}: missing")
            continue
        diff = compare(content, path.read_text(encoding="utf-8", errors="replace"), step)
        if diff:
            problems.append(f"file {name}: {diff}")
    return problems


def run_step(step: dict, ctx: dict, timeout: float) -> list[str]:
    problems = []
    if "run" in step:
        problems += run_command(step, ctx, timeout)
    if "http" in step:
        problems += run_http(step, ctx, timeout)
    if "files" in step:
        problems += check_files(step, ctx)
    if not {"run", "http", "files"} & set(step):
        problems.append("step has no `run`, `http` or `files`")
    return problems


def run_steps(case: dict, ctx: dict, timeout: float) -> tuple[list[str], list[str]]:
    """(failures, disputed failures)."""
    failures, disputed = [], []
    for i, step in enumerate(case.get("steps", []), 1):
        try:
            problems = run_step(step, ctx, timeout)
        except CaseFileError as err:
            return failures + [f"step {i}: bad case: {err}"], disputed
        if problems and step.get("disputed") is not None:
            disputed += [f"step {i}: {p}" for p in problems]
        elif problems:
            return failures + [f"step {i}: {p}" for p in problems], disputed
    return failures, disputed


def run_case(case: dict, root: Path, timeout: float, info: dict | None = None) -> tuple[list[str], list[str], str | None]:
    """(failures, disputed failures, how the program rejected an input the example shows working, if it did).
    `info` gets `absent`: a program path the case named that did not exist when a command failed."""
    with tempfile.TemporaryDirectory(prefix="example-") as tmp:
        ctx = {"root": root, "tmp": tmp, "port": free_port()}
        write_files(Path(tmp), case.get("files"), ctx)
        proc, problem = start_server(case["server"], ctx, timeout) if case.get("server") else (None, None)
        try:
            failures, disputed = ([problem], []) if problem else run_steps(case, ctx, timeout)
            if info is not None and ctx.get("_absent"):
                info["absent"] = ctx["_absent"]
            return failures, disputed, ctx.get("_rejected")
        finally:
            stop_server(proc)


# --- Main ------------------------------------------------------------------------------


def load_cases(path: Path) -> dict:
    if not path.is_file():
        return {"cases": [], "skipped": []}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except ValueError as err:
        raise CaseFileError(f"{path}: not valid JSON: {err}") from err
    if not isinstance(data, dict) or not isinstance(data.get("cases", []), list):
        raise CaseFileError(f"{path}: expected an object with a `cases` list")
    ids = [c.get("id") if isinstance(c, dict) else None for c in data.get("cases", [])]
    if any(not i for i in ids) or len(set(ids)) != len(ids):
        raise CaseFileError(f"{path}: every case needs a unique `id`")
    data.setdefault("cases", [])
    data.setdefault("skipped", [])
    return data


MATCH_MODES = ("exact", "json", "subset", "excerpt", "shape")
HTTP_LINE = re.compile(r"^[A-Za-z]+ /\S*$")


def structure_problems(case: dict) -> list[str]:
    """Spec mode: a case that cannot run as written. Found here, before the freeze, a mistake is the author's
    to fix; found by a run, the frozen case would fail for good."""
    problems = []
    steps = case.get("steps")
    if not isinstance(steps, list) or not steps or not all(isinstance(s, dict) for s in steps):
        return ["`steps` must be a non-empty list of objects"]
    if "files" in case and not isinstance(case["files"], dict):
        problems.append("`files` must be an object of file name to content")
    if "server" in case and not isinstance(case["server"], str):
        problems.append("`server` must be a command string")
    for i, step in enumerate(steps, 1):
        if not {"run", "http", "files"} & set(step):
            problems.append(f"step {i}: has no `run`, `http` or `files`")
        if "run" in step and not (isinstance(step["run"], str) and step["run"].strip()
                                  or isinstance(step["run"], list) and step["run"] and all(isinstance(a, str) for a in step["run"])):
            problems.append(f"step {i}: `run` must be a command string or a list of strings")
        if "http" in step and not (isinstance(step["http"], str) and HTTP_LINE.match(step["http"].strip())):
            problems.append(f"step {i}: `http` must be \"METHOD /path\"")
        if "files" in step and not isinstance(step["files"], dict):
            problems.append(f"step {i}: `files` must be an object of file name to expected content")
        for key in ("exit", "status"):
            if key in step and (not isinstance(step[key], int) or isinstance(step[key], bool)):
                problems.append(f"step {i}: `{key}` must be an integer")
        if step.get("match") is not None and step["match"] not in MATCH_MODES:
            problems.append(f"step {i}: unknown match {step['match']!r} (one of {', '.join(MATCH_MODES)})")
        for key in ("save", "headers"):
            if key in step and not isinstance(step[key], dict):
                problems.append(f"step {i}: `{key}` must be an object")
        if "vary" in step and not isinstance(step["vary"], list):
            problems.append(f"step {i}: `vary` must be a list of keys")
        if step.get("match") in ("json", "subset"):
            for key in ("stdout", "stderr", "response"):
                if isinstance(step.get(key), str) and parse_json_output(step[key]) is MISSING:
                    problems.append(f"step {i}: `{key}` is not JSON, but match is {step['match']}")
    return problems


def already_passing_problems(case: dict, requests: list[tuple[str, str]]) -> list[str]:
    """Spec mode: `already_passing` is for behaviour an earlier request built, so it needs a reason, an earlier
    request, and a source that is not from the newest one."""
    if "already_passing" not in case:
        return []
    if not (isinstance(case["already_passing"], str) and case["already_passing"].strip()):
        return ["`already_passing` needs a reason"]
    if len(requests) < 2:
        return ["`already_passing` is for behaviour an earlier request built, and there is only one saved request: "
                "a case must fail before the code exists"]
    if request_index(collapse(case.get("source", "")), requests) == len(requests) - 1:
        return [f"`already_passing` is for behaviour an earlier request built, but the source comes from the newest "
                f"request ({requests[-1][0]}): a case for it must fail before the code exists"]
    return []


def static_problems(data: dict, requests: list[tuple[str, str]], spec: bool = False) -> list[str]:
    requests_text = collapse("\n".join(text for _, text in requests))
    problems = []
    for case in data["cases"]:
        problems += [f"case {case['id']}: {p}" for p in source_problems(case, requests_text, spec)]
        if spec:
            problems += [f"case {case['id']}: {p}" for p in structure_problems(case) + already_passing_problems(case, requests)]
    problems += superseding_problems(data["cases"], requests, spec)
    problems += coverage_problems(requests, data["cases"], data["skipped"], spec)
    return problems + (rule_coverage_problems(requests, data["cases"], data["skipped"]) if spec else [])


def red_run(data: dict, requests: list[tuple[str, str]], chosen: list[dict], root: Path, timeout: float,
            spec: bool, as_json: bool) -> int:
    """Static checks, then every active case, before the code exists: failures are expected, so exit 0."""
    problems = static_problems(data, requests, spec)
    results = {}
    if not problems:
        for case in chosen:
            if case.get("superseded_by") is not None:
                continue
            info = {}
            failures, _disputed, _rejected = run_case(case, root, timeout, info)
            vacuous = not failures and bool(info.get("absent"))
            if vacuous:
                # An error case (`exit: 2`) passes on a program that is not there: it passes for the right reason
                # only once the program exists, so it counts as red.
                failures = [f"passes only because {info['absent']} does not exist yet"]
            results[case["id"]] = {"hash": case_hash(case), "passed": not failures,
                                   "derived": is_derived(case, spec), "already_passing": bool(case.get("already_passing")),
                                   "failures": failures, **({"vacuous": True} if vacuous else {})}
    if as_json:
        cases = {i: {k: v for k, v in r.items() if k != "failures"} for i, r in results.items()}
        print(json.dumps({"static_problems": problems, "cases": cases}, ensure_ascii=False))
        return 1 if problems else 0
    for line in problems:
        print(line)
    if problems:
        print(f"example_replay --red: {len(problems)} problem(s) in the case file; no case ran")
        return 1
    for case_id, r in results.items():
        label = " derived" if r["derived"] else ""
        if r["passed"]:
            note = " (already_passing)" if r["already_passing"] else ": passes before implementation"
            print(f"case {case_id}: GREEN{label}{note}")
        else:
            print(f"case {case_id}: RED{label} {r['failures'][0]}")
    red = sum(not r["passed"] for r in results.values())
    print(f"example_replay --red: {red}/{len(results)} cases fail before implementation, "
          f"{sum(r['passed'] and r['already_passing'] for r in results.values())} already passing")
    return 0


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--cases", default=CASES_DEFAULT)
    parser.add_argument("--requests", default=REQUESTS_DEFAULT)
    parser.add_argument("--root", default=".")
    parser.add_argument("--only", action="append", default=[], help="run only this case id (repeatable)")
    parser.add_argument("--timeout", type=float, default=30.0, help="seconds per step and for server start")
    parser.add_argument("--format", action="store_true", help="print the case file format and exit")
    parser.add_argument("--mode", choices=MODES, help="on or spec, for tests: DEV_TEAM_EXAMPLES=spec or a freeze file "
                        "(in the project or its copy) selects spec whatever this says")
    parser.add_argument("--red", action="store_true", help="red run: check the case file, run every case, exit 0 "
                        "even when cases fail (they should, before the code exists)")
    parser.add_argument("--json", action="store_true", help="with --red: print one JSON object")
    args = parser.parse_args(argv)
    root = Path(args.root).resolve()
    # The freeze file is always the project's, whatever --requests names: a copied requests folder without it
    # must not turn the freeze check off.
    frozen_path = root / REQUESTS_DEFAULT / FROZEN_NAME
    copy_path = freeze_copy_path(root)
    spec = resolve_mode(args.mode, frozen_path, copy_path=copy_path) == "spec"
    if args.format:
        print(FORMAT + SPEC_FORMAT if spec else FORMAT)
        return 0
    try:
        data = load_cases(root / args.cases)
        frozen, freeze_file_problems = load_freeze(frozen_path, copy_path) if spec and not args.red else ({}, [])
    except CaseFileError as err:
        print(f"example_replay: {err}", file=sys.stderr)
        if args.json:
            print(json.dumps({"error": str(err)}))
        return 2
    requests_dir = (root / args.requests).resolve()
    if spec and requests_dir != (root / REQUESTS_DEFAULT).resolve():
        message = (f"--requests {args.requests}: in spec mode the saved requests are {REQUESTS_DEFAULT}, which only "
                   "dev-team code writes; run without --requests")
        print(json.dumps({"static_problems": [message], "cases": {}}) if args.json else f"example_replay: {message}")
        return 1
    requests = load_requests(requests_dir)
    chosen = [c for c in data["cases"] if not args.only or c["id"] in args.only]
    if args.red:
        return red_run(data, requests, chosen, root, args.timeout, spec, args.json)
    failures, disputed = static_problems(data, requests, spec), []
    active = [c for c in chosen if c.get("superseded_by") is None]
    if spec:
        failures += freeze_file_problems + freeze_problems(data["cases"], frozen)
        known = {c["id"] for c in data["cases"]}
        failures += [f"--only {i}: no such case" for i in args.only if i not in known]
        every = [c for c in data["cases"] if c.get("superseded_by") is None]
        if args.only and len(active) < len(every):
            failures.append(f"partial run: --only ran {len(active)} of {len(every)} active cases; run without --only "
                            "before you report done")
    passed = 0
    frozen_disputes = []
    for case in chosen:
        problems, contested, rejected = run_case(case, root, args.timeout)
        if case.get("superseded_by") is not None:  # still run, so a dropped regression stays visible
            heir = replacement(case, data["cases"], requests) if spec else None
            if problems and rejected and heir:
                # The newer request made this input invalid, and its replacement (same input) checks that.
                disputed.append(f"case {case['id']}: SUPERSEDED by {heir}, now rejects the input (not counted; {heir} "
                                f"checks the newer behaviour) ({rejected})")
            elif problems and rejected:
                failures.append(f"case {case['id']}: FAIL superseded, but the program now rejects the input this earlier "
                                f"example shows working ({rejected}). A newer request changes outputs; rejecting an earlier "
                                "example's input is a regression unless the newer text names that input as invalid.")
            else:
                disputed += [f"case {case['id']}: SUPERSEDED, now fails (not counted) {p}" for p in problems]
            continue
        label = "FAIL derived" if is_derived(case, spec) else "FAIL"
        failures += [f"case {case['id']}: {label} {p}" for p in problems]
        disputed += [f"case {case['id']}: DISPUTED {p}" for p in contested]
        if spec and contested and case["id"] in frozen:
            frozen_disputes.append(case["id"])
        passed += not problems
    for line in failures + disputed:
        print(line)
    if frozen_disputes:
        print(f"DISPUTED FROZEN CASES: {', '.join(frozen_disputes)}: a failing step of a frozen case is not counted "
              "because it is marked `disputed`; give spec-compliance-review each case id and its quote to judge")
    blocks = sum("rule" not in s for s in data["skipped"]) if spec else len(data["skipped"])
    summary = (f"example_replay: {passed}/{len(active)} cases pass, {len(failures)} problem(s), {len(disputed)} disputed, "
               f"{blocks} block(s) skipped, {len(requests)} saved request(s)")
    if spec:
        summary += (f", spec mode: {sum(is_derived(c, spec) for c in active)} derived, "
                    f"{sum(bool(c.get('already_passing')) for c in active)} already passing, "
                    f"{sum('rule' in s for s in data['skipped'])} rule(s) skipped, {len(frozen)} frozen")
    print(summary)
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
