"""SurgeonPulse research toolkit.

A Python port of the analytics in ``@surgeonpulse/core`` (see
``packages/core/SPEC.md``), cross-checked against the TypeScript implementation
with the shared fixtures in ``/fixtures``. Summary dicts use the same camelCase
keys as the TypeScript ``SessionSummary``.

Quick start::

    from surgeonpulse_analysis import load_export, summaries_frame, sessions_to_frames
    bundle = load_export("export.json")
    df = summaries_frame(bundle)              # one wide row per session
    frames = sessions_to_frames(bundle)       # tidy samples / rr / events / sessions / participants
"""

from __future__ import annotations

__version__ = "0.1.0"

from .cohort import (
    METRIC_COLUMNS,
    SUMMARY_CSV_COLUMNS,
    aggregate,
    cohort_report,
    learning_curve,
    phase_profile,
    summaries_frame,
    summaries_to_csv,
    summarize_bundle,
    summary_row,
)
from .episodes import default_episode_threshold, detect_stress_episodes
from .hrv import baevsky_stress_index, clean_rr, compute_hrv, hrv_time_domain, rolling_hrv
from .io import (
    ExportWarning,
    SessionParseError,
    frames_to_csv,
    iso_utc,
    js_number_str,
    load_export,
    parse_csv,
    parse_import,
    parse_session,
    sessions_to_frames,
    to_csv,
)
from .phases import MARKER_KINDS, PHASE_ORDER, derive_phases, phase_at, session_end
from .stats import (
    detect_gaps,
    hr_stats,
    linear_trend,
    mean,
    median,
    moving_average,
    percentile,
    sample_sd,
    slice_by_time,
)
from .summary import compute_baseline, data_quality, summarize_session
from .tlx import NASA_TLX_DIMENSIONS, SURG_TLX_DIMENSIONS, score_workload, tlx_pairs
from .zones import estimate_max_hr, time_in_zones, zones_from_baseline, zones_from_max_hr

__all__ = [
    "__version__",
    # io
    "load_export", "parse_import", "parse_session", "sessions_to_frames", "frames_to_csv",
    "to_csv", "parse_csv", "iso_utc", "js_number_str", "SessionParseError", "ExportWarning",
    # stats / hr
    "mean", "median", "sample_sd", "percentile", "linear_trend", "moving_average",
    "hr_stats", "slice_by_time", "detect_gaps",
    # hrv
    "clean_rr", "hrv_time_domain", "compute_hrv", "rolling_hrv", "baevsky_stress_index",
    # zones / phases / episodes
    "estimate_max_hr", "zones_from_max_hr", "zones_from_baseline", "time_in_zones",
    "PHASE_ORDER", "MARKER_KINDS", "session_end", "derive_phases", "phase_at",
    "default_episode_threshold", "detect_stress_episodes",
    # instruments
    "SURG_TLX_DIMENSIONS", "NASA_TLX_DIMENSIONS", "tlx_pairs", "score_workload",
    # summary / cohort
    "compute_baseline", "data_quality", "summarize_session",
    "SUMMARY_CSV_COLUMNS", "METRIC_COLUMNS", "summary_row", "summarize_bundle", "summaries_to_csv",
    "summaries_frame", "aggregate", "learning_curve", "phase_profile", "cohort_report",
]  # fmt: skip
