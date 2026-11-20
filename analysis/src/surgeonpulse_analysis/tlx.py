"""Post-operative workload questionnaires (SURG-TLX and NASA-TLX).

Python port of ``instruments/tlx.ts`` (SPEC.md § instruments/tlx.ts).

References
----------
* Wilson M.R., Poolton J.M., Malhotra N., Ngo K., Bright E. & Masters R.S.W.
  (2011). Development and validation of a surgical workload measure: the
  Surgery Task Load Index (SURG-TLX). *World J Surg* 35(9):1961–1969.
* Hart S.G. & Staveland L.E. (1988). Development of NASA-TLX (Task Load
  Index): results of empirical and theoretical research. *Adv Psychol*
  52:139–183.
"""

from __future__ import annotations

from typing import Any, Mapping

from .stats import is_finite_number, naive_sum

__all__ = ["SURG_TLX_DIMENSIONS", "NASA_TLX_DIMENSIONS", "dimensions_for", "tlx_pairs", "score_workload"]

#: SURG-TLX dimensions (Wilson et al. 2011), in canonical order.
SURG_TLX_DIMENSIONS: tuple[dict[str, str], ...] = (
    {"id": "mental", "label": "Mental Demands", "question": "How mentally fatiguing was the procedure?", "low": "Very low", "high": "Very high"},
    {"id": "physical", "label": "Physical Demands", "question": "How physically fatiguing was the procedure?", "low": "Very low", "high": "Very high"},
    {"id": "temporal", "label": "Temporal Demands", "question": "How hurried or rushed was the pace of the procedure?", "low": "Very low", "high": "Very high"},
    {"id": "complexity", "label": "Task Complexity", "question": "How complex was the procedure?", "low": "Very low", "high": "Very high"},
    {"id": "stress", "label": "Situational Stress", "question": "How anxious did you feel while performing the procedure?", "low": "Very low", "high": "Very high"},
    {"id": "distraction", "label": "Distractions", "question": "How distracting was the operating environment?", "low": "Very low", "high": "Very high"},
)

#: NASA-TLX dimensions (Hart & Staveland 1988), in canonical order.
NASA_TLX_DIMENSIONS: tuple[dict[str, str], ...] = (
    {"id": "mental", "label": "Mental Demand", "question": "How mentally demanding was the task?", "low": "Very low", "high": "Very high"},
    {"id": "physical", "label": "Physical Demand", "question": "How physically demanding was the task?", "low": "Very low", "high": "Very high"},
    {"id": "temporal", "label": "Temporal Demand", "question": "How hurried or rushed was the pace of the task?", "low": "Very low", "high": "Very high"},
    {"id": "performance", "label": "Performance", "question": "How successful were you in accomplishing what you were asked to do?", "low": "Perfect", "high": "Failure"},
    {"id": "effort", "label": "Effort", "question": "How hard did you have to work to accomplish your level of performance?", "low": "Very low", "high": "Very high"},
    {"id": "frustration", "label": "Frustration", "question": "How insecure, discouraged, irritated, stressed and annoyed were you?", "low": "Very low", "high": "Very high"},
)


def dimensions_for(instrument: str) -> tuple[str, ...]:
    """Dimension ids of ``"surg-tlx"`` or ``"nasa-tlx"``."""
    dims = SURG_TLX_DIMENSIONS if instrument == "surg-tlx" else NASA_TLX_DIMENSIONS
    return tuple(d["id"] for d in dims)


def tlx_pairs(instrument: str) -> list[tuple[str, str]]:
    """The 15 unordered dimension pairs for the pairwise-weighting step, in fixed order."""
    ids = dimensions_for(instrument)
    return [(ids[i], ids[j]) for i in range(len(ids)) for j in range(i + 1, len(ids))]


def _clamp(x: float) -> float:
    return min(100, max(0, x))


def score_workload(resp: Mapping[str, Any]) -> dict[str, Any]:
    """Score a SURG-TLX / NASA-TLX response (SPEC ``scoreWorkload``).

    ``raw`` is the mean of the six ratings, each clamped to [0, 100].
    ``weighted = Σ(rating·weight)/15`` and is only computed when weights exist,
    every weight is an integer 0–5 and they sum to 15; otherwise ``None``.
    ``dimensions`` holds the clamped ratings.
    """
    instrument = resp.get("instrument", "surg-tlx")
    ids = dimensions_for(instrument)
    ratings = resp.get("ratings") or {}
    dims: dict[str, float] = {}
    for d in ids:
        v = ratings.get(d)
        if is_finite_number(v):
            dims[d] = _clamp(v)
    raw = naive_sum(dims.values()) / len(dims) if dims else 0
    weighted = None
    weights = resp.get("weights")
    if isinstance(weights, Mapping) and len(dims) == len(ids):
        ws = [weights.get(d) for d in ids]
        if all(is_finite_number(w) and float(w).is_integer() and 0 <= w <= 5 for w in ws) and naive_sum(ws) == 15:
            weighted = naive_sum(dims[d] * w for d, w in zip(ids, ws)) / 15
    return {"instrument": instrument, "raw": raw, "weighted": weighted, "dimensions": dims}
