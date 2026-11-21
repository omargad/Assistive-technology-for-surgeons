"""Cohort-level analysis: one wide row per session, grouped statistics, learning curves.

``summaries_frame`` produces exactly the columns of the TypeScript
``summariesToCsv`` (SPEC.md § io/csv.ts), so a CSV exported from the app or the
dashboard and one produced here can be analysed with the same SPSS/R/Stata
scripts. ``aggregate`` mirrors ``aggregateMetric`` (SPEC.md § analytics/trends.ts).
"""

from __future__ import annotations

import math
from typing import Any, Iterable, Mapping, Sequence

import numpy as np
import pandas as pd

from .io import _utc, iso_utc, to_csv
from .phases import PHASE_ORDER
from .stats import js_round, linear_trend, mean, median, naive_sum, sample_sd, t_critical_95
from .summary import summarize_session

__all__ = [
    "SUMMARY_CSV_COLUMNS",
    "METRIC_COLUMNS",
    "GROUP_COLUMNS",
    "summary_row",
    "summarize_bundle",
    "summaries_to_csv",
    "summaries_frame",
    "metric_values",
    "aggregate",
    "learning_curve",
    "phase_profile",
    "cohort_report",
]

_BASE_COLUMNS = (
    "session_id", "participant_code", "training_level", "started_at", "ended_at",
    "procedure_name", "specialty", "approach", "role", "urgency", "complexity",
    "duration_min", "hr_mean", "hr_median", "hr_min", "hr_max", "hr_sd", "hr_p95",
    "rmssd", "sdnn", "pnn50", "mean_rr", "stress_index", "rr_artifact_pct",
    "baseline_hr", "mean_hr_delta", "peak_hr_delta", "high_intensity_pct",
    "episode_count", "episode_minutes", "workload_instrument", "workload_raw",
    "workload_weighted", "performance", "perceived_stress", "coverage_pct",
)  # fmt: skip
_PHASE_FIELDS = ("duration_s", "hr_mean", "hr_delta", "rmssd")
#: Provenance and covariate columns, appended after the phase columns.
_PROVENANCE_COLUMNS = (
    "sensor_source", "simulated", "tz_offset_min", "started_local", "baseline_source",
    "baseline_duration_s", "max_hr", "peak_hr", "hrv_n", "sleep_hours", "caffeine",
    "outcome", "analytics_version",
)  # fmt: skip

#: Column order of the wide per-session CSV (identical to the TypeScript ``SUMMARY_CSV_COLUMNS``).
SUMMARY_CSV_COLUMNS: tuple[str, ...] = (
    _BASE_COLUMNS
    + tuple(f"{p.replace('-', '_')}_{f}" for p in PHASE_ORDER for f in _PHASE_FIELDS)
    + _PROVENANCE_COLUMNS
)

#: ``MetricKey`` (TypeScript ``METRICS``) → column(s) of :func:`summaries_frame`.
#: ``workload`` is always the raw (unweighted) score; ``peakHr`` is the robust peak
#: (``peak_hr``), falling back to the raw maximum for CSVs from older versions.
METRIC_COLUMNS: dict[str, tuple[str, ...]] = {
    "meanHr": ("hr_mean",),
    "peakHr": ("peak_hr", "hr_max"),
    "meanHrDelta": ("mean_hr_delta",),
    "peakHrDelta": ("peak_hr_delta",),
    "rmssd": ("rmssd",),
    "sdnn": ("sdnn",),
    "stressIndex": ("stress_index",),
    "highIntensityPct": ("high_intensity_pct",),
    "episodeCount": ("episode_count",),
    "episodeMinutes": ("episode_minutes",),
    "workload": ("workload_raw",),
    "performance": ("performance",),
    "perceivedStress": ("perceived_stress",),
    "durationMin": ("duration_min",),
    "criticalMeanHr": ("critical_hr_mean",),
    "criticalMeanHrDelta": ("critical_hr_delta",),
    "coveragePct": ("coverage_pct",),
}

#: ``GroupKey`` → column of :func:`summaries_frame` (``month`` and ``none`` are derived).
GROUP_COLUMNS: dict[str, str | None] = {
    "participant": "participant_code",
    "procedure": "procedure_name",
    "specialty": "specialty",
    "approach": "approach",
    "role": "role",
    "trainingLevel": "training_level",
    "urgency": "urgency",
    "month": None,
    "none": None,
}

_TEXT_COLUMNS = {
    "session_id", "participant_code", "training_level", "procedure_name", "specialty",
    "approach", "role", "urgency", "workload_instrument", "sensor_source", "started_local",
    "baseline_source", "outcome", "analytics_version",
}  # fmt: skip


def _finite(x: Any) -> bool:
    return isinstance(x, (int, float, np.integer, np.floating)) and not isinstance(x, bool) and math.isfinite(x)


def _local_iso(epoch_ms: float, tz_offset_min: Any) -> str | None:
    """Local start as ISO 8601 with offset (``…T08:00:00.000+11:00``); ``None`` when the offset is unknown."""
    if not _finite(tz_offset_min):
        return None
    shifted = iso_utc(epoch_ms + tz_offset_min * 60000)
    if not shifted.endswith("Z"):
        return None
    total = abs(js_round(tz_offset_min))
    sign = "-" if tz_offset_min < 0 else "+"
    return f"{shifted[:-1]}{sign}{total // 60:02d}:{total % 60:02d}"


def _flag(b: Any) -> int | None:
    return None if b is None else (1 if b else 0)


def _get(d: Mapping[str, Any] | None, key: str) -> Any:
    return None if d is None else d.get(key)


def _weighted(pairs: Iterable[tuple[float | None, float]]) -> float | None:
    """Duration-weighted mean of non-null values; ``None`` when no weight.

    A single value is returned as is (Σ(v·d)/Σd = v, without the rounding of the
    multiply/divide), which keeps CSVs byte-identical to the TypeScript export.
    """
    vals = [(v, w) for v, w in pairs if v is not None]
    if len(vals) == 1:
        return vals[0][0]
    num = 0.0
    den = 0.0
    for v, w in vals:
        num += v * w
        den += w
    return num / den if den > 0 else None


def summary_row(s: Mapping[str, Any]) -> dict[str, Any]:
    """One wide CSV row (``SUMMARY_CSV_COLUMNS``) from a ``SessionSummary`` dict.

    Percentages are fractions × 100; ``episode_minutes = Σ durationSec / 60``;
    phases that occur several times are duration-weighted; times are ISO-8601 UTC.
    """
    hr, hrv, wl = s.get("hr"), s.get("hrv"), s.get("workload")
    arts, base, q = s.get("rrArtifacts"), s.get("baseline"), s.get("quality") or {}
    hif = s.get("highIntensityFraction")
    episodes = s.get("episodes") or []
    row: dict[str, Any] = {
        "session_id": s["sessionId"],
        "participant_code": s["participantCode"],
        "training_level": s.get("trainingLevel"),
        "started_at": iso_utc(s["startedAt"]),
        "ended_at": iso_utc(s["endedAt"]),
        "procedure_name": s.get("procedureName"),
        "specialty": s.get("specialty"),
        "approach": s.get("approach"),
        "role": s.get("role"),
        "urgency": s.get("urgency"),
        "complexity": s.get("complexity"),
        "duration_min": s["durationSec"] / 60,
        "hr_mean": _get(hr, "mean"),
        "hr_median": _get(hr, "median"),
        "hr_min": _get(hr, "min"),
        "hr_max": _get(hr, "max"),
        "hr_sd": _get(hr, "sd"),
        "hr_p95": _get(hr, "p95"),
        "rmssd": _get(hrv, "rmssd"),
        "sdnn": _get(hrv, "sdnn"),
        "pnn50": _get(hrv, "pnn50"),
        "mean_rr": _get(hrv, "meanRr"),
        "stress_index": s.get("stressIndex"),
        "rr_artifact_pct": arts["ratio"] * 100 if arts is not None else None,
        "baseline_hr": _get(base, "restingHr"),
        "mean_hr_delta": s.get("meanHrDelta"),
        "peak_hr_delta": s.get("peakHrDelta"),
        "high_intensity_pct": hif * 100 if hif is not None else None,
        "episode_count": len(episodes),
        "episode_minutes": naive_sum(e["durationSec"] for e in episodes) / 60,
        "workload_instrument": _get(wl, "instrument"),
        "workload_raw": _get(wl, "raw"),
        "workload_weighted": _get(wl, "weighted"),
        "performance": s.get("performance"),
        "perceived_stress": s.get("perceivedStress"),
        "coverage_pct": q["coverage"] * 100 if q.get("coverage") is not None else None,
    }
    tail: dict[str, Any] = {
        "sensor_source": s.get("sensorSource"),
        "simulated": _flag(s.get("simulated")),
        "tz_offset_min": s.get("tzOffsetMin"),
        "started_local": _local_iso(s["startedAt"], s.get("tzOffsetMin")),
        "baseline_source": _get(base, "source"),
        "baseline_duration_s": (base["endedAt"] - base["startedAt"]) / 1000 if base is not None else None,
        "max_hr": s.get("maxHr"),
        "peak_hr": s.get("peakHr"),
        "hrv_n": _get(hrv, "n"),
        "sleep_hours": s.get("sleepHours"),
        "caffeine": _flag(s.get("caffeine")),
        "outcome": s.get("outcome"),
        "analytics_version": s.get("analyticsVersion"),
    }
    phases = s.get("phases") or []
    for ph in PHASE_ORDER:
        key = ph.replace("-", "_")
        occ = [p for p in phases if p["phase"] == ph]
        if not occ:
            for f in _PHASE_FIELDS:
                row[f"{key}_{f}"] = None
            continue
        row[f"{key}_duration_s"] = naive_sum(p["durationSec"] for p in occ)
        row[f"{key}_hr_mean"] = _weighted((_get(p["hr"], "mean"), p["durationSec"]) for p in occ)
        row[f"{key}_hr_delta"] = _weighted((p.get("meanHrDelta"), p["durationSec"]) for p in occ)
        row[f"{key}_rmssd"] = _weighted((_get(p["hrv"], "rmssd"), p["durationSec"]) for p in occ)
    row.update(tail)
    return row


def _is_summary(x: Any) -> bool:
    return isinstance(x, Mapping) and "sessionId" in x and "quality" in x


def summarize_bundle(source: Any, **summary_options: Any) -> list[dict[str, Any]]:
    """``SessionSummary`` dicts for a bundle / list of sessions / list of summaries (passed through)."""
    if isinstance(source, Mapping) and "sessions" in source:
        items: Sequence[Any] = source["sessions"]
    elif isinstance(source, Mapping):
        items = [source]
    else:
        items = list(source)
    return [dict(x) if _is_summary(x) else summarize_session(x, **summary_options) for x in items]


def summaries_to_csv(source: Any, **summary_options: Any) -> str:
    """Wide per-session CSV text (RFC 4180, CRLF) — the Python twin of ``summariesToCsv``."""
    rows = [summary_row(s) for s in summarize_bundle(source, **summary_options)]
    return to_csv(rows, SUMMARY_CSV_COLUMNS, formula_guard=True)


def summaries_frame(source: Any, **summary_options: Any) -> pd.DataFrame:
    """One row per session with the ``summariesToCsv`` columns.

    ``source`` is a bundle dict, a list of sessions or a list of ``SessionSummary``
    dicts. ``started_at``/``ended_at`` are ``datetime64[ms, UTC]``; text columns
    are ``object``; all other columns are ``float64`` (missing → NaN).
    Keyword options are passed to :func:`~surgeonpulse_analysis.summary.summarize_session`.
    """
    summaries = summarize_bundle(source, **summary_options)
    rows = [summary_row(s) for s in summaries]
    data: dict[str, Any] = {}
    for c in SUMMARY_CSV_COLUMNS:
        vals = [r[c] for r in rows]
        if c in ("started_at", "ended_at"):
            data[c] = _utc([s["startedAt" if c == "started_at" else "endedAt"] for s in summaries])
        elif c in _TEXT_COLUMNS:
            data[c] = pd.Series(vals, dtype="object")
        else:
            data[c] = pd.Series(np.asarray([np.nan if v is None else v for v in vals], dtype="float64"))
    return pd.DataFrame(data, columns=list(SUMMARY_CSV_COLUMNS))


def _missing(v: Any) -> bool:
    return v is None or v is pd.NA or (isinstance(v, float) and np.isnan(v)) or (isinstance(v, str) and v == "")


def metric_values(df: pd.DataFrame, metric: str) -> list[float | None]:
    """Per-row values of a ``MetricKey`` (e.g. ``"meanHr"``) or of any numeric column name."""
    cols = METRIC_COLUMNS.get(metric, (metric,))
    for c in cols:
        if c not in df.columns:
            raise KeyError(f"Unknown metric or column: {metric!r}")
    out: list[float | None] = []
    for i in range(len(df)):
        val = None
        for c in cols:
            v = df[c].iloc[i]
            if not _missing(v):
                val = float(v)
                break
        out.append(val)
    return out


def _group_labels(df: pd.DataFrame, group_by: str) -> list[str]:
    if group_by not in GROUP_COLUMNS:
        raise KeyError(f"Unknown group: {group_by!r} (expected one of {', '.join(GROUP_COLUMNS)})")
    if group_by == "none":
        return ["All"] * len(df)
    if group_by == "month":
        # Local month when the time-zone offset is known (as in the app), else UTC.
        offsets = df["tz_offset_min"].tolist() if "tz_offset_min" in df.columns else [None] * len(df)
        labels = []
        for t, off in zip(df["started_at"].tolist(), offsets):
            if _missing(t):
                labels.append("Unspecified")
                continue
            ts = pd.Timestamp(t).tz_convert("UTC")
            if _finite(off):
                ts = ts + pd.Timedelta(minutes=float(off))
            labels.append(f"{ts.year:04d}-{ts.month:02d}")
        return labels
    col = GROUP_COLUMNS[group_by]
    return ["Unspecified" if _missing(v) else str(v) for v in df[col].tolist()]


def aggregate(df: pd.DataFrame, metric: str, group_by: str = "none") -> pd.DataFrame:
    """Descriptive statistics of a metric per group (Python twin of ``aggregateMetric``).

    Returns columns ``group, n, mean, sd, median, min, max`` (``sd`` is the
    sample SD, 0 for n = 1). Groups with no non-null values are dropped, a
    missing group value becomes ``"Unspecified"``, ``month`` is the
    ``YYYY-MM`` of ``started_at`` in local time when ``tz_offset_min`` is known
    (UTC otherwise) and ``none`` is a single ``"All"`` group.
    Sorted by group name (months chronologically).
    """
    values = metric_values(df, metric)
    labels = _group_labels(df, group_by)
    groups: dict[str, list[float]] = {}
    for g, v in zip(labels, values):
        if v is not None:
            groups.setdefault(g, []).append(v)
    rows = [
        {"group": g, "n": len(vs), "mean": mean(vs), "sd": sample_sd(vs), "median": median(vs), "min": min(vs), "max": max(vs)}
        for g, vs in sorted(groups.items())
    ]
    return pd.DataFrame(rows, columns=["group", "n", "mean", "sd", "median", "min", "max"]).astype(
        {"n": "int64", "mean": "float64", "sd": "float64", "median": "float64", "min": "float64", "max": "float64"}
    )


def _session_order(df: pd.DataFrame) -> list[int]:
    """1-based chronological index of each row within its participant (ties broken by session id)."""
    order = [0] * len(df)
    keyed = sorted(
        range(len(df)),
        key=lambda i: (str(df["participant_code"].iloc[i]), df["started_at"].iloc[i], str(df["session_id"].iloc[i])),
    )
    counter: dict[str, int] = {}
    for i in keyed:
        p = str(df["participant_code"].iloc[i])
        counter[p] = counter.get(p, 0) + 1
        order[i] = counter[p]
    return order


def learning_curve(df: pd.DataFrame, metric: str = "meanHrDelta") -> pd.DataFrame:
    """Per-participant OLS slope of a metric against session number (learning curve).

    ``x`` is each participant's 1-based chronological session number; sessions
    with a missing metric are skipped (they still count towards the numbering).
    Returns ``participant, n, slope, intercept, r2, first, last`` with one row per
    participant plus a final ``"(pooled)"`` row fitted on all participants'
    points (same ``x`` definition; ``first``/``last`` are NaN there). ``slope`` is NaN when a fit is impossible
    (fewer than two sessions). ``t`` is the slope's t statistic (df = n − 2) and ``p_lt_05`` whether
    it differs from 0 at the two-sided 5 % level, assuming independent sessions. The pooled row ignores
    clustering by participant (its ``t`` overstates the evidence); for inference use a mixed model with
    a random intercept and slope per participant. A slope describes change over sessions, not its cause.
    """
    vals = metric_values(df, metric)
    order = _session_order(df)
    codes = [str(c) for c in df["participant_code"].tolist()]
    per: dict[str, list[tuple[int, float]]] = {}
    for c, x, y in zip(codes, order, vals):
        per.setdefault(c, [])
        if y is not None:
            per[c].append((x, y))
    rows = []

    def fit_row(label: str, pts: list[tuple[int, float]]) -> dict[str, Any]:
        pts = sorted(pts)
        fit = linear_trend(pts)
        t, sig = _slope_t(fit)
        return {
            "participant": label,
            "n": len(pts),
            "slope": fit["slope"] if fit else np.nan,
            "intercept": fit["intercept"] if fit else np.nan,
            "r2": fit["r2"] if fit else np.nan,
            "first": pts[0][1] if pts else np.nan,
            "last": pts[-1][1] if pts else np.nan,
            "t": t,
            "p_lt_05": sig,
        }

    for c in sorted(per):
        rows.append(fit_row(c, per[c]))
    pooled = fit_row("(pooled)", [p for c in sorted(per) for p in per[c]])
    pooled["first"] = pooled["last"] = np.nan  # not meaningful across participants
    rows.append(pooled)
    return pd.DataFrame(rows, columns=["participant", "n", "slope", "intercept", "r2", "first", "last", "t", "p_lt_05"])


def _slope_t(fit: Mapping[str, Any] | None) -> tuple[float, bool]:
    """t statistic of an OLS slope (df = n − 2) and whether two-sided p < 0.05 (as the app's ``trendEvidence``)."""
    if fit is None or fit["n"] < 3 or fit["slope"] == 0:
        return (np.nan if fit is None or fit["n"] < 3 else 0.0), False
    if fit["r2"] >= 1:
        return np.nan, True
    t = math.copysign(math.sqrt(fit["r2"] * (fit["n"] - 2) / (1 - fit["r2"])), fit["slope"])
    crit = t_critical_95(fit["n"] - 2)
    return t, crit is not None and abs(t) >= crit


def phase_profile(df: pd.DataFrame) -> pd.DataFrame:
    """Mean heart-rate response by operative phase across sessions.

    One row per phase in ``PHASE_ORDER`` with ``n`` (sessions where the phase
    occurred), mean phase duration (min), mean HR, mean / SD / median HR delta
    from baseline and mean RMSSD. Missing statistics are NaN.
    """
    rows = []
    for ph in PHASE_ORDER:
        key = ph.replace("-", "_")

        def col(f: str) -> list[float]:
            return [float(v) for v in df[f"{key}_{f}"].tolist() if not _missing(v)]

        dur, hrm, delta, rmssd = col("duration_s"), col("hr_mean"), col("hr_delta"), col("rmssd")
        rows.append(
            {
                "phase": ph,
                "n": len(dur),
                "duration_min_mean": (mean(dur) / 60) if dur else np.nan,
                "hr_mean": mean(hrm) if hrm else np.nan,
                "hr_delta_mean": mean(delta) if delta else np.nan,
                "hr_delta_sd": sample_sd(delta) if delta else np.nan,
                "hr_delta_median": median(delta) if delta else np.nan,
                "rmssd_mean": mean(rmssd) if rmssd else np.nan,
            }
        )
    return pd.DataFrame(rows)


def _fmt(v: Any, digits: int = 1) -> str:
    if _missing(v):
        return "-"
    if isinstance(v, (int, np.integer)):
        return str(int(v))
    return f"{float(v):.{digits}f}"


def _table(df: pd.DataFrame, digits: int = 1) -> str:
    """Plain-ASCII fixed-width table (safe for any console encoding)."""
    headers = [str(c) for c in df.columns]
    rows = list(df.itertuples(index=False))
    body = [[v if isinstance(v, str) else _fmt(v, digits) for v in row] for row in rows]
    is_text = [all(isinstance(row[i], str) for row in rows) if rows else True for i in range(len(headers))]
    widths = [max([len(h)] + [len(r[i]) for r in body]) for i, h in enumerate(headers)]

    def fmt_line(cells: Sequence[str]) -> str:
        return "  ".join(c.ljust(w) if t else c.rjust(w) for c, w, t in zip(cells, widths, is_text)).rstrip()

    return "\n".join([fmt_line(headers), fmt_line(["-" * w for w in widths])] + [fmt_line(r) for r in body])


def cohort_report(source: Any, **summary_options: Any) -> str:
    """Human-readable plain-text cohort report (ASCII only, so it prints on every console)."""
    if isinstance(source, pd.DataFrame):
        df = source
    else:
        df = summaries_frame(source, **summary_options)
    n = len(df)
    lines = ["SurgeonPulse cohort report", "=" * 26, ""]
    if n == 0:
        return "\n".join(lines + ["No valid sessions."]) + "\n"
    first, last = df["started_at"].min(), df["started_at"].max()
    lines += [
        f"Sessions: {n}    Participants: {df['participant_code'].nunique()}",
        f"Period:   {iso_utc(first.value // 1_000_000)[:10]} to {iso_utc(last.value // 1_000_000)[:10]} (UTC)",
        f"Total recorded time: {_fmt(df['duration_min'].sum() / 60, 1)} h; mean coverage {_fmt(df['coverage_pct'].mean(), 1)} %",
        "",
        "Per participant (mean over sessions)",
        "-" * 36,
    ]
    per = []
    for code in sorted(df["participant_code"].unique()):
        sub = df[df["participant_code"] == code]
        lvl = sub["training_level"].dropna()
        per.append(
            {
                "participant": str(code),
                "level": str(lvl.iloc[0]) if len(lvl) else "-",
                "sessions": int(len(sub)),
                "hr_mean": sub["hr_mean"].mean(),
                "hr_delta": sub["mean_hr_delta"].mean(),
                "rmssd": sub["rmssd"].mean(),
                "workload": pd.Series(metric_values(sub, "workload"), dtype="float64").mean(),
                "episodes": sub["episode_count"].mean(),
            }
        )
    lines += [_table(pd.DataFrame(per)), "", "Heart-rate response by phase (delta = HR - resting baseline, bpm)", "-" * 64]
    lines += [_table(phase_profile(df)), "", "Learning curves: change in mean HR delta per session (bpm/session)", "-" * 66]
    lc = learning_curve(df, "meanHrDelta")
    lines += [_table(lc, 2), ""]
    pooled = lc[lc["participant"] == "(pooled)"]["slope"].iloc[0]
    if not _missing(pooled):
        per_rows = lc[lc["participant"] != "(pooled)"]
        n_sig = int(per_rows["p_lt_05"].sum())
        lines.append(
            f"Pooled slope: {pooled:+.2f} bpm/session (naive OLS over every participant's sessions; it ignores "
            "clustering by participant, so it is descriptive only - use a mixed model with a random intercept "
            "and slope per participant for inference)."
        )
        lines.append(
            f"Participants whose own slope differs from 0 (p < 0.05): {n_sig} of {len(per_rows)}. A slope "
            "describes change over sessions, not its cause (case mix, workload and baseline conditions also vary)."
        )
        lines.append("")
    lines += ["Mean HR delta by training level", "-" * 31, _table(aggregate(df, "meanHrDelta", "trainingLevel")), ""]
    lines += ["Workload (SURG-TLX / NASA-TLX, raw score) by procedure", "-" * 54, _table(aggregate(df, "workload", "procedure")), ""]
    return "\n".join(lines) + "\n"

