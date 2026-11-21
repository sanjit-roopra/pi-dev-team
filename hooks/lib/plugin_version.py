#!/usr/bin/env python3
"""Resolve and print the dev-team package version (#1078).

The version is the ``"version"`` field of this checkout's ``package.json``.
Run as a script, prints a single deterministic line — no reasoning, no
file-by-file searching, so the answer never depends on the model guessing.

Contract:
    Output : one line, e.g. ``pi-dev-team v0.5.0 (scope: package)``
    Exit 0 : printed a version line
    Exit 2 : package.json missing/malformed or has no version (stderr)

Stdlib only, (ADR 0014 / 0015).
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

PACKAGE = "pi-dev-team"

# hooks/lib/plugin_version.py -> hooks/lib -> hooks -> package root
_MANIFEST = Path(__file__).resolve().parents[2] / "package.json"


def shipped_version() -> str:
    """Read the ``version`` declared in this checkout's ``package.json``.

    For callers (event-stream emitters) that stamp their own output with
    "which version of me produced this." Previously duplicated verbatim in
    hooks/lib/boundary_events.py, workflow_state.py, and
    iteration_journal_gate.py.
    """
    try:
        data = json.loads(_MANIFEST.read_text(encoding="utf-8"))
        version = data.get("version") if isinstance(data, dict) else None
        if isinstance(version, str) and version:
            return version
    except (OSError, ValueError):
        pass
    return "unknown"


def main(argv: list | None = None) -> int:
    version = shipped_version()
    if version == "unknown":
        print(
            f"Environment error: cannot read a version from {_MANIFEST}.",
            file=sys.stderr,
        )
        return 2
    print(f"{PACKAGE} v{version} (scope: package)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
