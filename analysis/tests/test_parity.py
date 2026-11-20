"""TypeScript ↔ Python parity on the shared fixtures in ``/fixtures``.

The fixtures (inputs and expected outputs) are produced by
``packages/core/scripts/generate-fixtures.ts`` from the public API of
``@surgeonpulse/core``. Here every expected value is recomputed with the
independent Python implementation (written from SPEC.md, not from the
TypeScript source) and compared field by field: exact for counts, ids,
timestamps and strings; ``rtol=1e-9, atol=1e-6`` for other numbers.

When a mismatch is traced to the TypeScript side violating SPEC.md, add the
check id to ``TS_DISCREPANCIES`` below with a reason: the check is then marked
``xfail(strict=True)``, so the suite stays green and starts failing (as a
reminder to remove the mark) once TypeScript is fixed.
"""

from __future__ import annotations

import math
import re
from functools import lru_cache
from pathlib import Path
from typing import Any, Callable

import pytest

from _support import csv_diff, find_non_finite, read_json, read_text_exact, tree_diff
from conftest import FIXTURES
from surgeonpulse_analysis import (
    aggregate,
    baevsky_stress_index,
    clean_rr,
    compute_baseline,
    compute_hrv,
    data_quality,
    derive_phases,
    detect_gaps,
    detect_stress_episodes,
    estimate_max_hr,
    frames_to_csv,
    hr_stats,
    hrv_time_domain,
    linear_trend,
    load_export,
    mean,
    median,
    moving_average,
    parse_csv,
    parse_import,
    parse_session,
    percentile,
    rolling_hrv,
    sample_sd,
    score_workload,
    session_end,
    sessions_to_frames,
    summaries_frame,
    summaries_to_csv,
    summarize_bundle,
    summarize_session,
    time_in_zones,
    zones_from_baseline,
    zones_from_max_hr,
)

MANIFEST_PATH = FIXTURES / "manifest.json"
MANIFEST: dict[str, Any] = read_json(MANIFEST_PATH) if MANIFEST_PATH.is_file() else {"sessions": []}
SESSION_NAMES = [fx["name"] for fx in MANIFEST["sessions"]]

pytestmark = pytest.mark.skipif(not MANIFEST_PATH.is_file(), reason="fixtures not generated")

#: check id → reason. Checks listed here are expected to fail because the TypeScript
#: implementation contradicts SPEC.md (see the discrepancy report). Empty = full parity.
TS_DISCREPANCIES: dict[str, str] = {}


def _param(check_id: str, *values: Any) -> Any:
    marks = []
    if check_id in TS_DISCREPANCIES:
        marks.append(pytest.mark.xfail(strict=True, reason=f"TS discrepancy: {TS_DISCREPANCIES[check_id]}"))
    return pytest.param(*values, id=check_id, marks=marks)


def snake(opts: dict[str, Any]) -> dict[str, Any]:
    """camelCase TypeScript option names → snake_case Python keyword arguments."""
    return {re.sub(r"(?<!^)(?=[A-Z])", "_", k).lower(): v for k, v in opts.items()}


@lru_cache(maxsize=None)
def _fixture(name: str) -> dict[str, Any]:
    return next(fx for fx in MANIFEST["sessions"] if fx["name"] == name)


@lru_cache(maxsize=None)
def _session(name: str) -> dict[str, Any]:
    return parse_session(read_json(FIXTURES / _fixture(name)["session"]))


def _expected(name: str, kind: str) -> Any:
    return read_json(FIXTURES / _fixture(name)["expected"][kind])


def _assert_same(py: Any, ts: Any) -> None:
    diffs = tree_diff(py, ts)
    assert not diffs, f"{len(diffs)} difference(s):\n" + "\n".join(diffs[:25])


# ---------------------------------------------------------------------------
# Session summaries
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("name", [_param(f"{n}:summary", n) for n in SESSION_NAMES])
def test_summary(name: str) -> None:
    fx = _fixture(name)
    py = summarize_session(_session(name), **snake(fx["summaryOptions"]))
    assert not find_non_finite(py)
    _assert_same(py, _expected(name, "summary"))


# ---------------------------------------------------------------------------
# HRV pipeline (computeHrv, cleanRr, rollingHrv, Baevsky)
# ---------------------------------------------------------------------------

_ROLL_CUSTOM = snake(MANIFEST.get("rollingHrvCustomOptions", {}))


def _valid_ms(s: dict[str, Any]) -> list[float]:
    valid = clean_rr(s["rr"])["valid"]
    return [r["ms"] for r, v in zip(s["rr"], valid) if v]


HRV_CHECKS: dict[str, Callable[[dict[str, Any]], Any]] = {
    "computeHrv": lambda s: compute_hrv(s["rr"]),
    "computeHrvMin20": lambda s: compute_hrv(s["rr"], min_intervals=20),
    "cleanRrValid": lambda s: clean_rr(s["rr"])["valid"],
    "cleanRrReport": lambda s: clean_rr(s["rr"])["report"],
    "hrvTimeDomainValid": lambda s: hrv_time_domain(_valid_ms(s)),
    "baevskyStressIndex": lambda s: baevsky_stress_index(_valid_ms(s)),
    "rollingHrv": lambda s: rolling_hrv(s["rr"]),
    "rollingHrvCustom": lambda s: rolling_hrv(s["rr"], **_ROLL_CUSTOM),
}


@pytest.mark.parametrize(
    "name,check", [_param(f"{n}:hrv.{c}", n, c) for n in SESSION_NAMES for c in HRV_CHECKS]
)
def test_hrv(name: str, check: str) -> None:
    _assert_same(HRV_CHECKS[check](_session(name)), _expected(name, "hrv")[check])


# ---------------------------------------------------------------------------
# Individual analytics functions with non-default options
# ---------------------------------------------------------------------------

_SPEC = MANIFEST.get("extrasSpec", {})


def _threshold(s: dict[str, Any]) -> float:
    hr = hr_stats(s["samples"])
    return hr["median"] + 5 if hr else 90


def _ctx(s: dict[str, Any]) -> dict[str, Any]:
    return {"segments": derive_phases(s), "events": s["events"]}


EXTRA_CHECKS: dict[str, Callable[[dict[str, Any]], Any]] = {
    "sessionEnd": session_end,
    "derivePhases": derive_phases,
    "hrStats": lambda s: hr_stats(s["samples"]),
    "percentiles": lambda s: [
        {"p": p, "value": percentile([x["bpm"] for x in s["samples"]], p)} for p in (0, 5, 33.3, 50, 95, 99.9, 100)
    ],
    "detectGaps2000": lambda s: detect_gaps(s["samples"], 2000),
    "dataQuality2000": lambda s: data_quality(s, 2000),
    "timeInZonesMaxHr185Gap3000": lambda s: time_in_zones(s["samples"], zones_from_max_hr(185), 3000),
    "timeInZonesBaseline65": lambda s: time_in_zones(s["samples"], zones_from_baseline(65)),
    "episodeThreshold": _threshold,
    "episodesNoMerge": lambda s: detect_stress_episodes(
        s["samples"], _threshold(s), min_duration_ms=0, merge_gap_ms=0, **_ctx(s)
    ),
    "episodesLongMerge": lambda s: detect_stress_episodes(
        s["samples"], _threshold(s), min_duration_ms=20000, merge_gap_ms=60000, **_ctx(s)
    ),
    "episodesNoContext": lambda s: detect_stress_episodes(s["samples"], _threshold(s)),
    "computeBaselineFirst5Min": lambda s: compute_baseline(s["samples"], s["rr"], s["startedAt"], s["startedAt"] + 300000),
    "cleanRrCustom": lambda s: clean_rr(s["rr"], **snake(_SPEC.get("cleanRrCustom", {}))),
    "computeHrvCustom": lambda s: compute_hrv(s["rr"], **snake(_SPEC.get("computeHrvCustom", {}))),
    "baevskyBin25": lambda s: baevsky_stress_index(_valid_ms(s), 25),
    "baevskyBin100": lambda s: baevsky_stress_index(_valid_ms(s), 100),
}


@pytest.mark.parametrize(
    "name,check", [_param(f"{n}:extras.{c}", n, c) for n in SESSION_NAMES for c in EXTRA_CHECKS]
)
def test_extras(name: str, check: str) -> None:
    _assert_same(EXTRA_CHECKS[check](_session(name)), _expected(name, "extras")[check])


# ---------------------------------------------------------------------------
# CSV exports (samplesToCsv / rrToCsv / eventsToCsv / summariesToCsv)
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "name,kind",
    [_param(f"{n}:csv.{k}", n, k) for n in SESSION_NAMES for k in ("samples", "rr", "events")],
)
def test_frames_csv_byte_identical(name: str, kind: str) -> None:
    """Python's tidy-frame CSVs are byte-for-byte the app's CSV exports (incl. CRLF)."""
    py = frames_to_csv(sessions_to_frames(_session(name)))[kind]
    ts = read_text_exact(FIXTURES / _fixture(name)["expected"][f"{kind}Csv"])
    if py != ts:
        diffs = csv_diff(parse_csv(py), parse_csv(ts))
        pytest.fail("CSV text differs:\n" + "\n".join(diffs[:25] or ["(line endings / quoting only)"]))


@pytest.mark.parametrize("dummy", [_param("sessions:summariesCsv", 0)])
def test_sessions_summaries_csv(dummy: int) -> None:
    sums = [summarize_session(_session(n), **snake(_fixture(n)["summaryOptions"])) for n in SESSION_NAMES]
    py = parse_csv(summaries_to_csv(sums))
    ts = parse_csv(read_text_exact(FIXTURES / MANIFEST["sessionsSummariesCsv"]))
    diffs = csv_diff(py, ts)
    assert not diffs, "\n".join(diffs[:25])


# ---------------------------------------------------------------------------
# Cohort bundle
# ---------------------------------------------------------------------------


@pytest.fixture(scope="module")
def cohort_bundle() -> dict[str, Any]:
    return load_export(FIXTURES / MANIFEST["cohort"]["bundle"])


@pytest.fixture(scope="module")
def cohort_summaries(cohort_bundle: dict[str, Any]) -> list[dict[str, Any]]:
    return summarize_bundle(cohort_bundle, **snake(MANIFEST["cohort"]["summaryOptions"]))


def test_cohort_bundle_loads(cohort_bundle: dict[str, Any]) -> None:
    opts = MANIFEST["cohort"]["simulateCohort"]
    assert len(cohort_bundle["sessions"]) == opts["participants"] * opts["sessionsPerParticipant"]
    assert {p["code"] for p in cohort_bundle["participants"]} >= {s["participantCode"] for s in cohort_bundle["sessions"]}


@pytest.mark.parametrize("dummy", [_param("cohort:summariesJson", 0)])
def test_cohort_summaries_json(dummy: int, cohort_summaries: list[dict[str, Any]]) -> None:
    _assert_same(cohort_summaries, read_json(FIXTURES / MANIFEST["cohort"]["expected"]["summariesJson"]))


@pytest.mark.parametrize("dummy", [_param("cohort:summariesCsv", 0)])
def test_cohort_summaries_csv(dummy: int, cohort_bundle: dict[str, Any]) -> None:
    py = parse_csv(summaries_to_csv(cohort_bundle))
    ts = parse_csv(read_text_exact(FIXTURES / MANIFEST["cohort"]["expected"]["summariesCsv"]))
    diffs = csv_diff(py, ts)
    assert not diffs, "\n".join(diffs[:25])


def test_cohort_summaries_frame_columns(cohort_bundle: dict[str, Any]) -> None:
    ts_header = parse_csv(read_text_exact(FIXTURES / MANIFEST["cohort"]["expected"]["summariesCsv"]))[0]
    df = summaries_frame(cohort_bundle)
    assert list(df.columns) == ts_header
    assert str(df["started_at"].dtype) == "datetime64[ms, UTC]"


_AGGS = read_json(FIXTURES / MANIFEST["cohort"]["expected"]["aggregates"]) if MANIFEST.get("cohort") else []


@pytest.mark.parametrize(
    "idx", [_param(f"cohort:aggregate.{a['metric']}-by-{a['groupBy']}", i) for i, a in enumerate(_AGGS)]
)
def test_cohort_aggregate(idx: int, cohort_bundle: dict[str, Any]) -> None:
    spec = _AGGS[idx]
    py = aggregate(summaries_frame(cohort_bundle), spec["metric"], spec["groupBy"]).to_dict("records")
    _assert_same(py, spec["result"])


# ---------------------------------------------------------------------------
# parseImport behaviour (bundle / list / single session, invalid sessions skipped)
# ---------------------------------------------------------------------------

_ISSUE = re.compile(r"sessions\[(\d+)\]: ([^:;]+):")


@pytest.mark.parametrize("idx", [_param(f"import:{c['name']}", i) for i, c in enumerate(MANIFEST.get("imports", []))])
def test_parse_import(idx: int) -> None:
    case = MANIFEST["imports"][idx]
    bundle, warns = parse_import(read_text_exact(FIXTURES / case["input"]))
    ts = read_json(FIXTURES / case["expected"])
    assert [s["id"] for s in bundle["sessions"]] == ts["sessionIds"]
    assert [p["code"] for p in bundle["participants"]] == ts["participantCodes"]
    assert bundle["deidentified"] == ts["deidentified"]
    assert [[x["t"] for x in s["samples"]] for s in bundle["sessions"]] == ts["firstSampleTimes"]
    assert len(warns) == ts["warningCount"]
    # Same skipped index and the same offending field path (message wording differs: zod vs Python).
    assert [_ISSUE.search(w).groups() for w in warns] == [_ISSUE.search(w).groups() for w in ts["warnings"]]


# ---------------------------------------------------------------------------
# Small vectors for the pure helpers
# ---------------------------------------------------------------------------

_MISC = read_json(FIXTURES / MANIFEST["misc"]) if MANIFEST.get("misc") else {}


def _zones_json(zs: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [{**z, "maxBpm": "Infinity" if z["maxBpm"] == math.inf else z["maxBpm"]} for z in zs]


MISC_CHECKS: dict[str, Callable[[dict[str, Any]], Any]] = {
    "stats": lambda c: {
        "xs": c["xs"],
        "mean": mean(c["xs"]),
        "median": median(c["xs"]),
        "sampleSd": sample_sd(c["xs"]),
        "percentiles": [{"p": p["p"], "value": percentile(c["xs"], p["p"])} for p in c["percentiles"]],
        "movingAverage3": moving_average(c["xs"], 3),
    },
    "linearTrend": lambda c: {"points": c["points"], "fit": linear_trend(c["points"])},
    "estimateMaxHr": lambda c: {**c, "maxHr": estimate_max_hr(c["birthYear"], c["atYear"])},
    "zonesFromMaxHr": lambda c: {"maxHr": c["maxHr"], "zones": _zones_json(zones_from_max_hr(c["maxHr"]))},
    "zonesFromBaseline": lambda c: {"restingHr": c["restingHr"], "zones": _zones_json(zones_from_baseline(c["restingHr"]))},
    "scoreWorkload": lambda c: {"input": c["input"], "output": score_workload(c["input"])},
    "hrvTimeDomain": lambda c: {"xs": c["xs"], "hrv": hrv_time_domain(c["xs"])},
}


@pytest.mark.parametrize(
    "group,idx",
    [_param(f"misc:{g}[{i}]", g, i) for g in MISC_CHECKS for i in range(len(_MISC.get(g, [])))],
)
def test_misc_vectors(group: str, idx: int) -> None:
    case = _MISC[group][idx]
    _assert_same(MISC_CHECKS[group](case), case)


# ---------------------------------------------------------------------------
# Spec ground rule: never NaN / Infinity in outputs
# ---------------------------------------------------------------------------


def test_typescript_outputs_are_finite() -> None:
    """The generator records any NaN/±Infinity it saw in TypeScript outputs (SPEC ground rule)."""
    assert MANIFEST.get("nonFiniteOutputs", {}) == {}


def test_fixtures_are_small(fixtures_dir: Path) -> None:
    total = sum(p.stat().st_size for p in fixtures_dir.rglob("*") if p.is_file())
    assert total < 15_000_000
