# Parity fixtures

These are the inputs and expected outputs shared by the TypeScript library
(`packages/core`) and the Python toolkit (`analysis`). They let CI check that both
implementations of the analytics in [`packages/core/SPEC.md`](../packages/core/SPEC.md) give the
same answers.

**Don't edit these files by hand.** Regenerate them with:

```bash
npm run fixtures -w @surgeonpulse/core
# equivalently: cd packages/core && npx tsx scripts/generate-fixtures.ts
```

The generator ([`packages/core/scripts/generate-fixtures.ts`](../packages/core/scripts/generate-fixtures.ts))
uses only the public API (`packages/core/src/index.ts`). It is fully deterministic (fixed seeds
and clocks), so the output is byte-identical on every run and every OS. CI regenerates the
fixtures and fails if `fixtures/` changes.

## Layout

| Path | Contents |
| --- | --- |
| `manifest.json` | Every fixture: description, simulator options, post-simulation edits, `SummaryOptions`, the options used for the "extras" calls, and any NaN/∞ the generator found in TypeScript outputs (`nonFiniteOutputs`, which must stay `{}`) |
| `sessions/<name>.json` | One `SurgicalSession` per file, already passed through `parseSession` |
| `cohort-small.json` | `ExportBundle` from `simulateCohort({seed: 2026, participants: 3, sessionsPerParticipant: 4})` |
| `imports/<name>.json` | Raw `parseImport` inputs: a list, a bundle and a single session, including invalid sessions |
| `expected/<name>.summary.json` | `summarizeSession(session, summaryOptions)` |
| `expected/<name>.hrv.json` | `computeHrv` (default and `minIntervals: 20`), `cleanRr` valid flags and report, `hrvTimeDomain` and `baevskyStressIndex` of the valid RR, `rollingHrv` (default and custom) |
| `expected/<name>.extras.json` | Direct calls with non-default options: `sessionEnd`, `derivePhases`, `hrStats`, `percentile`, `detectGaps`, `dataQuality`, `timeInZones`, `detectStressEpisodes` (three option sets), `computeBaseline`, custom `cleanRr` / `computeHrv`, Baevsky with other bin widths |
| `expected/<name>.{samples,rr,events}.csv` | `samplesToCsv`, `rrToCsv`, `eventsToCsv` (CRLF) |
| `expected/sessions.summaries.csv` | `summariesToCsv` over all single-session fixtures |
| `expected/cohort-small.summaries.{json,csv}` | Summaries of every cohort session, and `summariesToCsv` |
| `expected/cohort-small.aggregates.json` | `aggregateMetric` for several metric × group combinations |
| `expected/misc.json` | Small hand-picked vectors (inputs stored next to outputs): `mean`/`median`/`sampleSd`/`percentile`/`movingAverage`, `linearTrend`, `estimateMaxHr` for ages 0–90, zone definitions, `scoreWorkload` (clamping, invalid weights), `hrvTimeDomain` |
| `expected/import-*.result.json` | `parseImport`: kept session ids, participants (including synthesised ones), warnings, and the sort order of the samples |

## Session fixtures

| Name | What it exercises |
| --- | --- |
| `sim-1` | Default physiology, measured baseline, `birthYear` → Tanaka max HR |
| `sim-7` | Frequent 5–40 s dropouts, 6 markers per hour, reactive trainee |
| `sim-13` | 8 % RR artefacts |
| `sim-21` | No RR data: HRV, stress index and artefact ratio are null |
| `sim-34` | No measured baseline; profile `restingHr` → `source: "profile"` baseline |
| `sim-55` | No baseline and no resting HR; %HRmax zones from `birthYear` |
| `sim-89` | Explicit `SummaryOptions` (`maxHr`, `atYear`, `episodeThresholdBpm`, `maxGapMs`), 2 s sampling, no post-op report |
| `sim-144` | Dropouts and artefacts; NASA-TLX with invalid weights → `weighted: null` |
| `edge-phases` | Hand-built. Phase before the start (clamped), duplicate phase, zero-length middle segment, final phase at the session end, invalid bpm inside episodes, gaps of exactly 5 s and 6 s, merged and dropped episodes, an RR dropout, out-of-range RR |
| `edge-window` | Hand-built. Samples, RR and events before `startedAt` and after `endedAt` (window clipping), unaligned sample times |
| `edge-sparse` | One HR sample, 12 RR intervals, no events, no `endedAt` |
| `edge-empty` | No data at all, zero-length window |
| `edge-watch` | Hand-built. Health Connect at about one sample per minute (source-aware gap rule for coverage, dwell and episodes), `contact: false` samples, `tzOffsetMin`, sleep/caffeine/outcome covariates and a `demo` tag (`simulated: true`) |
| `edge-strap` | Hand-built. 1 Hz strap with a single spike (robust `peakHr`), a `contact: false` block, four 5-minute stress-index windows, a 40-s phase without HRV and an irregular-rhythm phase above the 10 % artefact limit |

## How the comparison works

`analysis/tests/test_parity.py` recomputes every expected value with the Python implementation.
Counts, ids, timestamps and strings must match exactly; other numbers must agree within
`rtol = 1e-9, atol = 1e-6`; the samples, RR and events CSVs must be byte-identical. Check ids are
named like `sim-7:hrv.rollingHrv` or `edge-phases:extras.episodesNoMerge`, so you can pin a known
TypeScript discrepancy with `xfail(strict=True)` (see `TS_DISCREPANCIES` in that file).

`.gitattributes` turns off end-of-line conversion for this directory. The expected CSVs use
RFC 4180 CRLF line endings and are compared byte for byte, so Git for Windows
(`core.autocrlf=true`) must not rewrite them.

The fixtures total about 6.7 MB; keep them under 15 MB (a test enforces this).
