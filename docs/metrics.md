# Metrics and definitions

This document defines every physiological, self-report and cross-session metric that SurgeonPulse computes, **as
implemented** in [`@surgeonpulse/core`](../packages/core/SPEC.md). The mobile app, the dashboard and the ingest server
all call the same core functions. The Python toolkit in [`analysis/`](../analysis/README.md) re-implements them, and CI
checks that both give the same answers (see [Parity](#parity-between-typescript-and-python)).

Each section gives the definition, the defaults, an interpretation note and the main caveats. Formulas are written in
plain text. `x[i]` is the i-th value, `n` the number of values, `Σ` a sum.

> **Research measures, not clinical ones.** These metrics describe the participating surgeon's own physiology and
> self-reported workload. They are not validated for diagnosis or for judging competence, and SurgeonPulse does not
> monitor patients. Thresholds marked "project default" were chosen for this prototype. They are not validated cut-offs.

Contents:
[Conventions](#conventions) ·
[Heart-rate statistics](#heart-rate-statistics) ·
[Time weighting](#time-weighting-dwell-time) ·
[Data quality](#data-quality) ·
[RR artefact cleaning](#rr-artefact-cleaning) ·
[Time-domain HRV](#time-domain-hrv) ·
[Rolling HRV](#rolling-hrv) ·
[Baevsky stress index](#baevsky-stress-index) ·
[Maximum HR and zones](#maximum-heart-rate-and-zones) ·
[Baseline](#resting-baseline) ·
[Deltas](#heart-rate-above-baseline) ·
[Phases](#phase-segmentation) ·
[Stress episodes](#stress-episodes) ·
[Workload](#workload-surg-tlx-and-nasa-tlx) ·
[Cross-session metrics](#cross-session-metrics) ·
[Insights](#insight-rules) ·
[Cohort aggregation](#cohort-aggregation) ·
[General caveats](#general-caveats-for-interpretation) ·
[References](#references)

## Conventions

| Item | Rule |
| --- | --- |
| Time | UTC epoch milliseconds. Durations in the outputs are in seconds unless the name says otherwise. |
| Valid heart-rate sample | `isValidBpm(bpm)`: a finite number within **[25, 250] bpm**, inclusive. Anything else (for example `0` sent by a strap without skin contact) is ignored by every HR metric. |
| Missing data | Functions return `null` when there is not enough data. No output is ever `NaN` or `Infinity`. |
| Rounding | Halves round up (JavaScript `Math.round`). The Python port uses `floor(x + 0.5)` to match. |
| Gap threshold | `maxGapMs` defaults to **5000 ms**. Two consecutive samples further apart than this are treated as a data gap. A `NaN` value also means 5000. |
| Session end | `sessionEnd(session)` = `endedAt`, else the latest sample, RR or event time, else `startedAt`. |

## Heart-rate statistics

Function: `hrStats(samples)` in [`analytics/hr.ts`](../packages/core/src/analytics/hr.ts). Output type `HrStats`.

| Field | Definition |
| --- | --- |
| `count` | Number of valid samples |
| `mean` | `Σ bpm / n` |
| `median` | Middle value of the sorted values; mean of the two middle values when `n` is even |
| `min`, `max` | Smallest and largest valid value |
| `sd` | Sample standard deviation with the `n − 1` denominator (two-pass algorithm); `0` when `n = 1` |
| `p95` | 95th percentile by linear interpolation: on the sorted values `s`, `rank = 0.95 · (n − 1)`, result = `s[floor(rank)] + (rank − floor(rank)) · (s[floor(rank) + 1] − s[floor(rank)])`. This is NumPy's default `linear` method (Hyndman & Fan definition 7). |

Returns `null` when no valid sample exists.

**These statistics are not time-weighted.** Every sample counts once, however long it represents. With a steady 1 Hz
strap this makes no practical difference. With irregular data (dropouts, or sparse watch data imported from a health
store) dense periods count more than sparse ones.

The whole-session values appear in the summary as `hr` and in the summary CSV as `hr_mean`, `hr_median`, `hr_min`,
`hr_max`, `hr_sd` and `hr_p95`. Per-phase values use the samples with `start ≤ t < end` of each phase.

**Interpretation.** Mean heart rate reflects the combined physical, thermal and psychological load of the case.
`p95` is a more robust "peak" than `max`, which a single spurious sample can set. Compare a surgeon with their own
baseline and their own earlier sessions rather than with other surgeons: resting heart rate and heart-rate reactivity
differ a lot between people.

## Time weighting (dwell time)

Zones, the high-intensity fraction and coverage are **time-weighted**. Each valid sample, after a stable sort by `t`,
gets a dwell time:

```
dwell[i]      = min(t[i+1] − t[i], maxGapMs)                       for every sample except the last
dwell[last]   = min(median(dwell[0 … last−1]), maxGapMs)          (0 when there is only one sample)
negative dwell → 0
```

The cap means that time inside a data gap is never credited to any zone. With the default 5000 ms cap, a 60-second
dropout contributes only 5 seconds to the zone of the sample before it.

## Data quality

Function: `dataQuality(session, maxGapMs = 5000)` in [`analytics/summary.ts`](../packages/core/src/analytics/summary.ts).
Output type `DataQuality`, stored as `summary.quality`.

| Field | Definition |
| --- | --- |
| `coverage` | `min(1, covered / duration)`, where `duration = sessionEnd − startedAt` and `covered = Σ min(t[i+1] − t[i], maxGapMs)` over consecutive valid samples, with each piece `[t[i], t[i] + dwell]` clipped to `[startedAt, sessionEnd]`. The last sample adds nothing. `0` when the duration is ≤ 0. |
| `gapCount` | Number of consecutive sample pairs (all samples, array order) with `next.t − prev.t > maxGapMs` (`detectGaps`) |
| `longestGapSec` | Longest of those gaps, in seconds (`0` when there are none) |
| `rrArtifactRatio` | `removed / total` from [RR artefact cleaning](#rr-artefact-cleaning); `null` when the session has no RR data |
| `sampleRateHz` | `max(0, inWindow − 1) / (covered / 1000)`, where `inWindow` counts valid samples with `startedAt ≤ t ≤ sessionEnd`; `0` when nothing is covered |

Where the flags appear:

| Where | Rule | Source |
| --- | --- | --- |
| Dashboard Overview, "data-quality flags" | coverage `< 0.8` or `rrArtifactRatio > 0.05` | [`apps/dashboard/src/lib/quality.ts`](../apps/dashboard/src/lib/quality.ts) |
| Insight `data-quality` | latest session coverage `< 0.8` | [Insight rule 5](#insight-rules) |
| Summary CSV | `coverage_pct = coverage × 100`, `rr_artifact_pct = ratio × 100` | [Data model](data-model.md#summary-csv) |

**Interpretation and caveats.**

- Low coverage at the start of a case is common with chest straps: dry electrodes conduct poorly until the skin
  warms or sweats. Moistening the electrodes before scrubbing helps.
- The 5-second gap threshold assumes roughly 1 Hz data from a Bluetooth strap. Heart rate imported from Apple Health
  or Health Connect is often sampled less densely than that, so coverage and the absolute seconds in each zone come
  out low for those sessions even when the watch worked as intended. Fractions and means are less affected.
- A high artefact ratio (more than about 5 %) makes HRV unreliable, even after cleaning. Treat RMSSD and the stress
  index from such sessions with caution.

## RR artefact cleaning

Function: `cleanRr(rr, opts)` in [`analytics/rr.ts`](../packages/core/src/analytics/rr.ts).

| Option | Default | Meaning |
| --- | --- | --- |
| `minMs` | 300 | Shortest plausible interval (200 bpm), inclusive |
| `maxMs` | 2000 | Longest plausible interval (30 bpm), inclusive |
| `window` | 11 | Size of the centred local-median window, in beats |
| `maxDeviation` | 0.2 | Largest allowed relative deviation from the local median (20 %) |

An interval `rr[i]` is **invalid** when either rule holds:

1. **Range.** `ms` is not finite, or lies outside `[minMs, maxMs]`.
2. **Local median.** `|ms − localMedian| / localMedian > maxDeviation`. `localMedian` is the median of the intervals
   at indices `max(0, i − 5) … min(n − 1, i + 5)` (for the default window of 11), **excluding `i` itself** and
   excluding intervals that failed rule 1. The rule is skipped when fewer than 3 such neighbours exist, or when the
   local median is ≤ 0.

The result is one `valid` flag per interval, and a report `{ total, removed, ratio }` where `ratio = removed / total`
(0 when `total` is 0). The RR CSV export writes the flag as the `valid` column (`1`/`0`).

Cleaning **flags and excludes** suspect beats. It does not interpolate or replace them. This follows the ESC/NASPE Task
Force (1996) recommendation that ectopic beats and artefacts must be edited out before HRV is computed.

**Caveats.** A 20 % local-median rule catches missed beats (about double the interval) and most ectopic beats, but
not every artefact, and it can reject genuine abrupt changes. A run of several consecutive artefacts can shift the
local median itself. Always look at `rr_artifact_pct` alongside HRV values.

## Time-domain HRV

Functions: `computeHrv(rr, opts)` (the robust pipeline used by every summary) and `hrvTimeDomain(intervalsMs)` (pure
maths on one clean, contiguous series), in [`analytics/rr.ts`](../packages/core/src/analytics/rr.ts). Output type
`HrvTimeDomain`.

### The `computeHrv` pipeline

| Option | Default | Meaning |
| --- | --- | --- |
| clean options | see above | Passed to `cleanRr` |
| `gapMs` | 3000 | Extra time between deliveries, beyond the interval itself, that marks a data dropout |
| `minIntervals` | 30 | Minimum number of valid intervals needed to report HRV |

1. Run `cleanRr`.
2. **Split into runs.** A new run starts wherever `rr[i].t − rr[i−1].t > gapMs + rr[i].ms`. (`t` is the time the
   interval was received; several intervals from one Bluetooth notification share the same `t`.) A non-finite time
   difference also starts a new run.
3. **SDNN and mean RR** pool every valid interval across all runs.
4. **Successive differences** `d = rr[i+1].ms − rr[i].ms` use only pairs `(i, i+1)` that are adjacent in beat order,
   both valid, and in the same run. An invalid beat therefore breaks a pair instead of joining its neighbours, which
   would fabricate a large difference.
5. The result is `null` when fewer than `minIntervals` intervals are valid, or when no valid pair exists.

### Definitions

| Field | Formula | Unit |
| --- | --- | --- |
| `n` | number of valid intervals | count |
| `pairs` | number of valid successive differences | count |
| `meanRr` | `Σ x / n` over the valid intervals | ms |
| `sdnn` | `sqrt( Σ (x − meanRr)² / (n − 1) )` | ms |
| `rmssd` | `sqrt( Σ d² / pairs )` | ms |
| `pnn50` | `100 · count(|d| > 50 ms) / pairs` (strictly greater than 50 ms) | % |
| `meanHr` | `60000 / meanRr` | bpm |

### Where each minimum applies

| Use | Function call | Minimum valid intervals |
| --- | --- | --- |
| Whole session (`summary.hrv`, CSV `rmssd`, `sdnn`, `pnn50`, `mean_rr`) | cleaned once, then the `computeHrv` steps | 30 |
| Each operative phase (`phases[].hrv`, CSV `<phase>_rmssd`) | `computeHrv(slice, { minIntervals: 20 })` on `[start, end)` | 20 |
| Resting baseline (`baseline.rmssd`, `baseline.sdnn`) | `computeHrv(slice, { minIntervals: 20 })` | 20 |
| Rolling windows | see [Rolling HRV](#rolling-hrv) | 20 |

Note that each phase slice is cleaned on its own, so a beat at a phase boundary is judged only against neighbours
inside that phase.

### Interpretation and caveats

- **RMSSD** mainly reflects beat-to-beat (vagal, parasympathetic) modulation of heart rate. It usually falls under
  acute stress and with fatigue, and rises with rest and recovery. It is the most robust of these measures for short
  recordings.
- **SDNN** reflects all sources of variability in the recording, and **it grows with recording length**. A
  whole-session SDNN over a 3-hour case is not comparable with one over a 40-minute case, nor with published 5-minute
  norms (Task Force, 1996; Shaffer & Ginsberg, 2017). Prefer RMSSD, per-phase values or rolling windows for comparisons.
- **pNN50** depends strongly on heart rate. At the elevated heart rates typical of operating, it is often close to
  zero, which limits its usefulness here.
- **Short windows.** The 20- and 30-interval minimums only guarantee that a number can be computed. Values from
  windows shorter than the conventional 5 minutes are noisier. In the literature RMSSD is generally reported to hold
  up better than SDNN in short recordings.
- **Artefacts** inflate RMSSD and pNN50 sharply. A single missed beat that passes cleaning can change RMSSD by tens of
  milliseconds. Check the artefact ratio first.
- **Breathing and speech** modulate HRV (respiratory sinus arrhythmia). Talking, teaching and changes in breathing
  pattern during a case change HRV independently of stress.
- **Posture** matters: standing lowers vagal HRV compared with sitting or lying, so a seated baseline and a standing
  case differ for reasons that have nothing to do with stress.
- **Sensor type.** HRV needs beat-to-beat RR intervals. ECG chest straps (for example the Polar H10) provide them.
  Optical (PPG) armbands and watches often send heart rate only, and their pulse-to-pulse intervals are less precise,
  especially during movement. Sessions without RR data have `hrv: null`.
- **External HRV readings** imported from Apple Health (SDNN) or Health Connect (RMSSD) are stored in the session's
  `externalHrv` array but are **not** used by any summary metric, because the platforms compute them over windows and
  with methods SurgeonPulse does not control.

## Rolling HRV

Function: `rollingHrv(rr, opts)` in [`analytics/rr.ts`](../packages/core/src/analytics/rr.ts). Used for the rolling
RMSSD charts in the app's session detail and in the dashboard.

| Option | Default |
| --- | --- |
| `windowMs` | 60000 (60 s) |
| `stepMs` | 30000 (30 s) |
| `minIntervals` | **20** |
| `gapMs` and clean options | as in `computeHrv` |
| `start` / `end` | first / last RR `t` |

- Window `k` ends at `start + windowMs + k · stepMs` and covers RR with `windowEnd − windowMs ≤ t < windowEnd`. Each
  point's `t` is the window end.
- **Only complete windows are emitted** (`windowEnd ≤ end`), so every point covers the same length of time. A
  recording shorter than one window gives no points.
- `cleanRr` runs **once over the whole series**, so a beat at a window edge is judged with its real neighbours. Each
  window then applies steps 2–5 of `computeHrv` with those validity flags.
- `rmssd`, `sdnn` and `meanHr` are `null` for a window with too few valid intervals. `n` (the number of valid
  intervals in the window) is reported even then.

**Caveat.** A 60-second window at 70–110 bpm holds about 70–110 beats. Expect visible noise from breathing, speech
and posture changes. Look at patterns across several minutes rather than single points. SDNN from 60-second windows
is comparable between windows of one session (equal length), but not with longer-window SDNN.

## Baevsky stress index

Function: `baevskyStressIndex(intervalsMs, binMs = 50)` in [`analytics/rr.ts`](../packages/core/src/analytics/rr.ts).
Stored as `summary.stressIndex` and CSV `stress_index`. The summary passes the **valid** RR intervals of the whole
session (after [cleaning](#rr-artefact-cleaning)).

```
histogram bins: [floor(x / binMs) · binMs, + binMs)        binMs = 50 ms
Mo     = centre of the most populated bin, in seconds       (ties → the lowest bin)
AMo    = count in that bin / n × 100                        (%)
MxDMn  = (max − min) / 1000                                 (seconds)
SI     = AMo / (2 · Mo · MxDMn)
```

Returns `null` with fewer than 30 intervals, or when `MxDMn` is 0 (or the mode is not positive). Non-finite values are
ignored. The index is dimensionless (often reported in "conventional units").

**Interpretation.** A narrow, peaked RR histogram (low variability, dominated by one interval) gives a high index,
which Baevsky and colleagues associate with sympathetic activation and stress. Higher means "more strained".

**Caveats.**

- The value depends on the bin width and on the recording length. Over a long case, slow drift in heart rate widens
  the histogram (`MxDMn` grows) and lowers the index, so values from sessions of different lengths are not directly
  comparable.
- `MxDMn` uses the extreme valid intervals, so one artefact that passes cleaning can change it noticeably.
- Some software reports the square root of this quantity (for example Kubios HRV), so check which form a published
  value uses before comparing.

## Maximum heart rate and zones

Functions in [`analytics/zones.ts`](../packages/core/src/analytics/zones.ts).

### Maximum heart rate

`summary.maxHr` is the first **valid** (25–250 bpm) value of:

1. `SummaryOptions.maxHr` (the mobile app passes the participant profile's `maxHr` when one is set);
2. `participantSnapshot.maxHr` stored with the session;
3. the Tanaka estimate `estimateMaxHr(birthYear, atYear)` when `participantSnapshot.birthYear` is known.

```
age   = atYear − birthYear          (atYear defaults to the UTC year of startedAt)
HRmax = round(208 − 0.7 · age)      computed as round((2080 − 7 · age) / 10), halves up
```

Otherwise `maxHr` is `null`. Only the birth year is stored, to limit identifiability, so the age can be off by up to a
year.

### Zones from maximum heart rate

`zonesFromMaxHr(maxHr)`, bounds `maxHr × pct / 100`, not rounded:

| id | Label | Range (% of HRmax) |
| --- | --- | --- |
| `z1` | Very light | `[0, 60)` |
| `z2` | Light | `[60, 70)` |
| `z3` | Moderate | `[70, 80)` |
| `z4` | Hard | `[80, 90)` |
| `z5` | Maximum | `[90, ∞)` |

### Zones relative to the resting baseline

`zonesFromBaseline(restingHr)`:

| id | Label | Range (bpm) |
| --- | --- | --- |
| `rest` | At rest | `[0, rest + 10)` |
| `elevated` | Elevated | `[rest + 10, rest + 20)` |
| `high` | High | `[rest + 20, rest + 30)` |
| `very-high` | Very high | `[rest + 30, ∞)` |

### Which zones a summary uses

`summary.zones` uses the **baseline-relative** zones when a baseline exists (measured, manual or from the profile's
resting HR), otherwise the **%HRmax** zones when `maxHr` is known, otherwise none (`[]`).

`timeInZones(samples, zones, maxGapMs = 5000)` gives, for each zone in order, `seconds` (Σ [dwell](#time-weighting-dwell-time)
of the valid samples in it, using the first zone with `minBpm ≤ bpm < maxBpm`) and `fraction = seconds / Σ seconds`
(0 when the total is 0). Zones with no time are included.

### High-intensity fraction

`summary.highIntensityFraction` is the time-weighted fraction of dwell time with `bpm ≥ 0.7 · maxHr`, using the same
dwell rule. It is `null` when `maxHr` is unknown **or** when the total dwell time is 0 (fewer than two valid samples).
CSV: `high_intensity_pct = fraction × 100`. This is computed whichever zone set the summary uses.

**Interpretation and caveats.**

- Age-predicted maximum heart rate is a population estimate. Individual maximums commonly differ from it by 10 bpm or
  more. A measured `maxHr` in the profile is better.
- %HRmax zones and their labels ("Hard", "Maximum") come from exercise physiology. In theatre, heart-rate elevation
  is mostly not caused by exercise, so read the labels as intensity bands, not as exercise prescriptions.
- The baseline-relative bands (+10, +20, +30 bpm) are **project defaults**, chosen so that differences between
  surgeons' resting heart rates do not dominate. They are not validated thresholds.
- Beta-blockers and some other medicines blunt heart-rate responses and invalidate age-predicted maximums.

## Resting baseline

Function: `computeBaseline(samples, rr, start, end)` in
[`analytics/baseline.ts`](../packages/core/src/analytics/baseline.ts).

- Uses the data with `start ≤ t < end`.
- `restingHr` = `hrStats(...).mean` of that window. The function returns `null` when the window has no valid sample.
- `rmssd` and `sdnn` come from `computeHrv(slice, { minIntervals: 20 })` and are omitted when that returns `null`.
- `source` = `'measured'`.

**How the app captures it.** On the baseline screen the app buffers heart rate from the connected sensor for the
chosen duration: **180 s by default**, adjustable from 60 to 300 s in Settings (the recording store clamps any value
to 10–600 s). The surgeon can skip it. The baseline samples are **not** stored in the session's `samples` array. Only the
resulting `Baseline` record (window, resting HR, RMSSD, SDNN) is kept. If there is not enough data, the app says so and
the summary falls back to the profile.

**Fallback.** When a session has no valid measured baseline but the participant snapshot has a valid `restingHr`, the
summary uses `{ source: 'profile', restingHr, startedAt, endedAt: startedAt }`. Otherwise `summary.baseline` is `null`
and every delta is `null`.

**Caveats.**

- The baseline is usually taken just before the case, when anticipation can already raise heart rate. It is a
  "pre-case reference", not a true resting value.
- Record it in a consistent posture. Standing raises heart rate and lowers HRV compared with sitting, so a seated
  baseline followed by a standing case inflates every delta.
- A 3-minute window is shorter than the 5 minutes conventionally used for short-term HRV, so baseline RMSSD and SDNN
  are approximate.
- Recent caffeine, poor sleep, illness, dehydration and heat all shift resting heart rate. The debrief records sleep
  hours and caffeine within 2 hours so that analyses can account for them.

## Heart rate above baseline

| Summary field | CSV column | Definition |
| --- | --- | --- |
| `meanHrDelta` | `mean_hr_delta` | `hr.mean − baseline.restingHr` |
| `peakHrDelta` | `peak_hr_delta` | `hr.max − baseline.restingHr` |
| `phases[].meanHrDelta` | `<phase>_hr_delta` | phase `hr.mean − baseline.restingHr` |
| `baseline.restingHr` | `baseline_hr` | resting HR actually used (measured or profile) |

Each is `null` when either side is missing. Deltas are the main reactivity measure in SurgeonPulse, because they
remove much of the between-person difference in resting heart rate. `peakHrDelta` uses the single highest sample, so
it is sensitive to artefacts. Use `hr_p95` minus `baseline_hr` for a more robust peak.

## Phase segmentation

Functions: `derivePhases(session)`, `phaseAt(segments, t)` and `sessionEnd(session)` in
[`analytics/phases.ts`](../packages/core/src/analytics/phases.ts).

The operative phases, in `PHASE_ORDER`, are `pre-op`, `incision`, `dissection`, `critical`, `closure` and `post-op`
(see the [data model](data-model.md#enumerations)). A phase begins at its `phase` event. Markers never create
segments.

1. Take the `type: 'phase'` events, stably sorted by `t`. Clamp each time to `[startedAt, sessionEnd]`.
2. If consecutive events have the same phase, keep only the first.
3. Each segment runs from its event to the next phase event, or to `sessionEnd` for the last one.
4. Drop zero-length segments, except a final segment that ends exactly at `sessionEnd` (for example "post-op" logged
   as the case ends).
5. Merge adjacent segments with the same phase. They can only meet across a dropped zero-length segment
   (`A, B (zero length), A` becomes one `A`).
6. Number the remaining segments `index = 0, 1, 2, …`.

Time before the first phase event belongs to **no** phase. It still counts in whole-session statistics. Phase order is
not enforced, because real cases loop (for example dissection, critical, dissection). A phase that occurs more than
once produces several segments, and the summary CSV combines them (total duration, duration-weighted means).

`phaseAt(segments, t)` returns the phase with `start ≤ t < end`. At exactly the last segment's end it returns the last
phase. Otherwise it returns `undefined`.

Per-phase summary fields (`PhaseSummary`): `durationSec = (end − start) / 1000`, `hr` (HR statistics on
`[start, end)`), `hrv` (`computeHrv` with `minIntervals: 20`) and `meanHrDelta`.

**Caveats.** Phases are only as accurate as the taps that mark them. During a case a circulating nurse or researcher
usually logs them (`loggedBy: 'team'`). Events can be corrected afterwards in the app's event editor. Short phases
rarely reach 20 valid RR intervals, so their HRV is often `null`.

## Stress episodes

Functions: `defaultEpisodeThreshold(baseline, hr)` and `detectStressEpisodes(samples, opts, context)` in
[`analytics/episodes.ts`](../packages/core/src/analytics/episodes.ts). An "episode" is a **sustained elevation of heart
rate**. It is labelled "stress episode" for brevity, but heart rate cannot tell psychological stress from physical
effort.

**Threshold** (project default):

```
threshold = baseline.restingHr + 20        when the summary has a baseline (measured or profile)
          = hr.median + 15                 otherwise
          = none (no episodes)             when there is no HR data
```

`SummaryOptions.episodeThresholdBpm` overrides it.

**Detection:**

| Step | Rule | Default |
| --- | --- | --- |
| 1. Runs | Maximal runs of consecutive valid samples with `bpm ≥ threshold`. A run breaks on a valid sample below the threshold, or on a gap of more than 5000 ms between consecutive valid samples. Invalid samples are skipped. A run starts at its first sample and ends at its last. | gap 5000 ms (fixed) |
| 2. Merge | Runs separated by `≤ mergeGapMs` (earlier end to later start) are merged. | `mergeGapMs` 30000 ms |
| 3. Keep | Merged episodes with `end − start ≥ minDurationMs` are kept. | `minDurationMs` 60000 ms |
| 4. Describe | `peakBpm`/`peakT`: the highest above-threshold sample (first occurrence wins). `meanBpm`: mean of the above-threshold samples. `phase`: `phaseAt(segments, peakT)`. `relatedEventIds`: ids of all events (phases and markers) with `start − 120000 ≤ t ≤ end`, in time order. `durationSec = (end − start) / 1000`. | look-back 2 min (fixed) |

Summary fields: `episodes`; CSV `episode_count` and `episode_minutes = Σ durationSec / 60`.

**Caveats.**

- The thresholds are pragmatic project defaults, not validated markers of stress.
- Physical work (repositioning a patient, prolonged retraction, heavy lead aprons), heat and dehydration can all
  produce episodes.
- `relatedEventIds` shows **temporal** association only. An event inside the 2-minute look-back is not necessarily the
  cause.
- When the baseline comes from a profile resting HR that is out of date, the threshold is shifted accordingly.

## Workload: SURG-TLX and NASA-TLX

Functions: `scoreWorkload(response)`, `tlxPairs(instrument)`, `SURG_TLX_DIMENSIONS` and `NASA_TLX_DIMENSIONS` in
[`instruments/tlx.ts`](../packages/core/src/instruments/tlx.ts).

The app's post-operative debrief uses **SURG-TLX** (Wilson et al., 2011): six sliders from 0 to 100 in steps of 5,
plus an optional pairwise-comparison weighting step. NASA-TLX (Hart & Staveland, 1988) responses are also accepted
on import.

| SURG-TLX id | Dimension | Question shown |
| --- | --- | --- |
| `mental` | Mental Demands | How mentally fatiguing was the procedure? |
| `physical` | Physical Demands | How physically fatiguing was the procedure? |
| `temporal` | Temporal Demands | How hurried or rushed was the pace of the procedure? |
| `complexity` | Task Complexity | How complex was the procedure? |
| `stress` | Situational Stress | How anxious did you feel while performing the procedure? |
| `distraction` | Distractions | How distracting was the operating environment? |

NASA-TLX dimensions: `mental` (Mental Demand), `physical` (Physical Demand), `temporal` (Temporal Demand),
`performance` (Performance; anchors **0 = Perfect, 100 = Failure**), `effort` (Effort) and `frustration`
(Frustration).

**Scoring** (`WorkloadScore`):

```
dimensions[d] = clamp(rating[d], 0, 100)          (missing or NaN → 0)
raw           = Σ dimensions / 6                  ("raw TLX")
weighted      = Σ (dimensions[d] · weight[d]) / 15
```

`weighted` is computed only when a weight exists for every dimension, each weight is an integer from 0 to 5, and the
weights sum to 15 (the tallies from the 15 pairwise comparisons that `tlxPairs` lists). Otherwise it is `null`.

The cross-session metric `workload` uses `weighted` when present, otherwise `raw`. CSV: `workload_instrument`,
`workload_raw`, `workload_weighted`.

**Other self-report items** from the debrief, stored in `postOp`: `performance` (self-rated, 0 very poor to 10
excellent), `perceivedStress` (0 none to 10 extreme), `sleepHours` (hours slept the night before), `caffeine` (within
2 hours before the case) and `outcome` (`as-planned`, `minor-deviation`, `major-deviation`). `performance` and
`perceivedStress` are copied into the summary and CSV. The others are in the session JSON.

**Caveats.** Raw and weighted TLX scores are not interchangeable; report which one you analyse. Ratings collected
after the case are retrospective and can be coloured by the outcome. SURG-TLX and NASA-TLX scores should not be pooled
without justification, because their dimensions differ.

## Cross-session metrics

`METRICS`, `metricValue(summary, key)` and `metricSeries(summaries, key)` in
[`analytics/trends.ts`](../packages/core/src/analytics/trends.ts). These keys drive the trend charts in the app, the
dashboard's Analysis page and the Python `aggregate` / `learning_curve` helpers.

| Key | Label | Unit | Higher is better | Value |
| --- | --- | --- | --- | --- |
| `meanHr` | Mean heart rate | bpm | depends | `hr.mean` |
| `peakHr` | Peak heart rate | bpm | depends | `hr.max` |
| `meanHrDelta` | Mean HR above baseline | bpm | no | `meanHrDelta` |
| `peakHrDelta` | Peak HR above baseline | bpm | no | `peakHrDelta` |
| `rmssd` | RMSSD | ms | yes | `hrv.rmssd` |
| `sdnn` | SDNN | ms | yes | `hrv.sdnn` |
| `stressIndex` | Stress index (Baevsky) | (none) | no | `stressIndex` |
| `highIntensityPct` | Time ≥ 70 % of max HR | % | no | `highIntensityFraction × 100` |
| `episodeCount` | Stress episodes | (none) | no | number of episodes |
| `episodeMinutes` | Time in stress episodes | min | no | `Σ episode durationSec / 60` |
| `workload` | Workload (TLX) | /100 | no | `workload.weighted ?? workload.raw` |
| `performance` | Self-rated performance | /10 | yes | `performance` |
| `perceivedStress` | Perceived stress | /10 | no | `perceivedStress` |
| `durationMin` | Duration | min | depends | `durationSec / 60` |
| `criticalMeanHr` | Mean HR in critical phase | bpm | depends | duration-weighted mean of `hr.mean` over the `critical` segments |
| `criticalMeanHrDelta` | Critical-phase HR above baseline | bpm | no | duration-weighted mean of `meanHrDelta` over the `critical` segments |
| `coveragePct` | Signal coverage | % | yes | `quality.coverage × 100` |

"Higher is better" (`higherIsBetter`) is display metadata for colouring. "Depends" (`null`) means the direction depends
on context. `METRICS` also gives the number of decimals to display.

`metricSeries(summaries, key)` returns `{ sessionId, t: startedAt, value }` in chronological order (stable for equal
start times), dropping sessions where the value is `null`.

**Trend lines.** `linearTrend(points)` in [`analytics/stats.ts`](../packages/core/src/analytics/stats.ts) is an
ordinary-least-squares fit `y = slope · x + intercept` with `r2`. It ignores points with a non-finite coordinate and
returns `null` with fewer than 2 points or when `x` has no variance. When `y` has no variance it returns `slope = 0`,
`intercept = y`, `r2 = 0`. The app and the dashboard fit against the **session number** (0, 1, 2, … in the app; 1, 2,
3, … in the dashboard), so the slope is "units per session", not per calendar day.

`pearsonCorrelation(points)` gives Pearson's r, clamped to [−1, 1], or `null` with fewer than 2 points or when either
variable has no variance.

## Insight rules

Function: `generateInsights(summaries, context?)` in [`analytics/trends.ts`](../packages/core/src/analytics/trends.ts).
Insights are short, plain-language feedback cards. They are written to **prompt reflection, not to evaluate**: they
describe patterns in the surgeon's own data and avoid judgement. Summaries are first put in chronological order. The
rules run in this order, and each produces at most one insight:

| # | `id` | Kind | Needs | Fires when |
| --- | --- | --- | --- | --- |
| 1 | `peak-phase` | info | ≥ 3 sessions with at least one phase that has HR data | One phase has the highest phase mean HR in **≥ 50 %** of those sessions. Ties between phases within a session, and ties in the count, go to the earlier phase in `PHASE_ORDER`. |
| 2 | `hr-trend` | positive / attention | ≥ 5 sessions with `meanHrDelta`; if there are fewer, ≥ 5 with `meanHr` | OLS slope of the metric against session order (the index among all summaries) is **≤ −0.5 bpm/session** (positive: "settling with experience") or **≥ +0.5 bpm/session** (attention). No insight in between. `meanHr` is used only when fewer than 5 sessions have `meanHrDelta`. |
| 3 | `hrv-trend` | attention / positive | ≥ 5 sessions with RMSSD | Mean RMSSD of the last 3 sessions versus the mean of the earlier ones: change **≤ −15 %** gives attention (suggests rest and recovery); **≥ +15 %** gives positive. Skipped when the earlier mean is not positive. |
| 4 | `workload-hr` | info | ≥ 5 sessions with both `workload` and `meanHrDelta` | **\|Pearson r\| ≥ 0.5** between workload and HR rise above baseline. |
| 5 | `data-quality` | attention | ≥ 1 session | The latest session's coverage is **< 0.8**. The card gives a sensor-fit tip. |
| 6 | `episodes-after-markers` | info | `context.sessions`, and ≥ 3 episodes in total | **≥ 50 %** of episodes have a related `complication` or `interruption` marker among their `relatedEventIds`. |

Every insight lists the supporting session ids in `evidence`. Rule 6 needs the full sessions, because a summary stores
only the ids of related events, not their kinds. The dashboard's participant feedback view passes the sessions. The
mobile app's Insights tab currently calls `generateInsights(summaries)` without them, so **rule 6 never fires in the
app**.

**Caveats.** These are deterministic heuristics on small numbers of sessions. They are not statistical tests: with 5
sessions, a slope of 0.5 bpm per session or an r of 0.5 can easily arise by chance. The thresholds are project defaults.
Treat each insight as a prompt for a conversation or a debrief.

## Cohort aggregation

Function: `aggregateMetric(summaries, key, groupBy)` in [`analytics/trends.ts`](../packages/core/src/analytics/trends.ts).

- Group keys: `participant`, `procedure`, `specialty`, `approach`, `role`, `trainingLevel`, `urgency`, `month` (UTC
  `YYYY-MM` of `startedAt`) and `none` (one group called `All`).
- Sessions whose metric value is `null` are skipped, and groups with no values are dropped. A missing or blank group
  field becomes `Unspecified`.
- Each row gives `n`, `mean`, `sd` (sample SD, `n − 1`; 0 when `n = 1`), `median`, `min` and `max`.
- Rows are sorted by group name in UTF-16 code-unit order (never locale-dependent), except `month`, which is
  chronological.

Where it is used:

- **Dashboard Analysis page**: metric × group-by table and bar chart with SD whiskers, plus a scatter of any two
  metrics with an OLS line and Pearson r.
- **Dashboard Overview**: mean HR Δ by phase (± SD) across the filtered sessions.
- **Dashboard participant feedback view**: the participant's phase profile against an anonymised **cohort median**.
  Other participants' codes are never shown there.
- **Python**: `aggregate(df, metric, group_by)`, `learning_curve(df, metric)` (OLS slope per participant and pooled) and
  `phase_profile(df)`. See the [analysis README](../analysis/README.md).

**Statistical caveat.** Sessions are nested within surgeons, and some surgeons contribute many more sessions than
others. Group means over sessions therefore weight prolific participants more heavily, and session-level standard
deviations understate the uncertainty about group differences. For inferential analyses, export the summary CSV and use
models that account for repeated measures (for example mixed-effects models in R, Stata or Python).

## General caveats for interpretation

These apply to almost every metric above.

| Factor | Effect |
| --- | --- |
| Posture and movement | Standing, walking and leaning over the table raise heart rate and lower HRV. Long cases and different table heights change posture over time. |
| Physical exertion and heat | Lead aprons, gowns, theatre lights and retraction add physical and thermal load that heart rate cannot separate from psychological stress. |
| Caffeine, sleep, illness, hydration | Caffeine and short sleep raise heart rate; illness and dehydration change both heart rate and HRV. The debrief records sleep and caffeine so they can be used as covariates. |
| Medicines | Beta-blockers and some other medicines blunt heart-rate responses and change HRV. |
| Time of day | Heart rate and HRV follow a daily rhythm. `tzOffsetMin` is stored so local time of day can be analysed. |
| Speech and breathing | Talking, teaching and changes in breathing pattern alter RR intervals and HRV. |
| Sensor type | ECG chest straps measure beat-to-beat intervals. Optical (PPG) sensors in watches and armbands are less accurate during movement and often provide heart rate without RR intervals. Do not mix sensor types within one analysis without checking. |
| Electrosurgery | Electrosurgical (diathermy) units are a known source of electrical interference with ECG electrodes. Expect artefacts, spurious beats or short dropouts while diathermy is in use; they show up in the artefact ratio and in coverage. |
| Between-person differences | Resting heart rate, maximum heart rate and HRV vary widely between healthy people. Prefer within-person comparisons and deltas from baseline. |
| Sampling | Imported health-store data is less dense than strap data, which lowers coverage and absolute time-in-zone (see [Data quality](#data-quality)). |

## Parity between TypeScript and Python

The Python toolkit (`analysis/src/surgeonpulse_analysis/`) re-implements the analytics from
[`packages/core/SPEC.md`](../packages/core/SPEC.md) without sharing code. `packages/core/scripts/generate-fixtures.ts`
writes simulated and hand-built sessions and the TypeScript outputs to [`fixtures/`](../fixtures/README.md), and
`analysis/tests/test_parity.py` recomputes them in Python. Counts, ids, timestamps and strings must match exactly,
other numbers within `rtol = 1e-9, atol = 1e-6`, and the samples, RR and events CSVs byte for byte. The insight rules
are not ported to Python. See [development](development.md#fixtures-and-parity) for the workflow.

## References

- Task Force of the European Society of Cardiology and the North American Society of Pacing and Electrophysiology
  (1996). Heart rate variability: standards of measurement, physiological interpretation and clinical use.
  *Circulation*, 93(5), 1043–1065.
- Shaffer, F., & Ginsberg, J. P. (2017). An overview of heart rate variability metrics and norms. *Frontiers in Public
  Health*, 5, 258.
- Laborde, S., Mosley, E., & Thayer, J. F. (2017). Heart rate variability and cardiac vagal tone in psychophysiological
  research: recommendations for experiment planning, data analysis, and data reporting. *Frontiers in Psychology*, 8,
  213.
- Baevsky, R. M., & Berseneva, A. P. (2008). *Use of KARDiVAR system for determination of the stress level and
  estimation of the body adaptability: standards of measurements and physiological interpretation*. Moscow–Prague.
- Baevsky, R. M., & Chernikova, A. G. (2017). Heart rate variability analysis: physiological foundations and main
  methods. *Cardiometry*, 10, 66–76. (Cited in the core source code for the stress-index formula.)
- Tanaka, H., Monahan, K. D., & Seals, D. R. (2001). Age-predicted maximal heart rate revisited. *Journal of the
  American College of Cardiology*, 37(1), 153–156.
- Wilson, M. R., Poolton, J. M., Malhotra, N., Ngo, K., Bright, E., & Masters, R. S. W. (2011). Development and
  validation of a surgical workload measure: the Surgery Task Load Index (SURG-TLX). *World Journal of Surgery*, 35(9),
  1961–1969.
- Hart, S. G., & Staveland, L. E. (1988). Development of NASA-TLX (Task Load Index): results of empirical and
  theoretical research. In P. A. Hancock & N. Meshkati (Eds.), *Human Mental Workload* (Advances in Psychology, Vol.
  52, pp. 139–183). North-Holland.
- Hyndman, R. J., & Fan, Y. (1996). Sample quantiles in statistical packages. *The American Statistician*, 50(4),
  361–365.
- Gillinov, S., Etiwy, M., Wang, R., et al. (2017). Variable accuracy of wearable heart rate monitors during aerobic
  exercise. *Medicine & Science in Sports & Exercise*, 49(8), 1697–1703.
