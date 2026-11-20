"""Unit tests for hrv.py (SPEC § analytics/rr.ts) with hand-computed vectors."""

from __future__ import annotations

import math

import pytest

from surgeonpulse_analysis.hrv import (
    baevsky_stress_index,
    clean_rr,
    compute_hrv,
    hrv_time_domain,
    rolling_hrv,
    valid_rr_ms,
)


def rr_series(ms: list[float], t0: int = 0, step: int = 1000) -> list[dict[str, float]]:
    """One beat per 1-s notification."""
    return [{"t": t0 + i * step, "ms": m} for i, m in enumerate(ms)]


def test_hrv_time_domain_hand_computed() -> None:
    h = hrv_time_domain([800, 810, 790, 850])
    # mean 812.5; d = [10, −20, 60]; Σd² = 4100; deviations² sum = 2075
    assert h == {
        "n": 4,
        "pairs": 3,
        "meanRr": 812.5,
        "sdnn": pytest.approx(math.sqrt(2075 / 3)),
        "rmssd": pytest.approx(math.sqrt(4100 / 3)),
        "pnn50": pytest.approx(100 / 3),
        "meanHr": pytest.approx(60000 / 812.5),
    }
    assert hrv_time_domain([800]) is None
    assert hrv_time_domain([]) is None
    flat = hrv_time_domain([800, 800])
    assert flat is not None and flat["sdnn"] == 0 and flat["rmssd"] == 0 and flat["pnn50"] == 0


def test_clean_rr_rule1_range_and_finite() -> None:
    res = clean_rr(rr_series([250, 800, 2100, float("nan"), 300, 2000]))
    assert res["valid"] == [False, True, False, False, True, True]
    assert res["report"] == {"total": 6, "removed": 3, "ratio": 0.5}


def test_clean_rr_rule2_local_median() -> None:
    ms = [800] * 5 + [1000] + [800] * 5 + [950] + [800] * 5
    valid = clean_rr(rr_series(ms))["valid"]
    assert valid[5] is False  # |1000 − 800| / 800 = 0.25 > 0.2
    assert valid[11] is True  # |950 − 800| / 800 = 0.1875
    assert sum(valid) == len(ms) - 1


def test_clean_rr_median_uses_only_rule1_valid_neighbours_and_needs_three() -> None:
    # Index 3 (1000 ms) only has two rule-1-valid neighbours (the 800s): rule 2 is skipped.
    ms = [800, 100, 100, 1000, 100, 100, 800]
    assert clean_rr(rr_series(ms))["valid"] == [True, False, False, True, False, False, True]


def test_clean_rr_window_is_clamped_and_excludes_self() -> None:
    ms = [1000, 800, 800, 800, 800, 800]
    # window 5 → index 0 sees indices 1..2 only (2 neighbours) → rule 2 skipped
    assert clean_rr(rr_series(ms), window=5)["valid"][0] is True
    # window 7 → index 0 sees 1..3 (3 neighbours, median 800) → 0.25 deviation → invalid
    assert clean_rr(rr_series(ms), window=7)["valid"][0] is False


def test_clean_rr_empty() -> None:
    assert clean_rr([]) == {"valid": [], "report": {"total": 0, "removed": 0, "ratio": 0}}


def test_compute_hrv_pairs_within_runs_only() -> None:
    ms = [800 if i % 2 == 0 else 850 for i in range(40)]
    rr = rr_series(ms)
    h = compute_hrv(rr)["hrv"]
    assert h is not None and h["n"] == 40 and h["pairs"] == 39
    assert h["rmssd"] == 50 and h["pnn50"] == 0  # |d| > 50 is strict

    # A 10-s dropout before beat 20 (Δt > gapMs + ms) splits the run → that pair is dropped.
    dropped = [dict(r, t=r["t"] + (10000 if i >= 20 else 0)) for i, r in enumerate(rr)]
    h2 = compute_hrv(dropped)["hrv"]
    assert h2 is not None and h2["n"] == 40 and h2["pairs"] == 38
    assert h2["sdnn"] == h["sdnn"]  # SDNN pools all valid intervals across runs


def test_compute_hrv_invalid_beat_breaks_pair() -> None:
    ms = [800 if i % 2 == 0 else 850 for i in range(40)]
    ms[10] = 2500  # rule 1 → invalid; pairs (9,10) and (10,11) dropped, 9 and 11 are NOT joined
    res = compute_hrv(rr_series(ms))
    assert res["artifacts"] == {"total": 40, "removed": 1, "ratio": 1 / 40}
    h = res["hrv"]
    assert h is not None and h["n"] == 39 and h["pairs"] == 37 and h["rmssd"] == 50


def test_compute_hrv_null_rules() -> None:
    rr = rr_series([800 + (i % 3) * 10 for i in range(29)])
    assert compute_hrv(rr)["hrv"] is None  # 29 < minIntervals 30
    assert compute_hrv(rr, min_intervals=20)["hrv"] is not None
    # Every beat in its own run → 0 valid pairs → null even with enough intervals.
    isolated = [{"t": i * 10000, "ms": 800} for i in range(40)]
    assert compute_hrv(isolated)["hrv"] is None
    assert compute_hrv([]) == {"hrv": None, "artifacts": {"total": 0, "removed": 0, "ratio": 0}}


def test_rolling_hrv_windows() -> None:
    rr = rr_series([800 if i % 2 == 0 else 840 for i in range(200)], t0=5000)
    out = rolling_hrv(rr)
    # windows end at t0 + 60 s + k·30 s while ≤ last t (t0 + 199 s) → k = 0..4
    assert [w["t"] for w in out] == [5000 + 60000 + k * 30000 for k in range(5)]
    assert all(w["n"] == 60 and w["rmssd"] == 40 for w in out)
    assert rolling_hrv([]) == []
    assert rolling_hrv(rr[:50]) == []  # shorter than one window


def test_rolling_hrv_null_window_keeps_count() -> None:
    rr = rr_series([800] * 30 + [810] * 30)
    rr = [r for r in rr if not (15000 <= r["t"] < 45000)]  # sparse first windows
    out = rolling_hrv(rr, window_ms=30000, step_ms=15000)
    assert [w["t"] for w in out] == [30000, 45000]
    assert out[0]["rmssd"] is None and out[0]["sdnn"] is None and out[0]["meanHr"] is None
    assert out[0]["n"] == 15  # 15 valid intervals in [0, 30 s) < minIntervals 20, still reported


def test_baevsky_hand_computed() -> None:
    xs = [800] * 20 + [900] * 10
    # Mo = 0.825 s (bin [800, 850)), AMo = 66.67 %, MxDMn = 0.1 s
    assert baevsky_stress_index(xs) == pytest.approx((20 / 30 * 100) / (2 * 0.825 * 0.1))
    tie = [800] * 15 + [900] * 15
    assert baevsky_stress_index(tie) == pytest.approx(50 / (2 * 0.825 * 0.1))  # ties → lowest bin
    assert baevsky_stress_index(xs, 100) == pytest.approx((20 / 30 * 100) / (2 * 0.85 * 0.1))
    assert baevsky_stress_index([800] * 29 + [900]) is not None
    assert baevsky_stress_index([800] * 29) is None  # n < 30
    assert baevsky_stress_index([800] * 40) is None  # MxDMn = 0


def test_valid_rr_ms() -> None:
    assert valid_rr_ms(rr_series([800, 250, 810])) == [800, 810]
