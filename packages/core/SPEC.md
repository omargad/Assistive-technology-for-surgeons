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
- Types come from `src/types.ts`. That file is the contract, so don't edit it. If you think a change is
  needed, report it instead.
- Relative imports have no file extension (`import { x } from './rr'`), because the code is resolved by Metro, Vite and tsx.
- Every module has unit tests in `test/<module>.test.ts` (Vitest).

Module layout (`src/`):

| File | Owner area | Contents |
| --- | --- | --- |
| `types.ts` | contract | Domain model (do not edit) |
| `index.ts` | contract | Public barrel: re-exports every module below |
| `analytics/stats.ts` | analytics | `mean`, `median`, `sampleSd`, `percentile`, `linearTrend`, `movingAverage` |
| `analytics/hr.ts` | analytics | `hrStats`, `sliceByTime`, `resampleHr`, `detectGaps` |
| `analytics/rr.ts` | analytics | `cleanRr`, `hrvTimeDomain`, `computeHrv`, `rollingHrv`, `baevskyStressIndex` |
| `analytics/zones.ts` | analytics | `estimateMaxHr`, `zonesFromMaxHr`, `zonesFromBaseline`, `timeInZones` |
| `analytics/phases.ts` | analytics | `derivePhases`, `phaseAt`, `sessionEnd` |
| `analytics/episodes.ts` | analytics | `detectStressEpisodes`, `defaultEpisodeThreshold` |
| `analytics/baseline.ts` | analytics | `computeBaseline` |
| `analytics/summary.ts` | analytics | `summarizeSession`, `dataQuality` |
| `analytics/trends.ts` | analytics | `METRICS`, `metricValue`, `aggregateMetric`, `metricSeries`, `generateInsights` |
| `instruments/tlx.ts` | analytics | `SURG_TLX_DIMENSIONS`, `NASA_TLX_DIMENSIONS`, `tlxPairs`, `scoreWorkload` |
| `ble/heartRate.ts` | io | GATT UUIDs, `parseHeartRateMeasurement`, `parseBodySensorLocation`, `parseBatteryLevel`, `base64ToBytes`, `bytesToBase64` |
| `io/schema.ts` | io | zod schemas, `parseSession`, `safeParseSession`, `migrateSession`, `SessionParseError` |
| `io/bundle.ts` | io | `createExportBundle`, `parseImport` |
| `io/csv.ts` | io | `toCsv`, `parseCsv`, `samplesToCsv`, `rrToCsv`, `eventsToCsv`, `summariesToCsv` |
| `io/deidentify.ts` | io | `deidentifySession`, `deidentifyBundle`, `isValidParticipantCode` |
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
```

## analytics/hr.ts

```ts
hrStats(samples: readonly HeartRateSample[]): HrStats | null
```
Ignores samples whose `bpm` is not finite or lies outside [25, 250]. Returns `null` if no valid samples remain.
Every statistic is computed over sample values (not time-weighted). `p95` uses `percentile(…, 95)`.

```ts
sliceByTime<T extends {t:number}>(xs: readonly T[], start: EpochMs, end: EpochMs): T[]   // start ≤ t < end
detectGaps(samples: readonly HeartRateSample[], maxGapMs = 5000): {start:EpochMs; end:EpochMs; durationMs:number}[]
```
A gap is any pair of consecutive samples where `next.t − prev.t > maxGapMs`. The gap runs from `prev.t` to `next.t`.

```ts
resampleHr(samples, intervalMs: number, opts?: {start?: EpochMs; end?: EpochMs; maxGapMs?: number /*5000*/}):
  {t: EpochMs; bpm: number | null}[]
```
Bucket `k` covers `[start + k·intervalMs, start + (k+1)·intervalMs)`. Its value is the mean bpm of the valid samples
in the bucket, or `null` when the bucket is empty. Buckets are emitted from `start` (default: first sample t) up to
`end` (default: last sample t, inclusive of that sample's bucket). Each bucket's `t` is its start time. Used for charting.
An empty input gives `[]`.

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
   rule 2 is skipped for that beat.

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
Windows end at `start + windowMs + k·stepMs` (start defaults to the first rr t; end defaults to the last rr t).
Each window covers RR with `windowEnd − windowMs ≤ t < windowEnd`, and `t` = windowEnd. Each window applies
`computeHrv` with `minIntervals` defaulting to **20** here. Values are null when hrv is null. Empty input gives `[]`.

```ts
baevskyStressIndex(intervalsMs: readonly number[], binMs = 50): number | null
```
`null` if fewer than 30 intervals. Build a histogram with bins `[floor(x/binMs)·binMs, +binMs)`.
`Mo` is the centre of the most populated bin in **seconds** (ties go to the lowest bin).
`AMo` is that bin's count / n × 100 (%). `MxDMn = (max − min)` in seconds.
`SI = AMo / (2 · Mo · MxDMn)`. Return null if MxDMn = 0.

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
Time-weighted. Sample i (valid bpm, sorted) has dwell `min(t[i+1] − t[i], maxGapMs)`. The last sample's dwell is
`min(median of the other dwells, maxGapMs)`, or 0 if it's the only sample. Each dwell goes to the zone with
`minBpm ≤ bpm < maxBpm`. Output follows the order of `zones`, includes zero-time zones, and sets `fraction = seconds / Σseconds`.

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
`index` counts 0,1,2… over the segments emitted. Time before the first phase event is **not** a segment.

```ts
phaseAt(segments: readonly PhaseSegment[], t: EpochMs): PhaseKind | undefined   // start ≤ t < end; t == last end → last phase
```

## analytics/baseline.ts

```ts
computeBaseline(samples: readonly HeartRateSample[], rr: readonly RRInterval[], start: EpochMs, end: EpochMs): Baseline | null
```
Uses data in `[start, end)`. `restingHr` = hrStats mean (null result if no HR). `rmssd`/`sdnn` come from `computeHrv`
with `minIntervals: 20`, and are omitted if that returns null. `source: 'measured'`.

## analytics/episodes.ts

```ts
defaultEpisodeThreshold(baseline: Baseline | null | undefined, hr: HrStats | null): number | null
```
Returns `baseline.restingHr + 20` when a baseline exists. Otherwise returns `hr.median + 15`, or `null` when there's no HR.

```ts
detectStressEpisodes(samples, opts: { thresholdBpm: number; minDurationMs?: number /*60000*/; mergeGapMs?: number /*30000*/ },
                     context?: { segments?: PhaseSegment[]; events?: SessionEvent[] }): StressEpisode[]
```
1. Find maximal runs of consecutive valid samples with `bpm ≥ threshold`. A run breaks on a sample below the threshold,
   or on a data gap greater than 5000 ms. A run's start is its first sample t, and its end is its last sample t.
2. Merge runs separated by `≤ mergeGapMs` (measured from the earlier run's end to the later run's start).
3. Keep merged episodes with `end − start ≥ minDurationMs`.
4. `peakBpm`/`peakT` is the max over the episode's above-threshold samples (first occurrence wins). `meanBpm` is the
   mean of the above-threshold samples in it. `phase` = `phaseAt(segments, peakT)`. `relatedEventIds` lists the
   events with `start − 120000 ≤ t ≤ end`, in time order.

## analytics/summary.ts

```ts
dataQuality(session: SurgicalSession, maxGapMs = 5000): DataQuality
```
`duration = sessionEnd − startedAt` (in ms; if ≤ 0, coverage is 0). Covered time is the sum of
`min(t[i+1]−t[i], maxGapMs)` between consecutive valid samples, clipped to the session window.
`coverage = min(1, covered/duration)`. `gapCount` and `longestGapSec` come from `detectGaps(samples, maxGapMs)`.
`sampleRateHz = (validCount − 1) / (covered/1000)` when covered > 0, else 0. `rrArtifactRatio` comes from `cleanRr`,
or is `null` without RR data.

```ts
interface SummaryOptions { maxHr?: number; atYear?: number; episodeThresholdBpm?: number; maxGapMs?: number }
summarizeSession(session: SurgicalSession, opts?: SummaryOptions): SessionSummary
```
- `endedAt = sessionEnd(session)`. `durationSec = (endedAt − startedAt)/1000`.
- `hr = hrStats(samples)`. `{hrv, artifacts} = computeHrv(rr)`. `rrArtifacts` is null when rr is empty.
  `stressIndex = baevskyStressIndex(valid rr ms)`.
- `baseline` = `session.baseline`. Otherwise, when `participantSnapshot.restingHr` exists, build
  `{source:'profile', restingHr, startedAt: startedAt, endedAt: startedAt}`. Otherwise null.
- `maxHr` = `opts.maxHr` ?? `participantSnapshot.maxHr` ?? `estimateMaxHr(birthYear, atYear ?? UTC year of startedAt)`
  when birthYear is known, else null.
- `zones`: use `zonesFromBaseline` when a baseline exists, else `zonesFromMaxHr` when maxHr is known, else `[]`.
- `highIntensityFraction`: the time-weighted (same dwell rule as `timeInZones`) fraction with bpm ≥ 0.7·maxHr,
  or null without maxHr.
- `phases`: `derivePhases`. Each phase gets hr/hrv computed on the slice `[start,end)`. HRV uses `computeHrv` with
  `minIntervals: 20`, and `meanHrDelta` = phase hr.mean − baseline.restingHr.
- `episodes`: threshold = `opts.episodeThresholdBpm ?? defaultEpisodeThreshold(baseline, hr)`. Empty when that's null.
- `markerCounts`: count of each marker kind present (omit kinds with zero).
- `workload` = `scoreWorkload(postOp.workload)`, or null. `performance`/`perceivedStress` come from postOp, or null.
- Copy the procedure fields and `participantSnapshot.trainingLevel`.

## analytics/trends.ts

```ts
type MetricKey = 'meanHr' | 'peakHr' | 'meanHrDelta' | 'peakHrDelta' | 'rmssd' | 'sdnn' | 'stressIndex'
  | 'highIntensityPct' | 'episodeCount' | 'episodeMinutes' | 'workload' | 'performance' | 'perceivedStress'
  | 'durationMin' | 'criticalMeanHr' | 'criticalMeanHrDelta' | 'coveragePct'
const METRICS: Record<MetricKey, { label: string; unit: string; higherIsBetter: boolean | null; decimals: number }>
metricValue(s: SessionSummary, key: MetricKey): number | null
```
`highIntensityPct = highIntensityFraction·100`. `workload` uses weighted ?? raw. `criticalMeanHr` is the
duration-weighted mean of hr.mean over the `critical` phases. `episodeMinutes` = Σ durationSec / 60.
`coveragePct = quality.coverage·100`.

```ts
type GroupKey = 'participant' | 'procedure' | 'specialty' | 'approach' | 'role' | 'trainingLevel' | 'urgency' | 'month' | 'none'
aggregateMetric(summaries: readonly SessionSummary[], key: MetricKey, groupBy: GroupKey):
  { group: string; n: number; mean: number; sd: number; median: number; min: number; max: number }[]
```
Groups with no non-null values are dropped. A missing group field becomes `'Unspecified'`. `month` is the UTC
`YYYY-MM` of startedAt. Results are sorted by group name, except that `month` sorts chronologically.

```ts
metricSeries(summaries, key: MetricKey): { sessionId: string; t: EpochMs; value: number }[]  // chronological, nulls dropped
generateInsights(summaries: readonly SessionSummary[]): Insight[]
```
Deterministic, evidence-based feedback written in plain, non-judgemental language. Needs at least 1 summary. Rules:
1. **Peak phase.** For each session, find the phase with the highest mean HR. If one phase is the peak in ≥ 50 % of
   sessions (with ≥ 3 sessions), report it as `info`.
2. **Trend.** With ≥ 5 sessions, fit `linearTrend` of `meanHrDelta` (else `meanHr`) against session order.
   A slope ≤ −0.5 bpm/session gives `positive` ("settling with experience"). A slope ≥ +0.5 gives `attention`.
3. **Recovery / HRV.** With ≥ 5 sessions that have RMSSD, compare the mean of the last 3 to the mean of the earlier ones.
   A drop of ≥ 15 % gives `attention` (suggest rest and recovery). A rise of ≥ 15 % gives `positive`.
4. **Workload vs physiology.** With ≥ 5 sessions that have both workload and meanHrDelta, compute the Pearson r.
   If |r| ≥ 0.5, give `info`.
5. **Data quality.** If the latest session has coverage < 0.8, give `attention` with a sensor-fit tip.
6. **Episodes after markers.** If ≥ 50 % of the episodes (with ≥ 3 episodes total) have a related `complication`
   or `interruption` event, give `info`.

Each insight `id` is a stable slug of the rule (e.g. `peak-phase`). `evidence` lists the session ids involved.

## instruments/tlx.ts

```ts
SURG_TLX_DIMENSIONS: readonly { id: SurgTlxDimension; label: string; question: string; low: string; high: string }[]
NASA_TLX_DIMENSIONS: readonly { id: NasaTlxDimension; label: string; question: string; low: string; high: string }[]
tlxPairs(instrument: WorkloadInstrument): [string, string][]     // the 15 unordered pairs, fixed order
scoreWorkload(resp: WorkloadResponse): WorkloadScore
```
SURG-TLX (Wilson et al., 2011): Mental Demands, Physical Demands, Temporal Demands, Task Complexity,
Situational Stress, Distractions. `raw` = mean of the 6 ratings, each clamped to [0,100]. `weighted` =
Σ(rating·weight)/15, and only applies when weights exist, every weight is an integer in 0–5, and they sum to 15.
Otherwise it's null. `dimensions` holds the clamped ratings.

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
Convert RR to ms as `raw · 1000 / 1024`, rounded to 3 decimals. A trailing odd byte is ignored.

```ts
parseBodySensorLocation(data): 'other'|'chest'|'wrist'|'finger'|'hand'|'ear-lobe'|'foot'|'unknown'
parseBatteryLevel(data): number                         // 0–100
base64ToBytes(b64: string): Uint8Array; bytesToBase64(bytes: ArrayLike<number>): string   // pure JS, no atob/Buffer
```

## io/schema.ts

Zod (v4) schemas that mirror `types.ts` exactly: `HeartRateSampleSchema`, `RRIntervalSchema`, `SessionEventSchema`,
`ProcedureInfoSchema`, `ParticipantProfileSchema`, `PostOpReportSchema`, `BaselineSchema`, `SurgicalSessionSchema`,
`ExportBundleSchema`. Numeric ranges: bpm 0–300, rr 0–5000 ms, ratings 0–100, performance and perceivedStress 0–10,
complexity 1–5. Unknown keys are **stripped**, not rejected. The zod types must be assignable to the TS types (add a
compile-time check).

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
`SessionParseError`.

## io/csv.ts

```ts
toCsv(rows: readonly Record<string, unknown>[], columns?: readonly string[]): string
```
RFC 4180 with `\r\n` line endings and a header row. Quote a field if it contains `,`, `"`, CR or LF, doubling any
embedded quotes. `null`/`undefined` become an empty field. Numbers use `String(n)`, and non-finite numbers become empty.
Columns default to the union of keys in first-seen order.

```ts
parseCsv(text: string): string[][]           // RFC 4180 inverse; handles quotes, CRLF/LF, trailing newline
samplesToCsv(s: SurgicalSession): string     // session_id,participant_code,t_iso,t_offset_s,bpm,contact,phase
rrToCsv(s: SurgicalSession): string          // session_id,participant_code,t_iso,t_offset_s,rr_ms,valid,phase
eventsToCsv(s: SurgicalSession): string      // session_id,participant_code,t_iso,t_offset_s,type,kind,logged_by,note
summariesToCsv(summaries: readonly SessionSummary[]): string
```
`t_offset_s` = (t − startedAt)/1000. `phase` = phaseAt. `valid` is `1`/`0` from cleanRr. `summariesToCsv` writes one
wide row per session for SPSS/R/Stata, with fixed columns: identifiers, procedure fields, duration_min, hr_mean,
hr_median, hr_min, hr_max, hr_sd, hr_p95, rmssd, sdnn, pnn50, mean_rr, stress_index, rr_artifact_pct,
baseline_hr, mean_hr_delta, peak_hr_delta, high_intensity_pct, episode_count, episode_minutes, workload_instrument,
workload_raw, workload_weighted, performance, perceived_stress, coverage_pct. Then for each phase in PHASE_ORDER:
`<phase>_duration_s`, `<phase>_hr_mean`, `<phase>_hr_delta`, `<phase>_rmssd`. Phase names use `_` (e.g. `pre_op_hr_mean`).
Phases that occur several times are duration-weighted.

## io/deidentify.ts

```ts
interface DeidentifyOptions { dropNotes?: boolean /*true*/; dropSensorId?: boolean /*true*/; timeShiftMs?: number /*0*/; dropTzOffset?: boolean /*false*/; dropBirthYear?: boolean /*false*/ }
deidentifySession(s: SurgicalSession, opts?): SurgicalSession
deidentifyBundle(b: ExportBundle, opts?): ExportBundle
isValidParticipantCode(code: string): boolean                // /^[A-Za-z0-9][A-Za-z0-9_-]{1,31}$/ and not an email-like string
```
With `dropNotes`, remove `postOp.notes` and every `event.note`, and replace `procedure.name` with the catalogue name
when `catalogId` resolves (free text in the name might contain patient details). `timeShiftMs` adds the offset to
**every** timestamp, consistently. `deidentifyBundle` applies the same options to every session and participant,
keeps `consent.version`, sets `givenAt` to the shifted value, and sets `deidentified: true`.

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
