"""Command-line interface: ``surgeonpulse`` (or ``python -m surgeonpulse_analysis``).

Examples::

    surgeonpulse summarize export.json -o summaries.csv
    surgeonpulse frames export.json -o outdir/
    surgeonpulse report export.json

Works the same on Windows, macOS and Linux: paths go through :mod:`pathlib`,
files are written as UTF-8 with explicit CRLF line endings (RFC 4180) and
without newline translation, CSV on standard output is written as bytes (so
Windows does not turn ``\\r\\n`` into ``\\r\\r\\n``), and the text report is
plain ASCII.
"""

from __future__ import annotations

import argparse
import sys
import warnings
from pathlib import Path
from typing import Sequence

from . import __version__
from .cohort import cohort_report, summaries_to_csv
from .io import ExportWarning, SessionParseError, frames_to_csv, load_export, sessions_to_frames, write_text

__all__ = ["main", "build_parser"]


def _summary_kwargs(args: argparse.Namespace) -> dict[str, float]:
    out: dict[str, float] = {}
    if args.max_hr is not None:
        out["max_hr"] = args.max_hr
    if args.at_year is not None:
        out["at_year"] = args.at_year
    if args.episode_threshold is not None:
        out["episode_threshold_bpm"] = args.episode_threshold
    if args.max_gap_ms is not None:
        out["max_gap_ms"] = args.max_gap_ms
    return out


def _add_summary_options(p: argparse.ArgumentParser) -> None:
    g = p.add_argument_group("summary options (SummaryOptions)")
    g.add_argument("--max-hr", type=float, help="override max HR (bpm) for every session")
    g.add_argument("--at-year", type=int, help="year used for age-predicted max HR (default: session year)")
    g.add_argument("--episode-threshold", type=float, help="stress-episode threshold in bpm")
    g.add_argument(
        "--max-gap-ms",
        type=float,
        help=(
            "longest sample spacing (ms) treated as continuous for coverage, zone time and stress episodes "
            "(default: per session, 5000 for most sources such as chest straps; for healthkit / health-connect "
            "sessions 1.5 x the median spacing of consecutive valid samples, clamped to 5000-900000 ms (15 min))"
        ),
    )


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="surgeonpulse",
        description="SurgeonPulse research toolkit: summarise exports, write tidy CSVs, print cohort reports.",
    )
    parser.add_argument("--version", action="version", version=f"%(prog)s {__version__}")
    sub = parser.add_subparsers(dest="command", required=True)

    p = sub.add_parser("summarize", help="one wide CSV row per session (same columns as the app's summariesToCsv)")
    p.add_argument("export", type=Path, help="export bundle, single session or list of sessions (.json)")
    p.add_argument("-o", "--output", type=Path, help="output CSV path (default: standard output)")
    _add_summary_options(p)

    p = sub.add_parser("frames", help="write tidy samples/rr/events/sessions/participants CSVs")
    p.add_argument("export", type=Path)
    p.add_argument("-o", "--outdir", type=Path, default=Path("."), help="output directory (created if missing)")

    p = sub.add_parser("report", help="print a plain-text cohort report")
    p.add_argument("export", type=Path)
    p.add_argument("-o", "--output", type=Path, help="also write the report to this file")
    _add_summary_options(p)
    return parser


def _write_stdout(text: str) -> None:
    buf = getattr(sys.stdout, "buffer", None)
    if buf is not None:
        sys.stdout.flush()
        buf.write(text.encode("utf-8"))
        buf.flush()
    else:  # e.g. captured by a test harness
        sys.stdout.write(text)


def main(argv: Sequence[str] | None = None) -> int:
    """Entry point of the ``surgeonpulse`` console script. Returns a process exit code."""
    args = build_parser().parse_args(argv)
    try:
        with warnings.catch_warnings(record=True) as caught:
            warnings.simplefilter("always", ExportWarning)
            bundle = load_export(args.export)
        for w in caught:
            print(f"warning: {w.message}", file=sys.stderr)
    except FileNotFoundError:
        print(f"error: file not found: {args.export}", file=sys.stderr)
        return 2
    except SessionParseError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1

    if args.command == "summarize":
        text = summaries_to_csv(bundle, **_summary_kwargs(args))
        if args.output is None:
            _write_stdout(text)
        else:
            write_text(args.output, text)
            print(f"Wrote {len(bundle['sessions'])} session(s) to {args.output}", file=sys.stderr)
        return 0

    if args.command == "frames":
        texts = frames_to_csv(sessions_to_frames(bundle))
        for name, text in texts.items():
            write_text(Path(args.outdir) / f"{name}.csv", text)
        print(f"Wrote {', '.join(f'{n}.csv' for n in texts)} to {args.outdir}", file=sys.stderr)
        return 0

    if args.command == "report":
        text = cohort_report(bundle, **_summary_kwargs(args))
        print(text, end="")
        if args.output is not None:
            write_text(args.output, text)
        return 0

    return 2  # pragma: no cover - argparse enforces the sub-command


if __name__ == "__main__":  # pragma: no cover
    sys.exit(main())
