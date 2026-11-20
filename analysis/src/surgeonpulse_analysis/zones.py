"""Heart-rate zones and time-in-zone.

Python port of ``analytics/zones.ts`` (SPEC.md § analytics/zones.ts).

References
----------
* Tanaka H., Monahan K.D. & Seals D.R. (2001). Age-predicted maximal heart
  rate revisited. *J Am Coll Cardiol* 37(1):153–156. — ``HRmax = 208 − 0.7·age``.
"""

from __future__ import annotations

import math
from typing import Any, Mapping, Sequence

from .stats import is_valid_bpm, js_round, median

__all__ = [
    "estimate_max_hr",
    "zones_from_max_hr",
    "zones_from_baseline",
    "zone_dwells",
    "time_in_zones",
]


def estimate_max_hr(birth_year: int, at_year: int) -> int:
    """Age-predicted maximum heart rate (Tanaka et al. 2001): ``round(208 − 0.7·age)``.

    Rounds halves up like JavaScript ``Math.round`` (not banker's rounding).
    """
    age = at_year - birth_year
    return js_round(208 - 0.7 * age)


def zones_from_max_hr(max_hr: float) -> list[dict[str, Any]]:
    """Five zones as a percentage of max HR; bounds ``max_hr·pct`` (not rounded).

    Z1 [0, 60 %) "Very light", Z2 [60, 70 %) "Light", Z3 [70, 80 %) "Moderate",
    Z4 [80, 90 %) "Hard", Z5 [90 %, ∞) "Maximum". ``maxBpm`` of Z5 is ``math.inf``.
    """
    b = [0, max_hr * 0.6, max_hr * 0.7, max_hr * 0.8, max_hr * 0.9, math.inf]
    labels = ["Very light", "Light", "Moderate", "Hard", "Maximum"]
    return [
        {"id": f"z{i + 1}", "label": labels[i], "minBpm": b[i], "maxBpm": b[i + 1]} for i in range(5)
    ]


def zones_from_baseline(resting_hr: float) -> list[dict[str, Any]]:
    """Four zones relative to the resting baseline.

    ``rest`` [0, rest+10) "At rest", ``elevated`` [rest+10, rest+20) "Elevated",
    ``high`` [rest+20, rest+30) "High", ``very-high`` [rest+30, ∞) "Very high".
    """
    r = resting_hr
    return [
        {"id": "rest", "label": "At rest", "minBpm": 0, "maxBpm": r + 10},
        {"id": "elevated", "label": "Elevated", "minBpm": r + 10, "maxBpm": r + 20},
        {"id": "high", "label": "High", "minBpm": r + 20, "maxBpm": r + 30},
        {"id": "very-high", "label": "Very high", "minBpm": r + 30, "maxBpm": math.inf},
    ]


def zone_dwells(samples: Sequence[Mapping[str, Any]], max_gap_ms: float = 5000) -> list[tuple[float, float]]:
    """``(bpm, dwell_ms)`` per valid sample, sorted by time (SPEC ``timeInZones`` dwell rule).

    Sample *i* dwells ``min(t[i+1] − t[i], max_gap_ms)``; the last sample dwells
    ``min(median of the other dwells, max_gap_ms)``, or 0 when it is the only one.
    """
    valid = sorted((s for s in samples if is_valid_bpm(s.get("bpm"))), key=lambda s: s["t"])
    n = len(valid)
    if n == 0:
        return []
    dwells = [min(valid[i + 1]["t"] - valid[i]["t"], max_gap_ms) for i in range(n - 1)]
    last = 0 if n == 1 else min(median(dwells), max_gap_ms)  # type: ignore[type-var]
    dwells.append(last)
    return [(s["bpm"], d) for s, d in zip(valid, dwells)]


def time_in_zones(
    samples: Sequence[Mapping[str, Any]],
    zones: Sequence[Mapping[str, Any]],
    max_gap_ms: float = 5000,
) -> list[dict[str, Any]]:
    """Time-weighted time in each zone (SPEC ``timeInZones``).

    Each dwell (see :func:`zone_dwells`) goes to the first zone with
    ``minBpm <= bpm < maxBpm``. Output follows ``zones`` order, includes
    zero-time zones, and ``fraction = seconds / Σseconds`` (0 when Σ is 0).
    """
    acc_ms = [0.0] * len(zones)
    for bpm, dwell in zone_dwells(samples, max_gap_ms):
        for k, z in enumerate(zones):
            if z["minBpm"] <= bpm < z["maxBpm"]:
                acc_ms[k] += dwell
                break
    seconds = [ms / 1000 for ms in acc_ms]
    total = 0.0
    for s in seconds:
        total += s
    return [
        {
            "id": z["id"],
            "label": z["label"],
            "seconds": seconds[k],
            "fraction": (seconds[k] / total) if total > 0 else 0,
        }
        for k, z in enumerate(zones)
    ]
