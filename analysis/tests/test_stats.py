"""Unit tests for stats.py (SPEC § analytics/stats.ts and § analytics/hr.ts) with hand-computed vectors."""

from __future__ import annotations

import math
import random

import numpy as np
import pytest

from surgeonpulse_analysis.stats import (
    detect_gaps,
    hr_stats,
    is_valid_bpm,
    js_round,
    linear_trend,
    mean,
    median,
    moving_average,
    naive_sum,
    pearson_correlation,
    percentile,
    sample_sd,
    slice_by_time,
)


def test_mean_median_sd_basic() -> None:
    assert mean([1, 2, 3, 4]) == 2.5
    assert mean([]) is None
    assert median([3, 1, 2]) == 2
    assert median([4, 1, 3, 2]) == 2.5
    assert median([]) is None
    # Σ(x − 5)² = 32 for this classic vector → sd = sqrt(32/7)
    assert sample_sd([2, 4, 4, 4, 5, 5, 7, 9]) == pytest.approx(math.sqrt(32 / 7), rel=1e-15)
    assert sample_sd([5]) == 0
    assert sample_sd([]) is None


def test_naive_sum_is_left_to_right() -> None:
    xs = [1e16, 1.0, -1e16]
    # A JavaScript reduce gives 0 here; compensated summation (math.fsum, Python>=3.12 sum) gives 1.
    assert naive_sum(xs) == 0.0
    assert math.fsum(xs) == 1.0


def test_percentile_hand_values() -> None:
    assert percentile([1, 2, 3, 4], 50) == 2.5
    assert percentile([10, 20], 95) == pytest.approx(19.5)
    assert percentile([60, 70, 80], 95) == pytest.approx(79.0)  # rank 1.9 → 70 + 0.9·10
    assert percentile([5, 1, 9], 0) == 1
    assert percentile([5, 1, 9], 100) == 9
    assert percentile([], 50) is None
    assert percentile([1, 2], float("nan")) is None
    assert percentile([1, 2], 150) == 2  # clamped to [0, 100]


@pytest.mark.parametrize("seed", range(5))
def test_percentile_matches_numpy_linear(seed: int) -> None:
    rng = random.Random(seed)
    xs = [rng.uniform(40, 180) for _ in range(rng.randint(1, 60))]
    for p in (0, 1, 2.5, 33.3, 50, 90, 95, 99.9, 100):
        assert percentile(xs, p) == pytest.approx(float(np.percentile(xs, p)), rel=1e-12, abs=1e-12)


def test_linear_trend() -> None:
    fit = linear_trend([(1, 2), (2, 4), (3, 6)])
    assert fit == {"slope": 2.0, "intercept": 0.0, "r2": 1.0, "n": 3}
    fit = linear_trend([{"x": 1, "y": 10}, {"x": 2, "y": 8.5}, {"x": 3, "y": 9}, {"x": 4, "y": 6}, {"x": 5, "y": 5.5}])
    # x̄=3, ȳ=7.8, Sxy=−11.5, Sxx=10, Syy=15.3 → slope −1.15, r² = 132.25/153
    assert fit["slope"] == pytest.approx(-1.15)
    assert fit["intercept"] == pytest.approx(7.8 + 1.15 * 3)
    assert fit["r2"] == pytest.approx(132.25 / 153)
    assert linear_trend([(1, 2)]) is None
    assert linear_trend([(1, 2), (1, 5)]) is None  # var(x) = 0
    assert linear_trend([(1, 3), (2, 3), (3, 3)]) == {"slope": 0.0, "intercept": 3.0, "r2": 0.0, "n": 3}


def test_pearson() -> None:
    assert pearson_correlation([1, 2, 3], [2, 4, 6]) == pytest.approx(1.0)
    assert pearson_correlation([1, 2, 3], [3, 2, 1]) == pytest.approx(-1.0)
    assert pearson_correlation([1, 1, 1], [1, 2, 3]) is None


def test_moving_average_trailing_partial() -> None:
    assert moving_average([1, 2, 3, 4], 2) == [1, 1.5, 2.5, 3.5]
    assert moving_average([3, 6, 9], 5) == [3, 4.5, 6]
    assert moving_average([], 3) == []


def test_js_round_halves_up() -> None:
    assert [js_round(x) for x in (0.5, 1.5, 2.5, -0.5, -1.5, 176.5, 0.49999999999999994)] == [1, 2, 3, 0, -1, 177, 0]
    assert round(176.5) == 176  # why js_round exists


def test_is_valid_bpm() -> None:
    assert is_valid_bpm(25) and is_valid_bpm(250) and is_valid_bpm(72.5)
    for bad in (24.9, 250.1, float("nan"), float("inf"), None, "70", True):
        assert not is_valid_bpm(bad)


def test_hr_stats_ignores_invalid() -> None:
    samples = [{"t": i, "bpm": b} for i, b in enumerate([60, 20, 70, 260, float("nan"), 80])]
    hs = hr_stats(samples)
    assert hs == {"count": 3, "mean": 70.0, "median": 70, "min": 60, "max": 80, "sd": 10.0, "p95": pytest.approx(79.0)}
    assert hr_stats([]) is None
    assert hr_stats([{"t": 0, "bpm": 300}]) is None
    single = hr_stats([{"t": 0, "bpm": 77}])
    assert single is not None and single["sd"] == 0 and single["p95"] == 77


def test_slice_by_time_half_open() -> None:
    xs = [{"t": t} for t in (0, 1000, 2000, 3000)]
    assert [x["t"] for x in slice_by_time(xs, 1000, 3000)] == [1000, 2000]


def test_detect_gaps() -> None:
    samples = [{"t": t, "bpm": 70} for t in (0, 1000, 7000, 8000, 13000, 19001)]
    assert detect_gaps(samples, 5000) == [
        {"start": 1000, "end": 7000, "durationMs": 6000},
        {"start": 13000, "end": 19001, "durationMs": 6001},
    ]  # 8000 → 13000 is exactly 5000 ms: not a gap
    assert detect_gaps([], 5000) == []
