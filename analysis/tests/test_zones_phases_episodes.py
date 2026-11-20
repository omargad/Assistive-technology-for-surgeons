"""Unit tests for zones.py, phases.py and episodes.py (SPEC § zones, § phases, § episodes)."""

from __future__ import annotations

import math

import pytest

from _support import make_session
from surgeonpulse_analysis.episodes import default_episode_threshold, detect_stress_episodes
from surgeonpulse_analysis.phases import derive_phases, phase_at, session_end
from surgeonpulse_analysis.zones import estimate_max_hr, time_in_zones, zones_from_baseline, zones_from_max_hr

# ---------------------------------------------------------------------------
# zones
# ---------------------------------------------------------------------------


def test_estimate_max_hr_tanaka() -> None:
    assert estimate_max_hr(1996, 2026) == 187  # 208 − 21
    assert estimate_max_hr(1986, 2026) == 180  # 208 − 28
    assert estimate_max_hr(2026, 2026) == 208
    assert estimate_max_hr(1980, 2026) == 176  # 208 − 32.2 = 175.8


def test_zones_from_max_hr() -> None:
    zs = zones_from_max_hr(200)
    assert [z["id"] for z in zs] == ["z1", "z2", "z3", "z4", "z5"]
    assert [z["label"] for z in zs] == ["Very light", "Light", "Moderate", "Hard", "Maximum"]
    assert [z["minBpm"] for z in zs] == [0, 120, 140, 160, 180]
    assert [z["maxBpm"] for z in zs] == [120, 140, 160, 180, math.inf]
    assert zones_from_max_hr(183)[2]["minBpm"] == 183 * 0.7  # not rounded


def test_zones_from_baseline() -> None:
    zs = zones_from_baseline(70)
    assert [(z["id"], z["label"], z["minBpm"], z["maxBpm"]) for z in zs] == [
        ("rest", "At rest", 0, 80),
        ("elevated", "Elevated", 80, 90),
        ("high", "High", 90, 100),
        ("very-high", "Very high", 100, math.inf),
    ]


def test_time_in_zones_dwell_rule() -> None:
    samples = [
        {"t": 11000, "bpm": 75},  # unsorted on purpose
        {"t": 0, "bpm": 75},
        {"t": 500, "bpm": 300},  # invalid → ignored
        {"t": 1000, "bpm": 85},
        {"t": 2000, "bpm": 95},
        {"t": 10000, "bpm": 105},
    ]
    # dwells: 1000, 1000, min(8000, 5000), 1000, last = median(1000, 1000, 5000, 1000) = 1000
    out = time_in_zones(samples, zones_from_baseline(70))
    assert [(z["id"], z["seconds"]) for z in out] == [("rest", 2), ("elevated", 1), ("high", 5), ("very-high", 1)]
    assert [z["fraction"] for z in out] == pytest.approx([2 / 9, 1 / 9, 5 / 9, 1 / 9])
    capped = time_in_zones(samples, zones_from_baseline(70), max_gap_ms=500)
    assert sum(z["seconds"] for z in capped) == pytest.approx(2.5)


def test_time_in_zones_degenerate() -> None:
    one = time_in_zones([{"t": 0, "bpm": 80}], zones_from_baseline(60))
    assert all(z["seconds"] == 0 and z["fraction"] == 0 for z in one) and len(one) == 4
    assert time_in_zones([], []) == []


# ---------------------------------------------------------------------------
# phases
# ---------------------------------------------------------------------------


def _ev(i: int, t: int, phase: str | None = None, marker: str | None = None) -> dict:
    e = {"id": f"e{i}", "t": t}
    e.update({"type": "phase", "phase": phase} if phase else {"type": "marker", "marker": marker})
    return e


def test_session_end_fallbacks() -> None:
    assert session_end(make_session(endedAt=5000)) == 5000
    s = make_session(samples=[{"t": 1_002_000, "bpm": 70}], rr=[{"t": 1_009_000, "ms": 800}], events=[_ev(1, 1_004_000, "pre-op")])
    assert session_end(s) == 1_009_000
    assert session_end(make_session()) == 1_000_000


def test_derive_phases_rules() -> None:
    t0 = 1_000_000
    s = make_session(
        startedAt=t0,
        endedAt=t0 + 100_000,
        events=[
            _ev(0, t0 - 5_000, "pre-op"),  # clamped to startedAt
            _ev(1, t0 + 10_000, "pre-op"),  # same phase again → ignored
            _ev(2, t0 + 20_000, "incision"),
            _ev(3, t0 + 25_000, marker="complication"),  # markers are not phases
            _ev(4, t0 + 30_000, "dissection"),  # zero-length → dropped
            _ev(5, t0 + 30_000, "critical"),
            _ev(6, t0 + 90_000, "closure"),
            _ev(7, t0 + 120_000, "post-op"),  # after the end → clamped → final zero-length kept
        ],
    )
    segs = derive_phases(s)
    assert [(g["phase"], g["index"], g["start"] - t0, g["end"] - t0) for g in segs] == [
        ("pre-op", 0, 0, 20_000),
        ("incision", 1, 20_000, 30_000),
        ("critical", 2, 30_000, 90_000),
        ("closure", 3, 90_000, 100_000),
        ("post-op", 4, 100_000, 100_000),
    ]
    assert phase_at(segs, t0 + 20_000) == "incision"  # start inclusive
    assert phase_at(segs, t0 + 29_999) == "incision"
    assert phase_at(segs, t0 + 100_000) == "post-op"  # t == last end → last phase
    assert phase_at(segs, t0 - 1) is None
    assert phase_at([], t0) is None


def test_time_before_first_phase_is_not_a_segment() -> None:
    s = make_session(endedAt=1_060_000, events=[_ev(0, 1_010_000, "dissection")])
    segs = derive_phases(s)
    assert [(g["start"], g["end"]) for g in segs] == [(1_010_000, 1_060_000)]
    assert phase_at(segs, 1_005_000) is None
    assert derive_phases(make_session(endedAt=1_060_000)) == []


# ---------------------------------------------------------------------------
# episodes
# ---------------------------------------------------------------------------


def test_default_episode_threshold() -> None:
    assert default_episode_threshold({"restingHr": 70}, {"median": 99}) == 90
    assert default_episode_threshold(None, {"median": 80}) == 95
    assert default_episode_threshold(None, None) is None


def _episode_samples() -> list[dict]:
    s: list[dict] = []
    s += [{"t": sec * 1000, "bpm": 105} for sec in range(0, 70)]  # run A (69 s)
    s += [{"t": sec * 1000, "bpm": 90} for sec in range(70, 90)]  # 20 s dip → merges with B
    s += [{"t": sec * 1000, "bpm": 110} for sec in range(90, 100)]  # run B, peak 110 first at 90 s
    s += [{"t": sec * 1000, "bpm": 80} for sec in range(100, 200)]
    s += [{"t": sec * 1000, "bpm": 120} for sec in range(200, 231)]  # run C, 30 s → too short
    s += [{"t": sec * 1000, "bpm": 80} for sec in range(231, 300)]
    s += [{"t": sec * 1000, "bpm": 101} for sec in range(300, 321)]  # run D1
    s += [{"t": sec * 1000, "bpm": 101} for sec in range(327, 401)]  # 6-s gap → run D2
    s += [{"t": 50_500, "bpm": 300}, {"t": 50_700, "bpm": 0}]  # invalid: ignored, do not break run A
    return s


def test_detect_stress_episodes_runs_merge_and_duration() -> None:
    segs = [
        {"phase": "dissection", "index": 0, "start": 0, "end": 95_000},
        {"phase": "critical", "index": 1, "start": 95_000, "end": 1_000_000},
    ]
    events = [
        {"id": "far", "t": -130_000, "type": "marker", "marker": "note"},
        {"id": "edge", "t": -120_000, "type": "marker", "marker": "interruption"},
        {"id": "end", "t": 99_000, "type": "marker", "marker": "complication"},
        {"id": "after", "t": 99_001, "type": "marker", "marker": "note"},
    ]
    eps = detect_stress_episodes(_episode_samples(), 100, segments=segs, events=events)
    assert len(eps) == 2
    a, d = eps
    assert (a["start"], a["end"], a["durationSec"]) == (0, 99_000, 99)
    assert (a["peakBpm"], a["peakT"]) == (110, 90_000)
    assert a["meanBpm"] == pytest.approx((70 * 105 + 10 * 110) / 80)
    assert a["phase"] == "dissection"
    assert a["relatedEventIds"] == ["edge", "end"]
    assert (d["start"], d["end"], d["peakT"], d["phase"]) == (300_000, 400_000, 300_000, "critical")

    no_merge = detect_stress_episodes(_episode_samples(), 100, merge_gap_ms=0, min_duration_ms=60_000)
    assert [(e["start"], e["end"]) for e in no_merge] == [(0, 69_000), (327_000, 400_000)]
    assert all("phase" not in e for e in no_merge)  # no segments → key omitted
    assert detect_stress_episodes([], 100) == []
