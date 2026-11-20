"""Stress-episode detection.

Python port of ``analytics/episodes.ts`` (SPEC.md § analytics/episodes.ts).
"""

from __future__ import annotations

from typing import Any, Mapping, Sequence

from .phases import phase_at
from .stats import is_valid_bpm, naive_sum

__all__ = ["default_episode_threshold", "detect_stress_episodes", "RUN_GAP_MS", "RELATED_EVENT_LOOKBACK_MS"]

#: A run of above-threshold samples breaks on a data gap longer than this.
RUN_GAP_MS = 5000
#: Events up to 2 min before an episode start are "related" to it.
RELATED_EVENT_LOOKBACK_MS = 120000


def default_episode_threshold(
    baseline: Mapping[str, Any] | None,
    hr: Mapping[str, Any] | None,
) -> float | None:
    """``baseline.restingHr + 20`` when a baseline exists, else ``hr.median + 15``, else ``None``."""
    if baseline is not None:
        return baseline["restingHr"] + 20
    if hr is not None:
        return hr["median"] + 15
    return None


def detect_stress_episodes(
    samples: Sequence[Mapping[str, Any]],
    threshold_bpm: float,
    *,
    min_duration_ms: float = 60000,
    merge_gap_ms: float = 30000,
    segments: Sequence[Mapping[str, Any]] | None = None,
    events: Sequence[Mapping[str, Any]] | None = None,
) -> list[dict[str, Any]]:
    """Sustained periods of heart rate at or above ``threshold_bpm`` (SPEC ``detectStressEpisodes``).

    1. Maximal runs of consecutive valid samples with ``bpm >= threshold``; a run
       breaks on a below-threshold sample or a data gap > 5000 ms. Run start/end
       are its first/last sample ``t``.
    2. Runs separated by ``<= merge_gap_ms`` (earlier end → later start) merge.
    3. Merged episodes with ``end − start >= min_duration_ms`` are kept.
    4. ``peakBpm``/``peakT``: max of the episode's above-threshold samples (first
       occurrence wins); ``meanBpm``: their mean; ``phase``: :func:`phase_at`
       at ``peakT`` (key omitted when unknown); ``relatedEventIds``: ids of
       events with ``start − 120000 <= t <= end`` in time order.
    """
    valid = sorted((s for s in samples if is_valid_bpm(s.get("bpm"))), key=lambda s: s["t"])
    runs: list[list[Mapping[str, Any]]] = []
    current: list[Mapping[str, Any]] | None = None
    prev_t: float | None = None
    for s in valid:
        above = s["bpm"] >= threshold_bpm
        if current is not None and (not above or (prev_t is not None and s["t"] - prev_t > RUN_GAP_MS)):
            runs.append(current)
            current = None
        if above:
            if current is None:
                current = [s]
            else:
                current.append(s)
        prev_t = s["t"]
    if current is not None:
        runs.append(current)

    merged: list[list[Mapping[str, Any]]] = []
    for run in runs:
        if merged and run[0]["t"] - merged[-1][-1]["t"] <= merge_gap_ms:
            merged[-1] = merged[-1] + run
        else:
            merged.append(list(run))

    sorted_events = sorted(events or [], key=lambda e: e["t"])
    out: list[dict[str, Any]] = []
    for ep in merged:
        start, end = ep[0]["t"], ep[-1]["t"]
        if end - start < min_duration_ms:
            continue
        peak = ep[0]
        for s in ep[1:]:
            if s["bpm"] > peak["bpm"]:
                peak = s
        episode: dict[str, Any] = {
            "start": start,
            "end": end,
            "durationSec": (end - start) / 1000,
            "peakBpm": peak["bpm"],
            "peakT": peak["t"],
            "meanBpm": naive_sum(s["bpm"] for s in ep) / len(ep),
        }
        phase = phase_at(segments, peak["t"]) if segments else None
        if phase is not None:
            episode["phase"] = phase
        episode["relatedEventIds"] = [
            e["id"] for e in sorted_events if start - RELATED_EVENT_LOOKBACK_MS <= e["t"] <= end
        ]
        out.append(episode)
    return out
