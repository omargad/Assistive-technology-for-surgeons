/**
 * Display formatters that are purely presentational (dates, numbers, units).
 * Domain labels and duration/clock formatting live in `@surgeonpulse/core`
 * (`formatDuration`, `formatClock`, `*_LABELS`) — use those for anything they cover.
 */

const EM_DASH = '—';

function isNum(x: number | null | undefined): x is number {
  return typeof x === 'number' && Number.isFinite(x);
}

/** Fixed-decimal number, or an em dash for null / non-finite input. */
export function formatNumber(x: number | null | undefined, decimals = 0): string {
  return isNum(x) ? x.toFixed(decimals) : EM_DASH;
}

/** Number with a unit, e.g. `"72 bpm"`. */
export function formatWithUnit(x: number | null | undefined, unit: string, decimals = 0): string {
  return isNum(x) ? `${x.toFixed(decimals)}${unit ? ` ${unit}` : ''}` : EM_DASH;
}

/** Signed delta, e.g. `"+12"` / `"−3"` (true minus sign for screen readers & typography). */
export function formatDelta(x: number | null | undefined, decimals = 0): string {
  if (!isNum(x)) return EM_DASH;
  const rounded = Number(x.toFixed(decimals));
  if (rounded === 0) return (0).toFixed(decimals);
  const body = Math.abs(rounded).toFixed(decimals);
  return rounded > 0 ? `+${body}` : `−${body}`;
}

/** Fraction 0–1 as a percentage string. */
export function formatPercent(fraction: number | null | undefined, decimals = 0): string {
  return isNum(fraction) ? `${(fraction * 100).toFixed(decimals)}%` : EM_DASH;
}

/** e.g. "Mon 5 Jan 2026". */
export function formatDate(t: number): string {
  try {
    return new Date(t).toLocaleDateString(undefined, {
      weekday: 'short',
      day: 'numeric',
      month: 'short',
      year: 'numeric',
    });
  } catch {
    return new Date(t).toDateString();
  }
}

/** e.g. "5 Jan". */
export function formatShortDate(t: number): string {
  try {
    return new Date(t).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
  } catch {
    const d = new Date(t);
    return `${d.getDate()}/${d.getMonth() + 1}`;
  }
}

/** Local time of day, e.g. "08:05". */
export function formatTimeOfDay(t: number): string {
  const d = new Date(t);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

/** e.g. "Mon 5 Jan 2026, 08:05". */
export function formatDateTime(t: number): string {
  return `${formatDate(t)}, ${formatTimeOfDay(t)}`;
}

/**
 * Elapsed time for chart axes and event lists: `"m:ss"` under an hour,
 * `"h:mm"` (or `"h:mm:ss"` with `withSeconds`) above.
 */
export function formatElapsed(ms: number, withSeconds = false): string {
  if (!Number.isFinite(ms)) return EM_DASH;
  const sign = ms < 0 ? '−' : '';
  const total = Math.floor(Math.abs(ms) / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const ss = String(s).padStart(2, '0');
  if (h === 0) return `${sign}${m}:${ss}`;
  const mm = String(m).padStart(2, '0');
  return withSeconds ? `${sign}${h}:${mm}:${ss}` : `${sign}${h}:${mm}`;
}

/**
 * Compact elapsed-time axis label: minutes ("0m", "15m") for cases under an
 * hour, hours ("1h", "1h30") otherwise — unambiguous, unlike "1:00".
 */
export function formatAxisTime(ms: number, durationMs: number): string {
  const totalMin = Math.round(ms / 60_000);
  if (durationMs < 3_600_000) return `${totalMin}m`;
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return m === 0 ? `${h}h` : `${h}h${String(m).padStart(2, '0')}`;
}

/** Spoken form of an elapsed time for accessibility labels, e.g. "1 hour 5 minutes". */
export function spokenElapsed(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const parts: string[] = [];
  if (h) parts.push(`${h} hour${h === 1 ? '' : 's'}`);
  if (m) parts.push(`${m} minute${m === 1 ? '' : 's'}`);
  if (!h && (s || parts.length === 0)) parts.push(`${s} second${s === 1 ? '' : 's'}`);
  return parts.join(' ');
}
