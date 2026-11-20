/**
 * Heart-rate zones and time-in-zone.
 *
 * References:
 * - Tanaka H, Monahan KD, Seals DR (2001). Age-predicted maximal heart rate revisited.
 *   J Am Coll Cardiol 37(1):153–156. HRmax = 208 − 0.7 × age.
 */
import type { HeartRateSample, ZoneDefinition, ZoneTime } from '../types';
import { isValidBpm } from './hr';
import { resolveMaxGapMs } from './internal';
import { median, stableSortBy } from './stats';

/**
 * Age-predicted maximal heart rate (Tanaka et al., 2001): `208 − 0.7 × age`, rounded to the nearest integer
 * (halves round up). Computed as `(2080 − 7·age) / 10` so whole-year ages are free of binary rounding error.
 *
 * @param birthYear Year of birth (only the year is stored, to limit identifiability).
 * @param atYear Year at which to evaluate the age (e.g. the UTC year of the session).
 * @throws RangeError when either year is not finite.
 */
export function estimateMaxHr(birthYear: number, atYear: number): number {
  if (!Number.isFinite(birthYear) || !Number.isFinite(atYear)) {
    throw new RangeError('estimateMaxHr: birthYear and atYear must be finite numbers');
  }
  const age = atYear - birthYear;
  return Math.round((2080 - 7 * age) / 10);
}

/**
 * Five zones as a percentage of max HR: z1 `[0, 60 %)` "Very light", z2 `[60, 70 %)` "Light",
 * z3 `[70, 80 %)` "Moderate", z4 `[80, 90 %)` "Hard", z5 `[90 %, ∞)` "Maximum".
 * Bounds are `maxHr × pct` and are not rounded (computed as `maxHr·pct/100` to avoid binary error in `0.7`).
 */
export function zonesFromMaxHr(maxHr: number): ZoneDefinition[] {
  const at = (pct: number): number => (maxHr * pct) / 100;
  return [
    { id: 'z1', label: 'Very light', minBpm: 0, maxBpm: at(60) },
    { id: 'z2', label: 'Light', minBpm: at(60), maxBpm: at(70) },
    { id: 'z3', label: 'Moderate', minBpm: at(70), maxBpm: at(80) },
    { id: 'z4', label: 'Hard', minBpm: at(80), maxBpm: at(90) },
    { id: 'z5', label: 'Maximum', minBpm: at(90), maxBpm: Number.POSITIVE_INFINITY },
  ];
}

/**
 * Four zones relative to a resting baseline: `rest` [0, rest+10) "At rest", `elevated` [rest+10, rest+20)
 * "Elevated", `high` [rest+20, rest+30) "High", `very-high` [rest+30, ∞) "Very high".
 */
export function zonesFromBaseline(restingHr: number): ZoneDefinition[] {
  return [
    { id: 'rest', label: 'At rest', minBpm: 0, maxBpm: restingHr + 10 },
    { id: 'elevated', label: 'Elevated', minBpm: restingHr + 10, maxBpm: restingHr + 20 },
    { id: 'high', label: 'High', minBpm: restingHr + 20, maxBpm: restingHr + 30 },
    { id: 'very-high', label: 'Very high', minBpm: restingHr + 30, maxBpm: Number.POSITIVE_INFINITY },
  ];
}

/**
 * Time-weighted dwell per sample: valid samples ({@link isValidBpm}) sorted by t (stably); sample i dwells
 * `min(t[i+1] − t[i], maxGapMs)`; the last sample dwells the median of the other (already capped) dwells, again
 * capped at `maxGapMs`, or 0 if it is the only sample. Negative dwells (duplicate t cannot produce any) count as 0.
 */
function sampleDwells(
  samples: readonly HeartRateSample[],
  maxGapMs: number,
): { bpm: number; dwellMs: number }[] {
  const valid = stableSortBy(
    samples.filter((s) => isValidBpm(s.bpm) && Number.isFinite(s.t)),
    (s) => s.t,
  );
  const n = valid.length;
  if (n === 0) return [];
  const dwells: number[] = [];
  for (let i = 0; i + 1 < n; i++) dwells.push(Math.min(valid[i + 1]!.t - valid[i]!.t, maxGapMs));
  const lastDwell = n === 1 ? 0 : Math.min(median(dwells) ?? 0, maxGapMs);
  dwells.push(lastDwell);
  return valid.map((s, i) => ({ bpm: s.bpm, dwellMs: Math.max(0, dwells[i]!) }));
}

/**
 * Time spent in each zone (time-weighted).
 *
 * Each valid sample (finite bpm within [25, 250], see {@link isValidBpm}) contributes its dwell
 * (`min(t[i+1] − t[i], maxGapMs)`; the last sample uses the median of the other, capped dwells, capped again at
 * `maxGapMs`, or 0 when it is the only sample) to the first zone with `minBpm ≤ bpm < maxBpm`. The output follows
 * the order of `zones`, includes zero-time zones, and has `fraction = seconds / Σseconds` (0 when nothing was
 * recorded).
 *
 * @param maxGapMs Cap on any one sample's dwell so data gaps are not credited to a zone (default 5000 ms;
 *   `NaN` also means the default, so a bad setting can never produce `NaN` seconds).
 */
export function timeInZones(
  samples: readonly HeartRateSample[],
  zones: readonly ZoneDefinition[],
  maxGapMs = 5000,
): ZoneTime[] {
  const ms = new Array<number>(zones.length).fill(0);
  for (const { bpm, dwellMs } of sampleDwells(samples, resolveMaxGapMs(maxGapMs))) {
    for (let z = 0; z < zones.length; z++) {
      const zone = zones[z]!;
      if (bpm >= zone.minBpm && bpm < zone.maxBpm) {
        ms[z]! += dwellMs;
        break;
      }
    }
  }
  let totalSec = 0;
  const seconds = ms.map((m) => m / 1000);
  for (const s of seconds) totalSec += s;
  return zones.map((zone, z) => {
    const sec = seconds[z]!;
    return { id: zone.id, label: zone.label, seconds: sec, fraction: totalSec > 0 ? sec / totalSec : 0 };
  });
}
