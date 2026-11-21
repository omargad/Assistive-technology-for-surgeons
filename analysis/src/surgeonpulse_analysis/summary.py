"""Per-session summary: the numbers behind the feedback and research dashboards.

Python port of ``analytics/baseline.ts`` and ``analytics/summary.ts``
(SPEC.md § analytics/baseline.ts, § analytics/summary.ts). Output dicts use the
same camelCase keys as the TypeScript ``SessionSummary`` so the two
implementations can be compared field by field (see ``tests/test_parity.py``).
Optional keys that are ``undefined`` in TypeScript are *omitted* here too.
"""

from __future__ import annotations

import math
from datetime import datetime, timedelta, timezone
from typing import Any, Mapping

from .episodes import default_episode_threshold, detect_stress_episodes
from .hrv import MAX_HRV_ARTIFACT_RATIO, clean_rr, compute_hrv, windowed_stress_index
from .phases import MARKER_KINDS, derive_phases, session_end
from .stats import (
    detect_gaps,
    hr_stats,
    is_finite_number,
    is_valid_bpm,
    is_valid_sample,
    median,
    robust_peak_hr,
    slice_by_time,
)
from .tlx import score_workload
from .zones import estimate_max_hr, time_in_zones, zone_dwells, zones_from_baseline, zones_from_max_hr

__all__ = [
    "compute_baseline",
    "data_quality",
    "summarize_session",
    "utc_year",
    "effective_max_gap_ms",
    "is_synthetic_session",
    "DEFAULT_MAX_GAP_MS",
    "MIN_PHASE_HRV_SEC",
    "ANALYTICS_VERSION",
]

DEFAULT_MAX_GAP_MS = 5000
#: Shortest phase (s) whose HRV is reported (SPEC ``MIN_PHASE_HRV_SEC``).
MIN_PHASE_HRV_SEC = 60
#: Must equal the TypeScript ``ANALYTICS_VERSION`` (checked by the parity fixtures).
ANALYTICS_VERSION = "2"
_MAX_HEALTH_STORE_GAP_MS = 900_000
_SYNTHETIC_TAGS = ("simulated", "demo")
_EPOCH = datetime(1970, 1, 1, tzinfo=timezone.utc)


def utc_year(epoch_ms: float) -> int:
    """UTC calendar year of an epoch-ms timestamp (portable: no ``fromtimestamp``, works for negatives on Windows)."""
    return (_EPOCH + timedelta(milliseconds=epoch_ms)).year


def compute_baseline(samples, rr, start: float, end: float) -> dict[str, Any] | None:
    """Resting baseline from data in ``[start, end)`` (SPEC ``computeBaseline``).

    ``restingHr`` is the :func:`~surgeonpulse_analysis.stats.hr_stats` mean
    (``None`` result without HR). ``rmssd``/``sdnn`` come from
    :func:`~surgeonpulse_analysis.hrv.compute_hrv` with ``min_intervals=20`` and are
    omitted when that returns ``None`` or when the window's artefact ratio exceeds
    ``MAX_HRV_ARTIFACT_RATIO``. ``source`` is ``"measured"``.
    """
    hr = hr_stats(slice_by_time(samples, start, end))
    if hr is None:
        return None
    out: dict[str, Any] = {"startedAt": start, "endedAt": end, "restingHr": hr["mean"], "source": "measured"}
    res = compute_hrv(slice_by_time(rr, start, end), min_intervals=20)
    hrv = res["hrv"]
    if hrv is not None and res["artifacts"]["ratio"] <= MAX_HRV_ARTIFACT_RATIO:
        out["rmssd"] = hrv["rmssd"]
        out["sdnn"] = hrv["sdnn"]
    return out


def effective_max_gap_ms(session: Mapping[str, Any], max_gap_ms: float | None = None) -> float:
    """Gap rule when no ``max_gap_ms`` is given (SPEC ``effectiveMaxGapMs``).

    An explicit number (not NaN) is used as given. Otherwise 5000 ms, except for
    ``healthkit``/``health-connect`` sessions: ``1.5 ×`` the median spacing of
    consecutive valid samples, clamped to [5000 ms, 15 min].
    """
    if max_gap_ms is not None and not (isinstance(max_gap_ms, float) and math.isnan(max_gap_ms)):
        return max_gap_ms
    source = (session.get("sensor") or {}).get("source")
    if source not in ("healthkit", "health-connect"):
        return DEFAULT_MAX_GAP_MS
    ts = sorted(s["t"] for s in (session.get("samples") or []) if is_valid_sample(s) and is_finite_number(s.get("t")))
    spacing = [b - a for a, b in zip(ts, ts[1:]) if b > a]
    m = median(spacing)
    if m is None:
        return DEFAULT_MAX_GAP_MS
    return min(_MAX_HEALTH_STORE_GAP_MS, max(DEFAULT_MAX_GAP_MS, 1.5 * m))


def is_synthetic_session(session: Mapping[str, Any]) -> bool:
    """Sensor source ``simulated``, or a ``simulated``/``demo`` tag (SPEC ``isSyntheticSession``)."""
    if (session.get("sensor") or {}).get("source") == "simulated":
        return True
    return any(t in _SYNTHETIC_TAGS for t in (session.get("tags") or []))


def data_quality(session: Mapping[str, Any], max_gap_ms: float | None = None) -> dict[str, Any]:
    """Signal coverage and quality (SPEC ``dataQuality``).

    ``max_gap_ms`` defaults to :func:`effective_max_gap_ms`.

    * ``coverage = min(1, covered/duration)`` where covered time is the sum of
      ``min(t[i+1] − t[i], max_gap_ms)`` between consecutive valid samples (valid
      bpm and not ``contact: false``),
      each piece clipped to ``[startedAt, sessionEnd]``; 0 when duration <= 0.
    * ``gapCount``/``longestGapSec`` from ``detect_gaps(samples, max_gap_ms)``.
    * ``sampleRateHz = max(0, inWindow − 1)/(covered/1000)`` when covered > 0, else 0,
      where ``inWindow`` counts valid samples with ``startedAt <= t <= sessionEnd``.
    * ``rrArtifactRatio`` from :func:`clean_rr`, ``None`` without RR data.
    """
    max_gap_ms = effective_max_gap_ms(session, max_gap_ms)
    start = session["startedAt"]
    end = session_end(session)
    duration = end - start
    samples = session.get("samples") or []
    valid = sorted((s for s in samples if is_valid_sample(s)), key=lambda s: s["t"])
    in_window = sum(1 for s in valid if start <= s["t"] <= end)
    covered: float = 0
    for a, b in zip(valid, valid[1:]):
        lo = max(a["t"], start)
        hi = min(a["t"] + min(b["t"] - a["t"], max_gap_ms), end)
        if hi > lo:
            covered += hi - lo
    gaps = detect_gaps(samples, max_gap_ms)
    rr = session.get("rr") or []
    return {
        "coverage": 0 if duration <= 0 else min(1, covered / duration),
        "gapCount": len(gaps),
        "longestGapSec": max((g["durationMs"] for g in gaps), default=0) / 1000,
        "rrArtifactRatio": clean_rr(rr)["report"]["ratio"] if rr else None,
        "sampleRateHz": max(0, in_window - 1) / (covered / 1000) if covered > 0 else 0,
    }


def _resolve_baseline(session: Mapping[str, Any]) -> dict[str, Any] | None:
    """Session baseline, else a profile baseline; a restingHr that is not a valid bpm counts as missing."""
    base = session.get("baseline")
    if base is not None and is_valid_bpm(base.get("restingHr")):
        return dict(base)
    snap = session.get("participantSnapshot") or {}
    if is_valid_bpm(snap.get("restingHr")):
        return {
            "source": "profile",
            "restingHr": snap["restingHr"],
            "startedAt": session["startedAt"],
            "endedAt": session["startedAt"],
        }
    return None


def _resolve_max_hr(session: Mapping[str, Any], max_hr: float | None, at_year: int | None) -> float | None:
    """Option → snapshot ``maxHr`` → Tanaka estimate; each used only when it is a valid bpm (25–250)."""
    if is_valid_bpm(max_hr):
        return max_hr
    snap = session.get("participantSnapshot") or {}
    if is_valid_bpm(snap.get("maxHr")):
        return snap["maxHr"]
    if snap.get("birthYear") is not None:
        year = at_year if at_year is not None else utc_year(session["startedAt"])
        est = estimate_max_hr(snap["birthYear"], year)
        return est if is_valid_bpm(est) else None
    return None


def summarize_session(
    session: Mapping[str, Any],
    *,
    max_hr: float | None = None,
    at_year: int | None = None,
    episode_threshold_bpm: float | None = None,
    max_gap_ms: float | None = None,
) -> dict[str, Any]:
    """Summarise one session (SPEC ``summarizeSession``) → ``SessionSummary`` dict.

    Keyword options mirror the TypeScript ``SummaryOptions`` (``maxHr``,
    ``atYear``, ``episodeThresholdBpm``, ``maxGapMs``).

    * ``baseline``: the session baseline, else a ``source: "profile"`` baseline
      from ``participantSnapshot.restingHr``, else ``None`` (a restingHr that is
      not a valid bpm, e.g. 0, counts as missing).
    * ``maxHr``: option → snapshot ``maxHr`` → Tanaka estimate from
      ``birthYear`` (at ``at_year`` or the UTC year of ``startedAt``) → ``None``;
      each candidate is used only when it is a valid bpm (25–250).
    * ``zones``: baseline zones if a baseline exists, else %HRmax zones, else ``[]``.
    * ``highIntensityFraction``: time-weighted fraction with ``bpm >= 0.7·maxHr``
      (``None`` without maxHr, or when there is no dwell time at all).
    * ``phases``: per-segment HR stats, HRV (``min_intervals=20``) and HR delta.
    * ``episodes``: threshold = option or :func:`default_episode_threshold`.
    """
    gap = effective_max_gap_ms(session, max_gap_ms)
    samples = session.get("samples") or []
    rr = session.get("rr") or []
    events = session.get("events") or []
    procedure = session.get("procedure") or {}
    snap = session.get("participantSnapshot") or {}
    started = session["startedAt"]
    ended = session_end(session)

    hr = hr_stats(samples)
    cleaned = clean_rr(rr)
    artifacts = cleaned["report"]
    rr_usable = artifacts["ratio"] <= MAX_HRV_ARTIFACT_RATIO
    hrv = compute_hrv(rr)["hrv"] if rr_usable else None
    stress_index = windowed_stress_index(rr, cleaned["valid"]) if rr_usable else None
    peak_hr = robust_peak_hr(samples)
    baseline = _resolve_baseline(session)
    resting = baseline["restingHr"] if baseline is not None else None
    mhr = _resolve_max_hr(session, max_hr, at_year)

    if baseline is not None:
        zone_defs = zones_from_baseline(resting)
    elif mhr is not None:
        zone_defs = zones_from_max_hr(mhr)
    else:
        zone_defs = []

    high_fraction = None
    if mhr is not None:
        dwells = zone_dwells(samples, gap)
        total = 0.0
        high = 0.0
        for bpm, d in dwells:
            total += d
            if bpm >= 0.7 * mhr:
                high += d
        # SPEC only defines null "without maxHr"; with zero dwell time the fraction is 0/0, so we
        # follow the ground rule "not enough data → null" (same as the TypeScript implementation).
        high_fraction = high / total if total > 0 else None

    segments = derive_phases(session)
    phases = []
    for seg in segments:
        phr = hr_stats(slice_by_time(samples, seg["start"], seg["end"]))
        duration_sec = (seg["end"] - seg["start"]) / 1000
        phrv = None
        if duration_sec >= MIN_PHASE_HRV_SEC:
            pres = compute_hrv(slice_by_time(rr, seg["start"], seg["end"]), min_intervals=20)
            if pres["artifacts"]["ratio"] <= MAX_HRV_ARTIFACT_RATIO:
                phrv = pres["hrv"]
        phases.append(
            {
                **seg,
                "durationSec": duration_sec,
                "hr": phr,
                "hrv": phrv,
                "meanHrDelta": (phr["mean"] - resting) if (phr is not None and resting is not None) else None,
            }
        )

    threshold = episode_threshold_bpm if episode_threshold_bpm is not None else default_episode_threshold(baseline, hr)
    episodes = (
        detect_stress_episodes(samples, threshold, max_sample_gap_ms=gap, segments=segments, events=events)
        if threshold is not None
        else []
    )

    marker_counts: dict[str, int] = {}
    for kind in MARKER_KINDS:
        c = sum(1 for e in events if e.get("type") == "marker" and e.get("marker") == kind)
        if c > 0:
            marker_counts[kind] = c

    post_op = session.get("postOp") or {}
    out: dict[str, Any] = {
        "sessionId": session["id"],
        "participantCode": session["participantCode"],
        "procedureName": procedure.get("name", ""),
    }
    for key in ("specialty", "approach", "role", "urgency", "complexity"):
        if procedure.get(key) is not None:
            out[key] = procedure[key]
    if snap.get("trainingLevel") is not None:
        out["trainingLevel"] = snap["trainingLevel"]
    out.update(
        {
            "startedAt": started,
            "endedAt": ended,
            "durationSec": (ended - started) / 1000,
            "hr": hr,
            "hrv": hrv,
            "rrArtifacts": artifacts if rr else None,
            "stressIndex": stress_index,
            "baseline": baseline,
            "meanHrDelta": (hr["mean"] - resting) if (hr is not None and resting is not None) else None,
            "peakHrDelta": (peak_hr - resting) if (peak_hr is not None and resting is not None) else None,
            "maxHr": mhr,
            "zones": time_in_zones(samples, zone_defs, gap),
            "highIntensityFraction": high_fraction,
            "phases": phases,
            "episodes": episodes,
            "markerCounts": marker_counts,
            "workload": score_workload(post_op["workload"]) if post_op.get("workload") is not None else None,
            "performance": post_op.get("performance"),
            "perceivedStress": post_op.get("perceivedStress"),
            "quality": data_quality(session, gap),
            "peakHr": peak_hr,
            "sensorSource": (session.get("sensor") or {}).get("source"),
            "simulated": is_synthetic_session(session),
        }
    )
    if is_finite_number(session.get("tzOffsetMin")):
        out["tzOffsetMin"] = session["tzOffsetMin"]
    out.update(
        {
            "sleepHours": post_op.get("sleepHours"),
            "caffeine": post_op.get("caffeine"),
            "outcome": post_op.get("outcome"),
            "maxGapMs": gap,
            "analyticsVersion": ANALYTICS_VERSION,
        }
    )
    return out
