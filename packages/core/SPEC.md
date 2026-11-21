# `@surgeonpulse/core` — API specification

Platform-agnostic TypeScript used by the mobile app (React Native / Hermes), the
web dashboard (browser), and the ingest server (Node). The Python toolkit in
`/analysis` re-implements the analytics sections of this spec, and both
implementations are checked against shared fixtures in `/fixtures`.

## Ground rules

- **No platform APIs.** No `Buffer`, `fs`, `window`, `document`, DOM types, or Node built-ins.
  Only ECMAScript 2022 plus `zod`. Must run unchanged on Hermes.
- **Erasable TypeScript only** (`erasableSyntaxOnly`): no `enum`, no `namespace`, no parameter properties.
- **Pure, deterministic functions.** Never mutate inputs. Never call `Date.now()` or `Math.random()`,
  except in `createId()` and in the documented defaults of the simulator. Clocks and seeds are always
  injectable.
- **Never return `NaN` or `Infinity` in outputs.** When there isn't enough data, return `null`, as documented.
  This also holds for finite inputs near `Number.MAX_VALUE` (see stats.ts) and for bad option values: a `maxGapMs`
  option that is `NaN` (e.g. `Number('')` from an empty settings field) means its default, 5000 ms.
- **Valid heart rate.** Wherever this spec says "valid bpm" or "valid sample", it means `isValidBpm`: a finite `bpm`
  within **[25, 250]** (inclusive). This applies to `hrStats`, `timeInZones`, `dataQuality`, `detectStressEpisodes`,
  `resampleHr`, and to the resting / maximum heart rates used by `summarizeSession`.
- **Rounding.** Every "rounded" value rounds halves **up** (towards +∞), i.e. JavaScript `Math.round`
  (`estimateMaxHr` at age 25 gives `round(190.5) = 191`; an RR of raw 1000 gives `976.5625 → 976.563` ms). Ports to
  languages whose `round` is half-to-even (Python) must use `floor(x + 0.5)`.
- Types come from `src/types.ts`. That file is the contract, so don't edit it. If you think a change is
  needed, report it instead.
- Relative imports have no file extension (`import { x } from './rr'`), because the code is resolved by Metro, Vite and tsx.
- Every module has unit tests in `test/<module>.test.ts` (Vitest).

Module layout (`src/`):

| File | Owner area | Contents |
| --- | --- | --- |
| `types.ts` | contract | Domain model (do not edit) |
| `index.ts` | contract | Public barrel: re-exports every module below |
| `analytics/stats.ts` | analytics | `mean`, `median`, `sampleSd`, `percentile`, `linearTrend`, `pearsonCorrelation`, `movingAverage`, `stableSortBy` |
| `analytics/internal.ts` | analytics | Internal helpers shared by the analytics modules; **not** re-exported from `index.ts`, not public API |
| `analytics/hr.ts` | analytics | `hrStats`, `sliceByTime`, `resampleHr`, `detectGaps`, `isValidBpm`, `isValidSample`, `robustPeakHr`, `PEAK_HR_HALF_WINDOW_MS`, `MAX_RESAMPLE_BUCKETS` |
| `analytics/rr.ts` | analytics | `cleanRr`, `hrvTimeDomain`, `computeHrv`, `rollingHrv`, `baevskyStressIndex`, `windowedStressIndex`, `MAX_HRV_ARTIFACT_RATIO`, `STRESS_INDEX_WINDOW_MS`, `MAX_ROLLING_HRV_WINDOWS` |
| `analytics/zones.ts` | analytics | `estimateMaxHr`, `zonesFromMaxHr`, `zonesFromBaseline`, `timeInZones` |
| `analytics/phases.ts` | analytics | `derivePhases`, `phaseAt`, `sessionEnd` |
| `analytics/episodes.ts` | analytics | `detectStressEpisodes`, `defaultEpisodeThreshold` |
| `analytics/baseline.ts` | analytics | `computeBaseline` |
| `analytics/summary.ts` | analytics | `summarizeSession`, `dataQuality`, `effectiveMaxGapMs`, `isSyntheticSession`, `MIN_PHASE_HRV_SEC` |
| `analytics/trends.ts` | analytics | `METRICS`, `metricValue`, `aggregateMetric`, `metricSeries`, `generateInsights`, `trendEvidence`, `tCritical95` |
| `instruments/tlx.ts` | analytics | `SURG_TLX_DIMENSIONS`, `NASA_TLX_DIMENSIONS`, `tlxPairs`, `scoreWorkload` |
| `ble/heartRate.ts` | io | GATT UUIDs, `parseHeartRateMeasurement`, `parseBodySensorLocation`, `parseBatteryLevel`, `base64ToBytes`, `bytesToBase64` |
| `io/schema.ts` | io | zod schemas, `parseSession`, `safeParseSession`, `migrateSession`, `SessionParseError` |
| `io/bundle.ts` | io | `createExportBundle`, `parseImport` |
| `io/csv.ts` | io | `toCsv`, `parseCsv`, `samplesToCsv`, `rrToCsv`, `eventsToCsv`, `summariesToCsv`, `SUMMARY_CSV_COLUMNS` |
| `io/deidentify.ts` | io | `deidentifySession`, `deidentifyBundle`, `isValidParticipantCode`, `sensorModelName`, `DEIDENTIFY_KEPT_TAGS`, `UNSPECIFIED_PROCEDURE_NAME` |
| `catalog/procedures.ts` | io | `PROCEDURE_CATALOG`, `findProcedure` |
| `presentation/labels.ts` | io | `PHASE_LABELS`, `PHASE_COLORS`, `MARKER_LABELS`, `MARKER_ICONS`, `TRAINING_LEVEL_LABELS`, `APPROACH_LABELS`, `ROLE_LABELS`, `formatDuration`, `formatClock` |
| `util/id.ts` | io | `createId` |
| `util/session.ts` | io | `createSession`, `appendSamples`, `appendRr`, `addEvent`, `updateEvent`, `removeEvent`, `finishSession`, `sortSession` |
| `sim/rng.ts` | sim | `createRng`, `gaussian` |
| `sim/simulate.ts` | sim | `simulateSession`, `simulateCohort`, `createLiveSimulator` |

---

## analytics/stats.ts

```ts
mean(xs: readonly number[]): number | null
median(xs: readonly number[]): number | null
sampleSd(xs: readonly number[]): number | null          // n−1 denominator; 0 for n=1; null for n=0
percentile(xs: readonly number[], p: number): number | null  // p in [0,100]; linear interpolation
                                                        // rank = p/100*(n−1) on sorted copy (NumPy "linear" default)
linearTrend(points: readonly {x:number;y:number}[]): {slope:number;intercept:number;r2:number;n:number} | null
                                                        // OLS; null if n<2 or var(x)=0; r2=0 when var(y)=0
movingAverage(xs: readonly number[], window: number): number[]  // trailing window, partial at start (length = xs.length)
pearsonCorrelation(points: readonly {x:number;y:number}[]): number | null   // null if n<2 or either variance is 0; clamped to [−1, 1]
```
Non-finite inputs are ignored. **Overflow:** each function first computes its result the ordinary way (so ordinary
inputs give the same bits as NumPy and the Python port). Only if that result is not finite (a sum, square or
difference overflowed, e.g. `mean([MAX, MAX])`) is it recomputed on values rescaled by their largest magnitude, so
`mean([MAX, MAX]) = MAX`, `median([MAX, MAX]) = MAX`, `percentile([−MAX, MAX], 50) = 0`. A result that cannot be
represented returns `null` (e.g. `sampleSd([−MAX, MAX]) = MAX·√2`); `movingAverage`, whose window means are always
representable, never overflows. `movingAverage` keeps a compensated (Neumaier) running sum so values of very
different magnitude do not absorb each other.

## analytics/hr.ts

```ts
hrStats(samples: readonly HeartRateSample[]): HrStats | null
```
Ignores invalid samples (see `isValidSample` below). Returns `null` if no valid samples remain.
Every statistic is computed over sample values (not time-weighted). `p95` uses `percentile(…, 95)`.

```ts
isValidSample(s: { bpm: number; contact?: boolean }): boolean   // isValidBpm(s.bpm) && s.contact !== false
```
A sample is **valid** when its bpm is finite and within [25, 250] **and** it was not recorded with `contact: false`
(the sensor supports contact detection and reported no skin contact, so the value is stale or noise; `contact`
undefined is accepted). Every analytics function that says "valid samples" (hrStats, resampleHr, timeInZones,
detectStressEpisodes, dataQuality coverage, robustPeakHr, effectiveMaxGapMs) uses this rule. `detectGaps` still looks
at all samples.

```ts
robustPeakHr(samples: readonly HeartRateSample[], halfWindowMs = 5000): number | null
```
Valid samples sorted by t (stable). For each sample i, take the `median` of the valid samples with
`|t − tᵢ| ≤ halfWindowMs`; the result is the largest of these medians (an 11-s rolling median at 1 Hz), or `null`
without valid samples. One spike cannot become the peak; with one sample per window it equals the maximum.

```ts
sliceByTime<T extends {t:number}>(xs: readonly T[], start: EpochMs, end: EpochMs): T[]   // start ≤ t < end
detectGaps(samples: readonly HeartRateSample[], maxGapMs = 5000): {start:EpochMs; end:EpochMs; durationMs:number}[]
```
A gap is any pair of consecutive samples (array order, all samples) where `next.t − prev.t > maxGapMs`. The gap runs
from `prev.t` to `next.t`.

```ts
resampleHr(samples, intervalMs: number, opts?: {start?: EpochMs; end?: EpochMs; /** @deprecated ignored */ maxGapMs?: number}):
  {t: EpochMs; bpm: number | null}[]
```
Bucket `k` covers `[start + k·intervalMs, start + (k+1)·intervalMs)`. Its value is the mean bpm of the valid samples
in the bucket, or `null` when the bucket is empty (so a data gap breaks a chart line by itself). Buckets are emitted
from `start` (default: first sample t) up to `end` (default: last sample t, inclusive of that sample's bucket). Each
bucket's `t` is its start time. Used for charting. An empty input, or `end < start`, gives `[]`. `maxGapMs` is
**deprecated and ignored**: a bucket's value depends only on the samples inside it. Throws `RangeError` when
`intervalMs` is not a positive finite number, or when more than `MAX_RESAMPLE_BUCKETS` (1 000 000) buckets would be
produced (e.g. `intervalMs: 1` over hours, or `start: 0`).

## analytics/rr.ts

```ts
interface CleanRrOptions { minMs?: number /*300*/; maxMs?: number /*2000*/; maxDeviation?: number /*0.2*/; window?: number /*11*/ }
cleanRr(rr: readonly RRInterval[], opts?): { valid: boolean[]; report: ArtifactReport }
```
An interval is invalid if:
1. `ms` is not finite, or is outside `[minMs, maxMs]`; **or**
2. `|ms − localMedian| / localMedian > maxDeviation`. `localMedian` is the median of the intervals in a centred window
   of `window` beats (clamped at the array ends: for index i, use indices max(0,i−⌊w/2⌋) … min(n−1,i+⌊w/2⌋),
   **excluding i itself**). The median uses only intervals that passed rule 1. If fewer than 3 such neighbours exist,
   rule 2 is skipped for that beat. The comparison is literally `>`: a beat is rejected only when it is true, so a
   `NaN` `maxDeviation` never rejects a beat. Rule 2 is also skipped when `localMedian ≤ 0`.

`valid[i]` matches `rr[i]`. `report.removed = count(!valid)`.

```ts
hrvTimeDomain(intervalsMs: readonly number[]): HrvTimeDomain | null
```
Pure math on one contiguous, already-clean series. `null` if fewer than 2 intervals.
`meanRr = mean`, `sdnn = sampleSd`, successive differences `d_i = x_{i+1} − x_i`, `rmssd = sqrt(mean(d²))`,
`pnn50 = 100 · count(|d|>50) / len(d)`, `meanHr = 60000 / meanRr`, `n = len`, `pairs = len(d)`.

```ts
interface ComputeHrvOptions extends CleanRrOptions { gapMs?: number /*3000*/; minIntervals?: number /*30*/ }
computeHrv(rr: readonly RRInterval[], opts?): { hrv: HrvTimeDomain | null; artifacts: ArtifactReport }
```
This is the robust pipeline used everywhere else:
1. Run `cleanRr`.
2. Split into **runs**. A new run starts wherever `rr[i].t − rr[i−1].t > gapMs + rr[i].ms`, which marks a data dropout.
3. `sdnn` and `meanRr` use all valid intervals pooled across runs.
4. Successive differences use only pairs `(i, i+1)` where both are valid **and** they're in the same run.
   An invalid beat therefore breaks a pair rather than joining its neighbours.
5. `hrv = null` if the valid count is below `minIntervals` or there are 0 valid pairs. Otherwise fill every field.
   `rmssd`/`pnn50` come from the valid pairs, and `meanHr = 60000/meanRr`.

```ts
rollingHrv(rr: readonly RRInterval[], opts?: ComputeHrvOptions & { windowMs?: number /*60000*/; stepMs?: number /*30000*/; start?: EpochMs; end?: EpochMs }):
  { t: EpochMs; rmssd: number | null; sdnn: number | null; meanHr: number | null; n: number }[]
```
Windows end at `start + windowMs + k·stepMs` (start defaults to the first (smallest) rr t; end defaults to the last
(largest) rr t). Each window covers RR with `windowEnd − windowMs ≤ t < windowEnd`, and `t` = windowEnd.
- **Complete windows only:** windows are emitted for k = 0, 1, … while `windowEnd ≤ end`. SDNN grows with recording
  length, so only equal-length windows are comparable (Task Force of ESC/NASPE, 1996). It follows that RR with
  t ≥ the last window end (including an RR exactly at the default `end`) are in no window, and a recording shorter
  than `windowMs` gives `[]`.
- **Cleaning:** `cleanRr` runs **once over the whole series** (with the clean options), as whole-recording artefact
  correction does; a beat at a window edge is judged with its real neighbours, even those outside the window. Each
  window then applies steps 2–5 of `computeHrv` to its intervals, in array (beat) order, using those validity flags,
  with `minIntervals` defaulting to **20** here.
- `rmssd`/`sdnn`/`meanHr` are null when that HRV is null. `n` is the number of **valid** (artefact-free) intervals in
  the window, reported even when the HRV is null (so a chart can say why a point is missing).
- Input that is not sorted by t is handled with one stable index sort (O(N log N)) and a binary search per window,
  never by filtering the whole array per window. Empty input gives `[]`. Throws `RangeError` when `windowMs`/`stepMs`
  is not a positive finite number, or when more than `MAX_ROLLING_HRV_WINDOWS` (1 000 000) windows would be produced.

```ts
baevskyStressIndex(intervalsMs: readonly number[], binMs = 50): number | null
```
`null` if fewer than 30 intervals. Build a histogram with bins `[floor(x/binMs)·binMs, +binMs)`.
`Mo` is the centre of the most populated bin in **seconds** (ties go to the lowest bin).
`AMo` is that bin's count / n × 100 (%). `MxDMn = (max − min)` in seconds.
`SI = AMo / (2 · Mo · MxDMn)`. Return null if MxDMn = 0. (Raw Baevsky SI; Kubios reports √SI.)

```ts
MAX_HRV_ARTIFACT_RATIO = 0.1
STRESS_INDEX_WINDOW_MS = 300000
windowedStressIndex(rr: readonly RRInterval[], valid: readonly boolean[], windowMs = 300000): number | null
```
The SI histogram depends on recording length and stationarity, so a whole-case SI falls as cases get longer. The
intervals with `valid[i] === true` and finite `t`/`ms` go into window `k = floor((t − t₀)/windowMs)`, where t₀ is the
first such interval's `t`. A window is used when the sum of its intervals' `ms` (plain left-to-right sum) is
`≥ 0.8·windowMs` and `baevskyStressIndex` of them is not null. Result: the `median` of the used windows' SI (windows in
ascending k), or null when none qualifies (e.g. less than 4 min of clean beats). A non-positive or non-finite
`windowMs` gives null.

## analytics/zones.ts

```ts
estimateMaxHr(birthYear: number, atYear: number): number          // Tanaka: 208 − 0.7·age, rounded to integer
zonesFromMaxHr(maxHr: number): ZoneDefinition[]
```
Five zones as % of max HR: Z1 `[0, 60%)` "Very light", Z2 `[60%, 70%)` "Light", Z3 `[70%, 80%)` "Moderate",
Z4 `[80%, 90%)` "Hard", Z5 `[90%, ∞)` "Maximum". Bounds are `maxHr·pct`, **not rounded**. Ids are `z1`…`z5`.

```ts
zonesFromBaseline(restingHr: number): ZoneDefinition[]
```
Four zones relative to the resting baseline: `rest` [0, rest+10) "At rest"; `elevated` [rest+10, rest+20) "Elevated";
`high` [rest+20, rest+30) "High"; `very-high` [rest+30, ∞) "Very high".

```ts
timeInZones(samples: readonly HeartRateSample[], zones: readonly ZoneDefinition[], maxGapMs = 5000): ZoneTime[]
```
Time-weighted. Sample i (valid bpm, i.e. finite and within [25, 250], sorted stably by t) has dwell
`min(t[i+1] − t[i], maxGapMs)`. The last sample's dwell is `min(median of the other dwells, maxGapMs)`, where the
other dwells are the **already capped** ones, or 0 if it's the only sample. Each dwell goes to the first zone with
`minBpm ≤ bpm < maxBpm`. Output follows the order of `zones`, includes zero-time zones, and sets
`fraction = seconds / Σseconds` (0 when Σ is 0). A `NaN` `maxGapMs` means the default 5000.

## analytics/phases.ts

```ts
sessionEnd(session: SurgicalSession): EpochMs
```
Returns `endedAt`, or else the max of the last sample t, last rr t and last event t, or else `startedAt`.

```ts
derivePhases(session: SurgicalSession): PhaseSegment[]
```
Take the `type:'phase'` events sorted by t (stable order). Clamp each t to `[startedAt, sessionEnd]`.
A segment runs from its event t to the next phase event's t (or to `sessionEnd`). If consecutive events have the same
phase, keep the first. Drop zero-length segments, except when a final segment ends exactly at sessionEnd with zero length.
Then **merge adjacent segments with the same phase** (which can only meet across a dropped zero-length segment):
`A, B (zero length), A` gives one `A` segment, so a phase is never split in per-phase statistics or CSV columns.
`index` counts 0,1,2… over the segments emitted. Time before the first phase event is **not** a segment.

```ts
phaseAt(segments: readonly PhaseSegment[], t: EpochMs): PhaseKind | undefined   // start ≤ t < end; t == last end → last phase
```

## analytics/baseline.ts

```ts
computeBaseline(samples: readonly HeartRateSample[], rr: readonly RRInterval[], start: EpochMs, end: EpochMs): Baseline | null
```
Uses data in `[start, end)`. `restingHr` = hrStats mean (null result if no HR). `rmssd`/`sdnn` come from `computeHrv`
with `minIntervals: 20`, and are omitted if that returns null **or its artefact ratio exceeds
`MAX_HRV_ARTIFACT_RATIO`**. `source: 'measured'`. (The app additionally refuses windows shorter than 60 s.)

## analytics/episodes.ts

```ts
defaultEpisodeThreshold(baseline: Baseline | null | undefined, hr: HrStats | null): number | null
```
Returns `baseline.restingHr + 20` when a baseline exists. Otherwise returns `hr.median + 15`, or `null` when there's no HR.

```ts
detectStressEpisodes(samples, opts: { thresholdBpm: number; minDurationMs?: number /*60000*/; mergeGapMs?: number /*30000*/;
                                       maxSampleGapMs?: number /*5000; NaN = default*/ },
                     context?: { segments?: PhaseSegment[]; events?: SessionEvent[] }): StressEpisode[]
```
1. Find maximal runs of consecutive valid samples (`isValidSample`) with `bpm ≥ threshold`. A run breaks on a sample
   below the threshold, or on a data gap greater than `maxSampleGapMs` (default 5000 ms). A run's start is its first
   sample t, and its end is its last sample t.
2. Merge runs separated by `≤ mergeGapMs` (measured from the earlier run's end to the later run's start).
3. Keep merged episodes with `end − start ≥ minDurationMs`.
4. `peakBpm`/`peakT` is the max over the episode's above-threshold samples (first occurrence wins). `meanBpm` is the
   mean of the above-threshold samples in it. `phase` = `phaseAt(segments, peakT)`. `relatedEventIds` lists the
   events with `start − 120000 ≤ t ≤ end`, in time order.

## analytics/summary.ts

```ts
dataQuality(session: SurgicalSession, maxGapMs?: number /* default effectiveMaxGapMs(session) */): DataQuality
```
`duration = sessionEnd − startedAt` (in ms; if ≤ 0, coverage is 0). Covered time is the sum of
`min(t[i+1]−t[i], maxGapMs)` between consecutive valid samples (sorted by t), each piece `[t[i], t[i] + dwell]`
clipped to the session window `[startedAt, sessionEnd]`. `coverage = min(1, covered/duration)`. `gapCount` and
`longestGapSec` come from `detectGaps(samples, maxGapMs)`. `sampleRateHz = max(0, inWindow − 1) / (covered/1000)` when
covered > 0, else 0, where `inWindow` counts the valid samples with `startedAt ≤ t ≤ sessionEnd` (the same window the
covered time is clipped to, so samples recorded before the start or after the end do not inflate the rate).
`rrArtifactRatio` comes from `cleanRr`, or is `null` without RR data. A missing or `NaN` `maxGapMs` means
`effectiveMaxGapMs(session)`. Samples with `contact: false` are not valid, so lost skin contact lowers coverage.

```ts
effectiveMaxGapMs(session: SurgicalSession, maxGapMs?: number): number
isSyntheticSession(session: Pick<SurgicalSession, 'sensor' | 'tags'>): boolean
MIN_PHASE_HRV_SEC = 60
```
`effectiveMaxGapMs`: an explicit number other than `NaN` is returned as given. Otherwise 5000, except for sensor source
`healthkit`/`health-connect` (sparse watch data): `1.5 ×` the `median` of the positive spacings between consecutive
valid samples (sorted by t), clamped to [5000, 900000]; 5000 when there is no spacing.
`isSyntheticSession`: sensor source `simulated`, or a `simulated` / `demo` tag.

```ts
interface SummaryOptions { maxHr?: number; atYear?: number; episodeThresholdBpm?: number; maxGapMs?: number }
summarizeSession(session: SurgicalSession, opts?: SummaryOptions): SessionSummary
```
- `maxGapMs = effectiveMaxGapMs(session, opts.maxGapMs)` (5000 for straps; data-driven for watch imports). It is
  used for coverage, zone dwell, `highIntensityFraction` and the episode run rule, and reported as `summary.maxGapMs`.
- `endedAt = sessionEnd(session)`. `durationSec = (endedAt − startedAt)/1000`.
- `hr = hrStats(samples)`. `{hrv, artifacts} = computeHrv(rr)`. `rrArtifacts` is null when rr is empty.
  `stressIndex = windowedStressIndex(rr, cleanRr valid flags)`. **When `artifacts.ratio > MAX_HRV_ARTIFACT_RATIO`
  (0.1), `hrv` and `stressIndex` are null** (so many beats were removed — poor contact, frequent ectopy or an irregular
  rhythm — that the HRV would describe the cleaning). (Implementations should clean RR once and reuse the flags for
  HRV, the stress index and `quality.rrArtifactRatio`; the results are identical.)
- `peakHr = robustPeakHr(samples)`; `peakHrDelta = peakHr − baseline.restingHr` (null if either is missing).
  `hr.max` stays the raw maximum.
- A resting or maximum heart rate is **used only when it is a valid bpm** (finite, within [25, 250]); anything else,
  such as a `0` meaning "not entered", counts as missing.
- `baseline` = `session.baseline` (when its `restingHr` is valid). Otherwise, when `participantSnapshot.restingHr` is
  valid, build `{source:'profile', restingHr, startedAt: startedAt, endedAt: startedAt}`. Otherwise null.
- `maxHr` = the first valid value of `opts.maxHr`, `participantSnapshot.maxHr`,
  `estimateMaxHr(birthYear, atYear ?? UTC year of startedAt)` (when birthYear is known), else null.
- `zones`: use `zonesFromBaseline` when a baseline exists, else `zonesFromMaxHr` when maxHr is known, else `[]`.
- `highIntensityFraction`: the time-weighted (same dwell rule as `timeInZones`) fraction with bpm ≥ 0.7·maxHr.
  It is null without maxHr **or when the total dwell time is 0** (no or a single valid sample): 0/0 is "not enough
  data", not "no time at high intensity". (`ZoneTime.fraction` keeps its own rule: 0 when the total is 0.)
- `phases`: `derivePhases`. Each phase gets hr/hrv computed on the slice `[start,end)`. HRV uses `computeHrv` with
  `minIntervals: 20`, and is null when the phase is shorter than `MIN_PHASE_HRV_SEC` (60 s) or the slice's artefact
  ratio exceeds `MAX_HRV_ARTIFACT_RATIO`. `meanHrDelta` = phase hr.mean − baseline.restingHr.
- `episodes`: threshold = `opts.episodeThresholdBpm ?? defaultEpisodeThreshold(baseline, hr)`, detected with
  `maxSampleGapMs: maxGapMs`. Empty when the threshold is null.
- `markerCounts`: count of each marker kind present (omit kinds with zero).
- `workload` = `scoreWorkload(postOp.workload)`, or null. `performance`/`perceivedStress` come from postOp, or null.
- Copy the procedure fields and `participantSnapshot.trainingLevel`.
- Provenance and covariates, after `quality`: `peakHr`; `sensorSource = sensor.source`;
  `simulated = isSyntheticSession(session)`; `tzOffsetMin` (only when the session has a finite one);
  `sleepHours`, `caffeine`, `outcome` from postOp (null when unanswered); `maxGapMs`; `analyticsVersion =
  ANALYTICS_VERSION` (types.ts; bumped whenever a summary definition changes, so stored summaries from older code can
  be recognised and recomputed). These keys are optional in the type only for summaries stored by older versions.

## analytics/trends.ts

```ts
type MetricKey = 'meanHr' | 'peakHr' | 'meanHrDelta' | 'peakHrDelta' | 'rmssd' | 'sdnn' | 'stressIndex'
  | 'highIntensityPct' | 'episodeCount' | 'episodeMinutes' | 'workload' | 'performance' | 'perceivedStress'
  | 'durationMin' | 'criticalMeanHr' | 'criticalMeanHrDelta' | 'coveragePct'
const METRICS: Record<MetricKey, { label: string; unit: string; higherIsBetter: boolean | null; decimals: number }>
metricValue(s: SessionSummary, key: MetricKey): number | null
```
`highIntensityPct = highIntensityFraction·100`. `peakHr` is `summary.peakHr` (the raw `hr.max` for summaries that
have no `peakHr` key). `workload` is always the **raw** TLX score (weighting is optional per debrief; mixing weighted
and raw scores in one series would change values with the scoring method). `criticalMeanHr` is the
duration-weighted mean of hr.mean over the `critical` phases. `episodeMinutes` = Σ durationSec / 60.
`coveragePct = quality.coverage·100`. `METRICS.sdnn` is labelled as depending on case length (`higherIsBetter: null`):
whole-case SDNN grows with recording length and must not be compared across durations.

```ts
type GroupKey = 'participant' | 'procedure' | 'specialty' | 'approach' | 'role' | 'trainingLevel' | 'urgency' | 'month' | 'none'
aggregateMetric(summaries: readonly SessionSummary[], key: MetricKey, groupBy: GroupKey):
  { group: string; n: number; mean: number; sd: number; median: number; min: number; max: number }[]
```
Groups with no non-null values are dropped. A missing (or blank) group field becomes `'Unspecified'`. `month` is the
`YYYY-MM` of `startedAt + tzOffsetMin·60000` (UTC getters) when the summary has a finite `tzOffsetMin`, else of
startedAt in UTC, so a Melbourne case at 08:00 on the 1st belongs to that month. `none` puts every session in a single group named `'All'`. Results are sorted by group
name (UTF-16 code-unit order, never locale-dependent), except that `month` sorts chronologically. `sd` is the sample
SD (0 for n = 1).

```ts
metricSeries(summaries, key: MetricKey): { sessionId: string; t: EpochMs; value: number }[]  // chronological, nulls dropped
generateInsights(summaries: readonly SessionSummary[], context?: { sessions?: readonly SurgicalSession[] }): Insight[]
```
Deterministic, evidence-based feedback written in plain, non-judgemental language. Needs at least 1 summary
(`[]` otherwise). Summaries are first put in chronological order (stable for equal `startedAt`). Rules that report change
over time or an association need enough sessions **and** a two-sided p < 0.05 test, so that ordinary
session-to-session variation does not produce feedback (with the old thresholds, iid noise fired the trend rule
70–80 % of the time at n = 5). Their wording describes the pattern and never attributes a cause (no "with experience",
no fatigue or recovery advice). Rules, in this order:
1. **Peak phase.** For each session with at least one phase that has HR data, combine the segments of each phase into
   one duration-weighted mean of hr.mean (a single segment is used as is; weights are `durationSec > 0`, plain mean if
   all weights are 0) and take the phase with the highest value (ties → the earlier phase in `PHASE_ORDER`). If one
   phase is the peak in ≥ 50 % of **those** sessions (with ≥ 3 such sessions), report it as `info`. Sessions without
   phase HR data are not in the denominator.
2. **Trend.** With ≥ 8 sessions, `trendEvidence` of `meanHrDelta` (else `meanHr`) against session order. Fires only
   when `significant` and |slope| ≥ 0.5 bpm/session: falling → `positive` ("lower in recent sessions"), rising →
   `attention` ("higher in recent sessions").
3. **Intra-operative HRV.** With ≥ 8 sessions that have RMSSD, compare the mean of the last 3 to the mean of the earlier
   ones. Fires (`info`) when |change| ≥ 15 % **and** Welch's t-test of the two groups is significant (|t| ≥
   `tCritical95(floor(Welch–Satterthwaite df))`; equal means with zero variance never fire). The text says that
   intra-operative HRV mostly reflects heart rate and arousal during the case and is not a measure of fatigue or
   recovery on its own.
4. **Workload vs physiology.** With ≥ 10 sessions that have both workload (raw) and meanHrDelta, compute the Pearson
   r. Give `info` when |r| ≥ 0.5 **and** `t = |r|·√(n−2)/√(1−r²) ≥ tCritical95(n−2)` (|r| = 1 always qualifies). The
   text gives r, n and p < 0.05 and says that correlation does not show causation.
5. **Data quality.** If the latest session has coverage < 0.8 and is not `sensorSource: 'simulated'`, give
   `attention` with a tip that matches the source (watch advice for `healthkit`/`health-connect`, strap fit
   otherwise).
6. **Episodes after markers.** If ≥ 50 % of the episodes (with ≥ 3 episodes total) have a related `complication`
   or `interruption` event, give `info`. A summary stores only the ids of an episode's related events, not their
   kinds, so this rule needs `context.sessions` (matched to summaries by id; summaries without a matching session are
   skipped). Without `context.sessions` the rule is not evaluated.

Each insight `id` is a stable slug of the rule (e.g. `peak-phase`). `evidence` lists the session ids involved.

```ts
tCritical95(df: number): number | null
trendEvidence(points: readonly {x: number; y: number}[]): (LinearTrend & { t: number | null; significant: boolean }) | null
```
`tCritical95`: two-sided 5 % critical value of Student's t from a fixed table (df 1–30: 12.706, 4.303, 3.182, 2.776,
2.571, 2.447, 2.365, 2.306, 2.262, 2.228, 2.201, 2.179, 2.16, 2.145, 2.131, 2.12, 2.11, 2.101, 2.093, 2.086, 2.08,
2.074, 2.069, 2.064, 2.06, 2.056, 2.052, 2.048, 2.045, 2.042); df is floored; 31–39 → 2.042, 40–59 → 2.021,
60–119 → 2.0, 120–999 → 1.98, ≥ 1000 → 1.96; null for df < 1 or non-finite.
`trendEvidence`: `linearTrend` (null when that is null) plus `t = sign(slope)·√(r²·(n−2)/(1−r²))`. n < 3 →
`t: null, significant: false`; slope 0 → `t: 0, significant: false`; r² = 1 → `t: null, significant: true`; otherwise
`significant = |t| ≥ tCritical95(n − 2)`. Assumes independent sessions.

## instruments/tlx.ts

```ts
SURG_TLX_DIMENSIONS: readonly { id: SurgTlxDimension; label: string; question: string; low: string; high: string }[]
NASA_TLX_DIMENSIONS: readonly { id: NasaTlxDimension; label: string; question: string; low: string; high: string }[]
tlxPairs(instrument: WorkloadInstrument): [string, string][]     // the 15 unordered pairs, fixed order
scoreWorkload(resp: WorkloadResponse): WorkloadScore
```
SURG-TLX (Wilson et al., 2011): Mental Demands, Physical Demands, Temporal Demands, Task Complexity,
Situational Stress, Distractions. `raw` = mean of the 6 ratings, each clamped to [0,100]. `weighted` =
Σ(rating·weight)/15 using the **clamped** ratings, and only applies when weights exist, every weight is an integer
in 0–5, and they sum to 15. Otherwise it's null. `dimensions` holds the clamped ratings (a missing or `NaN` rating
counts as 0).

## ble/heartRate.ts

```ts
HEART_RATE_SERVICE = '0000180d-0000-1000-8000-00805f9b34fb'
HEART_RATE_MEASUREMENT = '00002a37-0000-1000-8000-00805f9b34fb'
BODY_SENSOR_LOCATION = '00002a38-0000-1000-8000-00805f9b34fb'
BATTERY_SERVICE = '0000180f-0000-1000-8000-00805f9b34fb'
BATTERY_LEVEL = '00002a19-0000-1000-8000-00805f9b34fb'
DEVICE_INFORMATION_SERVICE = '0000180a-…'
interface HeartRateMeasurement { bpm: number; contactSupported: boolean; contact?: boolean; energyExpendedKj?: number; rrMs: number[] }
parseHeartRateMeasurement(data: ArrayLike<number>): HeartRateMeasurement   // throws RangeError on truncated payloads
```
Per Bluetooth GATT Heart Rate Measurement (0x2A37), little-endian:
- flags bit0: HR value format (0 → uint8, 1 → uint16);
- bits1–2: sensor contact (bit2 = supported, bit1 = detected; `contact` is only defined when supported);
- bit3: Energy Expended present (uint16, kJ);
- bit4: RR-Interval present, followed by one or more uint16 values in units of 1/1024 s until the payload ends.
Convert RR to ms as `raw · 1000 / 1024`, rounded to 3 decimals (halves up). Complete uint16 values are read until
the payload ends: a trailing odd byte is ignored, and an RR flag followed by 0 or 1 bytes gives `rrMs: []` (not an
error, so the heart rate in that notification is not lost). `RangeError` is only for payloads shorter than the
mandatory fields (flags, HR value, energy expended when flagged) or for non-byte values.

```ts
parseBodySensorLocation(data): 'other'|'chest'|'wrist'|'finger'|'hand'|'ear-lobe'|'foot'|'unknown'
parseBatteryLevel(data): number                         // 0–100
base64ToBytes(b64: string): Uint8Array; bytesToBase64(bytes: ArrayLike<number>): string   // pure JS, no atob/Buffer
```

## io/schema.ts

Zod (v4) schemas that mirror `types.ts` exactly: `HeartRateSampleSchema`, `RRIntervalSchema`, `SessionEventSchema`,
`ProcedureInfoSchema`, `ParticipantProfileSchema`, `PostOpReportSchema`, `BaselineSchema`, `SurgicalSessionSchema`,
`ExportBundleSchema`. Numeric ranges: bpm 0–300, rr 0–5000 ms, ratings 0–100, performance and perceivedStress 0–10,
complexity 1–5. Time windows must not run backwards: `SurgicalSession.endedAt` (when present) ≥ `startedAt`, and
`Baseline.endedAt` ≥ `startedAt` (issue path `endedAt` / `baseline.endedAt`). Unknown keys are **stripped**, not
rejected. The zod types must be assignable to the TS types (add a compile-time check). Resting / maximum HR keep the
bpm range (0 is accepted on import); `summarizeSession` treats implausible values as missing instead of rejecting the
whole session.

```ts
class SessionParseError extends Error { issues: string[] }    // human-readable "path: message" lines
migrateSession(raw: unknown): unknown        // upgrade older schemaVersion objects; v1 is identity; unknown future version → throws SessionParseError
parseSession(raw: unknown): SurgicalSession  // migrate → validate → sort samples/rr/events by t (stable) → return new object
safeParseSession(raw: unknown): { ok: true; session: SurgicalSession } | { ok: false; error: SessionParseError }
```

## io/bundle.ts

```ts
createExportBundle(input: { sessions: SurgicalSession[]; participants?: ParticipantProfile[]; app?: AppInfo; deidentify?: boolean | DeidentifyOptions; now: EpochMs }): ExportBundle
parseImport(text: string): { bundle: ExportBundle; warnings: string[] }
```
`parseImport` accepts a JSON `ExportBundle`, a single session object, or an array of sessions (wrapped in a bundle
with `deidentified:false`). Invalid sessions are skipped with a warning naming the index and the issues. A
participant is synthesised (`{code}`) for each session code that has no profile. Bundles that fail to parse throw
`SessionParseError`, and so does a **single** session object that is invalid (there is nothing else to import).
`createExportBundle` never mutates its input. With `deidentify` the sessions are new objects; without it the bundle's
`sessions` array is new but holds the caller's session objects (no deep copy), which must be treated as immutable.

## io/csv.ts

```ts
interface CsvOptions { formulaGuard?: boolean /*false*/ }
toCsv(rows: readonly Record<string, unknown>[], columns?: readonly string[], options?: CsvOptions): string
```
RFC 4180 with `\r\n` line endings and a header row; **every** record, including the last, ends with `\r\n`. Quote a
field if it contains `,`, `"`, CR or LF, doubling any embedded quotes. `null`/`undefined` become an empty field.
Numbers use `String(n)`, and non-finite numbers become empty. Booleans become `true`/`false`, `Date`s their
`toISOString()`, other objects JSON. Columns default to the union of keys in first-seen order; no columns gives `""`.
No byte-order mark is written.

**Formula guard** (OWASP "CSV injection"): with `formulaGuard`, a **string** value whose first character is `=`, `+`,
`-`, `@`, TAB or CR is written with a leading `'`, so spreadsheets show it as text instead of running it (e.g. a note
`=HYPERLINK(…)`). Numbers are never altered (negative `t_offset_s` stays numeric); header names are never altered.
Plain `toCsv` (guard off) and `parseCsv` round-trip exactly. **All four exporters below enable the guard.** (An ISO
timestamp outside years 0000–9999, which starts with `+`/`-`, is also prefixed; no spreadsheet can store such a date.)

```ts
parseCsv(text: string): string[][]           // RFC 4180 inverse; handles quotes, CRLF/LF, trailing newline
samplesToCsv(s: SurgicalSession): string     // session_id,participant_code,t_iso,t_offset_s,bpm,contact,phase
rrToCsv(s: SurgicalSession): string          // session_id,participant_code,t_iso,t_offset_s,rr_ms,valid,phase
eventsToCsv(s: SurgicalSession): string      // session_id,participant_code,t_iso,t_offset_s,type,kind,logged_by,note
summariesToCsv(summaries: readonly SessionSummary[]): string
```
`t_iso` (and `started_at`/`ended_at` below) is `Date.prototype.toISOString()`: UTC, milliseconds, `Z`
(`2026-01-05T08:00:00.000Z`). `t_offset_s` = (t − startedAt)/1000. `phase` = phaseAt (empty outside the segments).
`contact` is `1`/`0` (empty when the sensor does not report it) and `valid` is `1`/`0` from cleanRr. `summariesToCsv`
writes one wide row per session for SPSS/R/Stata, with the fixed columns of `SUMMARY_CSV_COLUMNS`: the identifiers
`session_id, participant_code, training_level, started_at, ended_at`, the procedure fields
`procedure_name, specialty, approach, role, urgency, complexity`, then duration_min, hr_mean,
hr_median, hr_min, hr_max, hr_sd, hr_p95, rmssd, sdnn, pnn50, mean_rr, stress_index, rr_artifact_pct,
baseline_hr, mean_hr_delta, peak_hr_delta, high_intensity_pct, episode_count, episode_minutes, workload_instrument,
workload_raw, workload_weighted, performance, perceived_stress, coverage_pct. Then for each phase in PHASE_ORDER:
`<phase>_duration_s`, `<phase>_hr_mean`, `<phase>_hr_delta`, `<phase>_rmssd`. Phase names use `_` (e.g. `pre_op_hr_mean`).
Phases that occur several times are duration-weighted (`_duration_s` is their total; a single occurrence is copied
exactly). Then the provenance and covariate columns (appended so positional scripts keep working):
`sensor_source` (summary.sensorSource), `simulated` (1/0), `tz_offset_min`, `started_local` (local start as
`YYYY-MM-DDTHH:MM:SS.sssZ` of `startedAt + tzOffsetMin·60000` with the `Z` replaced by `±HH:MM` of
`|round(tzOffsetMin)|`; empty without tzOffsetMin), `baseline_source`, `baseline_duration_s`
(`(baseline.endedAt − baseline.startedAt)/1000`), `max_hr`, `peak_hr`, `hrv_n` (hrv.n), `sleep_hours`, `caffeine`
(1/0), `outcome`, `analytics_version`. Percentages (`*_pct`) are fractions × 100. Missing values (including fields an
older stored summary does not have) are empty fields.

## io/deidentify.ts

```ts
interface DeidentifyOptions { dropNotes?: boolean /*true*/; dropSensorId?: boolean /*true*/; timeShiftMs?: number /*0*/; dropTzOffset?: boolean /*false*/; dropBirthYear?: boolean /*false*/ }
deidentifySession(s: SurgicalSession, opts?): SurgicalSession
deidentifyBundle(b: ExportBundle, opts?): ExportBundle
isValidParticipantCode(code: string): boolean                // /^[A-Za-z0-9][A-Za-z0-9_-]{1,31}$/ and not an email-like string
```
With `dropNotes`, remove all free text: `postOp.notes`, every `event.note`, and every tag except the machine tags in
`DEIDENTIFY_KEPT_TAGS` (`simulated`, `demo`, which must survive so synthetic data is never mistaken for real data; the
`tags` key is removed when none remain). `procedure.name` becomes the catalogue name when `catalogId` resolves, or
when the typed name equals a catalogue name (trimmed, case-insensitive; its `catalogId` is then set); otherwise it
becomes `UNSPECIFIED_PROCEDURE_NAME` (`'Unspecified procedure'`), because free text in the name might contain
patient details. An unresolvable `catalogId` is removed.
With `dropSensorId`, remove `sensor.id` and reduce `sensor.name` to the device model with `sensorModelName`: trailing
whitespace-separated tokens made of hex digits and `:`/`-`/`_` (≥ 4 characters, containing a digit or `:`, optionally
in brackets or after `#`) are removed, as is a `:`/`#`-joined hex suffix containing a digit
(`'Polar H10 A1B2C3D4'` → `'Polar H10'`, `'HRM-Dual:123456'` → `'HRM-Dual'`); a name that is only a serial is removed.
`timeShiftMs` adds the offset to **every** timestamp, consistently. The output shares no objects with the input.
Participant codes are not changed but must already be pseudonyms: `deidentifySession`/`deidentifyBundle` throw
`RangeError` when a session's or participant's code fails `isValidParticipantCode` (e.g. an e-mail address), since
de-identification cannot repair a direct identifier. `deidentifyBundle` applies the same options to every session and
participant, keeps `consent.version`, sets `givenAt` to the shifted value, shifts `exportedAt`, and sets
`deidentified: true`. That flag means "`deidentifySession` was applied to every session" (types.ts), whatever the
options: with the defaults (`timeShiftMs: 0`, `tzOffsetMin` kept) calendar dates and local times remain, so a study
that must hide operating dates chooses a secret shift and sets `dropTzOffset`.

## catalog/procedures.ts

`PROCEDURE_CATALOG: readonly { id: string; name: string; specialty: string; defaultApproach?: SurgicalApproach }[]`,
with at least 40 common procedures across general, colorectal, upper GI/HPB, urology, gynaecology, orthopaedics,
vascular, cardiothoracic, neurosurgery, ENT, plastics and paediatrics. Ids are stable kebab-case.
`findProcedure(id)`.

## presentation/labels.ts

Human-readable labels for every union in `types.ts`, plus `PHASE_COLORS: Record<PhaseKind, string>` (accessible
hex colours that are distinguishable under common colour-vision deficiencies and readable as translucent bands on
light and dark backgrounds). Also `MARKER_ICONS` (a short emoji-free glyph or letter per marker).
`formatDuration(sec)` gives `"1h 05m"`, `"12m 30s"` or `"45s"`. `formatClock(ms)` gives `"HH:MM:SS"` of elapsed time.

## util/id.ts and util/session.ts

`createId()` returns an RFC 4122 v4 UUID string. It uses `globalThis.crypto.randomUUID` when present, otherwise
`crypto.getRandomValues`, otherwise `Math.random`.

`createSession({participantCode, procedure, sensor, app, startedAt, id?, tzOffsetMin?, participantSnapshot?, baseline?})`
returns a `status:'recording'` session with empty arrays. `appendSamples`, `appendRr`, `addEvent`, `updateEvent(id, patch)`
and `removeEvent` return new sessions; inserts keep t-sorted order. `finishSession(s, endedAt, status='completed')`
does what its name says. `sortSession` gives a stable sort of all arrays.

## sim/rng.ts and sim/simulate.ts

```ts
createRng(seed: number): () => number                   // mulberry32, uniform in [0,1)
gaussian(rng): number                                   // Box–Muller standard normal
simulateSession(opts?: SimulateOptions): SurgicalSession
interface SimulateOptions {
  seed?: number /*1*/; participantCode?: string /*'SIM-001'*/; procedure?: ProcedureInfo; startedAt?: EpochMs /*Date.UTC(2026,0,5,8,0)*/;
  durationMin?: number /*90*/; restingHr?: number /*68*/; reactivity?: number /*0..1, 0.5*/; experience?: number /*0..1, 0.5*/;
  sampleIntervalMs?: number /*1000*/; includeRr?: boolean /*true*/; artifactRate?: number /*0.005*/;
  dropoutRate?: number /*0 — probability per minute of a 5–40 s gap*/; markerRate?: number /*per hour, 1.0*/;
  withBaseline?: boolean /*true*/; withPostOp?: boolean /*true*/; trainingLevel?: TrainingLevel; birthYear?: number
}
```
Physiology model (document it in code comments):
- Phases: pre-op 10 %, incision 10 %, dissection 40 %, critical 15 %, closure 20 %, post-op 5 % of the duration.
  Jitter each by ±20 % (seeded), then renormalise.
- HR(t) = resting + phaseOffset·gain + drift + ε. Phase offsets (bpm): pre-op 6, incision 12, dissection 10,
  critical 22, closure 6, post-op 3. `gain = 0.5 + reactivity·(1 − 0.6·experience)`. Drift is an AR(1) process
  (φ = 0.995, σ = 0.6). ε ~ N(0, 1.5). Transitions are smoothed with a first-order lag (τ = 45 s).
- Markers arrive as Poisson events at `markerRate` per hour. A `complication` adds a response of
  `+15·gain·exp(−Δt/180 s)`. `interruption` and `equipment` add `+6·gain·exp(−Δt/90 s)`.
- RR: generate beats sequentially. `rr = 60000/HR(t) + RSA + noise`, where RSA = `A·sin(2π·0.25 Hz·t)`,
  A = 25 ms·(1 − 0.5·stressLoad) and stressLoad ∈ [0,1] rises with HR above resting. Noise ~ N(0, 8 ms).
  Artefacts at `artifactRate`: half are a missed beat (merged with the next, ≈2×) and half are ectopic
  (0.6× then a compensatory 1.4×). Beats are delivered in 1-second notifications: each beat's `t` is the next whole
  second after its occurrence. `bpm` samples are 1 Hz, as a rounded integer of the instantaneous HR from the last
  beats (like real straps).
- The baseline is a 5-minute window *before* `startedAt` at resting HR. Its samples are **not** included in the
  session arrays; only the `Baseline` record is stored, computed with `computeBaseline` on the generated baseline data.
- PostOp uses a SURG-TLX correlated with mean HR delta and complications (seeded), plus performance and stress values.
- The output must pass `parseSession` and be identical for the same seed.

```ts
simulateCohort(opts?: { seed?: number; participants?: number /*8*/; sessionsPerParticipant?: number /*12*/; start?: EpochMs; spacingDays?: number /*7*/ }):
  { participants: ParticipantProfile[]; sessions: SurgicalSession[] }
```
Mix of training levels. Experience grows across a participant's sessions (learning curve), so trainee reactivity
declines over time. Procedures come from the catalogue. Deterministic per seed. Keep the default output under
~25 MB of JSON: use `sampleIntervalMs: 5000` and `includeRr: true` only for every 3rd session by default.

```ts
createLiveSimulator(opts?: { seed?: number; restingHr?: number; reactivity?: number; startedAt?: EpochMs }): LiveSimulator
interface LiveSimulator {
  /** Advance to time `now` and return all samples / RR generated since the last call (1 Hz samples). */
  tick(now: EpochMs): { samples: HeartRateSample[]; rr: RRInterval[] };
  setPhase(phase: PhaseKind): void;            // shifts the target offset
  trigger(marker: MarkerKind): void;           // adds the marker response
}
```
Used by the app's demo/simulator sensor so that tapping "Complication" visibly raises HR.
