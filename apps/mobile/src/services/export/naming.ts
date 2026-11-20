/**
 * File naming for exports: `surgeonpulse-<code>-<yyyymmdd-hhmm>[-suffix].<ext>`
 * using local time (what the surgeon sees on the clock). Codes are sanitised
 * so a filename can never carry anything other than the pseudonymous code.
 */

function pad(n: number, width = 2): string {
  return String(n).padStart(width, '0');
}

/** `yyyymmdd-hhmm` in local time. */
export function fileTimestamp(t: number): string {
  const d = new Date(t);
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
}

/** Keep only filename-safe characters of a participant code. */
export function safeCode(code: string | null | undefined): string {
  const cleaned = (code ?? '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32);
  return cleaned === '' ? 'export' : cleaned;
}

export function exportFileName(code: string | null | undefined, t: number, ext: string, suffix?: string): string {
  const tail = suffix ? `-${suffix.replace(/[^A-Za-z0-9_-]/g, '')}` : '';
  return `surgeonpulse-${safeCode(code)}-${fileTimestamp(t)}${tail}.${ext}`;
}
