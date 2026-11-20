"""Unit tests for tlx.py and summary.py (SPEC § instruments/tlx.ts, § baseline, § summary)."""

from __future__ import annotations

import pytest

from _support import find_non_finite, make_session
from surgeonpulse_analysis.summary import compute_baseline, data_quality, summarize_session, utc_year
from surgeonpulse_analysis.tlx import NASA_TLX_DIMENSIONS, SURG_TLX_DIMENSIONS, score_workload, tlx_pairs

R6 = {"mental": 70, "physical": 35, "temporal": 60, "complexity": 65, "stress": 80, "distraction": 25}
W6 = {"mental": 4, "physical": 1, "temporal": 2, "complexity": 3, "stress": 5, "distraction": 0}


def test_tlx_dimensions_and_pairs() -> None:
    assert [d["label"] for d in SURG_TLX_DIMENSIONS] == [
        "Mental Demands", "Physical Demands", "Temporal Demands",
        "Task Complexity", "Situational Stress", "Distractions",
    ]  # fmt: skip
    assert len(NASA_TLX_DIMENSIONS) == 6
    pairs = tlx_pairs("surg-tlx")
    assert len(pairs) == 15 and len(set(pairs)) == 15 and pairs[0] == ("mental", "physical")
    assert all(a != b for a, b in pairs)


def test_score_workload_raw_and_weighted() -> None:
    s = score_workload({"instrument": "surg-tlx", "ratings": R6, "weights": W6, "completedAt": 0})
    assert s["instrument"] == "surg-tlx"
    assert s["raw"] == pytest.approx(335 / 6)
    assert s["weighted"] == pytest.approx(1030 / 15)  # Σ rating·weight = 1030
    assert s["dimensions"] == R6
    assert score_workload({"instrument": "surg-tlx", "ratings": R6, "completedAt": 0})["weighted"] is None


def test_score_workload_clamps() -> None:
    s = score_workload({"instrument": "surg-tlx", "ratings": {**R6, "mental": 120, "distraction": -10}, "completedAt": 0})
    assert s["dimensions"]["mental"] == 100 and s["dimensions"]["distraction"] == 0
    assert s["raw"] == pytest.approx((100 + 35 + 60 + 65 + 80 + 0) / 6)


@pytest.mark.parametrize(
    "weights",
    [
        {k: 2.5 for k in R6},  # not integers
        {**W6, "mental": 6, "stress": 3},  # > 5
        {**W6, "stress": 4},  # sums to 14
        {k: v for k, v in W6.items() if k != "distraction"},  # missing one
    ],
)
def test_score_workload_invalid_weights(weights: dict) -> None:
    assert score_workload({"instrument": "surg-tlx", "ratings": R6, "weights": weights, "completedAt": 0})["weighted"] is None


def test_score_workload_nasa() -> None:
    n6 = {"mental": 55, "physical": 10, "temporal": 40, "performance": 20, "effort": 50, "frustration": 15}
    w = {"mental": 5, "physical": 0, "temporal": 3, "performance": 2, "effort": 4, "frustration": 1}
    s = score_workload({"instrument": "nasa-tlx", "ratings": n6, "weights": w, "completedAt": 0})
    assert s["raw"] == pytest.approx(190 / 6)
    assert s["weighted"] == pytest.approx((275 + 120 + 40 + 200 + 15) / 15)


# ---------------------------------------------------------------------------
# baseline / data quality / summary
# ---------------------------------------------------------------------------


def test_compute_baseline() -> None:
    samples = [{"t": t * 1000, "bpm": 60 + (t % 3)} for t in range(300)]
    rr = [{"t": t * 1000, "ms": 1000 if t % 2 else 980} for t in range(300)]
    b = compute_baseline(samples, rr, 0, 60_000)
    assert b is not None and b["source"] == "measured" and (b["startedAt"], b["endedAt"]) == (0, 60_000)
    assert b["restingHr"] == pytest.approx(61) and b["rmssd"] == pytest.approx(20)
    no_rr = compute_baseline(samples, rr[:10], 0, 60_000)
    assert no_rr is not None and "rmssd" not in no_rr and "sdnn" not in no_rr
    assert compute_baseline([], rr, 0, 60_000) is None


def test_data_quality_hand_computed() -> None:
    s = make_session(
        startedAt=0,
        endedAt=10_000,
        samples=[{"t": t, "bpm": 70} for t in (0, 1000, 2000, 9000, 10_000)] + [{"t": 5000, "bpm": 10}],
    )
    s["samples"].sort(key=lambda x: x["t"])
    q = data_quality(s)
    # covered = 1000 + 1000 + min(7000, 5000) + 1000 = 8000; the invalid sample at 5 s is not a sample here,
    # but detectGaps sees all samples: 2000 → 5000 → 9000 has no gap > 5000 ms.
    assert q == {"coverage": 0.8, "gapCount": 0, "longestGapSec": 0, "rrArtifactRatio": None, "sampleRateHz": 0.5}
    s2 = make_session(startedAt=0, endedAt=10_000, samples=[{"t": t, "bpm": 70} for t in (0, 1000, 2000, 9000, 10_000)])
    assert data_quality(s2)["gapCount"] == 1 and data_quality(s2)["longestGapSec"] == 7


def test_data_quality_clips_to_window_and_zero_duration() -> None:
    s = make_session(startedAt=0, endedAt=4000, samples=[{"t": t, "bpm": 70} for t in (-3000, -2000, 0, 2000, 6000)])
    q = data_quality(s)
    assert q["coverage"] == pytest.approx(4000 / 4000)  # [-3,-2] and [-2,0] clipped away; [0,2]+[2,4] counted
    empty = data_quality(make_session(startedAt=0, endedAt=0))
    assert empty == {"coverage": 0, "gapCount": 0, "longestGapSec": 0, "rrArtifactRatio": None, "sampleRateHz": 0}


def test_utc_year_is_portable() -> None:
    assert utc_year(0) == 1970 and utc_year(-1) == 1969 and utc_year(1767225599999) == 2025


def _profile_session(**kw):
    t0 = 1_767_600_000_000
    samples = [{"t": t0 + i * 1000, "bpm": 70 + (20 if 60 <= i < 200 else 0)} for i in range(300)]
    events = [
        {"id": "p1", "t": t0, "type": "phase", "phase": "pre-op"},
        {"id": "p2", "t": t0 + 60_000, "type": "phase", "phase": "critical"},
        {"id": "m1", "t": t0 + 70_000, "type": "marker", "marker": "complication"},
        {"id": "m2", "t": t0 + 80_000, "type": "marker", "marker": "complication"},
        {"id": "m3", "t": t0 + 90_000, "type": "marker", "marker": "note"},
    ]
    return make_session(startedAt=t0, endedAt=t0 + 300_000, samples=samples, events=events, **kw)


def test_summarize_profile_baseline_and_maxhr_precedence() -> None:
    s = _profile_session(participantSnapshot={"restingHr": 65, "birthYear": 1986, "trainingLevel": "resident"})
    out = summarize_session(s)
    assert out["baseline"] == {"source": "profile", "restingHr": 65, "startedAt": s["startedAt"], "endedAt": s["startedAt"]}
    assert out["maxHr"] == 180  # Tanaka at the UTC year of startedAt (2026)
    assert summarize_session(s, at_year=2036)["maxHr"] == 173  # 208 − 0.7·50
    assert summarize_session(s, max_hr=150)["maxHr"] == 150
    assert summarize_session({**s, "participantSnapshot": {"maxHr": 190, "birthYear": 1986}})["maxHr"] == 190
    assert [z["id"] for z in out["zones"]] == ["rest", "elevated", "high", "very-high"]
    assert out["trainingLevel"] == "resident"
    assert out["meanHrDelta"] == pytest.approx(out["hr"]["mean"] - 65)
    assert out["peakHrDelta"] == 25
    assert out["markerCounts"] == {"complication": 2, "note": 1}
    crit = out["phases"][1]
    # critical = [60 s, 300 s): 140 samples at 90 bpm + 100 at 70 bpm
    assert crit["phase"] == "critical" and crit["durationSec"] == 240
    assert crit["hr"]["mean"] == pytest.approx(19600 / 240) and crit["meanHrDelta"] == pytest.approx(19600 / 240 - 65)
    # threshold = 65 + 20 = 85 → one 139-s episode in the critical phase
    assert [(e["durationSec"], e["phase"], e["relatedEventIds"]) for e in out["episodes"]] == [
        (139, "critical", ["p1", "p2", "m1", "m2", "m3"])
    ]
    assert summarize_session(s, episode_threshold_bpm=95)["episodes"] == []


def test_summarize_high_intensity_fraction() -> None:
    s = _profile_session(participantSnapshot={"maxHr": 125})  # 0.7·125 = 87.5 → the 90-bpm block
    out = summarize_session(s)
    assert out["highIntensityFraction"] == pytest.approx(140 / 300)
    assert [z["id"] for z in out["zones"]] == ["z1", "z2", "z3", "z4", "z5"]
    assert summarize_session(_profile_session())["highIntensityFraction"] is None  # no maxHr


def test_summarize_empty_session_has_only_nulls_no_nan() -> None:
    s = make_session(endedAt=1_000_000, participantSnapshot={"maxHr": 190})
    out = summarize_session(s)
    assert find_non_finite(out) == []
    for key in ("hr", "hrv", "rrArtifacts", "stressIndex", "baseline", "meanHrDelta", "peakHrDelta",
                "highIntensityFraction", "workload", "performance", "perceivedStress"):  # fmt: skip
        assert out[key] is None, key
    assert out["zones"] and all(z["seconds"] == 0 for z in out["zones"])
    assert out["phases"] == [] and out["episodes"] == [] and out["markerCounts"] == {}
    assert out["durationSec"] == 0 and out["quality"]["coverage"] == 0
    assert "specialty" not in out and "trainingLevel" not in out  # undefined → omitted


def test_summarize_copies_procedure_and_post_op() -> None:
    s = _profile_session(
        procedure={"name": "Lap chole", "specialty": "General surgery", "approach": "laparoscopic", "role": "primary", "complexity": 2, "urgency": "elective"},
        postOp={"workload": {"instrument": "surg-tlx", "ratings": R6, "weights": W6, "completedAt": 0}, "performance": 7, "perceivedStress": 4},
    )
    out = summarize_session(s)
    assert {k: out[k] for k in ("procedureName", "specialty", "approach", "role", "complexity", "urgency")} == {
        "procedureName": "Lap chole", "specialty": "General surgery", "approach": "laparoscopic",
        "role": "primary", "complexity": 2, "urgency": "elective",
    }  # fmt: skip
    assert out["workload"]["weighted"] == pytest.approx(1030 / 15)
    assert (out["performance"], out["perceivedStress"]) == (7, 4)


def test_summary_invalid_resting_and_max_hr_count_as_missing() -> None:
    samples = [{"t": i * 1000, "bpm": 70 + (i % 40)} for i in range(120)]
    s = make_session(
        startedAt=0, endedAt=120000, samples=samples, participantSnapshot={"restingHr": 0, "maxHr": 0, "birthYear": 1980}
    )
    out = summarize_session(s, at_year=2026)
    assert out["baseline"] is None
    assert out["maxHr"] == 176


def test_data_quality_rate_counts_in_window_samples_only() -> None:
    s = make_session(startedAt=20000, endedAt=80000, samples=[{"t": i * 1000, "bpm": 70} for i in range(101)])
    assert data_quality(s)["sampleRateHz"] == 1


def test_summary_nan_max_gap_is_finite() -> None:
    samples = [{"t": i * 1000, "bpm": 70 + (i % 40)} for i in range(120)]
    s = make_session(startedAt=0, endedAt=120000, samples=samples, participantSnapshot={"maxHr": 190})
    assert not find_non_finite(summarize_session(s, max_gap_ms=float("nan")))
