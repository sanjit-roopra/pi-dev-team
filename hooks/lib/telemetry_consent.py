"""telemetry_consent.py — shared, home-scoped telemetry consent check (#1405).

Single source of truth for whether the user has opted in to dev-team's
local telemetry writers. Reads **only** `~/.pi/agent/dev-team/telemetry.json`
(`<agentDir>/dev-team/telemetry.json`; agentDir is `$PI_CODING_AGENT_DIR` when
set — see `artifact_paths.user_state_dir()`) —
deliberately no environment-variable branch and no project-scoped
(`<cwd>/.pi/dev-team/telemetry.json`) fallback. Consent is a user-level decision,
not a per-project or per-invocation one.

Fail-open: a missing file, a malformed file, or any read error is treated as
"not enabled" — never raises, never blocks the calling hook.

Stdlib only. See ADR 0014 / ADR 0015.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

_LIB_DIR = Path(__file__).resolve().parent
if str(_LIB_DIR) not in sys.path:
    sys.path.insert(0, str(_LIB_DIR))

from artifact_paths import user_state_dir


def _consent_path() -> Path:
    return user_state_dir() / "telemetry.json"


def is_enabled() -> bool:
    """Return True only when `~/.pi/agent/dev-team/telemetry.json` contains
    `{"enabled": true}`. Any other state — file absent, malformed JSON,
    `"enabled"` false or missing, or a read error — returns False."""
    config = _consent_path()
    try:
        if not config.is_file():
            return False
        data = json.loads(config.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return False
    if not isinstance(data, dict):
        return False
    # Deliberate strict identity check (`is True`, not truthiness): a
    # non-bool value such as `"true"` or `1` must NOT imply consent — only
    # the literal JSON boolean `true` does.
    return data.get("enabled") is True
