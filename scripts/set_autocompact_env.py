#!/usr/bin/env python3
"""Merge `autocompactPct` into a project's `.pi/dev-team.json`.

Used by `/dev-team:setup` (#2177). Merges exactly one top-level key,
preserving every other key; it never replaces the file wholesale. The value
is written as a JSON integer.

    set_autocompact_env.py [--project-dir DIR] [--autocompact-pct N]
                           [--yes] [--no-autocompact]

Value resolution (all `--yes` / prompt logic lives here, not in SKILL.md):

  existing value | --autocompact-pct | result
  -------------- | ----------------- | ------------------------------------
  none           | none              | "40" (prompt default, or --yes)
  none           | N                 | "N"
  valid "60"     | none              | kept "60" (prompt Enter keeps it)
  valid "60"     | N                 | "N"
  invalid        | none              | replaced with "40" (or prompted value)

The threshold can only be LOWERED by the harness: a value above the
(reported, unverified) harness default of ~83 is written but warned about.
The env var DEV_TEAM_AUTOCOMPACT_PCT and `.pi/dev-team.local.json` outrank
this file; the script warns when either already sets a value.

`--no-autocompact` leaves dev-team.json untouched and creates
`.pi/dev-team/memory/autocompact-nudge-off` so the SessionStart nudge stays quiet.

Exit codes: 0 ok, 2 error. On any error the original file bytes are left
untouched. Stdlib only; Python 3.10+.
"""

from __future__ import annotations

import argparse
import json
import os
import stat
import sys
import tempfile
from collections.abc import Callable, Mapping
from pathlib import Path

_LIB = Path(__file__).resolve().parents[1] / "hooks" / "lib"
if str(_LIB) not in sys.path:
    sys.path.insert(0, str(_LIB))

from autocompact_config import (  # type: ignore[import-not-found]
    CONFIG_KEY,
    DEFAULT_PCT,
    HARNESS_DEFAULT_PCT,
    KEY,
    detect,
    validate_pct,
)

CONFIG_RELPATH = Path(".pi") / "dev-team.json"
NUDGE_OFF_RELPATH = Path(".pi") / "dev-team" / "memory" / "autocompact-nudge-off"
_TOKENS_ON_200K = 200_000


class SetupError(Exception):
    """A user-facing failure; the config file was not modified."""


def _prompt_text(default: int) -> str:
    approx = _TOKENS_ON_200K * DEFAULT_PCT // 100 // 1000
    return (
        f"Autocompact at what % of the window? [{default}] "
        f"({DEFAULT_PCT}% ~ {approx}K tokens on a 200K window; "
        "lower = earlier compaction) "
    )


def _load_settings(path: Path) -> dict:
    if path.is_symlink():
        raise SetupError(f"refusing to follow symlink: {path}; not modified")
    if not path.exists():
        return {}
    try:
        raw = path.read_bytes().decode("utf-8")
        data = json.loads(raw) if raw.strip() else {}
    except (OSError, ValueError) as exc:
        if isinstance(exc, OSError):
            raise SetupError(f"cannot read {path}: {exc}; not modified") from exc
        raise SetupError(f"malformed dev-team.json: {path}; not modified") from exc
    if not isinstance(data, dict):
        raise SetupError(f"dev-team.json top level is not an object: {path}; not modified")
    return data


def _atomic_write(path: Path, data: dict) -> None:
    """Write `data` via a unique temp file in the same directory + os.replace.

    mkstemp gives an unpredictable name opened O_EXCL (no planted-symlink or
    race on a fixed `dev-team.json.tmp`); the existing file's mode is kept.
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp_name = None
    try:
        fd, tmp_name = tempfile.mkstemp(dir=path.parent, prefix=".dev-team.", suffix=".tmp")
        try:
            mode = stat.S_IMODE(path.stat().st_mode)
        except OSError:
            mode = 0o644
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(data, handle, indent=2)
            handle.write("\n")
        os.chmod(tmp_name, mode)
        os.replace(tmp_name, path)
    except OSError as exc:
        if tmp_name is not None:
            try:
                os.unlink(tmp_name)
            except OSError:
                pass
        raise SetupError(f"cannot write {path}: {exc}; not modified") from exc


def run(
    project_dir: Path,
    pct_flag: str | None,
    assume_yes: bool,
    no_autocompact: bool,
    interactive: bool,
    input_fn: Callable[[str], str] = input,
    environ: Mapping[str, str] | None = None,
) -> list[str]:
    """Apply the setup step; return the stdout lines. Raises SetupError."""
    if no_autocompact:
        marker = project_dir / NUDGE_OFF_RELPATH
        try:
            marker.parent.mkdir(parents=True, exist_ok=True)
            marker.touch()
        except OSError as exc:
            raise SetupError(f"cannot create {marker}: {exc}") from exc
        return [f"autocompact left unconfigured; nudge silenced ({marker})"]

    if pct_flag is not None and validate_pct(pct_flag) is None:
        raise SetupError(f"invalid --autocompact-pct '{pct_flag}': expected integer 1-100")

    path = project_dir / CONFIG_RELPATH
    data = _load_settings(path)
    existing_raw = data.get(CONFIG_KEY)
    existing_pct = validate_pct(existing_raw)
    existing_valid = existing_pct is not None
    # A valid value (JSON number or numeric string) compares as its digits.
    existing = str(existing_pct) if existing_valid else existing_raw
    existing_present = CONFIG_KEY in data

    lines: list[str] = []
    # Only the project's dev-team.json is ever written. A process-env or
    # dev-team.local.json entry outranks it, so say so rather than report a
    # success the harness will not honor.
    effective = detect(project_dir, os.environ if environ is None else environ)
    shadow = effective if effective.source in ("process env", "dev-team.local.json") else None
    if pct_flag is not None:
        final = pct_flag
    else:
        default = int(existing) if existing_valid else DEFAULT_PCT
        final = str(default)
        if interactive and not assume_yes:
            answer = input_fn(_prompt_text(default)).strip()
            if answer:
                if validate_pct(answer) is None:
                    raise SetupError(f"invalid value '{answer}': expected integer 1-100")
                final = answer

    if existing_valid and pct_flag is None and final == existing:
        lines.append(
            f"kept existing {CONFIG_KEY}={existing} (pass --autocompact-pct to change)"
        )
    elif existing_present and not existing_valid:
        lines.append(f"replaced invalid value '{existing}' with {final}")
    if int(final) > HARNESS_DEFAULT_PCT:
        lines.append(
            f"{final} exceeds the harness default (~{HARNESS_DEFAULT_PCT}%); values above "
            "the default are ignored, so compaction will still occur at the default"
        )

    if shadow is not None:
        shadow_key = KEY if shadow.source == "process env" else CONFIG_KEY
        lines.append(
            f"warning: {shadow_key} is also set in {shadow.source} (value {shadow.raw!r}), which "
            f"takes precedence over {path}; the value written here will not take effect "
            "until that entry is removed or corrected"
        )

    if existing == final:
        if not lines:
            lines.append(f"{CONFIG_KEY}={final} already set in {path}")
        return lines

    data[CONFIG_KEY] = int(final)
    _atomic_write(path, data)
    lines.insert(0, f"set {CONFIG_KEY}={final} in {path}")
    return lines


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--project-dir", default=".")
    parser.add_argument("--autocompact-pct", default=None)
    parser.add_argument("--yes", action="store_true", dest="assume_yes")
    parser.add_argument("--no-autocompact", action="store_true")
    args = parser.parse_args(argv)
    try:
        lines = run(
            Path(args.project_dir),
            args.autocompact_pct,
            args.assume_yes,
            args.no_autocompact,
            interactive=sys.stdin.isatty(),
        )
    except SetupError as exc:
        print(str(exc), file=sys.stderr)
        return 2
    except EOFError:
        print("no input available; pass --yes or --autocompact-pct", file=sys.stderr)
        return 2
    for line in lines:
        print(line)
    return 0


if __name__ == "__main__":
    sys.exit(main())
