/**
 * Display formatters.
 *
 * All output is locale-independent (no `Intl`/`toLocaleString`), so the
 * dashboard shows identical text on every OS, browser and language setting,
 * and so tests are deterministic. Dates are shown in the *recording's* local
 * time when the session stores its timezone offset, otherwise in UTC — never
 * in the viewer's timezone, which would shift a case across midnight
 * depending on where the dashboard is opened.
 */
import {
  APPROACH_LABELS,
  METRICS,
  ROLE_LABELS,
  TRAINING_LEVEL_LABELS,
  URGENCY_LABELS,
} from '@surgeonpulse/core';
import type { GroupKey, MetricKey } from '@surgeonpulse/core';

/** Placeholder shown for missing values. */
export const NO_DATA = '—';

/** Typographic minus sign used for negative numbers. */
const MINUS = '−';

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** Format a number with fixed decimals; `null`/non-finite gives the placeholder. */
export function fmtNumber(value: number | null | undefined, decimals = 0): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return NO_DATA;
  const fixed = value.toFixed(decimals);
  // Avoid "-0" / "-0.0" after rounding.
  if (/^-0(\.0+)?$/.test(fixed)) return fixed.slice(1);
  return fixed.startsWith('-') ? MINUS + fixed.slice(1) : fixed;
}

/** Like {@link fmtNumber} but always shows the sign (`+7.5`, `−2.0`). */
export function fmtSigned(value: number | null | undefined, decimals = 0): string {
  const s = fmtNumber(value, decimals);
  if (s === NO_DATA || s.startsWith(MINUS)) return s;
  return Number(value) === 0 || /^0(\.0+)?$/.test(s) ? s : `+${s}`;
}

/** Format a 0–1 fraction as a percentage string (`"92 %"`). */
export function fmtPercent(fraction: number | null | undefined, decimals = 0): string {
  if (fraction === null || fraction === undefined || !Number.isFinite(fraction)) return NO_DATA;
  return `${fmtNumber(fraction * 100, decimals)}\u00a0%`;
}

/** Format a metric value with the decimals from core `METRICS` (no unit). */
export function fmtMetric(key: MetricKey, value: number | null | undefined): string {
  return fmtNumber(value, METRICS[key].decimals);
}

/** Format a metric value with its unit, e.g. `"7.5 bpm"`, `"42 /100"`. */
export function fmtMetricWithUnit(key: MetricKey, value: number | null | undefined): string {
  const s = fmtMetric(key, value);
  const unit = METRICS[key].unit;
  if (s === NO_DATA || unit === '') return s;
  return unit.startsWith('/') ? `${s}${unit}` : `${s} ${unit}`;
}

/** Metric label with its unit, e.g. `"Mean heart rate (bpm)"`. */
export function metricLabel(key: MetricKey): string {
  const { label, unit } = METRICS[key];
  if (unit === '') return label;
  // "/100" style units are scales: "Workload (TLX), 0–100", "Self-rated performance (0–10)".
  const shown = unit.startsWith('/') ? `0–${unit.slice(1)}` : unit;
  return label.endsWith(')') ? `${label}, ${shown}` : `${label} (${shown})`;
}

/** Integer with comma thousands separators (locale-independent): `132,328`. */
export function fmtCount(n: number): string {
  if (!Number.isFinite(n)) return NO_DATA;
  const s = String(Math.round(Math.abs(n))).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return n < 0 ? MINUS + s : s;
}

/** Shift an epoch time into the recording's local wall-clock time. */
function wallClock(t: number, tzOffsetMin?: number): Date {
  return new Date(t + (tzOffsetMin ?? 0) * 60_000);
}

/** `YYYY-MM-DD` in the recording's local date (UTC when the offset is unknown). */
export function fmtDate(t: number, tzOffsetMin?: number): string {
  if (!Number.isFinite(t)) return NO_DATA;
  const d = wallClock(t, tzOffsetMin);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

/** `HH:MM` in the recording's local time (UTC when the offset is unknown). */
export function fmtTime(t: number, tzOffsetMin?: number): string {
  if (!Number.isFinite(t)) return NO_DATA;
  const d = wallClock(t, tzOffsetMin);
  return `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`;
}

/** `YYYY-MM-DD HH:MM` plus a zone suffix (`UTC`, `UTC+10`, `UTC−05:30`). */
export function fmtDateTime(t: number, tzOffsetMin?: number): string {
  if (!Number.isFinite(t)) return NO_DATA;
  return `${fmtDate(t, tzOffsetMin)} ${fmtTime(t, tzOffsetMin)} ${fmtZone(tzOffsetMin)}`;
}

/** Timezone suffix for a minutes-east-of-UTC offset. */
export function fmtZone(tzOffsetMin?: number): string {
  if (tzOffsetMin === undefined || tzOffsetMin === 0) return 'UTC';
  const sign = tzOffsetMin > 0 ? '+' : MINUS;
  const abs = Math.abs(tzOffsetMin);
  const h = Math.floor(abs / 60);
  const m = abs % 60;
  return m === 0 ? `UTC${sign}${h}` : `UTC${sign}${pad2(h)}:${pad2(m)}`;
}

/** Minutes (one decimal) from a session start, for chart axes. */
export function minutesSince(t: number, start: number): number {
  return (t - start) / 60_000;
}

/** Axis tick for elapsed minutes: `"45"` under an hour, `"1:30"` above. */
export function fmtElapsedTick(minutes: number): string {
  if (!Number.isFinite(minutes)) return '';
  const total = Math.round(minutes);
  if (Math.abs(total) < 60) return String(total);
  const h = Math.trunc(total / 60);
  const m = Math.abs(total % 60);
  return `${h}:${pad2(m)}`;
}

/** Month label for a `YYYY-MM` key, e.g. `"Jan 2026"`. */
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export function fmtMonthKey(key: string): string {
  const m = /^(\d{4})-(\d{2})$/.exec(key);
  if (m === null) return key;
  const name = MONTHS[Number(m[2]) - 1];
  return name === undefined ? key : `${name} ${m[1]}`;
}

/** Human-readable names of the core `GroupKey`s. */
export const GROUP_LABELS: Readonly<Record<GroupKey, string>> = {
  none: 'No grouping (all sessions)',
  participant: 'Participant',
  procedure: 'Procedure',
  specialty: 'Specialty',
  approach: 'Approach',
  role: 'Role',
  trainingLevel: 'Training level',
  urgency: 'Urgency',
  month: 'Month',
};

/** Display label for a group value produced by core `aggregateMetric`. */
export function groupValueLabel(groupBy: GroupKey, value: string): string {
  switch (groupBy) {
    case 'approach':
      return lookup(APPROACH_LABELS, value);
    case 'role':
      return lookup(ROLE_LABELS, value);
    case 'trainingLevel':
      return lookup(TRAINING_LEVEL_LABELS, value);
    case 'urgency':
      return lookup(URGENCY_LABELS, value);
    case 'month':
      return fmtMonthKey(value);
    default:
      return value;
  }
}

/** Look up a label in a core label map, falling back to the raw value. */
export function lookup(labels: Readonly<Record<string, string>>, value: string | undefined | null): string {
  if (value === undefined || value === null || value === '') return NO_DATA;
  return Object.prototype.hasOwnProperty.call(labels, value) ? (labels[value] ?? value) : value;
}

/** Pluralise a count: `plural(1, 'session')` → `"1 session"`. */
export function plural(n: number, singular: string, pluralForm = `${singular}s`): string {
  return `${n} ${n === 1 ? singular : pluralForm}`;
}

/** Compact file-size formatter (`"12.9 MB"`). */
export function fmtBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return NO_DATA;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} kB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
