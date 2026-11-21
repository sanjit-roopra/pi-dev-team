#!/usr/bin/env python3
"""token_efficiency_review — PostToolUse hook (run by the dev-team extension; #607).

PostToolUse hook for Write/Edit — checks file length, instructions-file
(AGENTS.md / CLAUDE.md) length, and function length. Emits advisory warnings
on stdout; never blocks.

Contract:
    Input : PostToolUse JSON on stdin
    Output: Advisory warnings on stdout, or empty
    Exit  : Always 0

Stdlib-only.
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

_HOOK_DIR = Path(__file__).resolve().parent
_LIB_DIR = _HOOK_DIR / "lib"
if str(_LIB_DIR) not in sys.path:
    sys.path.insert(0, str(_LIB_DIR))

try:
    from token_efficiency_limits import (  # type: ignore[import-not-found]
        FILE_LINE_LIMIT,
        INSTRUCTIONS_MD_CHAR_LIMIT,
    )
    from token_efficiency_limits import char_count as _char_count
    from token_efficiency_limits import (
        is_instructions_md_file as _is_instructions_md_file,
    )
except ImportError:
    # Fail-open per the hook contract: never let a missing sibling module
    # break advisory output. Mirror the shared defaults and logic.
    INSTRUCTIONS_MD_CHAR_LIMIT = 5000
    FILE_LINE_LIMIT = 500

    def _is_instructions_md_file(path: Path) -> bool:
        return path.name.lower() in {"agents.md", "claude.md"}

    def _char_count(path: Path) -> int:
        return len(path.read_text(encoding="utf-8", errors="replace"))


# The .sh's awk pattern: function-declaration heuristics for common
# languages. Three alternatives (top-level function keyword; const/let/var =
# fn; indented method opening) — the same set the .sh emits.
_FUNC_START_RE = re.compile(
    r"^\s*(async\s+)?function\s+[a-zA-Z_]"
    r"|"
    r"^\s*(const|let|var)\s+[a-zA-Z_]+\s*=\s*(async\s+)?\("
    r"|"
    r"^\s+[a-zA-Z_]+\s*\([^)]*\)\s*\{"
)


_SOURCE_EXTS = (
    ".js",
    ".ts",
    ".jsx",
    ".tsx",
    ".py",
    ".rb",
    ".go",
    ".rs",
    ".java",
    ".cs",
)


def _extract_path(payload: dict) -> str:
    """Mirror `.tool_input.file_path // .tool_input.path // .file_path // .path`."""
    tool_input = payload.get("tool_input") or {}
    return (
        tool_input.get("file_path")
        or tool_input.get("path")
        or payload.get("file_path")
        or payload.get("path")
        or ""
    )


def _read_json(raw: bytes) -> dict:
    try:
        return json.loads(raw or b"{}")
    except json.JSONDecodeError:
        return {}


def _check_instructions_md(path: Path) -> str | None:
    """Character-count check for instructions files (AGENTS.md / CLAUDE.md)."""
    if not _is_instructions_md_file(path):
        return None
    try:
        count = _char_count(path)
    except OSError:
        return None
    if count > INSTRUCTIONS_MD_CHAR_LIMIT:
        return (
            f"Token: {path.name} is {count} chars (limit: {INSTRUCTIONS_MD_CHAR_LIMIT}). "
            "Move detailed examples to docs/ or skills."
        )
    return None


def _line_count_from_lines(lines: list[str]) -> int:
    return len(lines)


def _long_functions_from_lines(lines: list[str], limit: int = 50) -> list[str]:
    """Return a list of `  Line N: <name> (<len> lines)` for functions
    longer than `limit`. Mirrors the .sh's awk block."""
    findings: list[str] = []
    func_start = 0
    func_name = ""
    lineno = 0
    for line in lines:
        lineno += 1
        if _FUNC_START_RE.search(line):
            if func_start > 0 and lineno - func_start > limit:
                findings.append(
                    f"  Line {func_start}: {func_name} ({lineno - func_start} lines)"
                )
            func_start = lineno
            name = line.lstrip()
            # Strip anything after `(` or `{` — matches bash sub()s.
            name = re.sub(r"[({].*", "", name)
            func_name = name
    if func_start > 0 and lineno - func_start > limit:
        findings.append(
            f"  Line {func_start}: {func_name} ({lineno - func_start} lines)"
        )
    return findings


def _check_source_file(path: Path) -> list[str]:
    """Return warning lines for source-file length + long functions.

    Reads the file's content exactly once and reuses the resulting lines for
    both checks (line-count, long-function scan)."""
    warnings: list[str] = []
    if path.suffix.lower() not in _SOURCE_EXTS:
        return warnings
    try:
        lines = path.read_text(errors="replace").splitlines()
    except OSError:
        return warnings
    lc = _line_count_from_lines(lines)
    if lc > FILE_LINE_LIMIT:
        warnings.append(
            f"Token: File is {lc} lines (limit: {FILE_LINE_LIMIT}). Large files "
            "require more context tokens — consider splitting."
        )
    long_funcs = _long_functions_from_lines(lines)
    if long_funcs:
        warnings.append(
            "Token: Long functions detected (limit: 50 lines). "
            "Split into smaller units:\n" + "\n".join(long_funcs)
        )
    return warnings


def main() -> int:
    try:
        raw = sys.stdin.buffer.read()
    except (OSError, ValueError):
        raw = b""
    payload = _read_json(raw)
    file_path_str = _extract_path(payload)
    if not file_path_str:
        return 0
    file_path = Path(file_path_str)
    if not file_path.is_file():
        return 0

    warnings: list[str] = []
    instructions_md_warning = _check_instructions_md(file_path)
    if instructions_md_warning:
        warnings.append(instructions_md_warning)
    warnings.extend(_check_source_file(file_path))

    if warnings:
        # The .sh formats WARNINGS by concatenating each warning with a
        # leading newline, then echoing $WARNINGS. That produces a leading
        # newline before the first warning. Reproduce for byte-parity.
        print()
        print("\n".join(warnings))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
