"""Per-session summary: the numbers behind the feedback and research dashboards.

Python port of ``analytics/baseline.ts`` and ``analytics/summary.ts``
(SPEC.md § analytics/baseline.ts, § analytics/summary.ts). Output dicts use the
same camelCase keys as the TypeScript ``SessionSummary`` so the two
implementations can be compared field by field (see ``tests/test_parity.py``).
Optional keys that are ``undefined`` in TypeScript are *omitted* here too.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any, Mapping

from .episodes import default_episode_threshold, detect_stress_episodes
from .hrv import baevsky_stress_index, clean_rr, compute_hrv
from .phases import MARKER_KINDS, derive_phases, session_end
from .stats import detect_gaps, hr_stats, is_valid_bpm, slice_by_time
from .tlx import score_workload
from .zones import estimate_max_hr, time_in_zones, zone_dwells, zones_from_baseline, zones_from_max_hr

__all__ = ["compute_baseline", "data_quality", "summarize_session", "utc_year", "DEFAULT_MAX_GAP_MS"]

DEFAULT_MAX_GAP_MS = 5000
_EPOCH = datetime(1970, 1, 1, tzinfo=timezone.utc)


def utc_year(epoch_ms: float) -> int:
    """UTC calendar year of an epoch-ms timestamp (portable: no ``fromtimestamp``, works for negatives on Windows)."""
    return (_EPOCH + timedelta(milliseconds=epoch_ms)).year


def compute_baseline(samples, rr, start: float, end: float) -> dict[str, Any] | None:
    """Resting baseline from data in ``[start, end)`` (SPEC ``computeBaseline``).

    ``restingHr`` is the :func:`~surgeonpulse_analysis.stats.hr_stats` mean
    (``None`` result without HR). ``rmssd``/``sdnn`` come from
    :func:`~surgeonpulse_analysis.hrv.compute_hrv` with ``min_intervals=20`` and are
    omitted when that returns ``None``. ``source`` is ``"measured"``.
    """
    hr = hr_stats(slice_by_time(samples, start, end))
    if hr is None:
        return None
    out: dict[str, Any] = {"startedAt": start, "endedAt": end, "restingHr": hr["mean"], "source": "measured"}
    hrv = compute_hrv(slice_by_time(rr, start, end), min_intervals=20)["hrv"]
    if hrv is not None:
        out["rmssd"] = hrv["rmssd"]
        out["sdnn"] = hrv["sdnn"]
    return out


def data_quality(session: Mapping[str, Any], max_gap_ms: float = DEFAULT_MAX_GAP_MS) -> dict[str, Any]:
    """Signal coverage and quality (SPEC ``dataQuality``).

    * ``coverage = min(1, covered/duration)`` where covered time is the sum of
      ``min(t[i+1] − t[i], max_gap_ms)`` between consecutive valid samples,
      each piece clipped to ``[startedAt, sessionEnd]``; 0 when duration <= 0.
    * ``gapCount``/``longestGapSec`` from ``detect_gaps(samples, max_gap_ms)``.
    * ``sampleRateHz = (validCount − 1)/(covered/1000)`` when covered > 0, else 0.
    * ``rrArtifactRatio`` from :func:`clean_rr`, ``None`` without RR data.
    """
    start = session["startedAt"]
    end = session_end(session)
    duration = end - start
    samples = session.get("samples") or []
    valid = sorted((s for s in samples if is_valid_bpm(s.get("bpm"))), key=lambda s: s["t"])
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
        "sampleRateHz": (len(valid) - 1) / (covered / 1000) if covered > 0 else 0,
    }


def _resolve_baseline(session: Mapping[str, Any]) -> dict[str, Any] | None:
    if session.get("baseline") is not None:
        return dict(session["baseline"])
    snap = session.get("participantSnapshot") or {}
    if snap.get("restingHr") is not None:
        return {
            "source": "profile",
            "restingHr": snap["restingHr"],
            "startedAt": session["startedAt"],
            "endedAt": session["startedAt"],
        }
    return None


def _resolve_max_hr(session: Mapping[str, Any], max_hr: float | None, at_year: int | None) -> float | None:
    if max_hr is not None:
        return max_hr
    snap = session.get("participantSnapshot") or {}
    if snap.get("maxHr") is not None:
        return snap["maxHr"]
    if snap.get("birthYear") is not None:
        year = at_year if at_year is not None else utc_year(session["startedAt"])
        return estimate_max_hr(snap["birthYear"], year)
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
      from ``participantSnapshot.restingHr``, else ``None``.
    * ``maxHr``: option → snapshot ``maxHr`` → Tanaka estimate from
      ``birthYear`` (at ``at_year`` or the UTC year of ``startedAt``) → ``None``.
    * ``zones``: baseline zones if a baseline exists, else %HRmax zones, else ``[]``.
    * ``highIntensityFraction``: time-weighted fraction with ``bpm >= 0.7·maxHr``
      (``None`` without maxHr, or when there is no dwell time at all).
    * ``phases``: per-segment HR stats, HRV (``min_intervals=20``) and HR delta.
    * ``episodes``: threshold = option or :func:`default_episode_threshold`.
    """
    gap = DEFAULT_MAX_GAP_MS if max_gap_ms is None else max_gap_ms
    samples = session.get("samples") or []
    rr = session.get("rr") or []
    events = session.get("events") or []
    procedure = session.get("procedure") or {}
    snap = session.get("participantSnapshot") or {}
    started = session["startedAt"]
    ended = session_end(session)

    hr = hr_stats(samples)
    cleaned = clean_rr(rr)
    hrv_res = compute_hrv(rr)
    valid_ms = [r["ms"] for r, v in zip(rr, cleaned["valid"]) if v]
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
        phrv = compute_hrv(slice_by_time(rr, seg["start"], seg["end"]), min_intervals=20)["hrv"]
        phases.append(
            {
                **seg,
                "durationSec": (seg["end"] - seg["start"]) / 1000,
                "hr": phr,
                "hrv": phrv,
                "meanHrDelta": (phr["mean"] - resting) if (phr is not None and resting is not None) else None,
            }
        )

    threshold = episode_threshold_bpm if episode_threshold_bpm is not None else default_episode_threshold(baseline, hr)
    episodes = (
        detect_stress_episodes(samples, threshold, segments=segments, events=events) if threshold is not None else []
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
            "hrv": hrv_res["hrv"],
            "rrArtifacts": hrv_res["artifacts"] if rr else None,
            "stressIndex": baevsky_stress_index(valid_ms),
            "baseline": baseline,
            "meanHrDelta": (hr["mean"] - resting) if (hr is not None and resting is not None) else None,
            "peakHrDelta": (hr["max"] - resting) if (hr is not None and resting is not None) else None,
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
        }
    )
    return out
