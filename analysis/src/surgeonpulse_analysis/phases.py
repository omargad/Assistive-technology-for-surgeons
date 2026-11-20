"""Operative phase segmentation.

Python port of ``analytics/phases.ts`` (SPEC.md § analytics/phases.ts).
"""

from __future__ import annotations

from typing import Any, Mapping, Sequence

__all__ = ["PHASE_ORDER", "MARKER_KINDS", "session_end", "derive_phases", "phase_at"]

#: Canonical phase order (``types.ts`` ``PHASE_ORDER``).
PHASE_ORDER: tuple[str, ...] = ("pre-op", "incision", "dissection", "critical", "closure", "post-op")
#: Marker kinds (``types.ts`` ``MARKER_KINDS``).
MARKER_KINDS: tuple[str, ...] = ("complication", "interruption", "equipment", "teaching", "takeover", "note")


def session_end(session: Mapping[str, Any]) -> float:
    """``endedAt``; else the max of the last sample / RR / event ``t``; else ``startedAt``."""
    ended = session.get("endedAt")
    if ended is not None:
        return ended
    lasts = [arr[-1]["t"] for arr in (session.get("samples") or [], session.get("rr") or [], session.get("events") or []) if arr]
    if lasts:
        return max(lasts)
    return session["startedAt"]


def derive_phases(session: Mapping[str, Any]) -> list[dict[str, Any]]:
    """Phase segments from ``type == "phase"`` events (SPEC ``derivePhases``).

    Events are stably sorted by ``t`` and clamped to ``[startedAt, sessionEnd]``.
    A consecutive event repeating the previous phase is ignored (the first is
    kept). Each segment runs from its event to the next kept event (or to
    ``sessionEnd``). Zero-length segments are dropped, except a final segment
    ending exactly at ``sessionEnd``. Time before the first phase event is not
    a segment. Returns ``[{"phase", "index", "start", "end"}, ...]``.
    """
    start = session["startedAt"]
    end = session_end(session)
    events = sorted((e for e in session.get("events") or [] if e.get("type") == "phase"), key=lambda e: e["t"])
    kept: list[tuple[str, float]] = []
    for e in events:
        t = min(max(e["t"], start), end)
        if kept and kept[-1][0] == e["phase"]:
            continue
        kept.append((e["phase"], t))
    segments: list[dict[str, Any]] = []
    for i, (phase, t) in enumerate(kept):
        is_last = i == len(kept) - 1
        seg_end = end if is_last else kept[i + 1][1]
        if seg_end - t <= 0 and not (is_last and seg_end == end):
            continue
        segments.append({"phase": phase, "index": len(segments), "start": t, "end": seg_end})
    return segments


def phase_at(segments: Sequence[Mapping[str, Any]], t: float) -> str | None:
    """Phase in progress at ``t``: ``start <= t < end``; ``t`` equal to the last end → last phase."""
    for seg in segments:
        if seg["start"] <= t < seg["end"]:
            return seg["phase"]
    if segments and t == segments[-1]["end"]:
        return segments[-1]["phase"]
    return None
