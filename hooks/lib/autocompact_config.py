"""Detect whether harness autocompact is configured (#2177, slice 2).

Single decider used by both `scripts/set_autocompact_env.py` (the `/setup`
writer) and `hooks/autocompact_setup_nudge.py`. Import direction is
scripts -> hooks/lib; this module never imports from `scripts/`.

The threshold is an integer 1-100 (percent of the auto-compact window).
Values above the harness default are ignored, so it can only lower the
threshold. `HARNESS_DEFAULT_PCT` (~83) is REPORTED, not confirmed against
primary docs.

Sources consulted, highest precedence first (same order and labels as
`extensions/dev-team/lib/autocompact.ts`):

  - the `DEV_TEAM_AUTOCOMPACT_PCT` environment variable ("process env");
  - top-level `autocompactPct` in `.pi/dev-team.local.json`
    ("dev-team.local.json");
  - top-level `autocompactPct` in `.pi/dev-team.json` ("dev-team.json");
  - top-level `autocompactPct` in `<agentDir>/dev-team.json`, where agentDir
    is `$PI_CODING_AGENT_DIR` (tilde-expanded) or `~/.pi/agent`
    ("user dev-team.json").

A config value may be a JSON integer 1-100 or the same as a numeric string.
The first source that defines the key decides. An unreadable or malformed
config file is skipped, never raised.

Stdlib only.
"""

from __future__ import annotations

import json
import re
from collections.abc import Mapping
from dataclasses import dataclass
from enum import Enum
from pathlib import Path

from artifact_paths import agent_dir  # type: ignore[import-not-found]

KEY = "DEV_TEAM_AUTOCOMPACT_PCT"
CONFIG_KEY = "autocompactPct"
DEFAULT_PCT = 40
HARNESS_DEFAULT_PCT = 83  # reported, not verified against primary docs

# Plain ASCII integer 1-100: no sign, no whitespace, no decimal point, no leading zero.
_PCT_RE = re.compile(r"(?:100|[1-9][0-9]?)")


class Status(Enum):
    CONFIGURED = "configured"
    INVALID = "invalid"
    ABSENT = "absent"


@dataclass(frozen=True)
class Detection:
    status: Status
    raw: object = None
    source: str | None = None


def validate_pct(raw: object) -> int | None:
    """Return the integer percent for a valid value 1-100, else None.

    A string must be a plain integer (see `_PCT_RE`). A JSON number from a
    config file must be a whole number 1-100 (`40` or `40.0`, never `true`).
    """
    if isinstance(raw, bool):
        return None
    if isinstance(raw, int):
        return raw if 1 <= raw <= 100 else None
    if isinstance(raw, float):
        return int(raw) if raw.is_integer() and 1 <= raw <= 100 else None
    if not isinstance(raw, str) or not _PCT_RE.fullmatch(raw):
        return None
    return int(raw)


def user_config_path(env: Mapping[str, str]) -> Path:
    """`<agentDir>/dev-team.json`, agentDir from `artifact_paths.agent_dir(env)`."""
    return agent_dir(env) / "dev-team.json"


def _config(path: Path) -> Mapping[str, object] | None:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError, RecursionError, RuntimeError):
        return None
    return data if isinstance(data, dict) else None


def detect(project_dir: str | Path, env: Mapping[str, str]) -> Detection:
    """Find the first source defining the key and classify its value."""
    if KEY in env:
        raw = env[KEY]
        return Detection(
            Status.CONFIGURED if validate_pct(raw) is not None else Status.INVALID,
            raw,
            "process env",
        )
    root = Path(project_dir)
    candidates = (
        ("dev-team.local.json", root / ".pi" / "dev-team.local.json"),
        ("dev-team.json", root / ".pi" / "dev-team.json"),
        ("user dev-team.json", user_config_path(env)),
    )
    for label, path in candidates:
        config = _config(path)
        if config is not None and CONFIG_KEY in config:
            raw = config[CONFIG_KEY]
            ok = validate_pct(raw) is not None
            return Detection(Status.CONFIGURED if ok else Status.INVALID, raw, label)
    return Detection(Status.ABSENT)


def autocompact_configured(project_dir: str | Path, env: Mapping[str, str]) -> Status:
    """CONFIGURED (valid), INVALID (present, bad value) or ABSENT."""
    return detect(project_dir, env).status
