#!/usr/bin/env python3
"""Run the examples a request shows as acceptance tests for the program.

A request (issue, spec, ticket) that shows an example (a command and its output, an HTTP call and its
response) makes that example a contract. This script reads a case file (default `.dev-team/examples.json`)
in which each example is copied from the request, runs every case against the program, and compares the
output. It also checks that the case file is honest and complete against the saved requests (default
`.claude/memory/requests/`):

- every case quotes its example (`source`) word for word from a saved request, and every expected value
  appears in that quote, so a case cannot be edited to match the code;
- every fenced code block in a saved request is covered by a case's `source` or skipped with a reason.

Cases are kept across requests, so a later change that breaks an earlier example fails here. A case stops
running only when `superseded_by` quotes text from a saved request that changes the behaviour.

    example_replay.py [--cases FILE] [--requests DIR] [--root DIR] [--only ID] [--timeout SECONDS]
    example_replay.py --format        prints the case file format

Exit 0: every check holds and every case passes. 1: a check or case failed (each is listed). 2: the case file
is unusable.
"""
from __future__ import annotations

import argparse
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
         "status": 201, "response": {"id": "1", "created_at": "2025-10-12T14:03:22Z"}, "vary": ["id", "created_at"]},
        {"files": {"out/warnings.txt": "\\n"}}
      ],
      "superseded_by": "<optional: text from a newer request that changes this behaviour; the case then stops running>"
    }
  ],
  "skipped": [{"block": "<first line of a code block that is not an example>", "reason": "schema / grammar / not runnable"}]
}

Each case runs in a fresh temporary directory (the working directory) after `files` are written there.
Placeholders: {root} the project root, {tmp} the case directory, {port} a free port. `server`, when set, is
started before the steps (and stopped after them); `http` steps go to it.
A step checks only what it names: `stdout`, `stderr`, `exit` for `run`; `status`, `response` for `http`;
`files` compares files in the case directory after the earlier steps.

match (per step):
  exact   text equal (line endings and trailing whitespace ignored); the default for text
  json    JSON equal, key order ignored; the default when the expected value is JSON. Output that is not one
          JSON value is read as JSON lines. Numbers compare by value.
  subset  like json, but objects may have keys the example omits: only for an example the request marks as
          partial ("...", "for example", "fields include")
  shape   text with the same shape: digit runs match any digits, other characters must be equal
vary: keys whose values change from run to run (ids, timestamps). Their values must have the example's
  shape: same characters except digit runs, same JSON type. 2025-10-12T14:03:22Z does not match
  2025-10-12T14:03:22.148842Z or 2025-10-12T14:03:22+00:00.
unordered: true compares JSON arrays as multisets, only when the request says the order is unspecified.

Copy expected values exactly as the request shows them. When the program disagrees with an example, fix the
program, not the case.
"""

CASES_DEFAULT = ".dev-team/examples.json"
REQUESTS_DEFAULT = ".claude/memory/requests"
FENCE = re.compile(r"^ {0,3}(`{3,}|~{3,})[^\n]*\n(.*?)^ {0,3}\1[ \t]*$", re.M | re.S)
DIGITS = re.compile(r"[0-9]+")
MISSING = object()


class CaseFileError(Exception):
    pass


def collapse(text: str) -> str:
    return " ".join(str(text).split())


def shape_pattern(example: str) -> re.Pattern:
    """Digit runs match any digit run; every other character must be equal."""
    parts = [re.escape(piece) for piece in DIGITS.split(example)]
    return re.compile("[0-9]+".join(parts) + r"\Z")


def same_shape(expected, actual) -> bool:
    if isinstance(expected, bool) or isinstance(actual, bool):
        return type(expected) is type(actual)
    if isinstance(expected, (int, float)):
        return isinstance(actual, (int, float)) and isinstance(expected, int) == isinstance(actual, int)
    if isinstance(expected, str):
        return isinstance(actual, str) and bool(shape_pattern(expected).match(actual))
    return type(expected) is type(actual)


# --- JSON comparison ---------------------------------------------------------


def parse_json_output(text: str):
    """One JSON value, else JSON lines; MISSING when neither parses."""
    try:
        return json.loads(text)
    except ValueError:
        pass
    lines = [line for line in text.splitlines() if line.strip()]
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
        for k, value in expected.items():
            if k not in actual:
                return f"{path}.{k}: missing"
            diff = self.first(value, actual[k], f"{path}.{k}", k)
            if diff:
                return diff
        extra = sorted(set(actual) - set(expected))
        return None if self.subset or not extra else f"{path}: unexpected keys {extra}"

    def _list(self, expected, actual, path):
        if not isinstance(actual, list):
            return f"{path}: expected an array, got {type(actual).__name__}"
        if len(expected) != len(actual) and not (self.subset and len(actual) > len(expected)):
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


# --- Text comparison -----------------------------------------------------------


def normalize_text(text: str) -> str:
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


def compare(expected, actual_text: str, step: dict):
    """None when `actual_text` matches `expected` under the step's match mode, else the reason."""
    mode = step.get("match") or default_mode(expected)
    if mode in ("json", "subset"):
        want = json.loads(expected) if isinstance(expected, str) else expected
        got = parse_json_output(actual_text)
        if got is MISSING:
            return f"output is not JSON: {actual_text[:200]!r}"
        return JsonDiff(step.get("vary"), mode == "subset", bool(step.get("unordered"))).first(want, got)
    want, got = normalize_text(expected), normalize_text(actual_text)
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


# --- Requests: source and coverage checks ----------------------------------------


def load_requests(directory: Path) -> list[tuple[str, str]]:
    if not directory.is_dir():
        return []
    files = sorted(p for p in directory.iterdir() if p.is_file())
    return [(p.name, p.read_text(encoding="utf-8", errors="replace")) for p in files]


def expected_values(case: dict):
    """Every expected value a case states, as text or JSON, for the source check."""
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


def json_text(value) -> str:
    return value if isinstance(value, str) else json.dumps(value)


def value_in_source(value, source: str) -> str | None:
    """The first piece of `value` the source does not contain, or None."""
    parsed = value if isinstance(value, (dict, list)) else parse_json_output(str(value))
    if isinstance(parsed, (dict, list)):
        for leaf in scalar_leaves(parsed):
            if collapse(json_text(leaf)) not in source:
                return json_text(leaf)
        return None
    return None if collapse(json_text(value)) in source else json_text(value)


def source_problems(case: dict, requests_text: str) -> list[str]:
    source = collapse(case.get("source", ""))
    if not source:
        return ["has no `source` (the example copied from the request)"]
    if source not in requests_text:
        return ["`source` is not word for word in any saved request"]
    problems = []
    for where, value in expected_values(case):
        missing = value_in_source(value, source)
        if missing is not None:
            problems.append(f"expected {where} has {missing[:80]!r}, which its `source` does not show")
    superseded = case.get("superseded_by")
    if superseded is not None and collapse(superseded) not in requests_text:
        problems.append("`superseded_by` is not word for word in any saved request")
    return problems


def uncovered_blocks(requests: list[tuple[str, str]], cases: list[dict], skipped: list[dict]) -> list[str]:
    sources = [collapse(c.get("source", "")) for c in cases]
    skips = [collapse(s.get("block", "")) for s in skipped if collapse(s.get("block", "")) and s.get("reason")]
    missing = []
    for name, text in requests:
        for match in FENCE.finditer(text):
            block = collapse(match.group(2))
            if not block or any(block in s or (s and s in block) for s in sources):
                continue
            if any(block.startswith(skip) for skip in skips):
                continue
            first = next((line.strip() for line in match.group(2).splitlines() if line.strip()), "")
            missing.append(f"{name}: block starting {first[:80]!r}")
    return missing


# --- Running cases -------------------------------------------------------------


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
        path.write_text(json_text(content), encoding="utf-8")


def start_server(command: str, ctx: dict, timeout: float):
    proc = subprocess.Popen(fill(command, ctx), shell=True, cwd=ctx["tmp"], stdout=subprocess.DEVNULL,
                            stderr=subprocess.PIPE, start_new_session=True)
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if proc.poll() is not None:
            return proc, f"server exited with {proc.returncode}: {(proc.stderr.read() if proc.stderr else b"").decode()[-400:]}"
        try:
            socket.create_connection(("127.0.0.1", ctx["port"]), timeout=0.5).close()
            return proc, None
        except OSError:
            time.sleep(0.1)
    return proc, f"server did not listen on port {ctx['port']} within {timeout:.0f}s"


def stop_server(proc) -> None:
    if proc is None:
        return
    if proc.stderr:
        proc.stderr.close()
    if proc.poll() is not None:
        return
    try:
        os.killpg(proc.pid, signal.SIGTERM)
        proc.wait(timeout=5)
    except (ProcessLookupError, subprocess.TimeoutExpired):
        os.killpg(proc.pid, signal.SIGKILL)


def run_command(step: dict, ctx: dict, timeout: float) -> list[str]:
    command = step["run"]
    args = [fill(a, ctx) for a in command] if isinstance(command, list) else fill(command, ctx)
    try:
        done = subprocess.run(args, shell=isinstance(args, str), cwd=ctx["tmp"], input=step.get("stdin", ""),
                              capture_output=True, text=True, timeout=timeout)
    except subprocess.TimeoutExpired:
        return [f"timed out after {timeout:.0f}s"]
    problems = []
    if "exit" in step and done.returncode != step["exit"]:
        problems.append(f"exit {done.returncode}, expected {step['exit']}; stderr: {done.stderr[-300:]!r}")
    for stream in ("stdout", "stderr"):
        if stream in step:
            diff = compare(step[stream], getattr(done, stream), step)
            if diff:
                problems.append(f"{stream}: {diff}")
    return problems


def http_call(step: dict, ctx: dict, timeout: float):
    method, _, target = fill(step["http"], ctx).partition(" ")
    body = step.get("body")
    data = None if body is None else json_text(body).encode()
    headers = {"Content-Type": "application/json"} if isinstance(body, (dict, list)) else {}
    headers.update(step.get("headers") or {})
    request = urllib.request.Request(f"http://127.0.0.1:{ctx['port']}{target.strip()}", data=data,
                                     headers=headers, method=method.upper())
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return response.status, response.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as err:
        return err.code, err.read().decode("utf-8", "replace")


def run_http(step: dict, ctx: dict, timeout: float) -> list[str]:
    try:
        status, text = http_call(step, ctx, timeout)
    except (OSError, ValueError) as err:
        return [f"request failed: {err}"]
    problems = []
    if "status" in step and status != step["status"]:
        problems.append(f"status {status}, expected {step['status']}; body: {text[:300]!r}")
    if "response" in step:
        diff = compare(step["response"], text, step)
        if diff:
            problems.append(f"response: {diff}")
    return problems


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


def run_case(case: dict, root: Path, timeout: float) -> list[str]:
    with tempfile.TemporaryDirectory(prefix="example-") as tmp:
        ctx = {"root": root, "tmp": tmp, "port": free_port()}
        write_files(Path(tmp), case.get("files"), ctx)
        proc, problem = start_server(case["server"], ctx, timeout) if case.get("server") else (None, None)
        try:
            if problem:
                return [problem]
            for i, step in enumerate(case.get("steps", []), 1):
                problems = run_step(step, ctx, timeout)
                if problems:
                    return [f"step {i}: {p}" for p in problems]
            return []
        finally:
            stop_server(proc)


# --- Main ----------------------------------------------------------------------


def load_cases(path: Path) -> dict:
    if not path.is_file():
        return {"cases": [], "skipped": []}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except ValueError as err:
        raise CaseFileError(f"{path}: not valid JSON: {err}") from err
    if not isinstance(data, dict) or not isinstance(data.get("cases", []), list):
        raise CaseFileError(f"{path}: expected an object with a `cases` list")
    ids = [c.get("id") for c in data.get("cases", [])]
    if any(not i for i in ids) or len(set(ids)) != len(ids):
        raise CaseFileError(f"{path}: every case needs a unique `id`")
    return data


def static_problems(data: dict, requests: list[tuple[str, str]]) -> list[str]:
    requests_text = collapse("\n".join(text for _, text in requests))
    problems = []
    for case in data.get("cases", []):
        problems += [f"case {case['id']}: {p}" for p in source_problems(case, requests_text)]
    blocks = uncovered_blocks(requests, data.get("cases", []), data.get("skipped", []))
    problems += [f"not covered by a case or skipped with a reason: {b}" for b in blocks]
    return problems


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--cases", default=CASES_DEFAULT)
    parser.add_argument("--requests", default=REQUESTS_DEFAULT)
    parser.add_argument("--root", default=".")
    parser.add_argument("--only", action="append", default=[], help="run only this case id (repeatable)")
    parser.add_argument("--timeout", type=float, default=30.0, help="seconds per step and for server start")
    parser.add_argument("--format", action="store_true", help="print the case file format and exit")
    args = parser.parse_args(argv)
    if args.format:
        print(FORMAT)
        return 0
    root = Path(args.root).resolve()
    try:
        data = load_cases(root / args.cases)
    except CaseFileError as err:
        print(f"example_replay: {err}", file=sys.stderr)
        return 2
    requests = load_requests(root / args.requests)
    failures = static_problems(data, requests)
    active = [c for c in data["cases"] if c.get("superseded_by") is None and (not args.only or c["id"] in args.only)]
    passed = 0
    for case in active:
        problems = run_case(case, root, args.timeout)
        failures += [f"case {case['id']}: FAIL {p}" for p in problems]
        passed += not problems
    for line in failures:
        print(line)
    print(f"example_replay: {passed}/{len(active)} cases pass, {len(failures)} problem(s), {len(requests)} saved request(s)")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
