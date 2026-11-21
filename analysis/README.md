# surgeonpulse-analysis

The Python research toolkit for SurgeonPulse exports. It does three things:

- **Re-implements the analytics** of `@surgeonpulse/core` (heart rate, HRV, zones, phases, stress
  episodes, data quality and SURG-TLX). It was written independently from
  [`packages/core/SPEC.md`](../packages/core/SPEC.md), and the summary dicts use the same camelCase
  keys as the TypeScript `SessionSummary`.
- **Builds tidy pandas DataFrames** from an export: `sessions`, `samples`, `rr`, `events` and
  `participants`. `t` is `datetime64[ms, UTC]` and `t_offset_s` is the time since the session started.
- **Supports cohort analysis.** You get one wide row per session (the same columns as the app's
  `summariesToCsv`, ready for SPSS/R/Stata), grouped statistics, per-surgeon learning curves and
  phase profiles.

The TypeScript and Python implementations are checked against each other on every CI run, on
Linux, Windows and macOS (see [Parity](#parity-with-the-typescript-implementation)).

## Install

Requires Python ≥ 3.10, numpy and pandas. Run these commands from the repository root:

```bash
python -m venv .venv
# macOS / Linux:
source .venv/bin/activate
# Windows (PowerShell):
.venv\Scripts\Activate.ps1

python -m pip install -e "analysis[dev]"     # dev extra = pytest
```

This installs the `surgeonpulse` command. `python -m surgeonpulse_analysis …` does the same thing,
which is handy if the scripts directory isn't on your `PATH` (common on Windows).

## Command line

```bash
# One wide CSV row per session (same columns as the app / dashboard export)
surgeonpulse summarize export.json -o summaries.csv
surgeonpulse summarize export.json --max-hr 185 --episode-threshold 95 > summaries.csv

# Tidy long-format CSVs: samples.csv, rr.csv, events.csv, sessions.csv, participants.csv
surgeonpulse frames export.json -o outdir/

# Plain-text cohort report (participants, phase profile, learning curves, workload)
surgeonpulse report export.json
surgeonpulse report export.json -o report.txt
```

`summarize` and `report` take the same summary options (`SummaryOptions` in the TypeScript core):
`--max-hr` (max HR in bpm for every session), `--at-year` (year for the age-predicted max HR; default
the session's year), `--episode-threshold` (stress-episode threshold in bpm) and `--max-gap-ms` (the
longest sample spacing treated as continuous for coverage, zone time and stress episodes). Without
`--max-gap-ms` the gap rule is chosen per session: 5000 ms for most sources (BLE / Web Bluetooth
straps, simulated, import), and for `healthkit` / `health-connect` sessions 1.5 × the median spacing of
consecutive valid samples, clamped to 5000–900000 ms (15 min), or 5000 ms when there is no spacing.
`surgeonpulse summarize --help` lists them.

`export.json` can be an export bundle (`format: "surgeonpulse-export"`), a single session, or a
JSON array of sessions. That's the same input the app's `parseImport` accepts. Invalid sessions are
skipped, and a warning on stderr names the session index and the field at fault.

All CSVs follow RFC 4180 with CRLF line endings and UTF-8 encoding. Numbers are formatted like
JavaScript's `String(n)` and times as ISO-8601 UTC (`2026-01-05T08:00:00.000Z`). As a result,
`samples.csv`, `rr.csv` and `events.csv` are **byte-identical** to the files the app produces (the
parity tests compare them byte for byte), and `summaries.csv` has the same columns in the same order
with the same values (compared cell by cell, numbers within the parity tolerance).

## Python API

```python
from surgeonpulse_analysis import (
    load_export, sessions_to_frames, summarize_session, summaries_frame,
    aggregate, learning_curve, phase_profile,
)

bundle = load_export("export.json")          # dict: participants, sessions, …

# Per-session analytics (same keys as the TypeScript SessionSummary)
s = summarize_session(bundle["sessions"][0], max_hr=185)
s["hrv"]["rmssd"], s["quality"]["coverage"], s["phases"][0]["meanHrDelta"]

# Tidy frames for plotting / mixed models
frames = sessions_to_frames(bundle)
samples = frames["samples"]                  # session_id, participant_code, t, t_ms, t_offset_s, bpm, contact, phase
samples.groupby(["participant_code", "phase"])["bpm"].mean()

# Cohort analysis
df = summaries_frame(bundle)                 # one row per session, summariesToCsv columns
aggregate(df, "meanHrDelta", "trainingLevel")   # group, n, mean, sd, median, min, max
learning_curve(df, "criticalMeanHrDelta")       # OLS slope, t and p_lt_05 per participant + pooled
phase_profile(df)                               # mean HR / HR delta / RMSSD by operative phase
```

`aggregate` and `learning_curve` accept the app's metric keys (`meanHr`, `peakHr`, `meanHrDelta`,
`peakHrDelta`, `rmssd`, `sdnn`, `stressIndex`, `highIntensityPct`, `episodeCount`,
`episodeMinutes`, `workload`, `performance`, `perceivedStress`, `durationMin`, `criticalMeanHr`,
`criticalMeanHrDelta`, `coveragePct`) or any numeric column name. `workload` is always the raw TLX
score (`workload_raw`), and `peakHr` reads the robust peak `peak_hr` (falling back to `hr_max` for
older files). The group keys are `participant`, `procedure`, `specialty`, `approach`, `role`,
`trainingLevel`, `urgency`, `month` (local month when `tz_offset_min` is known) and `none`.

`learning_curve` returns `participant, n, slope, intercept, r2, first, last, t, p_lt_05`: `t` is the
slope's t statistic (df = n − 2) and `p_lt_05` whether it differs from 0 at the two-sided 5 % level,
assuming independent sessions. The final `"(pooled)"` row ignores clustering by participant, so it is
**descriptive only**; for inference use a mixed model with a random intercept and slope per
participant. `surgeonpulse report` words the pooled slope the same way and counts the participants
whose own slope is significant.

`summaries_frame` includes the `simulated` and `analytics_version` columns: drop rows with
`simulated == 1`, and do not pool rows computed by different analytics versions.

Function names are snake_case ports of the TypeScript names (`cleanRr` → `clean_rr`,
`summarizeSession` → `summarize_session`), and options become keyword arguments
(`{minIntervals: 20}` → `min_intervals=20`). Where TypeScript returns `null`, these functions
return `None`, and they never produce NaN or ∞. DataFrames use NaN for missing values, as pandas
normally does.

## Metrics and definitions

| Metric (summary key / CSV column) | Definition | Reference |
| --- | --- | --- |
| `hr.mean/median/min/max/sd/p95` (`hr_*`) | Over valid samples (finite, 25–250 bpm, not recorded with `contact: false`), not time-weighted; SD with n−1; p95 by linear interpolation (NumPy `linear`) | Hyndman & Fan 1996 (def. 7) |
| `peakHr` (`peak_hr`) | Robust peak: highest 11-s rolling median of the valid samples | — |
| Artefact rejection (`rr_artifact_pct`) | RR outside 300–2000 ms, or deviating > 20 % from the median of the ±5 neighbouring valid beats | Task Force 1996 (editing of ectopic beats/artefacts) |
| `hrv.meanRr`, `sdnn` | Mean and sample SD of all valid RR intervals; whole-session HRV and the stress index are `None` when more than 10 % of intervals are artefacts | Task Force of ESC/NASPE 1996 |
| `hrv.rmssd` | √(mean of squared successive differences), using only valid pairs within a contiguous run (a gap > 3 s + RR starts a new run) | Task Force 1996 |
| `hrv.pnn50` | % of valid successive differences with \|Δ\| > 50 ms | Task Force 1996 |
| `stressIndex` (`stress_index`) | Baevsky SI = AMo / (2·Mo·MxDMn), 50 ms bins, Mo and MxDMn in seconds, AMo in % (raw SI, not √SI); the summary value is the median over 5-min windows with ≥ 4 min of clean beats | Baevsky & Chernikova 2017 |
| `maxHr` | Override → participant `maxHr` → 208 − 0.7·age, rounded half-up | Tanaka, Monahan & Seals 2001 |
| `zones` | Baseline zones (rest+10/20/30 bpm) when a baseline exists, else 60/70/80/90 % of HRmax; time-weighted dwell, gaps capped at `maxGapMs` (5 s for straps; 1.5 × median sample spacing, 5 s–15 min, for Apple Health / Health Connect) | — |
| `highIntensityFraction` (`high_intensity_pct`) | Time-weighted fraction with HR ≥ 70 % HRmax | — |
| `baseline` / `meanHrDelta` / `peakHrDelta` | Measured pre-op resting HR over the configured window (default 3 min, 1–5 min, minimum 60 s; see `baseline.startedAt`/`endedAt` and `baseline_duration_s`), else profile resting HR; delta = session (or phase) mean − resting, peak delta = `peakHr` − resting | — |
| `phases` (`<phase>_*`) | Segments from phase markers; per-phase HR stats, HRV (≥ 20 intervals, phase ≥ 60 s, ≤ 10 % artefacts) and HR delta; repeated phases are duration-weighted in the CSV | — |
| `episodes` (`episode_count/minutes`) | Runs with HR ≥ threshold (rest + 20 bpm, else median + 15), merged across ≤ 30 s, kept if ≥ 60 s; peak, mean, phase at peak, events from 2 min before | — |
| `quality.coverage` (`coverage_pct`) | Covered time (gaps capped at `maxGapMs`, clipped to the session) ÷ duration | — |
| `workload.raw` / `weighted` | SURG-TLX: mean of the 6 ratings (0–100); weighted = Σ(rating·weight)/15 when the 15 pairwise tallies are valid. The cross-session metric `workload` is the raw score | Wilson et al. 2011; Hart & Staveland 1988 |
| learning curve slope | OLS slope of a metric against each surgeon's session number, with a slope t-test (`t`, `p_lt_05`) | — |

References:

- Task Force of the European Society of Cardiology and the North American Society of Pacing and
  Electrophysiology (1996). Heart rate variability: standards of measurement, physiological
  interpretation and clinical use. *Circulation* 93:1043–1065.
- Baevsky R.M., Chernikova A.G. (2017). Heart rate variability analysis: physiological foundations
  and main methods. *Cardiometry* 10:66–76.
- Tanaka H., Monahan K.D., Seals D.R. (2001). Age-predicted maximal heart rate revisited. *J Am
  Coll Cardiol* 37:153–156.
- Wilson M.R., Poolton J.M., Malhotra N., Ngo K., Bright E., Masters R.S.W. (2011). Development
  and validation of a surgical workload measure: the Surgery Task Load Index (SURG-TLX). *World J
  Surg* 35:1961–1969.
- Hart S.G., Staveland L.E. (1988). Development of NASA-TLX. *Advances in Psychology* 52:139–183.
- Hyndman R.J., Fan Y. (1996). Sample quantiles in statistical packages. *Am Stat* 50:361–365.

## Parity with the TypeScript implementation

`packages/core/scripts/generate-fixtures.ts` uses the public API of `@surgeonpulse/core` to write
simulated and hand-built sessions, a small cohort bundle and the expected outputs to
[`/fixtures`](../fixtures/README.md). `tests/test_parity.py` recomputes all of it in Python and
compares the results field by field:

- **Exact:** counts, ids, timestamps, strings and booleans.
- **Within tolerance:** all other numbers, with `rtol = 1e-9` and `atol = 1e-6`.
- **Byte-for-byte:** the samples/RR/events CSVs.

```bash
# regenerate fixtures after changing the TypeScript analytics (deterministic output)
npm run fixtures -w @surgeonpulse/core

# run the Python tests (unit + parity); either works from a plain checkout
cd analysis && python -m pytest -q
python -m pytest -q analysis
```

CI fails when `fixtures/` is stale. Suppose a mismatch turns out to come from the TypeScript side
violating SPEC.md. In that case, add the check id to `TS_DISCREPANCIES` in `tests/test_parity.py`.
The check is then marked `xfail(strict=True)`, so the suite stays green until TypeScript is fixed,
and then fails so you remember to remove the mark. **The list is currently empty: every check
agrees.**

## Cross-platform notes

The toolkit runs unchanged on Windows, macOS and Linux, and CI runs the tests on all three with
Python 3.10 and 3.13. It relies on these choices:

- Files are read as UTF-8, and a BOM written by a Windows editor is accepted. Files are written as
  UTF-8 with `newline=""`, so CRLF is never doubled. CSV sent to stdout is written as bytes.
- Times are computed from the Unix epoch with `timedelta`, not with `time.localtime` or
  `fromtimestamp`, which fail for negative values on Windows. ISO strings are formatted field by
  field, because `strftime("%Y")` isn't zero-padded on every platform.
- Integer columns are explicitly `int64`. NumPy < 2 defaults to 32-bit integers on Windows, which
  would overflow epoch milliseconds.
- Summation runs left to right, as in JavaScript, rather than with Python ≥ 3.12's compensated
  `sum`. Rounding uses JavaScript's half-up `Math.round`, not Python's banker's rounding. Both
  keep results identical to the app.
- The report is plain ASCII, so it prints on any console code page.
- `fixtures/.gitattributes` turns off end-of-line conversion, so Git on Windows can't rewrite the
  byte-compared fixtures.
