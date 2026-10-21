#!/usr/bin/env python3
"""build_phase.py — write `/build`'s phase record in one command (pi port).

`/build` keeps `.claude/memory/build-phase.json` (schema in `skills/build/SKILL.md`,
read by `hooks/lib/build_state.py` and `hooks/lib/test_file_classify.py`). Writing it
by hand cost a model turn per phase transition. This helper writes the same record
from one short command, so the write can share a message with real work or be
chained onto a test command with `&&`.

    build_phase.py implement|test|between-steps <N.M> [--plan <path>]
    build_phase.py refactor <N.M> [--plan <path>] [--stage <test file> ...]
    build_phase.py clear

- `written_at` is now (UTC). `plan_path` comes from `--plan`, else from the current record.
- `--stage` (refactor only) runs `git add` on the files, then records them, repo-relative,
  in `test_files_staged`: the index is the baseline the tests-frozen guards enforce.
  Nothing is written when `git add` fails.
- `clear` deletes the record (the plan's last step is done).

The record lands at `<git root of the cwd>/.claude/memory/build-phase.json`, the path the
guards read. Exit 0 on success, 1 when staging or writing fails, 2 on bad arguments.
Port-owned (not in upstream); stdlib only.
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "hooks" / "lib"))

from artifact_paths import project_root  # noqa: E402
from atomic_state import atomic_write  # noqa: E402
from build_state import BETWEEN_STEPS, STATE_RELPATH  # noqa: E402

PHASES = ("implement", "test", "refactor", BETWEEN_STEPS)


def repo_relative(root: Path, raw: str) -> str:
    """`raw` (absolute, or relative to the cwd) as a repo-relative POSIX path; unchanged when outside the repo."""
    path = Path(raw)
    absolute = path if path.is_absolute() else Path.cwd() / path
    try:
        return absolute.resolve().relative_to(root.resolve()).as_posix()
    except ValueError:
        return raw


def current_plan_path(state_file: Path) -> str:
    try:
        data = json.loads(state_file.read_text(encoding="utf-8"))
    except (OSError, ValueError, UnicodeDecodeError):
        return ""
    plan = data.get("plan_path") if isinstance(data, dict) else None
    return plan if isinstance(plan, str) else ""


def build_record(phase: str, step: str, plan_path: str, staged: list[str], now: datetime | None = None) -> dict:
    written_at = (now or datetime.now(timezone.utc)).isoformat(timespec="seconds")
    return {
        "phase": phase,
        "step": step,
        "written_at": written_at,
        "test_files_staged": staged if phase == "refactor" else [],
        "plan_path": plan_path,
    }


def parse_args(argv: list[str]) -> argparse.Namespace:
    ap = argparse.ArgumentParser(description="Write /build's .claude/memory/build-phase.json record.")
    ap.add_argument("phase", choices=PHASES + ("clear",))
    ap.add_argument("step", nargs="?", help="step id N.M (required unless clear)")
    ap.add_argument("--plan", help="repo-relative plan path (default: the current record's)")
    ap.add_argument("--stage", nargs="+", default=[], metavar="FILE", help="refactor only: test files to git add and record")
    args = ap.parse_args(argv)
    if args.phase != "clear" and not (args.step or "").strip():
        ap.error(f"{args.phase} needs a step id (N.M)")
    if args.stage and args.phase != "refactor":
        ap.error("--stage is only for refactor (the TEST -> REFACTOR baseline)")
    return args


def main(argv: list[str] | None = None) -> int:
    args = parse_args(sys.argv[1:] if argv is None else argv)
    root = project_root(Path.cwd())
    state_file = root / STATE_RELPATH

    if args.phase == "clear":
        state_file.unlink(missing_ok=True)
        print(f"build-phase: cleared {STATE_RELPATH}")
        return 0

    staged = [repo_relative(root, f) for f in args.stage]
    if staged:
        added = subprocess.run(["git", "add", "--", *staged], cwd=str(root), capture_output=True, text=True, check=False)
        if added.returncode != 0:
            print(f"build-phase: git add failed, record not written: {added.stderr.strip()}", file=sys.stderr)
            return 1

    plan_path = args.plan if args.plan is not None else current_plan_path(state_file)
    if not plan_path:
        print("build-phase: no plan path (pass --plan); writing an empty plan_path", file=sys.stderr)
    record = build_record(args.phase, args.step.strip(), plan_path, staged)
    try:
        atomic_write(state_file, json.dumps(record) + "\n", fail_open=False)
    except OSError as exc:
        print(f"build-phase: could not write {state_file}: {exc}", file=sys.stderr)
        return 1
    detail = f", {len(staged)} test file(s) staged" if staged else ""
    print(f"build-phase: {record['phase']} step {record['step']}{detail}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
