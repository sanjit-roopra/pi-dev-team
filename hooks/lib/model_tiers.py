"""Model tiers, cheapest first, and the old Claude-named aliases.

Python twin of the tier table in extensions/dev-team/lib/config.ts: keep the
two in step. Old names (haiku, sonnet, opus, fable) still work everywhere a
tier is accepted; code writes and shows the new names. Stdlib only.
"""

from __future__ import annotations

TIERS = ("small", "standard", "strong", "max")
ALIASES = {"haiku": "small", "sonnet": "standard", "opus": "strong", "fable": "max"}


def normalize_tier(name: str | None) -> str | None:
    """`name` as a tier, with an old name mapped to its new one; None when it is not a tier."""
    if not name:
        return None
    low = name.strip().lower()
    low = ALIASES.get(low, low)
    return low if low in TIERS else None
