/**
 * Data dictionary for the session-summary CSV (`summariesToCsv` in core).
 *
 * The column list is read from core at runtime (the header of an empty
 * export), so the dictionary always matches what is downloaded; this module
 * only supplies the descriptions.
 */
import { PHASE_LABELS, PHASE_ORDER, parseCsv, summariesToCsv } from '@surgeonpulse/core';
import type { PhaseKind } from '@surgeonpulse/core';

export interface ColumnInfo {
  column: string;
  description: string;
  unit: string;
}

const BASE: Readonly<Record<string, [description: string, unit: string]>> = {
  session_id: ['Unique session identifier (UUID).', ''],
  participant_code: ['Pseudonymous participant study code.', ''],
  training_level: ['Training level at the time of the session.', ''],
  started_at: ['Session start, ISO 8601 UTC.', ''],
  ended_at: ['Session end, ISO 8601 UTC.', ''],
  procedure_name: ['Procedure name (catalogue name after de-identification).', ''],
  specialty: ['Surgical specialty.', ''],
  approach: ['Surgical approach (open, laparoscopic, robotic, …).', ''],
  role: ["Participant's role in the case.", ''],
  urgency: ['Case urgency (elective, urgent, emergency).', ''],
  complexity: ['Anticipated complexity rated before the case.', '1–5'],
  duration_min: ['Session duration.', 'min'],
  hr_mean: ['Mean heart rate over the session.', 'bpm'],
  hr_median: ['Median heart rate.', 'bpm'],
  hr_min: ['Minimum heart rate.', 'bpm'],
  hr_max: ['Maximum heart rate.', 'bpm'],
  hr_sd: ['Sample standard deviation of heart rate.', 'bpm'],
  hr_p95: ['95th percentile of heart rate.', 'bpm'],
  rmssd: ['Root mean square of successive RR differences (artefact-corrected; empty when more than 10 % of beats were artefacts).', 'ms'],
  sdnn: ['Standard deviation of valid RR intervals over the whole case (grows with case length; do not compare across durations).', 'ms'],
  pnn50: ['Share of successive RR differences greater than 50 ms.', '%'],
  mean_rr: ['Mean valid RR interval.', 'ms'],
  stress_index: ['Baevsky stress index (raw SI, not √SI): median over 5-min windows of valid RR intervals.', 'index'],
  rr_artifact_pct: ['RR intervals flagged as artefact/ectopic and excluded.', '%'],
  baseline_hr: ['Resting baseline heart rate (measured before the case or from the profile).', 'bpm'],
  mean_hr_delta: ['Mean heart rate minus baseline.', 'bpm'],
  peak_hr_delta: ['Robust peak heart rate (peak_hr) minus baseline.', 'bpm'],
  high_intensity_pct: ['Time at or above 70 % of maximum heart rate.', '%'],
  episode_count: ['Number of sustained stress episodes (HR above threshold ≥ 60 s).', 'count'],
  episode_minutes: ['Total time in stress episodes.', 'min'],
  workload_instrument: ['Workload questionnaire used (surg-tlx or nasa-tlx).', ''],
  workload_raw: ['Unweighted mean of the six TLX ratings.', '0–100'],
  workload_weighted: ['Weighted TLX score from pairwise comparisons (empty when not collected).', '0–100'],
  performance: ['Self-rated performance.', '0–10'],
  perceived_stress: ['Self-rated overall stress during the case.', '0–10'],
  coverage_pct: [
    'Share of the session covered by heart-rate samples (gaps over 5 s excluded, or the sparser watch rule; samples without skin contact excluded).',
    '%',
  ],
  sensor_source: ['Heart-rate source (ble, web-bluetooth, healthkit, health-connect, simulated, import).', ''],
  simulated: ['1 for simulated or demo data, which must be excluded from analyses; 0 otherwise.', '0/1'],
  tz_offset_min: ['Local time-zone offset at the start, minutes east of UTC (e.g. 660 for AEDT).', 'min'],
  started_local: ['Session start in local time, ISO 8601 with UTC offset (empty when the offset is unknown).', ''],
  baseline_source: ['Where baseline_hr came from: measured before the case, entered manually, or the profile resting HR.', ''],
  baseline_duration_s: ['Length of the baseline window (0 for a profile baseline).', 's'],
  max_hr: ['Maximum heart rate used for high_intensity_pct (measured override or age-predicted).', 'bpm'],
  peak_hr: ['Robust peak heart rate: highest 11-s rolling median, so a single spike is ignored.', 'bpm'],
  hrv_n: ['Number of valid RR intervals behind the whole-session HRV.', 'count'],
  sleep_hours: ['Self-reported hours slept the night before.', 'h'],
  caffeine: ['Self-reported caffeine within 2 hours before the case (1 yes, 0 no).', '0/1'],
  outcome: ['Self-reported case outcome (as-planned, minor-deviation, major-deviation).', ''],
  analytics_version: ['Version of the analytics definitions that computed this row; recompute rows from older versions before pooling.', ''],
};

const PHASE_METRIC: Readonly<Record<string, [description: (phase: string) => string, unit: string]>> = {
  duration_s: [(p) => `Total time in the ${p} phase.`, 's'],
  hr_mean: [(p) => `Mean heart rate during the ${p} phase (duration-weighted over repeated segments).`, 'bpm'],
  hr_delta: [(p) => `Mean heart rate above baseline during the ${p} phase.`, 'bpm'],
  rmssd: [(p) => `RMSSD during the ${p} phase.`, 'ms'],
};

const PHASE_STEMS: ReadonlyMap<string, PhaseKind> = new Map(PHASE_ORDER.map((p) => [p.replace(/-/g, '_'), p]));

/** Describe one summary-CSV column. Unknown columns get a generic description. */
export function describeColumn(column: string): ColumnInfo {
  const base = BASE[column];
  if (base !== undefined) return { column, description: base[0], unit: base[1] };
  for (const [stem, phase] of PHASE_STEMS) {
    if (!column.startsWith(`${stem}_`)) continue;
    const metric = PHASE_METRIC[column.slice(stem.length + 1)];
    if (metric !== undefined) {
      return { column, description: metric[0](PHASE_LABELS[phase].toLowerCase()), unit: metric[1] };
    }
  }
  return { column, description: 'See the SurgeonPulse core documentation.', unit: '' };
}

/** Columns of the summary CSV, in download order, with descriptions. */
export function summaryColumnDictionary(): ColumnInfo[] {
  const header = parseCsv(summariesToCsv([]))[0] ?? [];
  return header.map(describeColumn);
}
