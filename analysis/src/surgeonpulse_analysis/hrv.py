"""RR-interval cleaning and time-domain heart-rate variability.

Python port of ``analytics/rr.ts`` (SPEC.md § analytics/rr.ts).

References
----------
* Task Force of the European Society of Cardiology and the North American
  Society of Pacing and Electrophysiology (1996). Heart rate variability:
  standards of measurement, physiological interpretation and clinical use.
  *Circulation* 93(5):1043–1065. — definitions of SDNN, RMSSD, pNN50.
* Baevsky R.M. & Chernikova A.G. (2017). Heart rate variability analysis:
  physiological foundations and main methods. *Cardiometry* 10:66–76. —
  stress index ``SI = AMo / (2·Mo·MxDMn)``.
"""

from __future__ import annotations

import bisect
import math
from typing import Any, Mapping, Sequence

from .stats import is_finite_number, median, naive_sum, sample_sd

__all__ = [
    "clean_rr",
    "hrv_time_domain",
    "compute_hrv",
    "rolling_hrv",
    "baevsky_stress_index",
    "windowed_stress_index",
    "valid_rr_ms",
    "MAX_HRV_ARTIFACT_RATIO",
    "STRESS_INDEX_WINDOW_MS",
    "MAX_ROLLING_HRV_WINDOWS",
]

#: Largest RR artefact ratio at which summaries and baselines still report HRV (SPEC ``MAX_HRV_ARTIFACT_RATIO``).
MAX_HRV_ARTIFACT_RATIO = 0.1
#: Window length of :func:`windowed_stress_index` (5 min).
STRESS_INDEX_WINDOW_MS = 300_000

#: Upper limit on the number of windows :func:`rolling_hrv` produces (SPEC ``rollingHrv``).
MAX_ROLLING_HRV_WINDOWS = 1_000_000

RR = Mapping[str, Any]


def clean_rr(
    rr: Sequence[RR],
    *,
    min_ms: float = 300,
    max_ms: float = 2000,
    max_deviation: float = 0.2,
    window: int = 11,
) -> dict[str, Any]:
    """Flag artefactual / ectopic RR intervals.

    An interval is invalid when (SPEC ``cleanRr``):

    1. ``ms`` is not finite or lies outside ``[min_ms, max_ms]``; or
    2. ``|ms − localMedian| / localMedian > max_deviation``, where
       ``localMedian`` is the median of the rule-1-valid intervals in a centred
       window of ``window`` beats (clamped at the array ends) *excluding the
       beat itself*. Rule 2 is skipped when fewer than 3 such neighbours exist.

    Returns ``{"valid": [bool, ...], "report": {"total", "removed", "ratio"}}``
    with ``valid[i]`` matching ``rr[i]``.
    """
    n = len(rr)
    ms = [r.get("ms") for r in rr]
    ok = [is_finite_number(m) and min_ms <= m <= max_ms for m in ms]
    half = int(math.floor(window / 2))
    valid: list[bool] = []
    for i in range(n):
        if not ok[i]:
            valid.append(False)
            continue
        lo = max(0, i - half)
        hi = min(n - 1, i + half)
        neighbours = [ms[j] for j in range(lo, hi + 1) if j != i and ok[j]]
        if len(neighbours) < 3:
            valid.append(True)
            continue
        local = median(neighbours)
        assert local is not None
        valid.append(not (abs(ms[i] - local) / local > max_deviation))
    removed = sum(1 for v in valid if not v)
    return {
        "valid": valid,
        "report": {"total": n, "removed": removed, "ratio": (removed / n) if n > 0 else 0},
    }


def hrv_time_domain(intervals_ms: Sequence[float]) -> dict[str, float] | None:
    """Time-domain HRV of one contiguous, already-clean RR series.

    ``meanRr`` = mean, ``sdnn`` = sample SD, ``rmssd`` = sqrt(mean(d²)) and
    ``pnn50`` = 100·count(|d| > 50 ms)/len(d) with successive differences
    ``d_i = x_{i+1} − x_i`` (Task Force 1996); ``meanHr = 60000/meanRr``.
    ``None`` for fewer than 2 intervals.
    """
    xs = list(intervals_ms)
    if len(xs) < 2:
        return None
    diffs = [b - a for a, b in zip(xs, xs[1:])]
    return _fill(xs, diffs)


def _fill(valid_ms: Sequence[float], diffs: Sequence[float]) -> dict[str, float]:
    mean_rr = naive_sum(valid_ms) / len(valid_ms)
    sd = sample_sd(valid_ms)
    assert sd is not None
    return {
        "n": len(valid_ms),
        "pairs": len(diffs),
        "meanRr": mean_rr,
        "sdnn": sd,
        "rmssd": math.sqrt(naive_sum(d * d for d in diffs) / len(diffs)),
        "pnn50": 100 * sum(1 for d in diffs if abs(d) > 50) / len(diffs),
        "meanHr": 60000 / mean_rr,
    }


def _hrv_from_validity(
    rr: Sequence[RR], valid: Sequence[bool], indices: Sequence[int], gap_ms: float, min_intervals: int
) -> tuple[dict[str, float] | None, int]:
    """Steps 2–5 of ``computeHrv`` for precomputed validity flags, over ``rr[i] for i in indices``.

    Consecutive entries of ``indices`` form the candidate pairs; a pair counts when both are valid and
    in the same run (``t[j] − t[i] <= gap_ms + ms[j]``). Returns ``(hrv or None, n_valid)``.
    """
    valid_ms: list[float] = []
    diffs: list[float] = []
    prev: int | None = None
    for i in indices:
        if valid[i]:
            cur = rr[i]
            valid_ms.append(cur["ms"])
            if prev is not None and valid[prev]:
                before = rr[prev]
                if not (cur["t"] - before["t"] > gap_ms + cur["ms"]):  # same run
                    diffs.append(cur["ms"] - before["ms"])
        prev = i
    if len(valid_ms) < min_intervals or len(valid_ms) == 0 or len(diffs) == 0:
        return None, len(valid_ms)
    return _fill(valid_ms, diffs), len(valid_ms)


def compute_hrv(
    rr: Sequence[RR],
    *,
    gap_ms: float = 3000,
    min_intervals: int = 30,
    min_ms: float = 300,
    max_ms: float = 2000,
    max_deviation: float = 0.2,
    window: int = 11,
) -> dict[str, Any]:
    """Robust HRV pipeline used for sessions, phases and baselines (SPEC ``computeHrv``).

    1. :func:`clean_rr`.
    2. Split into runs: a new run starts where ``rr[i].t − rr[i−1].t > gap_ms + rr[i].ms``
       (a data dropout).
    3. ``sdnn``/``meanRr`` pool every valid interval across runs.
    4. Successive differences use only pairs ``(i, i+1)`` that are both valid
       *and* in the same run — an invalid beat breaks a pair instead of
       joining its neighbours.
    5. ``hrv`` is ``None`` when fewer than ``min_intervals`` valid intervals or
       zero valid pairs remain.

    Returns ``{"hrv": HrvTimeDomain | None, "artifacts": ArtifactReport}``.
    """
    cleaned = clean_rr(rr, min_ms=min_ms, max_ms=max_ms, max_deviation=max_deviation, window=window)
    hrv, _ = _hrv_from_validity(rr, cleaned["valid"], range(len(rr)), gap_ms, min_intervals)
    return {"hrv": hrv, "artifacts": cleaned["report"]}


def valid_rr_ms(rr: Sequence[RR], **clean_opts: Any) -> list[float]:
    """The ``ms`` values of the intervals that :func:`clean_rr` keeps, in beat order."""
    valid = clean_rr(rr, **clean_opts)["valid"]
    return [r["ms"] for r, v in zip(rr, valid) if v]


def rolling_hrv(
    rr: Sequence[RR],
    *,
    window_ms: float = 60000,
    step_ms: float = 30000,
    start: float | None = None,
    end: float | None = None,
    min_intervals: int = 20,
    gap_ms: float = 3000,
    min_ms: float = 300,
    max_ms: float = 2000,
    max_deviation: float = 0.2,
    window: int = 11,
) -> list[dict[str, Any]]:
    """Sliding-window HRV for charts (SPEC ``rollingHrv``).

    Windows end at ``start + window_ms + k·step_ms`` for k = 0, 1, … while the
    window end is ``<= end`` (complete, equal-length windows only, because SDNN
    depends on recording length — Task Force 1996). ``start``/``end`` default
    to the first/last RR ``t``. Each window covers RR with
    ``windowEnd − window_ms <= t < windowEnd``, kept in array (beat) order.

    :func:`clean_rr` runs **once over the whole series**; each window then applies
    steps 2–5 of :func:`compute_hrv` with those validity flags (``min_intervals``
    defaults to 20 here). Each point is ``{"t": windowEnd, "rmssd", "sdnn", "meanHr", "n"}``
    where the HRV values are ``None`` when ``hrv`` is ``None`` and ``n`` is the number of
    valid intervals in the window (reported even then).

    Raises ``ValueError`` for non-positive window/step or more than
    :data:`MAX_ROLLING_HRV_WINDOWS` windows.
    """
    if not (math.isfinite(window_ms) and window_ms > 0 and math.isfinite(step_ms) and step_ms > 0):
        raise ValueError("rolling_hrv: window_ms and step_ms must be positive finite numbers")
    if len(rr) == 0:
        return []
    ts_all = [r["t"] for r in rr if is_finite_number(r["t"])]
    if not ts_all:
        return []
    t0 = min(ts_all) if start is None else start
    t1 = max(ts_all) if end is None else end
    if t0 + window_ms > t1:
        return []
    if (t1 - t0 - window_ms) / step_ms + 1 > MAX_ROLLING_HRV_WINDOWS:
        raise ValueError(f"rolling_hrv: more than {MAX_ROLLING_HRV_WINDOWS} windows requested")
    valid = clean_rr(rr, min_ms=min_ms, max_ms=max_ms, max_deviation=max_deviation, window=window)["valid"]
    # Positions ordered by t (stable): binary search per window, whatever the input order.
    order = sorted((i for i in range(len(rr)) if is_finite_number(rr[i]["t"])), key=lambda i: rr[i]["t"])
    ts = [rr[i]["t"] for i in order]
    out: list[dict[str, Any]] = []
    k = 0
    while True:
        we = t0 + window_ms + k * step_ms
        if we > t1:
            break
        ws = we - window_ms
        idx = sorted(order[bisect.bisect_left(ts, ws) : bisect.bisect_left(ts, we)])
        hrv, n_valid = _hrv_from_validity(rr, valid, idx, gap_ms, min_intervals)
        out.append(
            {
                "t": we,
                "rmssd": hrv["rmssd"] if hrv else None,
                "sdnn": hrv["sdnn"] if hrv else None,
                "meanHr": hrv["meanHr"] if hrv else None,
                "n": n_valid,
            }
        )
        k += 1
    return out


def baevsky_stress_index(intervals_ms: Sequence[float], bin_ms: float = 50) -> float | None:
    """Baevsky stress index ``SI = AMo / (2 · Mo · MxDMn)`` (SPEC ``baevskyStressIndex``).

    * histogram bins ``[floor(x/bin_ms)·bin_ms, +bin_ms)``;
    * ``Mo`` — centre of the most populated bin in **seconds** (ties → lowest bin);
    * ``AMo`` — that bin's count / n × 100 (%);
    * ``MxDMn`` — (max − min) in seconds.

    ``None`` with fewer than 30 intervals or when ``MxDMn`` is 0.
    """
    xs = [x for x in intervals_ms if is_finite_number(x)]
    n = len(xs)
    if n < 30 or bin_ms <= 0:
        return None
    counts: dict[float, int] = {}
    for x in xs:
        b = math.floor(x / bin_ms) * bin_ms
        counts[b] = counts.get(b, 0) + 1
    best_bin = None
    best_count = -1
    for b in sorted(counts):
        if counts[b] > best_count:
            best_bin, best_count = b, counts[b]
    assert best_bin is not None
    mo = (best_bin + bin_ms / 2) / 1000
    amo = best_count / n * 100
    mxdmn = (max(xs) - min(xs)) / 1000
    if mxdmn == 0 or mo <= 0:
        return None
    return amo / (2 * mo * mxdmn)


def windowed_stress_index(
    rr: Sequence[RR], valid: Sequence[bool], window_ms: float = STRESS_INDEX_WINDOW_MS
) -> float | None:
    """Median Baevsky SI over consecutive 5-min windows (SPEC ``windowedStressIndex``).

    Valid intervals with a finite ``t`` are assigned to window
    ``k = floor((t − t0)/window_ms)`` (``t0`` = first such interval's ``t``); a
    window is used when its intervals sum to ``>= 0.8·window_ms`` and
    :func:`baevsky_stress_index` of them is not ``None``. ``None`` when no window qualifies.
    """
    if not (is_finite_number(window_ms) and window_ms > 0):
        return None
    t0 = None
    windows: dict[int, list[float]] = {}
    for r, v in zip(rr, valid):
        if v is not True or not is_finite_number(r.get("t")) or not is_finite_number(r.get("ms")):
            continue
        if t0 is None:
            t0 = r["t"]
        k = math.floor((r["t"] - t0) / window_ms)
        windows.setdefault(k, []).append(r["ms"])
    values: list[float] = []
    for k in sorted(windows):
        ms = windows[k]
        total = 0.0
        for x in ms:
            total += x
        if total < 0.8 * window_ms:
            continue
        si = baevsky_stress_index(ms)
        if si is not None:
            values.append(si)
    return median(values)
