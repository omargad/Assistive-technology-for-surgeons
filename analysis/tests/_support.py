"""Helpers shared by the test modules (importable because ``tests`` is on ``pythonpath``)."""

from __future__ import annotations

import json
import math
from pathlib import Path
from typing import Any

RTOL = 1e-9
ATOL = 1e-6

#: Keys whose numeric values are counts, indices or timestamps and must match exactly.
EXACT_KEYS = frozenset(
    {
        "count", "n", "pairs", "total", "removed", "gapCount", "index", "complexity",
        "startedAt", "endedAt", "start", "end", "peakT", "t", "completedAt", "maxHr",
        "birthYear", "atYear",
    }
)  # fmt: skip


def read_text_exact(path: Path) -> str:
    """Read UTF-8 text *without* newline translation (CRLF stays CRLF on every platform)."""
    return path.read_bytes().decode("utf-8")


def read_json(path: Path) -> Any:
    return json.loads(read_text_exact(path))


def make_session(**overrides: Any) -> dict[str, Any]:
    """A minimal valid session dict for unit tests."""
    base: dict[str, Any] = {
        "schemaVersion": 1,
        "id": "s-1",
        "participantCode": "P-01",
        "procedure": {"name": "Test procedure"},
        "startedAt": 1_000_000,
        "status": "completed",
        "sensor": {"source": "simulated"},
        "app": {"version": "test", "platform": "unknown"},
        "samples": [],
        "rr": [],
        "events": [],
    }
    base.update(overrides)
    return base


def _is_num(x: Any) -> bool:
    return isinstance(x, (int, float)) and not isinstance(x, bool)


def tree_diff(py: Any, ts: Any, path: str = "$", key: str | None = None, out: list[str] | None = None) -> list[str]:
    """Differences between a Python result and the TypeScript JSON (empty list = equal).

    Dict key sets must match exactly (optional keys omitted on both sides);
    counts / ids / timestamps (``EXACT_KEYS``) and strings / booleans / ``None``
    must be equal; other numbers must satisfy ``|py − ts| <= ATOL + RTOL·|ts|``.
    """
    if out is None:
        out = []
    if isinstance(ts, dict):
        if not isinstance(py, dict):
            out.append(f"{path}: python={py!r} typescript=object")
            return out
        missing, extra = sorted(set(ts) - set(py)), sorted(set(py) - set(ts))
        if missing or extra:
            out.append(f"{path}: keys missing in python={missing} extra in python={extra}")
        for k in ts:
            if k in py:
                tree_diff(py[k], ts[k], f"{path}.{k}", k, out)
    elif isinstance(ts, list):
        if not isinstance(py, (list, tuple)) or len(py) != len(ts):
            out.append(f"{path}: python len={len(py) if isinstance(py, (list, tuple)) else py!r} typescript len={len(ts)}")
            return out
        for i, (a, b) in enumerate(zip(py, ts)):
            tree_diff(a, b, f"{path}[{i}]", key, out)
    elif _is_num(ts) and _is_num(py):
        if not (math.isfinite(py)):
            out.append(f"{path}: python produced non-finite {py!r}")
        elif key in EXACT_KEYS:
            if py != ts:
                out.append(f"{path}: python={py!r} typescript={ts!r} (exact)")
        elif not abs(py - ts) <= ATOL + RTOL * abs(ts):
            out.append(f"{path}: python={py!r} typescript={ts!r}")
    elif py != ts or (type(py) is bool) != (type(ts) is bool):
        out.append(f"{path}: python={py!r} typescript={ts!r}")
    return out


def csv_diff(py_rows: list[list[str]], ts_rows: list[list[str]]) -> list[str]:
    """Cell-by-cell CSV comparison: exact header/strings, numeric cells within tolerance."""
    out: list[str] = []
    if py_rows[:1] != ts_rows[:1]:
        return [f"header differs: python={py_rows[:1]} typescript={ts_rows[:1]}"]
    if len(py_rows) != len(ts_rows):
        return [f"row count python={len(py_rows)} typescript={len(ts_rows)}"]
    header = ts_rows[0]
    for i, (a, b) in enumerate(zip(py_rows[1:], ts_rows[1:]), start=1):
        for col, x, y in zip(header, a, b):
            if x == y:
                continue
            try:
                fx, fy = float(x), float(y)
            except ValueError:
                out.append(f"row {i} {col}: python={x!r} typescript={y!r}")
                continue
            if not abs(fx - fy) <= ATOL + RTOL * abs(fy):
                out.append(f"row {i} {col}: python={x} typescript={y}")
    return out


def find_non_finite(value: Any, path: str = "$") -> list[str]:
    """Paths of NaN/inf floats inside a nested structure (SPEC: never in outputs)."""
    bad: list[str] = []
    if isinstance(value, float) and not math.isfinite(value):
        bad.append(path)
    elif isinstance(value, dict):
        for k, v in value.items():
            bad += find_non_finite(v, f"{path}.{k}")
    elif isinstance(value, (list, tuple)):
        for i, v in enumerate(value):
            bad += find_non_finite(v, f"{path}[{i}]")
    return bad
