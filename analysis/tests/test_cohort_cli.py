"""Unit tests for cohort.py and cli.py."""

from __future__ import annotations

import json
import math
import os
import subprocess
import sys
from pathlib import Path

import numpy as np
import pandas as pd
import pytest

from _support import make_session
from conftest import ANALYSIS_DIR
from surgeonpulse_analysis import __version__
from surgeonpulse_analysis.cli import main
from surgeonpulse_analysis.cohort import (
    SUMMARY_CSV_COLUMNS,
    aggregate,
    cohort_report,
    learning_curve,
    phase_profile,
    summaries_frame,
    summary_row,
)
from surgeonpulse_analysis.io import parse_csv

DAY = 86_400_000
T0 = 1_767_600_000_000  # 2026-01-05T08:00Z


def synthetic_session(sid: str, code: str, k: int, delta: float, level: str = "registrar", proc: str = "Lap chole") -> dict:
    """10-minute session: 3 phases, HR = 70 + delta during 'critical', resting baseline 70."""
    t0 = T0 + k * 7 * DAY
    samples = [{"t": t0 + i * 1000, "bpm": 70 + (delta if 200 <= i < 400 else 5)} for i in range(600)]
    rr = [{"t": t0 + i * 1000, "ms": 800 + (i % 2) * 20} for i in range(600)]
    return make_session(
        id=sid,
        participantCode=code,
        startedAt=t0,
        endedAt=t0 + 600_000,
        procedure={"name": proc, "specialty": "General surgery", "approach": "laparoscopic"},
        participantSnapshot={"trainingLevel": level},
        baseline={"startedAt": t0 - 300_000, "endedAt": t0, "restingHr": 70, "source": "manual"},
        samples=samples,
        rr=rr,
        events=[
            {"id": f"{sid}-1", "t": t0, "type": "phase", "phase": "dissection"},
            {"id": f"{sid}-2", "t": t0 + 200_000, "type": "phase", "phase": "critical"},
            {"id": f"{sid}-3", "t": t0 + 400_000, "type": "phase", "phase": "closure"},
        ],
        postOp={"workload": {"instrument": "surg-tlx", "completedAt": t0,
                             "ratings": {"mental": 50, "physical": 30, "temporal": 40, "complexity": 60, "stress": 20 + delta, "distraction": 10}}},
    )  # fmt: skip


@pytest.fixture()
def bundle() -> dict:
    sessions = [synthetic_session(f"a{k}", "P-A", k, 30 - 5 * k, "resident") for k in range(4)]
    sessions += [synthetic_session(f"b{k}", "P-B", k, 10, "consultant", proc="Hernia repair") for k in range(2)]
    sessions.append(synthetic_session("c0", "P-C", 5, 12, "consultant"))
    sessions[-1].pop("participantSnapshot")
    return {"format": "surgeonpulse-export", "version": 1, "exportedAt": 0, "deidentified": False,
            "participants": [{"code": c} for c in ("P-A", "P-B", "P-C")], "sessions": sessions}  # fmt: skip


def test_summaries_frame_columns_and_values(bundle: dict) -> None:
    df = summaries_frame(bundle)
    assert list(df.columns) == list(SUMMARY_CSV_COLUMNS) and len(df) == 7
    assert str(df["started_at"].dtype) == "datetime64[ms, UTC]"
    a0 = df.iloc[0]
    assert a0["duration_min"] == 10 and a0["critical_duration_s"] == 200
    assert a0["critical_hr_mean"] == 100 and a0["critical_hr_delta"] == 30 and a0["dissection_hr_delta"] == 5
    assert a0["rmssd"] == pytest.approx(20) and a0["episode_count"] == 1
    assert math.isnan(a0["pre_op_duration_s"])  # phase absent → missing
    assert a0["workload_instrument"] == "surg-tlx" and math.isnan(a0["workload_weighted"])


def test_summary_row_duration_weights_repeated_phases() -> None:
    def ph(dur: float, mean: float | None, delta: float | None, rmssd: float | None) -> dict:
        return {"phase": "critical", "durationSec": dur, "hr": None if mean is None else {"mean": mean},
                "hrv": None if rmssd is None else {"rmssd": rmssd}, "meanHrDelta": delta}  # fmt: skip

    summary = {"sessionId": "x", "participantCode": "P", "startedAt": 0, "endedAt": 1000, "durationSec": 1,
               "quality": {"coverage": 0.5}, "episodes": [{"durationSec": 30}, {"durationSec": 60}],
               "phases": [ph(60, 100, 30, 20), ph(120, 110, 40, None), ph(0, None, None, None)],
               "rrArtifacts": {"ratio": 0.02}, "highIntensityFraction": 0.25}  # fmt: skip
    row = summary_row(summary)
    assert row["critical_duration_s"] == 180
    assert row["critical_hr_mean"] == pytest.approx((100 * 60 + 110 * 120) / 180)
    assert row["critical_hr_delta"] == pytest.approx((30 * 60 + 40 * 120) / 180)
    assert row["critical_rmssd"] == 20  # only one occurrence has HRV
    assert row["episode_minutes"] == 1.5 and row["episode_count"] == 2
    assert row["rr_artifact_pct"] == 2 and row["high_intensity_pct"] == 25 and row["coverage_pct"] == 50
    assert row["started_at"] == "1970-01-01T00:00:00.000Z"


def test_aggregate_groups_sorting_and_unspecified(bundle: dict) -> None:
    df = summaries_frame(bundle)
    by_p = aggregate(df, "criticalMeanHrDelta", "participant")
    assert by_p["group"].tolist() == ["P-A", "P-B", "P-C"]
    a = by_p.iloc[0]
    assert (a["n"], a["mean"], a["min"], a["max"], a["median"]) == (4, 22.5, 15, 30, 22.5)
    assert a["sd"] == pytest.approx(np.std([30, 25, 20, 15], ddof=1))
    assert by_p.iloc[1]["sd"] == 0  # identical values → SD 0
    by_lvl = aggregate(df, "meanHr", "trainingLevel")
    assert by_lvl["group"].tolist() == ["Unspecified", "consultant", "resident"]  # code-point order
    assert aggregate(df, "meanHr", "none")["group"].tolist() == ["All"]
    assert aggregate(df, "meanHr", "month")["group"].tolist() == ["2026-01", "2026-02"]
    wl = aggregate(df, "workload", "none")  # weighted missing → raw
    assert wl.iloc[0]["n"] == 7
    assert aggregate(df, "performance", "participant").empty  # groups without values are dropped
    with pytest.raises(KeyError):
        aggregate(df, "nope", "none")
    with pytest.raises(KeyError):
        aggregate(df, "meanHr", "nope")


def test_learning_curve(bundle: dict) -> None:
    lc = learning_curve(summaries_frame(bundle), "criticalMeanHrDelta").set_index("participant")
    assert lc.loc["P-A", "slope"] == pytest.approx(-5) and lc.loc["P-A", "r2"] == pytest.approx(1)
    assert lc.loc["P-A", "first"] == 30 and lc.loc["P-A", "last"] == 15 and lc.loc["P-A", "n"] == 4
    assert lc.loc["P-B", "slope"] == pytest.approx(0)
    assert math.isnan(lc.loc["P-C", "slope"])  # single session
    assert lc.index[-1] == "(pooled)" and lc.loc["(pooled)", "n"] == 7


def test_phase_profile(bundle: dict) -> None:
    pp = phase_profile(summaries_frame(bundle)).set_index("phase")
    assert pp.index.tolist() == ["pre-op", "incision", "dissection", "critical", "closure", "post-op"]
    assert pp.loc["pre-op", "n"] == 0 and math.isnan(pp.loc["pre-op", "hr_delta_mean"])
    assert pp.loc["critical", "n"] == 7 and pp.loc["dissection", "hr_delta_mean"] == pytest.approx(5)
    assert pp.loc["critical", "hr_delta_mean"] == pytest.approx((30 + 25 + 20 + 15 + 10 + 10 + 12) / 7)


def test_cohort_report_is_ascii(bundle: dict) -> None:
    text = cohort_report(bundle)
    text.encode("ascii")  # printable on any console code page
    assert "Sessions: 7    Participants: 3" in text and "(pooled)" in text
    assert cohort_report({"sessions": []}).endswith("No valid sessions.\n")


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


@pytest.fixture()
def export_file(tmp_path: Path, bundle: dict) -> Path:
    p = tmp_path / "export dir" / "export.json"  # space in path on purpose
    p.parent.mkdir()
    p.write_text(json.dumps(bundle), encoding="utf-8")
    return p


def test_cli_summarize_to_file(export_file: Path, tmp_path: Path) -> None:
    out = tmp_path / "out" / "summaries.csv"
    assert main(["summarize", str(export_file), "-o", str(out), "--max-hr", "190"]) == 0
    raw = out.read_bytes()
    assert raw.endswith(b"\r\n") and b"\r\r\n" not in raw
    rows = parse_csv(raw.decode("utf-8"))
    assert rows[0] == list(SUMMARY_CSV_COLUMNS) and len(rows) == 8
    assert rows[1][rows[0].index("high_intensity_pct")] == "0"


def test_cli_summarize_to_stdout(export_file: Path, capfdbinary: pytest.CaptureFixture[bytes]) -> None:
    assert main(["summarize", str(export_file)]) == 0
    out = capfdbinary.readouterr().out
    assert out.startswith(b"session_id,participant_code,") and b"\r\r\n" not in out


def test_cli_frames(export_file: Path, tmp_path: Path) -> None:
    outdir = tmp_path / "frames"
    assert main(["frames", str(export_file), "-o", str(outdir)]) == 0
    assert sorted(p.name for p in outdir.iterdir()) == ["events.csv", "participants.csv", "rr.csv", "samples.csv", "sessions.csv"]
    samples = pd.read_csv(outdir / "samples.csv")
    assert len(samples) == 7 * 600 and samples["t_iso"].iloc[0] == "2026-01-05T08:00:00.000Z"


def test_cli_report(export_file: Path, tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    assert main(["report", str(export_file), "-o", str(tmp_path / "r.txt")]) == 0
    out = capsys.readouterr().out
    assert "SurgeonPulse cohort report" in out and (tmp_path / "r.txt").read_text(encoding="utf-8") == out


def test_cli_errors(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    assert main(["summarize", str(tmp_path / "missing.json")]) == 2
    bad = tmp_path / "bad.json"
    bad.write_text("{not json", encoding="utf-8")
    assert main(["report", str(bad)]) == 1
    assert "not valid JSON" in capsys.readouterr().err


def test_python_dash_m_entry_point() -> None:
    env = dict(os.environ)
    env["PYTHONPATH"] = os.pathsep.join([str(ANALYSIS_DIR / "src"), env.get("PYTHONPATH", "")])
    res = subprocess.run(
        [sys.executable, "-m", "surgeonpulse_analysis", "--version"], capture_output=True, text=True, env=env, check=False
    )
    assert res.returncode == 0 and res.stdout.strip() == f"surgeonpulse {__version__}"
