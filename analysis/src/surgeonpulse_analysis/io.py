"""Reading SurgeonPulse exports and turning them into tidy pandas DataFrames.

* :func:`load_export` / :func:`parse_import` mirror ``io/bundle.ts``
  ``parseImport``: they accept an ``ExportBundle``, a single session object or a
  list of sessions, validate each session (ranges as in ``io/schema.ts``), skip
  invalid sessions with a warning and synthesise missing participants.
* :func:`sessions_to_frames` returns tidy frames (``sessions``, ``samples``,
  ``rr``, ``events``, ``participants``) with ``t`` as ``datetime64[ms, UTC]``
  and ``t_offset_s`` relative to the session start.
* :func:`to_csv` / :func:`js_number_str` / :func:`iso_utc` reproduce the
  TypeScript CSV conventions (RFC 4180, CRLF, JavaScript ``String(number)``,
  ``Date.prototype.toISOString``) so files written by Python and by the app
  are byte-identical.

Portability: files are read as UTF-8 (a BOM from Windows editors is
tolerated) and written as UTF-8 with ``newline=""`` so CRLF is never doubled on
Windows; times are computed from the Unix epoch with ``timedelta`` (no
``time.localtime``/``fromtimestamp``), and integer columns are explicitly
``int64`` (NumPy < 2 defaults to 32-bit ints on Windows).
"""

from __future__ import annotations

import json
import math
import os
import warnings
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Iterable, Mapping, Sequence

import numpy as np
import pandas as pd

from .hrv import clean_rr
from .phases import derive_phases, phase_at, session_end
from .stats import is_finite_number, sorted_by_t

__all__ = [
    "SessionParseError",
    "ExportWarning",
    "migrate_session",
    "parse_session",
    "parse_import",
    "load_export",
    "sessions_to_frames",
    "frames_to_csv",
    "js_number_str",
    "iso_utc",
    "to_csv",
    "parse_csv",
    "write_text",
    "SAMPLES_CSV_COLUMNS",
    "RR_CSV_COLUMNS",
    "EVENTS_CSV_COLUMNS",
]

SCHEMA_VERSION = 1
_EPOCH = datetime(1970, 1, 1, tzinfo=timezone.utc)

SAMPLES_CSV_COLUMNS = ("session_id", "participant_code", "t_iso", "t_offset_s", "bpm", "contact", "phase")
RR_CSV_COLUMNS = ("session_id", "participant_code", "t_iso", "t_offset_s", "rr_ms", "valid", "phase")
EVENTS_CSV_COLUMNS = ("session_id", "participant_code", "t_iso", "t_offset_s", "type", "kind", "logged_by", "note")


class SessionParseError(ValueError):
    """Raised when an export cannot be parsed. ``issues`` holds ``"path: message"`` lines."""

    def __init__(self, message: str, issues: Sequence[str] = ()) -> None:
        super().__init__(message if not issues else f"{message}\n  " + "\n  ".join(issues))
        self.issues = list(issues)


class ExportWarning(UserWarning):
    """Emitted by :func:`load_export` for sessions skipped during import."""


# ---------------------------------------------------------------------------
# Formatting helpers (JavaScript-compatible)
# ---------------------------------------------------------------------------


def js_number_str(x: float) -> str:
    """Format a number exactly like JavaScript ``String(x)`` (ECMA-262 Number::toString).

    Both languages print the shortest digit string that round-trips, but they
    switch to exponent notation at different magnitudes (JS: < 1e-6 or >= 1e21)
    and JS prints integral floats without ``.0``. Non-finite values give ``""``
    (the CSV convention for missing values).
    """
    if isinstance(x, (bool, np.bool_)):
        return "true" if x else "false"
    if isinstance(x, (int, np.integer)) and abs(int(x)) < 2**53:
        return str(int(x))  # exactly representable: same digits in both languages
    x = float(x)
    if not math.isfinite(x):
        return ""
    if x == 0:
        return "0"  # also -0, like JavaScript
    sign = "-" if x < 0 else ""
    # repr() gives the shortest round-tripping digits (as JS does); only the layout differs.
    mant, _, exp = repr(abs(x)).partition("e")
    int_part, _, frac_part = mant.partition(".")
    all_digits = int_part + frac_part
    stripped = all_digits.lstrip("0")
    leading_zeros = len(all_digits) - len(stripped)
    # ECMA-262 notation: value = 0.d1d2…dk × 10^n
    n = len(int_part) + (int(exp) if exp else 0) - leading_zeros
    digits = stripped.rstrip("0")
    k = len(digits)
    if k <= n <= 21:
        s = digits + "0" * (n - k)
    elif 0 < n <= 21:
        s = digits[:n] + "." + digits[n:]
    elif -6 < n <= 0:
        s = "0." + "0" * (-n) + digits
    else:
        e = n - 1
        es = f"e{'+' if e >= 0 else '-'}{abs(e)}"
        s = digits + es if k == 1 else digits[0] + "." + digits[1:] + es
    return sign + s


def iso_utc(epoch_ms: float) -> str:
    """``Date.prototype.toISOString`` for an epoch-ms value: ``YYYY-MM-DDTHH:MM:SS.sssZ`` (UTC).

    Formatted field by field (``strftime('%Y')`` is not zero-padded on every platform).
    """
    dt = _EPOCH + timedelta(milliseconds=float(epoch_ms))
    ms = dt.microsecond // 1000
    year = f"{dt.year:04d}" if 0 <= dt.year <= 9999 else f"{'+' if dt.year > 0 else '-'}{abs(dt.year):06d}"
    return f"{year}-{dt.month:02d}-{dt.day:02d}T{dt.hour:02d}:{dt.minute:02d}:{dt.second:02d}.{ms:03d}Z"


def _is_missing(v: Any) -> bool:
    if v is None or v is pd.NA or v is pd.NaT:
        return True
    if isinstance(v, (float, np.floating)) and math.isnan(v):
        return True
    return False


#: First characters that make a spreadsheet evaluate a cell as a formula (OWASP CSV injection).
_FORMULA_START = ("=", "+", "-", "@", "\t", "\r")


def _cell(v: Any, formula_guard: bool = False) -> str:
    if _is_missing(v):
        return ""
    if isinstance(v, (bool, np.bool_)):
        return "1" if v else "0"
    if isinstance(v, pd.Timestamp):
        # .value is always nanoseconds since the epoch (UTC for tz-aware; naive is treated as UTC).
        return iso_utc(v.value // 1_000_000)
    if isinstance(v, datetime):
        aware = v if v.tzinfo is not None else v.replace(tzinfo=timezone.utc)
        return iso_utc((aware - _EPOCH) // timedelta(milliseconds=1))
    if isinstance(v, (int, float, np.integer, np.floating)):
        return js_number_str(v)
    s = str(v)
    if formula_guard and s.startswith(_FORMULA_START):
        s = "'" + s
    if any(c in s for c in ',"\r\n'):
        s = '"' + s.replace('"', '""') + '"'
    return s


def to_csv(
    rows: Iterable[Mapping[str, Any]], columns: Sequence[str] | None = None, *, formula_guard: bool = False
) -> str:
    """RFC 4180 CSV with ``\\r\\n`` line endings and a header row (SPEC ``toCsv``).

    Fields containing ``,``, ``"``, CR or LF are quoted (embedded quotes doubled);
    ``None``/NaN become empty fields; numbers are formatted like JavaScript
    ``String(n)``; booleans as ``1``/``0``; timestamps as ISO-8601 UTC.
    Columns default to the union of keys in first-seen order.

    ``formula_guard`` (SPEC ``CsvOptions.formulaGuard``) prefixes ``'`` to text
    values starting with ``= + - @``, TAB or CR so spreadsheets show them as text;
    numbers are never altered. The app's exporters (and :func:`frames_to_csv`)
    turn it on.
    """
    rows = list(rows)
    if columns is None:
        seen: dict[str, None] = {}
        for r in rows:
            for k in r:
                seen.setdefault(k, None)
        columns = list(seen)
    lines = [",".join(_cell(c) for c in columns)]
    for r in rows:
        lines.append(",".join(_cell(r.get(c), formula_guard) for c in columns))
    return "\r\n".join(lines) + "\r\n"


def parse_csv(text: str) -> list[list[str]]:
    """RFC 4180 parser (inverse of :func:`to_csv`): quotes, CRLF/LF, optional trailing newline."""
    rows: list[list[str]] = []
    row: list[str] = []
    field: list[str] = []
    i, n = 0, len(text)
    in_quotes = False
    while i < n:
        c = text[i]
        if in_quotes:
            if c == '"':
                if i + 1 < n and text[i + 1] == '"':
                    field.append('"')
                    i += 1
                else:
                    in_quotes = False
            else:
                field.append(c)
        elif c == '"':
            in_quotes = True
        elif c == ",":
            row.append("".join(field))
            field = []
        elif c in "\r\n":
            if c == "\r" and i + 1 < n and text[i + 1] == "\n":
                i += 1
            row.append("".join(field))
            rows.append(row)
            row, field = [], []
        else:
            field.append(c)
        i += 1
    if field or row:
        row.append("".join(field))
        rows.append(row)
    return rows


def write_text(path: str | os.PathLike[str], text: str) -> Path:
    """Write UTF-8 text without newline translation (CRLF stays CRLF on Windows). Creates parent dirs."""
    p = Path(path)
    p.parent.mkdir(parents=True, exist_ok=True)
    with open(p, "w", encoding="utf-8", newline="") as fh:
        fh.write(text)
    return p


# ---------------------------------------------------------------------------
# Validation (mirrors the ranges of io/schema.ts)
# ---------------------------------------------------------------------------

_STATUS = {"recording", "completed", "aborted"}
_SOURCES = {"ble", "web-bluetooth", "healthkit", "health-connect", "simulated", "import"}
_PLATFORMS = {"ios", "android", "web", "unknown"}
_PHASES = {"pre-op", "incision", "dissection", "critical", "closure", "post-op"}
_MARKERS = {"complication", "interruption", "equipment", "teaching", "takeover", "note"}
_LOGGERS = {"self", "team", "retrospective"}


class _Checker:
    def __init__(self) -> None:
        self.issues: list[str] = []

    def add(self, path: str, msg: str) -> None:
        if len(self.issues) < 50:
            self.issues.append(f"{path or '(root)'}: {msg}")

    def obj(self, v: Any, path: str) -> bool:
        if not isinstance(v, Mapping):
            self.add(path, "expected object")
            return False
        return True

    def string(self, v: Any, path: str, *, optional: bool = False, choices: set[str] | None = None) -> None:
        if v is None and optional:
            return
        if not isinstance(v, str):
            self.add(path, "expected string")
        elif choices is not None and v not in choices:
            self.add(path, f"expected one of {', '.join(sorted(choices))}")

    def number(self, v: Any, path: str, *, optional: bool = False, lo: float | None = None, hi: float | None = None, integer: bool = False) -> None:
        if v is None and optional:
            return
        if not is_finite_number(v):
            self.add(path, "expected number")
            return
        if integer and not float(v).is_integer():
            self.add(path, "expected integer")
        if (lo is not None and v < lo) or (hi is not None and v > hi):
            self.add(path, f"expected number in [{js_number_str(lo) if lo is not None else '-inf'}, {js_number_str(hi) if hi is not None else 'inf'}]")

    def boolean(self, v: Any, path: str, *, optional: bool = False) -> None:
        if v is None and optional:
            return
        if not isinstance(v, bool):
            self.add(path, "expected boolean")

    def array(self, v: Any, path: str) -> bool:
        if not isinstance(v, list):
            self.add(path, "expected array")
            return False
        return True


def _check_workload(c: _Checker, w: Any, path: str) -> None:
    if not c.obj(w, path):
        return
    inst = w.get("instrument")
    c.string(inst, f"{path}.instrument", choices={"surg-tlx", "nasa-tlx"})
    dims = (
        ("mental", "physical", "temporal", "complexity", "stress", "distraction")
        if inst == "surg-tlx"
        else ("mental", "physical", "temporal", "performance", "effort", "frustration")
    )
    if c.obj(w.get("ratings"), f"{path}.ratings"):
        for d in dims:
            c.number(w["ratings"].get(d), f"{path}.ratings.{d}", lo=0, hi=100)
    if w.get("weights") is not None and c.obj(w["weights"], f"{path}.weights"):
        for d in dims:
            c.number(w["weights"].get(d), f"{path}.weights.{d}")
    c.number(w.get("completedAt"), f"{path}.completedAt")


def _check_session(raw: Any) -> list[str]:
    c = _Checker()
    if not c.obj(raw, ""):
        return c.issues
    c.string(raw.get("id"), "id")
    c.string(raw.get("participantCode"), "participantCode")
    if c.obj(raw.get("procedure"), "procedure"):
        p = raw["procedure"]
        c.string(p.get("name"), "procedure.name")
        c.number(p.get("complexity"), "procedure.complexity", optional=True, lo=1, hi=5, integer=True)
    c.number(raw.get("startedAt"), "startedAt")
    c.number(raw.get("endedAt"), "endedAt", optional=True)
    c.string(raw.get("status"), "status", choices=_STATUS)
    if c.obj(raw.get("sensor"), "sensor"):
        c.string(raw["sensor"].get("source"), "sensor.source", choices=_SOURCES)
    if c.obj(raw.get("app"), "app"):
        c.string(raw["app"].get("version"), "app.version")
        c.string(raw["app"].get("platform"), "app.platform", choices=_PLATFORMS)
    c.number(raw.get("tzOffsetMin"), "tzOffsetMin", optional=True)
    if c.array(raw.get("samples"), "samples"):
        for i, s in enumerate(raw["samples"]):
            if c.obj(s, f"samples[{i}]"):
                c.number(s.get("t"), f"samples[{i}].t")
                c.number(s.get("bpm"), f"samples[{i}].bpm", lo=0, hi=300)
                c.boolean(s.get("contact"), f"samples[{i}].contact", optional=True)
    if c.array(raw.get("rr"), "rr"):
        for i, r in enumerate(raw["rr"]):
            if c.obj(r, f"rr[{i}]"):
                c.number(r.get("t"), f"rr[{i}].t")
                c.number(r.get("ms"), f"rr[{i}].ms", lo=0, hi=5000)
    if c.array(raw.get("events"), "events"):
        for i, e in enumerate(raw["events"]):
            if not c.obj(e, f"events[{i}]"):
                continue
            c.string(e.get("id"), f"events[{i}].id")
            c.number(e.get("t"), f"events[{i}].t")
            c.string(e.get("loggedBy"), f"events[{i}].loggedBy", optional=True, choices=_LOGGERS)
            c.string(e.get("note"), f"events[{i}].note", optional=True)
            if e.get("type") == "phase":
                c.string(e.get("phase"), f"events[{i}].phase", choices=_PHASES)
            elif e.get("type") == "marker":
                c.string(e.get("marker"), f"events[{i}].marker", choices=_MARKERS)
            else:
                c.add(f"events[{i}].type", "expected 'phase' or 'marker'")
    b = raw.get("baseline")
    if b is not None and c.obj(b, "baseline"):
        c.number(b.get("startedAt"), "baseline.startedAt")
        c.number(b.get("endedAt"), "baseline.endedAt")
        c.number(b.get("restingHr"), "baseline.restingHr")
        c.string(b.get("source"), "baseline.source", choices={"measured", "manual", "profile"})
    snap = raw.get("participantSnapshot")
    if snap is not None and c.obj(snap, "participantSnapshot"):
        for key in ("yearsExperience", "birthYear", "maxHr", "restingHr"):
            c.number(snap.get(key), f"participantSnapshot.{key}", optional=True)
    post = raw.get("postOp")
    if post is not None and c.obj(post, "postOp"):
        if post.get("workload") is not None:
            _check_workload(c, post["workload"], "postOp.workload")
        c.number(post.get("performance"), "postOp.performance", optional=True, lo=0, hi=10)
        c.number(post.get("perceivedStress"), "postOp.perceivedStress", optional=True, lo=0, hi=10)
    tags = raw.get("tags")
    if tags is not None and c.array(tags, "tags"):
        for i, tag in enumerate(tags):
            c.string(tag, f"tags[{i}]")
    # Time windows must not run backwards (SPEC io/schema: endedAt >= startedAt), checked once the fields are valid.
    if not c.issues:
        if raw.get("endedAt") is not None and raw["endedAt"] < raw["startedAt"]:
            c.add("endedAt", "endedAt must not be before startedAt")
        if b is not None and b["endedAt"] < b["startedAt"]:
            c.add("baseline.endedAt", "endedAt must not be before startedAt")
    return c.issues


def migrate_session(raw: Any) -> Any:
    """Upgrade older ``schemaVersion`` objects. v1 is the identity; a future version raises."""
    if not isinstance(raw, Mapping):
        raise SessionParseError("Session must be a JSON object", ["(root): expected object"])
    v = raw.get("schemaVersion")
    if v == SCHEMA_VERSION:
        return raw
    if is_finite_number(v) and v > SCHEMA_VERSION:
        raise SessionParseError(
            f"Session schemaVersion {v} is newer than this toolkit supports ({SCHEMA_VERSION}); please upgrade.",
            [f"schemaVersion: unsupported version {v}"],
        )
    raise SessionParseError("Unrecognised session schemaVersion", [f"schemaVersion: expected {SCHEMA_VERSION}"])


def parse_session(raw: Any) -> dict[str, Any]:
    """Migrate → validate → stably sort ``samples``/``rr``/``events`` by ``t`` → new dict.

    Raises :class:`SessionParseError` with ``"path: message"`` issues.
    """
    migrated = migrate_session(raw)
    issues = _check_session(migrated)
    if issues:
        raise SessionParseError("Invalid session", issues)
    out = dict(migrated)
    for key in ("samples", "rr", "events"):
        out[key] = [dict(x) for x in sorted_by_t(migrated[key])]
    return out


def _session_like(x: Any) -> bool:
    return isinstance(x, Mapping) and ("schemaVersion" in x or "samples" in x or "participantCode" in x)


def parse_import(text: str) -> tuple[dict[str, Any], list[str]]:
    """Parse export JSON text into ``(bundle, warnings)`` (SPEC ``parseImport``).

    Accepts an ``ExportBundle``, a single session object or a list of sessions
    (wrapped in a bundle with ``deidentified: False``). Invalid sessions are
    skipped with a warning naming the index and issues; a ``{"code"}``
    participant is synthesised for every session code without a profile.
    Raises :class:`SessionParseError` for malformed JSON or bundles.
    """
    try:
        data = json.loads(text)
    except json.JSONDecodeError as exc:
        raise SessionParseError("File is not valid JSON", [f"(root): {exc.msg} at line {exc.lineno} column {exc.colno}"]) from exc

    warns: list[str] = []
    participants: list[dict[str, Any]] = []
    meta: dict[str, Any] = {}
    if isinstance(data, Mapping) and data.get("format") == "surgeonpulse-export":
        c = _Checker()
        if data.get("version") != 1:
            c.add("version", "expected 1")
        c.number(data.get("exportedAt"), "exportedAt")
        c.boolean(data.get("deidentified"), "deidentified")
        c.array(data.get("participants"), "participants")
        c.array(data.get("sessions"), "sessions")
        for i, p in enumerate(data.get("participants") or []):
            if c.obj(p, f"participants[{i}]"):
                c.string(p.get("code"), f"participants[{i}].code")
        if c.issues:
            raise SessionParseError("Invalid SurgeonPulse export bundle", c.issues)
        raw_sessions = list(data["sessions"])
        participants = [dict(p) for p in data["participants"]]
        meta = {k: data[k] for k in ("exportedAt", "app", "deidentified") if k in data}
    elif isinstance(data, list):
        raw_sessions = data
    elif _session_like(data):
        raw_sessions = [data]
    else:
        raise SessionParseError(
            "Unrecognised file: expected a SurgeonPulse export bundle, a session or a list of sessions",
            ["(root): expected object with format 'surgeonpulse-export', a session object, or an array"],
        )

    sessions: list[dict[str, Any]] = []
    for i, raw in enumerate(raw_sessions):
        try:
            sessions.append(parse_session(raw))
        except SessionParseError as exc:
            warns.append(f"Skipped sessions[{i}]: " + "; ".join(exc.issues or [str(exc)]))

    known = {p["code"] for p in participants}
    for s in sessions:
        if s["participantCode"] not in known:
            participants.append({"code": s["participantCode"]})
            known.add(s["participantCode"])

    bundle: dict[str, Any] = {
        "format": "surgeonpulse-export",
        "version": 1,
        "exportedAt": meta.get("exportedAt", max((session_end(s) for s in sessions), default=0)),
        "deidentified": bool(meta.get("deidentified", False)),
        "participants": participants,
        "sessions": sessions,
    }
    if "app" in meta:
        bundle["app"] = meta["app"]
    return bundle, warns


def load_export(path: str | os.PathLike[str], *, strict: bool = False) -> dict[str, Any]:
    """Load a SurgeonPulse export file (bundle, single session or session list) → bundle dict.

    Skipped sessions are reported with :class:`ExportWarning` (or raise
    :class:`SessionParseError` when ``strict=True``).
    """
    text = Path(path).read_text(encoding="utf-8-sig")
    bundle, warns = parse_import(text)
    if warns and strict:
        raise SessionParseError(f"{len(warns)} invalid session(s) in {path}", warns)
    for w in warns:
        warnings.warn(w, ExportWarning, stacklevel=2)
    return bundle


# ---------------------------------------------------------------------------
# Tidy frames
# ---------------------------------------------------------------------------


def _as_sessions(source: Any) -> tuple[list[Mapping[str, Any]], list[Mapping[str, Any]]]:
    """(sessions, participants) from a bundle dict, a list of sessions or one session."""
    if isinstance(source, Mapping) and "sessions" in source:
        return list(source["sessions"]), list(source.get("participants") or [])
    if isinstance(source, Mapping):
        return [source], []
    return list(source), []


def _utc(ms: Sequence[float]) -> pd.Series:
    """epoch-ms → ``datetime64[ms, UTC]`` Series (fractional ms are floored)."""
    arr = np.floor(np.asarray(ms, dtype="float64")).astype("int64").astype("datetime64[ms]")
    return pd.Series(arr, dtype="datetime64[ms]").dt.tz_localize("UTC")


def _num(values: Sequence[Any]) -> pd.Series:
    """Numeric column: int64 when every value is integral, else float64 (None → NaN)."""
    if values and all(isinstance(v, (int, np.integer)) and not isinstance(v, bool) for v in values):
        return pd.Series(np.asarray(values, dtype="int64"))
    return pd.Series(np.asarray([np.nan if v is None else v for v in values], dtype="float64"))


def _opt_num(values: Sequence[Any]) -> pd.Series:
    """Nullable numeric column (``Int64`` when integral, else ``Float64``-compatible float64)."""
    if values and all(v is None or (isinstance(v, (int, np.integer)) and not isinstance(v, bool)) for v in values) and any(v is not None for v in values):
        return pd.Series(pd.array(values, dtype="Int64"))
    return pd.Series(np.asarray([np.nan if v is None else v for v in values], dtype="float64"))


def _text(values: Sequence[Any]) -> pd.Series:
    return pd.Series(list(values), dtype="object")


def sessions_to_frames(source: Any) -> dict[str, pd.DataFrame]:
    """Tidy (long) DataFrames from a bundle, a list of sessions or a single session.

    Returns ``{"sessions", "samples", "rr", "events", "participants"}``:

    * ``samples``: session_id, participant_code, t, t_ms, t_offset_s, bpm, contact, phase
    * ``rr``: session_id, participant_code, t, t_ms, t_offset_s, rr_ms, valid, phase
      (``valid`` from :func:`~surgeonpulse_analysis.hrv.clean_rr` defaults)
    * ``events``: session_id, participant_code, event_id, t, t_ms, t_offset_s, type, kind, logged_by, note
    * ``sessions``: one row per session (procedure, participant snapshot, baseline, counts)
    * ``participants``: one row per participant profile

    ``t`` is ``datetime64[ms, UTC]``; ``t_offset_s = (t − startedAt)/1000``;
    ``phase`` is the operative phase in progress (``phase_at``).
    """
    sessions, participants = _as_sessions(source)
    cols: dict[str, dict[str, list[Any]]] = {
        "samples": {k: [] for k in ("session_id", "participant_code", "t_ms", "t_offset_s", "bpm", "contact", "phase")},
        "rr": {k: [] for k in ("session_id", "participant_code", "t_ms", "t_offset_s", "rr_ms", "valid", "phase")},
        "events": {k: [] for k in ("session_id", "participant_code", "event_id", "t_ms", "t_offset_s", "type", "kind", "logged_by", "note")},
    }
    srows: list[dict[str, Any]] = []
    for s in sessions:
        sid, code, t0 = s["id"], s["participantCode"], s["startedAt"]
        segs = derive_phases(s)
        samples, rr, events = s.get("samples") or [], s.get("rr") or [], s.get("events") or []
        c = cols["samples"]
        for x in samples:
            c["session_id"].append(sid)
            c["participant_code"].append(code)
            c["t_ms"].append(x["t"])
            c["t_offset_s"].append((x["t"] - t0) / 1000)
            c["bpm"].append(x["bpm"])
            c["contact"].append(x.get("contact"))
            c["phase"].append(phase_at(segs, x["t"]))
        valid = clean_rr(rr)["valid"]
        c = cols["rr"]
        for x, v in zip(rr, valid):
            c["session_id"].append(sid)
            c["participant_code"].append(code)
            c["t_ms"].append(x["t"])
            c["t_offset_s"].append((x["t"] - t0) / 1000)
            c["rr_ms"].append(x["ms"])
            c["valid"].append(v)
            c["phase"].append(phase_at(segs, x["t"]))
        c = cols["events"]
        for e in events:
            c["session_id"].append(sid)
            c["participant_code"].append(code)
            c["event_id"].append(e.get("id"))
            c["t_ms"].append(e["t"])
            c["t_offset_s"].append((e["t"] - t0) / 1000)
            c["type"].append(e.get("type"))
            c["kind"].append(e.get("phase") if e.get("type") == "phase" else e.get("marker"))
            c["logged_by"].append(e.get("loggedBy"))
            c["note"].append(e.get("note"))
        proc = s.get("procedure") or {}
        snap = s.get("participantSnapshot") or {}
        base = s.get("baseline") or {}
        sensor = s.get("sensor") or {}
        app = s.get("app") or {}
        end = session_end(s)
        srows.append(
            {
                "session_id": sid,
                "participant_code": code,
                "status": s.get("status"),
                "started_at_ms": t0,
                "ended_at_ms": end,
                "duration_s": (end - t0) / 1000,
                "tz_offset_min": s.get("tzOffsetMin"),
                "procedure_name": proc.get("name"),
                "catalog_id": proc.get("catalogId"),
                "specialty": proc.get("specialty"),
                "approach": proc.get("approach"),
                "role": proc.get("role"),
                "complexity": proc.get("complexity"),
                "urgency": proc.get("urgency"),
                "training_level": snap.get("trainingLevel"),
                "years_experience": snap.get("yearsExperience"),
                "birth_year": snap.get("birthYear"),
                "max_hr": snap.get("maxHr"),
                "resting_hr": snap.get("restingHr"),
                "baseline_hr": base.get("restingHr"),
                "baseline_source": base.get("source"),
                "sensor_source": sensor.get("source"),
                "sensor_name": sensor.get("name"),
                "sensor_location": sensor.get("location"),
                "app_platform": app.get("platform"),
                "app_version": app.get("version"),
                "n_samples": len(samples),
                "n_rr": len(rr),
                "n_events": len(events),
                "n_phases": len(segs),
                "has_post_op": s.get("postOp") is not None,
                "tags": ";".join(s.get("tags") or []),
            }
        )

    def frame(name: str, ordered: Sequence[str], numeric: Sequence[str]) -> pd.DataFrame:
        c = cols[name]
        data: dict[str, pd.Series] = {}
        for k in ordered:
            if k == "t":
                data["t"] = _utc(c["t_ms"])
            elif k == "t_ms":
                data[k] = _num(c[k]) if c[k] else pd.Series(np.zeros(0, dtype="int64"))
            elif k in numeric:
                data[k] = _num(c[k]) if c[k] else pd.Series(np.zeros(0, dtype="float64"))
            elif k == "contact":
                data[k] = pd.Series(pd.array(c[k], dtype="boolean"))
            elif k == "valid":
                data[k] = pd.Series(np.asarray(c[k], dtype=bool))
            else:
                data[k] = _text(c[k])
        return pd.DataFrame(data, columns=list(ordered))

    out = {
        "samples": frame("samples", ("session_id", "participant_code", "t", "t_ms", "t_offset_s", "bpm", "contact", "phase"), ("t_offset_s", "bpm")),
        "rr": frame("rr", ("session_id", "participant_code", "t", "t_ms", "t_offset_s", "rr_ms", "valid", "phase"), ("t_offset_s", "rr_ms")),
        "events": frame(
            "events",
            ("session_id", "participant_code", "event_id", "t", "t_ms", "t_offset_s", "type", "kind", "logged_by", "note"),
            ("t_offset_s",),
        ),
    }

    scols = list(srows[0].keys()) if srows else [
        "session_id", "participant_code", "status", "started_at_ms", "ended_at_ms", "duration_s",
    ]
    sdata: dict[str, pd.Series] = {}
    for k in scols:
        vals = [r[k] for r in srows]
        if k in ("started_at_ms", "ended_at_ms", "n_samples", "n_rr", "n_events", "n_phases"):
            sdata[k] = _num(vals) if vals else pd.Series(np.zeros(0, dtype="int64"))
        elif k in ("duration_s", "baseline_hr", "max_hr", "resting_hr", "years_experience"):
            sdata[k] = pd.Series(np.asarray([np.nan if v is None else v for v in vals], dtype="float64"))
        elif k in ("tz_offset_min", "complexity", "birth_year"):
            sdata[k] = _opt_num(vals)
        elif k == "has_post_op":
            sdata[k] = pd.Series(np.asarray(vals, dtype=bool))
        else:
            sdata[k] = _text(vals)
    sframe = pd.DataFrame(sdata, columns=scols)
    sframe.insert(2, "started_at", _utc([r["started_at_ms"] for r in srows]))
    sframe.insert(3, "ended_at", _utc([r["ended_at_ms"] for r in srows]))
    out["sessions"] = sframe

    prow = []
    for p in participants:
        consent = p.get("consent") or {}
        prow.append(
            {
                "code": p.get("code"),
                "training_level": p.get("trainingLevel"),
                "specialty": p.get("specialty"),
                "years_experience": p.get("yearsExperience"),
                "birth_year": p.get("birthYear"),
                "max_hr": p.get("maxHr"),
                "resting_hr": p.get("restingHr"),
                "consent_version": consent.get("version"),
                "consent_given_at": iso_utc(consent["givenAt"]) if consent.get("givenAt") is not None else None,
                "consent_withdrawn_at": iso_utc(consent["withdrawnAt"]) if consent.get("withdrawnAt") is not None else None,
            }
        )
    pcols = ["code", "training_level", "specialty", "years_experience", "birth_year", "max_hr", "resting_hr", "consent_version", "consent_given_at", "consent_withdrawn_at"]
    pdata: dict[str, pd.Series] = {}
    for k in pcols:
        vals = [r[k] for r in prow]
        if k in ("years_experience", "max_hr", "resting_hr"):
            pdata[k] = pd.Series(np.asarray([np.nan if v is None else v for v in vals], dtype="float64"))
        elif k == "birth_year":
            pdata[k] = _opt_num(vals) if vals else pd.Series(pd.array([], dtype="Int64"))
        else:
            pdata[k] = _text(vals)
    out["participants"] = pd.DataFrame(pdata, columns=pcols)
    return out


def frames_to_csv(frames: Mapping[str, pd.DataFrame]) -> dict[str, str]:
    """CSV text for each tidy frame.

    ``samples``/``rr``/``events`` use exactly the columns of the TypeScript
    ``samplesToCsv``/``rrToCsv``/``eventsToCsv`` (so files are interchangeable
    with app exports); ``sessions``/``participants`` write every column. Text
    cells are formula-guarded like the app's exports.
    """
    out: dict[str, str] = {}
    layouts = {"samples": SAMPLES_CSV_COLUMNS, "rr": RR_CSV_COLUMNS, "events": EVENTS_CSV_COLUMNS}
    for name, df in frames.items():
        if name in layouts:
            sub = df.assign(t_iso=[iso_utc(v) for v in df["t_ms"].tolist()]) if len(df) else df.assign(t_iso=[])
            out[name] = to_csv(_records(sub, layouts[name]), layouts[name], formula_guard=True)
        else:
            cols = [c for c in df.columns if not (c.endswith("_ms") and c[:-3] in df.columns)]
            out[name] = to_csv(_records(df, cols), cols, formula_guard=True)
    return out


def _records(df: pd.DataFrame, columns: Sequence[str]) -> list[dict[str, Any]]:
    data = {c: df[c].tolist() for c in columns}
    return [{c: data[c][i] for c in columns} for i in range(len(df))]
