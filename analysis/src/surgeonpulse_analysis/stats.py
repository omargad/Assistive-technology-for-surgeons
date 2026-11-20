"""Descriptive statistics and heart-rate sample statistics.

Python port of ``analytics/stats.ts`` and ``analytics/hr.ts`` from
``packages/core/SPEC.md``. Everything is pure Python (no numpy) so results are
bit-for-bit reproducible across platforms and match the TypeScript
implementation to within floating-point rounding:

* Sums are plain left-to-right accumulations, like ``Array.prototype.reduce``
  in JavaScript. (Python >= 3.12's builtin ``sum`` uses compensated summation
  for floats, which is *more* accurate but not what the TypeScript does.)
* No function ever returns ``nan`` or ``inf``; "not enough data" is ``None``.
"""

from __future__ import annotations

import math
from typing import Any, Iterable, Mapping, Sequence

__all__ = [
    "HR_VALID_MIN_BPM",
    "HR_VALID_MAX_BPM",
    "is_finite_number",
    "is_valid_bpm",
    "js_round",
    "naive_sum",
    "mean",
    "median",
    "sample_sd",
    "percentile",
    "linear_trend",
    "pearson_correlation",
    "moving_average",
    "hr_stats",
    "slice_by_time",
    "detect_gaps",
    "sorted_by_t",
]

#: Physiologically plausible heart-rate range (bpm); samples outside are ignored (SPEC ``hrStats``).
HR_VALID_MIN_BPM = 25
HR_VALID_MAX_BPM = 250


def is_finite_number(x: Any) -> bool:
    """True for a real, finite ``int``/``float`` (``bool`` is not a number here, as in JSON)."""
    return isinstance(x, (int, float)) and not isinstance(x, bool) and math.isfinite(x)


def is_valid_bpm(bpm: Any) -> bool:
    """SPEC ``hrStats``: a sample is valid when ``bpm`` is finite and within [25, 250]."""
    return is_finite_number(bpm) and HR_VALID_MIN_BPM <= bpm <= HR_VALID_MAX_BPM


def js_round(x: float) -> int:
    """JavaScript ``Math.round``: nearest integer, halves rounded towards +infinity.

    Python's :func:`round` uses banker's rounding (``round(176.5) == 176``),
    which would make e.g. Tanaka max-HR estimates differ from the app.
    """
    f = math.floor(x)
    return int(f + 1) if x - f >= 0.5 else int(f)


def naive_sum(xs: Iterable[float]) -> float:
    """Left-to-right sum (same rounding behaviour as a JavaScript ``reduce``)."""
    s: float = 0
    for x in xs:
        s += x
    return s


def mean(xs: Sequence[float]) -> float | None:
    """Arithmetic mean; ``None`` for an empty sequence."""
    if len(xs) == 0:
        return None
    return naive_sum(xs) / len(xs)


def median(xs: Sequence[float]) -> float | None:
    """Median (mean of the two middle values for even n); ``None`` for an empty sequence."""
    n = len(xs)
    if n == 0:
        return None
    s = sorted(xs)
    mid = n // 2
    if n % 2 == 1:
        return s[mid]
    return (s[mid - 1] + s[mid]) / 2


def sample_sd(xs: Sequence[float]) -> float | None:
    """Sample standard deviation (n − 1 denominator); 0 for n = 1, ``None`` for n = 0."""
    n = len(xs)
    if n == 0:
        return None
    if n == 1:
        return 0.0
    m = naive_sum(xs) / n
    ss = naive_sum((x - m) * (x - m) for x in xs)
    return math.sqrt(ss / (n - 1))


def percentile(xs: Sequence[float], p: float) -> float | None:
    """Percentile with linear interpolation between closest ranks.

    SPEC: ``rank = p/100·(n−1)`` on a sorted copy — identical to NumPy's default
    ``method="linear"`` (Hyndman & Fan 1996, definition 7). ``p`` is clamped to
    [0, 100]; ``None`` for empty input or non-finite ``p``.
    """
    n = len(xs)
    if n == 0 or not is_finite_number(p):
        return None
    p = min(100.0, max(0.0, p))
    s = sorted(xs)
    rank = p / 100 * (n - 1)
    lo = math.floor(rank)
    hi = min(lo + 1, n - 1)
    frac = rank - lo
    if frac == 0:
        return s[lo]
    return s[lo] + (s[hi] - s[lo]) * frac


def _xy(point: Any) -> tuple[float, float]:
    if isinstance(point, Mapping):
        return point["x"], point["y"]
    x, y = point
    return x, y


def linear_trend(points: Iterable[Any]) -> dict[str, float] | None:
    """Ordinary least-squares fit ``y = slope·x + intercept``.

    ``points`` are ``{"x", "y"}`` mappings or ``(x, y)`` pairs. Returns
    ``{"slope", "intercept", "r2", "n"}``, or ``None`` when n < 2 or var(x) = 0.
    ``r2`` is 0 when var(y) = 0.
    """
    pts = [_xy(p) for p in points]
    n = len(pts)
    if n < 2:
        return None
    mx = naive_sum(x for x, _ in pts) / n
    my = naive_sum(y for _, y in pts) / n
    sxx = naive_sum((x - mx) * (x - mx) for x, _ in pts)
    if sxx == 0:
        return None
    sxy = naive_sum((x - mx) * (y - my) for x, y in pts)
    syy = naive_sum((y - my) * (y - my) for _, y in pts)
    slope = sxy / sxx
    intercept = my - slope * mx
    r2 = 0.0 if syy == 0 else min(1.0, max(0.0, (sxy * sxy) / (sxx * syy)))
    return {"slope": slope, "intercept": intercept, "r2": r2, "n": n}


def pearson_correlation(xs: Sequence[float], ys: Sequence[float]) -> float | None:
    """Pearson r of paired values; ``None`` if n < 2 or either variance is 0."""
    n = min(len(xs), len(ys))
    if n < 2:
        return None
    mx = naive_sum(xs[:n]) / n
    my = naive_sum(ys[:n]) / n
    sxx = naive_sum((x - mx) ** 2 for x in xs[:n])
    syy = naive_sum((y - my) ** 2 for y in ys[:n])
    if sxx == 0 or syy == 0:
        return None
    sxy = naive_sum((x - mx) * (y - my) for x, y in zip(xs[:n], ys[:n]))
    return sxy / math.sqrt(sxx * syy)


def moving_average(xs: Sequence[float], window: int) -> list[float]:
    """Trailing moving average; partial windows at the start (output length = input length)."""
    w = max(1, int(window))
    out: list[float] = []
    for i in range(len(xs)):
        chunk = xs[max(0, i - w + 1) : i + 1]
        out.append(naive_sum(chunk) / len(chunk))
    return out


def sorted_by_t(xs: Iterable[Mapping[str, Any]]) -> list[Mapping[str, Any]]:
    """Stable sort by ``t`` (Python's sort is stable, like ``Array.prototype.sort`` since ES2019)."""
    return sorted(xs, key=lambda x: x["t"])


def hr_stats(samples: Iterable[Mapping[str, Any]]) -> dict[str, float] | None:
    """Heart-rate summary statistics over sample values (not time-weighted).

    Ignores samples whose ``bpm`` is not finite or lies outside [25, 250].
    Returns ``{"count", "mean", "median", "min", "max", "sd", "p95"}`` or
    ``None`` when no valid sample remains. ``p95`` uses :func:`percentile`.
    """
    vals = [s["bpm"] for s in samples if is_valid_bpm(s.get("bpm"))]
    if not vals:
        return None
    return {
        "count": len(vals),
        "mean": naive_sum(vals) / len(vals),
        "median": median(vals),
        "min": min(vals),
        "max": max(vals),
        "sd": sample_sd(vals),
        "p95": percentile(vals, 95),
    }


def slice_by_time(xs: Iterable[Mapping[str, Any]], start: float, end: float) -> list[Mapping[str, Any]]:
    """Items with ``start <= t < end`` (order preserved)."""
    return [x for x in xs if start <= x["t"] < end]


def detect_gaps(samples: Sequence[Mapping[str, Any]], max_gap_ms: float = 5000) -> list[dict[str, float]]:
    """Data gaps: consecutive samples with ``next.t − prev.t > max_gap_ms``.

    Each gap runs from ``prev.t`` to ``next.t``: ``{"start", "end", "durationMs"}``.
    """
    gaps: list[dict[str, float]] = []
    for prev, nxt in zip(samples, samples[1:]):
        dt = nxt["t"] - prev["t"]
        if dt > max_gap_ms:
            gaps.append({"start": prev["t"], "end": nxt["t"], "durationMs": dt})
    return gaps
