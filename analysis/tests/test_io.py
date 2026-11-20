"""Unit tests for io.py: import/validation, JS-compatible formatting, CSV, tidy frames, portability."""

from __future__ import annotations

import json
import warnings
from pathlib import Path

import pytest

from _support import make_session
from surgeonpulse_analysis.io import (
    EVENTS_CSV_COLUMNS,
    RR_CSV_COLUMNS,
    SAMPLES_CSV_COLUMNS,
    ExportWarning,
    SessionParseError,
    frames_to_csv,
    iso_utc,
    js_number_str,
    load_export,
    migrate_session,
    parse_csv,
    parse_import,
    parse_session,
    sessions_to_frames,
    to_csv,
    write_text,
)


@pytest.mark.parametrize(
    "value,expected",
    [
        (0, "0"), (-0.0, "0"), (1.0, "1"), (72, "72"), (0.1, "0.1"), (-2.5, "-2.5"),
        (1 / 3, "0.3333333333333333"), (104.69999999999993, "104.69999999999993"),
        (1e-6, "0.000001"), (1.5e-6, "0.0000015"), (1e-7, "1e-7"), (1.5e-7, "1.5e-7"),
        (123456789.123, "123456789.123"), (1e20, "100000000000000000000"),
        (1e21, "1e+21"), (1.5e21, "1.5e+21"), (2**53, "9007199254740992"), (2**60, "1152921504606847000"),
        (5e-324, "5e-324"), (1.7976931348623157e308, "1.7976931348623157e+308"),
        (float("inf"), ""), (float("nan"), ""),
    ],
)  # fmt: skip
def test_js_number_str_matches_javascript(value: float, expected: str) -> None:
    assert js_number_str(value) == expected


def test_iso_utc_matches_to_iso_string() -> None:
    assert iso_utc(0) == "1970-01-01T00:00:00.000Z"
    assert iso_utc(1767600000000) == "2026-01-05T08:00:00.000Z"
    assert iso_utc(1767600000123) == "2026-01-05T08:00:00.123Z"
    assert iso_utc(-1) == "1969-12-31T23:59:59.999Z"  # negative epochs work on Windows too
    assert iso_utc(-62135596800000) == "0001-01-01T00:00:00.000Z"  # zero-padded year on every platform


def test_to_csv_rfc4180() -> None:
    rows = [{"a": 1, "b": 'say "hi"', "c": None}, {"a": 0.5, "c": True, "d": "x,y\nz"}]
    text = to_csv(rows)
    assert text == 'a,b,c,d\r\n1,"say ""hi""",,\r\n0.5,,1,"x,y\nz"\r\n'
    assert parse_csv(text) == [["a", "b", "c", "d"], ["1", 'say "hi"', "", ""], ["0.5", "", "1", "x,y\nz"]]
    assert to_csv([], ["x", "y"]) == "x,y\r\n"


def test_parse_csv_variants() -> None:
    assert parse_csv("a,b\nc,d") == [["a", "b"], ["c", "d"]]
    assert parse_csv("a,b\r\nc,d\r\n") == [["a", "b"], ["c", "d"]]
    assert parse_csv('"a\r\nb",c\r\n') == [["a\r\nb", "c"]]
    assert parse_csv("") == []


def test_write_text_keeps_crlf_bytes(tmp_path: Path) -> None:
    p = write_text(tmp_path / "nested" / "dir" / "x.csv", "a,b\r\n1,2\r\n")
    assert p.read_bytes() == b"a,b\r\n1,2\r\n"  # no \r\r\n on Windows


# ---------------------------------------------------------------------------
# import
# ---------------------------------------------------------------------------


def test_parse_session_sorts_stably_and_validates() -> None:
    raw = make_session(
        samples=[{"t": 2, "bpm": 70}, {"t": 1, "bpm": 71}],
        rr=[{"t": 5, "ms": 800}, {"t": 5, "ms": 810}, {"t": 4, "ms": 790}],
    )
    s = parse_session(raw)
    assert [x["t"] for x in s["samples"]] == [1, 2]
    assert [x["ms"] for x in s["rr"]] == [790, 800, 810]  # ties keep beat order
    assert raw["samples"][0]["t"] == 2  # input not mutated
    with pytest.raises(SessionParseError) as err:
        parse_session(make_session(samples=[{"t": 1, "bpm": 400}], procedure={}))
    assert "samples[0].bpm: expected number in [0, 300]" in err.value.issues
    assert "procedure.name: expected string" in err.value.issues


def test_migrate_session_versions() -> None:
    assert migrate_session(make_session()) is not None
    with pytest.raises(SessionParseError, match="newer"):
        migrate_session(make_session(schemaVersion=2))


def test_parse_import_forms() -> None:
    a, b = make_session(id="a", participantCode="P-1"), make_session(id="b", participantCode="P-2")
    bundle, warns = parse_import(json.dumps(a))
    assert [s["id"] for s in bundle["sessions"]] == ["a"] and warns == []
    assert bundle["format"] == "surgeonpulse-export" and bundle["deidentified"] is False
    assert bundle["participants"] == [{"code": "P-1"}]

    bad = make_session(id="bad", rr=[{"t": 1, "ms": -5}])
    bundle, warns = parse_import(json.dumps([a, bad, b]))
    assert [s["id"] for s in bundle["sessions"]] == ["a", "b"]
    assert warns == ["Skipped sessions[1]: rr[0].ms: expected number in [0, 5000]"]

    full = {"format": "surgeonpulse-export", "version": 1, "exportedAt": 5, "deidentified": True,
            "participants": [{"code": "P-2", "trainingLevel": "fellow"}], "sessions": [a, b]}  # fmt: skip
    bundle, _ = parse_import(json.dumps(full))
    assert bundle["deidentified"] is True and bundle["exportedAt"] == 5
    assert bundle["participants"] == [{"code": "P-2", "trainingLevel": "fellow"}, {"code": "P-1"}]


def test_parse_import_errors() -> None:
    with pytest.raises(SessionParseError, match="not valid JSON"):
        parse_import("{oops")
    with pytest.raises(SessionParseError, match="bundle"):
        parse_import(json.dumps({"format": "surgeonpulse-export", "version": 2, "exportedAt": 0,
                                 "deidentified": False, "participants": [], "sessions": []}))  # fmt: skip
    with pytest.raises(SessionParseError, match="Unrecognised"):
        parse_import("42")


def test_load_export_bom_warnings_and_strict(tmp_path: Path) -> None:
    p = tmp_path / "export.json"
    payload = json.dumps([make_session(id="ok"), make_session(id="bad", status="weird")])
    p.write_bytes(b"\xef\xbb\xbf" + payload.encode("utf-8"))  # UTF-8 BOM, as Windows editors write
    with warnings.catch_warnings(record=True) as caught:
        warnings.simplefilter("always")
        bundle = load_export(p)
    assert [s["id"] for s in bundle["sessions"]] == ["ok"]
    assert [w.category for w in caught] == [ExportWarning]
    with pytest.raises(SessionParseError):
        load_export(str(p), strict=True)


# ---------------------------------------------------------------------------
# frames
# ---------------------------------------------------------------------------


def _frames_session() -> dict:
    t0 = 1_767_600_000_000
    return parse_session(
        make_session(
            id="f1",
            participantCode="P-9",
            startedAt=t0,
            endedAt=t0 + 10_000,
            procedure={"name": "Proc", "complexity": 3},
            participantSnapshot={"trainingLevel": "fellow", "birthYear": 1980},
            samples=[{"t": t0 + i * 1000, "bpm": 70 + i, **({"contact": i % 2 == 0} if i < 4 else {})} for i in range(10)],
            rr=[{"t": t0 + i * 1000, "ms": 2500 if i == 3 else 800 + i} for i in range(10)],
            events=[
                {"id": "e1", "t": t0, "type": "phase", "phase": "pre-op"},
                {"id": "e2", "t": t0 + 5000, "type": "marker", "marker": "note", "note": 'a "quoted", note', "loggedBy": "team"},
                {"id": "e3", "t": t0 + 6000, "type": "phase", "phase": "closure"},
            ],
        )
    )


def test_sessions_to_frames_shapes_and_dtypes() -> None:
    frames = sessions_to_frames({"sessions": [_frames_session()], "participants": [{"code": "P-9", "consent": {"version": "PICF-1", "givenAt": 0}}]})
    smp, rr, ev, ses, par = (frames[k] for k in ("samples", "rr", "events", "sessions", "participants"))
    assert str(smp["t"].dtype) == "datetime64[ms, UTC]"
    assert str(smp["t_ms"].dtype) == "int64"  # explicit: NumPy<2 on Windows would default to int32
    assert smp["t_offset_s"].tolist() == [float(i) for i in range(10)]
    assert str(smp["contact"].dtype) == "boolean"
    assert smp["contact"].tolist()[:4] == [True, False, True, False]
    assert smp["contact"].isna().tolist()[4:] == [True] * 6
    assert smp["phase"].tolist() == ["pre-op"] * 6 + ["closure"] * 4
    assert rr["valid"].tolist() == [True, True, True, False] + [True] * 6 and rr["valid"].dtype == bool
    assert ev["kind"].tolist() == ["pre-op", "note", "closure"]
    assert ev["logged_by"].tolist() == [None, "team", None]
    assert ses.loc[0, "duration_s"] == 10 and ses.loc[0, "n_phases"] == 2 and ses.loc[0, "training_level"] == "fellow"
    assert str(ses["started_at"].dtype) == "datetime64[ms, UTC]"
    assert par.loc[0, "consent_given_at"] == "1970-01-01T00:00:00.000Z"


def test_frames_to_csv_layout() -> None:
    texts = frames_to_csv(sessions_to_frames(_frames_session()))
    assert parse_csv(texts["samples"])[0] == list(SAMPLES_CSV_COLUMNS)
    assert parse_csv(texts["rr"])[0] == list(RR_CSV_COLUMNS)
    assert parse_csv(texts["events"])[0] == list(EVENTS_CSV_COLUMNS)
    assert parse_csv(texts["samples"])[1] == ["f1", "P-9", "2026-01-05T08:00:00.000Z", "0", "70", "1", "pre-op"]
    assert parse_csv(texts["samples"])[5][5] == ""  # contact unknown
    assert parse_csv(texts["rr"])[4][5] == "0"
    assert parse_csv(texts["events"])[2][-1] == 'a "quoted", note'
    assert all(t.endswith("\r\n") and "\r\r\n" not in t for t in texts.values())


def test_sessions_to_frames_empty() -> None:
    frames = sessions_to_frames({"sessions": [], "participants": []})
    assert all(len(df) == 0 for df in frames.values())
    assert list(frames["samples"].columns) == ["session_id", "participant_code", "t", "t_ms", "t_offset_s", "bpm", "contact", "phase"]


def test_to_csv_formula_guard() -> None:
    rows = [{"a": "=1+1", "b": -3, "c": "@x", "d": "ok"}]
    assert parse_csv(to_csv(rows))[1] == ["=1+1", "-3", "@x", "ok"]
    assert parse_csv(to_csv(rows, formula_guard=True))[1] == ["'=1+1", "-3", "'@x", "ok"]


def test_parse_session_rejects_backwards_windows() -> None:
    with pytest.raises(SessionParseError) as exc:
        parse_session(make_session(startedAt=10_000, endedAt=9_000))
    assert exc.value.issues == ["endedAt: endedAt must not be before startedAt"]
    base = {"startedAt": 5, "endedAt": 4, "restingHr": 60, "source": "manual"}
    with pytest.raises(SessionParseError):
        parse_session(make_session(baseline=base))
