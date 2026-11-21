/**
 * CSV export/import (RFC 4180) for statistics packages (R, SPSS, Stata,
 * Excel, pandas). Output uses CRLF line endings and a header row; the parser
 * accepts CRLF, LF or CR and a leading byte-order mark.
 */
import type { PhaseKind, PhaseSummary, SessionSummary, SurgicalSession } from '../types';
import { PHASE_ORDER } from '../types';
import { derivePhases, phaseAt } from '../analytics/phases';
import { cleanRr } from '../analytics/rr';

const CRLF = '\r\n';
const NEEDS_QUOTES = /[",\r\n]/;
/** First characters that make Excel, LibreOffice or Google Sheets treat a cell as a formula (OWASP CSV injection). */
const FORMULA_START = /^[=+\-@\t\r]/;

/** Options for {@link toCsv}. */
export interface CsvOptions {
  /**
   * Neutralise spreadsheet formula injection (OWASP "CSV Injection"): a **string** value whose first character is
   * `=`, `+`, `-`, `@`, TAB or CR is written with a leading `'`, so a spreadsheet shows it as text instead of
   * evaluating it (e.g. a note `=HYPERLINK(...)`). Numbers are never altered, so negative values such as
   * `t_offset_s` stay numeric. Default `false`, so plain `toCsv` → `parseCsv` round-trips exactly; the session and
   * summary exporters turn it on.
   */
  formulaGuard?: boolean;
}

/** Render one value as CSV field text (before quoting). */
function formatValue(v: unknown, formulaGuard: boolean): string {
  if (v === null || v === undefined) return '';
  switch (typeof v) {
    case 'string':
      return formulaGuard && FORMULA_START.test(v) ? `'${v}` : v;
    case 'number':
      return Number.isFinite(v) ? String(v) : '';
    case 'boolean':
      return v ? 'true' : 'false';
    case 'bigint':
      return String(v);
    case 'object': {
      if (v instanceof Date) return Number.isNaN(v.getTime()) ? '' : v.toISOString();
      try {
        return JSON.stringify(v) ?? '';
      } catch {
        return '';
      }
    }
    default:
      return '';
  }
}

/** Quote a field if it contains a comma, quote, CR or LF, doubling embedded quotes (RFC 4180 §2.6–2.7). */
function escapeField(s: string): string {
  return NEEDS_QUOTES.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function unionKeys(rows: readonly Record<string, unknown>[]): string[] {
  const seen = new Set<string>();
  const keys: string[] = [];
  for (const row of rows) {
    for (const k of Object.keys(row)) {
      if (!seen.has(k)) {
        seen.add(k);
        keys.push(k);
      }
    }
  }
  return keys;
}

/**
 * Serialise rows as RFC 4180 CSV: a header row, then one record per row,
 * each terminated by `\r\n` (including the last one).
 *
 * - Fields containing `,`, `"`, CR or LF are quoted, with `"` doubled.
 * - `null`/`undefined`/missing keys → empty field. Numbers use `String(n)`;
 *   `NaN`/`±Infinity` → empty. Booleans → `true`/`false`. Dates → ISO 8601.
 *   Other objects → JSON.
 * - `columns` defaults to the union of the rows' own keys in first-seen order.
 *   With no columns at all the result is `""`.
 * - `options.formulaGuard` prefixes `'` to string values that a spreadsheet
 *   would run as a formula (see {@link CsvOptions}); header names are never
 *   altered.
 *
 * No byte-order mark is written, because R's `read.csv` and pandas would
 * otherwise read it into the first column name. When saving a file meant to be
 * opened by double-clicking in Excel on Windows, prepend `"﻿"` so Excel
 * detects UTF-8.
 */
export function toCsv(
  rows: readonly Record<string, unknown>[],
  columns?: readonly string[],
  options: CsvOptions = {},
): string {
  const cols = columns !== undefined ? columns.slice() : unionKeys(rows);
  if (cols.length === 0) return '';
  const guard = options.formulaGuard === true;
  const lines: string[] = [cols.map(escapeField).join(',')];
  for (const row of rows) {
    lines.push(
      cols
        .map((c) => escapeField(Object.prototype.hasOwnProperty.call(row, c) ? formatValue(row[c], guard) : ''))
        .join(','),
    );
  }
  return lines.join(CRLF) + CRLF;
}

/**
 * Parse RFC 4180 CSV into rows of string fields (the inverse of
 * {@link toCsv}). Handles quoted fields with embedded commas, doubled quotes
 * and line breaks; CRLF, LF or CR record separators; an optional trailing
 * newline (no empty last row); and a leading UTF-8 byte-order mark.
 *
 * Lenient on malformed input rather than throwing: a `"` inside an unquoted
 * field is literal, text after a closing quote is appended, and an
 * unterminated quoted field runs to the end of the input.
 */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  const n = text.length;
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  let row: string[] = [];
  let field = '';
  // A quote opens a quoted field only as the first character of a field.
  let atFieldStart = true;

  while (i < n) {
    const c = text.charCodeAt(i);
    if (c === 0x22 /* " */ && atFieldStart) {
      // Quoted field: read up to the closing quote, un-doubling "" pairs.
      atFieldStart = false;
      i++;
      for (;;) {
        const q = text.indexOf('"', i);
        if (q < 0) {
          field += text.slice(i);
          i = n;
          break;
        }
        field += text.slice(i, q);
        if (text.charCodeAt(q + 1) === 0x22) {
          field += '"';
          i = q + 2;
        } else {
          i = q + 1;
          break;
        }
      }
      continue;
    }
    if (c === 0x2c /* , */) {
      row.push(field);
      field = '';
      atFieldStart = true;
      i++;
      continue;
    }
    if (c === 0x0d /* CR */ || c === 0x0a /* LF */) {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      atFieldStart = true;
      i += c === 0x0d && text.charCodeAt(i + 1) === 0x0a ? 2 : 1;
      continue;
    }
    // Unquoted run up to the next delimiter (a '"' in here is literal).
    let j = i + 1;
    while (j < n) {
      const d = text.charCodeAt(j);
      if (d === 0x2c || d === 0x0d || d === 0x0a) break;
      j++;
    }
    field += text.slice(i, j);
    atFieldStart = false;
    i = j;
  }
  // Flush a final record that has no trailing line break.
  if (!atFieldStart || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Session exports (long format: one row per sample / beat / event)
// ---------------------------------------------------------------------------

/**
 * Every exporter below writes files meant to be opened in spreadsheets and statistics packages, and some fields are
 * free text (event notes, procedure names) or come from imported files, so they all enable the formula guard.
 */
const EXPORT_OPTIONS: CsvOptions = { formulaGuard: true };

function isoTime(t: number): string {
  if (!Number.isFinite(t)) return '';
  const d = new Date(t);
  return Number.isNaN(d.getTime()) ? '' : d.toISOString();
}

function offsetSec(t: number, startedAt: number): number {
  return (t - startedAt) / 1000;
}

/**
 * Heart-rate samples, one row each:
 * `session_id,participant_code,t_iso,t_offset_s,bpm,contact,phase`.
 * `t_iso` is `Date.prototype.toISOString()` (UTC, milliseconds, `Z`);
 * `t_offset_s` = (t − startedAt)/1000; `contact` is `1`/`0` (empty when the
 * sensor does not report it); `phase` is the phase in progress (`phaseAt`).
 * Text fields are formula-guarded ({@link CsvOptions}).
 */
export function samplesToCsv(s: SurgicalSession): string {
  const segments = derivePhases(s);
  const rows = s.samples.map((x) => ({
    session_id: s.id,
    participant_code: s.participantCode,
    t_iso: isoTime(x.t),
    t_offset_s: offsetSec(x.t, s.startedAt),
    bpm: x.bpm,
    contact: x.contact === undefined ? '' : x.contact ? 1 : 0,
    phase: phaseAt(segments, x.t) ?? '',
  }));
  return toCsv(rows, ['session_id', 'participant_code', 't_iso', 't_offset_s', 'bpm', 'contact', 'phase'], EXPORT_OPTIONS);
}

/**
 * RR intervals in beat order, one row each:
 * `session_id,participant_code,t_iso,t_offset_s,rr_ms,valid,phase`.
 * `valid` is `1`/`0` from `cleanRr` (artefact/ectopic screening).
 */
export function rrToCsv(s: SurgicalSession): string {
  const segments = derivePhases(s);
  const { valid } = cleanRr(s.rr);
  const rows = s.rr.map((x, i) => {
    const v = valid[i];
    return {
      session_id: s.id,
      participant_code: s.participantCode,
      t_iso: isoTime(x.t),
      t_offset_s: offsetSec(x.t, s.startedAt),
      rr_ms: x.ms,
      valid: v === undefined ? '' : v ? 1 : 0,
      phase: phaseAt(segments, x.t) ?? '',
    };
  });
  return toCsv(rows, ['session_id', 'participant_code', 't_iso', 't_offset_s', 'rr_ms', 'valid', 'phase'], EXPORT_OPTIONS);
}

/**
 * Events, one row each:
 * `session_id,participant_code,t_iso,t_offset_s,type,kind,logged_by,note`.
 * `kind` is the phase or marker kind. Free-text notes are formula-guarded
 * ({@link CsvOptions}), so a note such as `=HYPERLINK(…)` is shown as text.
 */
export function eventsToCsv(s: SurgicalSession): string {
  const rows = s.events.map((e) => ({
    session_id: s.id,
    participant_code: s.participantCode,
    t_iso: isoTime(e.t),
    t_offset_s: offsetSec(e.t, s.startedAt),
    type: e.type,
    kind: e.type === 'phase' ? e.phase : e.marker,
    logged_by: e.loggedBy ?? '',
    note: e.note ?? '',
  }));
  return toCsv(rows, ['session_id', 'participant_code', 't_iso', 't_offset_s', 'type', 'kind', 'logged_by', 'note'], EXPORT_OPTIONS);
}

// ---------------------------------------------------------------------------
// Session summaries (wide format: one row per session)
// ---------------------------------------------------------------------------

/** Column-name stem for a phase: `pre-op` → `pre_op`. */
function phaseStem(phase: PhaseKind): string {
  return phase.replace(/-/g, '_');
}

const SUMMARY_BASE_COLUMNS: readonly string[] = [
  // identifiers
  'session_id',
  'participant_code',
  'training_level',
  'started_at',
  'ended_at',
  // procedure
  'procedure_name',
  'specialty',
  'approach',
  'role',
  'urgency',
  'complexity',
  // whole-session physiology
  'duration_min',
  'hr_mean',
  'hr_median',
  'hr_min',
  'hr_max',
  'hr_sd',
  'hr_p95',
  'rmssd',
  'sdnn',
  'pnn50',
  'mean_rr',
  'stress_index',
  'rr_artifact_pct',
  'baseline_hr',
  'mean_hr_delta',
  'peak_hr_delta',
  'high_intensity_pct',
  'episode_count',
  'episode_minutes',
  // self-report
  'workload_instrument',
  'workload_raw',
  'workload_weighted',
  'performance',
  'perceived_stress',
  // data quality
  'coverage_pct',
];

const PHASE_METRICS = ['duration_s', 'hr_mean', 'hr_delta', 'rmssd'] as const;

/**
 * Provenance and covariate columns, after the phase columns (appended so that scripts that address the older
 * columns by position keep working).
 */
const SUMMARY_PROVENANCE_COLUMNS: readonly string[] = [
  'sensor_source',
  'simulated',
  'tz_offset_min',
  'started_local',
  'baseline_source',
  'baseline_duration_s',
  'max_hr',
  'peak_hr',
  'hrv_n',
  'sleep_hours',
  'caffeine',
  'outcome',
  'analytics_version',
];

/**
 * Fixed column order of {@link summariesToCsv}: identifiers, procedure fields,
 * whole-session metrics, self-report, `coverage_pct`, then for each phase in
 * `PHASE_ORDER`: `<phase>_duration_s`, `<phase>_hr_mean`, `<phase>_hr_delta`,
 * `<phase>_rmssd` (with `_` in phase names, e.g. `pre_op_hr_mean`), then the
 * provenance and covariate columns `sensor_source`, `simulated`,
 * `tz_offset_min`, `started_local`, `baseline_source`, `baseline_duration_s`,
 * `max_hr`, `peak_hr`, `hrv_n`, `sleep_hours`, `caffeine`, `outcome`,
 * `analytics_version`.
 */
export const SUMMARY_CSV_COLUMNS: readonly string[] = Object.freeze([
  ...SUMMARY_BASE_COLUMNS,
  ...PHASE_ORDER.flatMap((p) => PHASE_METRICS.map((m) => `${phaseStem(p)}_${m}`)),
  ...SUMMARY_PROVENANCE_COLUMNS,
]);

/**
 * Local wall-clock time as ISO 8601 with the UTC offset, e.g. `2026-03-02T08:00:00.000+11:00` for
 * `2026-03-01T21:00:00.000Z` at +660 min; empty when the offset is unknown. Uses only UTC getters (via
 * `toISOString` of a shifted timestamp), so the device's own time zone never matters.
 */
function localIsoTime(t: number, tzOffsetMin: number | undefined): string {
  if (typeof tzOffsetMin !== 'number' || !Number.isFinite(tzOffsetMin)) return '';
  const shifted = isoTime(t + tzOffsetMin * 60000);
  if (shifted === '' || !shifted.endsWith('Z')) return '';
  const abs = Math.abs(Math.round(tzOffsetMin));
  const sign = tzOffsetMin < 0 ? '-' : '+';
  const hh = String(Math.floor(abs / 60)).padStart(2, '0');
  const mm = String(abs % 60).padStart(2, '0');
  return `${shifted.slice(0, -1)}${sign}${hh}:${mm}`;
}

function flag(b: boolean | null | undefined): number | null {
  return b === null || b === undefined ? null : b ? 1 : 0;
}

/**
 * Duration-weighted mean of the finite values. Falls back to the plain mean
 * when every weight is zero, and gives `null` when there is no finite value.
 * A single value is returned unchanged (not as `(w·x)/w`, which can differ in
 * the last bit), so a phase that occurs once exports exactly the value in its
 * `PhaseSummary`.
 */
function weightedMean(items: readonly { value: number | null | undefined; weight: number }[]): number | null {
  let sumW = 0;
  let sumWX = 0;
  let sum = 0;
  let n = 0;
  let only = 0;
  for (const { value, weight } of items) {
    if (value === null || value === undefined || !Number.isFinite(value)) continue;
    n++;
    sum += value;
    only = value;
    if (Number.isFinite(weight) && weight > 0) {
      sumW += weight;
      sumWX += weight * value;
    }
  }
  if (n === 0) return null;
  if (n === 1) return only;
  return sumW > 0 ? sumWX / sumW : sum / n;
}

function phaseColumns(phases: readonly PhaseSummary[]): Record<string, number | null> {
  const out: Record<string, number | null> = {};
  for (const phase of PHASE_ORDER) {
    const stem = phaseStem(phase);
    const segs = phases.filter((p) => p.phase === phase);
    if (segs.length === 0) {
      for (const m of PHASE_METRICS) out[`${stem}_${m}`] = null;
      continue;
    }
    out[`${stem}_duration_s`] = segs.reduce((acc, p) => acc + (Number.isFinite(p.durationSec) ? p.durationSec : 0), 0);
    out[`${stem}_hr_mean`] = weightedMean(segs.map((p) => ({ value: p.hr?.mean, weight: p.durationSec })));
    out[`${stem}_hr_delta`] = weightedMean(segs.map((p) => ({ value: p.meanHrDelta, weight: p.durationSec })));
    out[`${stem}_rmssd`] = weightedMean(segs.map((p) => ({ value: p.hrv?.rmssd, weight: p.durationSec })));
  }
  return out;
}

function pct(fraction: number | null | undefined): number | null {
  return fraction === null || fraction === undefined ? null : fraction * 100;
}

/**
 * One wide row per session for SPSS/R/Stata (columns:
 * {@link SUMMARY_CSV_COLUMNS}). Missing values are empty fields. Percentages
 * are 0–100. A phase that occurs several times in a session is combined:
 * `_duration_s` is the total, and `_hr_mean`, `_hr_delta` and `_rmssd` are
 * duration-weighted means over its segments. Phases that never occur are
 * empty. `started_at`/`ended_at` are ISO 8601 UTC with milliseconds;
 * `started_local` is the local start with its offset (empty without
 * `tzOffsetMin`). `simulated` and `caffeine` are `1`/`0`;
 * `baseline_duration_s = (baseline.endedAt − baseline.startedAt)/1000` (0 for a
 * profile baseline); `hrv_n` is the number of valid RR intervals behind the
 * whole-session HRV. Fields a summary does not have (older stored summaries)
 * are empty. Text fields are formula-guarded ({@link CsvOptions}).
 */
export function summariesToCsv(summaries: readonly SessionSummary[]): string {
  const rows = summaries.map((s) => {
    const workload = s.workload;
    const episodeSec = s.episodes.reduce((acc, e) => acc + (Number.isFinite(e.durationSec) ? e.durationSec : 0), 0);
    return {
      session_id: s.sessionId,
      participant_code: s.participantCode,
      training_level: s.trainingLevel,
      started_at: isoTime(s.startedAt),
      ended_at: isoTime(s.endedAt),
      procedure_name: s.procedureName,
      specialty: s.specialty,
      approach: s.approach,
      role: s.role,
      urgency: s.urgency,
      complexity: s.complexity,
      duration_min: s.durationSec / 60,
      hr_mean: s.hr?.mean,
      hr_median: s.hr?.median,
      hr_min: s.hr?.min,
      hr_max: s.hr?.max,
      hr_sd: s.hr?.sd,
      hr_p95: s.hr?.p95,
      rmssd: s.hrv?.rmssd,
      sdnn: s.hrv?.sdnn,
      pnn50: s.hrv?.pnn50,
      mean_rr: s.hrv?.meanRr,
      stress_index: s.stressIndex,
      rr_artifact_pct: pct(s.rrArtifacts?.ratio),
      baseline_hr: s.baseline?.restingHr,
      mean_hr_delta: s.meanHrDelta,
      peak_hr_delta: s.peakHrDelta,
      high_intensity_pct: pct(s.highIntensityFraction),
      episode_count: s.episodes.length,
      episode_minutes: episodeSec / 60,
      workload_instrument: workload?.instrument,
      workload_raw: workload?.raw,
      workload_weighted: workload?.weighted,
      performance: s.performance,
      perceived_stress: s.perceivedStress,
      coverage_pct: pct(s.quality.coverage),
      ...phaseColumns(s.phases),
      sensor_source: s.sensorSource,
      simulated: flag(s.simulated),
      tz_offset_min: s.tzOffsetMin,
      started_local: localIsoTime(s.startedAt, s.tzOffsetMin),
      baseline_source: s.baseline?.source,
      baseline_duration_s: s.baseline ? (s.baseline.endedAt - s.baseline.startedAt) / 1000 : null,
      max_hr: s.maxHr,
      peak_hr: s.peakHr,
      hrv_n: s.hrv?.n,
      sleep_hours: s.sleepHours,
      caffeine: flag(s.caffeine),
      outcome: s.outcome,
      analytics_version: s.analyticsVersion,
    };
  });
  return toCsv(rows, SUMMARY_CSV_COLUMNS, EXPORT_OPTIONS);
}
