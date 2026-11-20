/**
 * Minimal chart maths for the hand-rolled SVG charts: linear scales, "nice"
 * tick generation and gap-aware SVG path building. Pure functions (unit-testable).
 */

export type Scale = (v: number) => number;

/** Linear map from [d0, d1] to [r0, r1]; a degenerate domain maps to the range midpoint. */
export function linearScale(d0: number, d1: number, r0: number, r1: number): Scale {
  const span = d1 - d0;
  if (!Number.isFinite(span) || span === 0) {
    const mid = (r0 + r1) / 2;
    return () => mid;
  }
  const k = (r1 - r0) / span;
  return (v: number) => r0 + (v - d0) * k;
}

/** A "nice" step (1, 2, 2.5, 5 × 10^k) for roughly `count` intervals over `span`. */
export function niceStep(span: number, count: number): number {
  if (!(span > 0) || !(count > 0)) return 1;
  const raw = span / count;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / mag;
  const nice = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10;
  return nice * mag;
}

/** Nice domain covering [min, max] and the ticks inside it. */
export function niceDomain(min: number, max: number, count = 4): { min: number; max: number; ticks: number[] } {
  let lo = min;
  let hi = max;
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return { min: 0, max: 1, ticks: [0, 1] };
  if (lo === hi) {
    lo -= 1;
    hi += 1;
  }
  const step = niceStep(hi - lo, count);
  const nMin = Math.floor(lo / step) * step;
  const nMax = Math.ceil(hi / step) * step;
  const ticks: number[] = [];
  for (let v = nMin; v <= nMax + step / 2; v += step) ticks.push(Number(v.toFixed(6)));
  return { min: nMin, max: nMax, ticks };
}

const MINUTE = 60_000;
const TIME_STEPS = [1, 2, 5, 10, 15, 20, 30, 60, 90, 120, 180, 240].map((m) => m * MINUTE);

/** Elapsed-time tick offsets (ms from start) for a duration, at whole-minute steps. */
export function timeTicks(durationMs: number, maxTicks = 6): number[] {
  if (!(durationMs > 0)) return [0];
  const step = TIME_STEPS.find((s) => durationMs / s <= maxTicks) ?? Math.ceil(durationMs / maxTicks / (60 * MINUTE)) * 60 * MINUTE;
  const ticks: number[] = [];
  for (let t = 0; t <= durationMs + 1; t += step) ticks.push(t);
  return ticks;
}

export interface PathPoint {
  x: number;
  y: number | null;
}

/** SVG path through the points; a `null` y breaks the line (data gap). */
export function linePath(points: readonly PathPoint[]): string {
  let d = '';
  let pen = false;
  for (const p of points) {
    if (p.y == null || !Number.isFinite(p.y) || !Number.isFinite(p.x)) {
      pen = false;
      continue;
    }
    d += `${pen ? 'L' : 'M'}${p.x.toFixed(1)},${p.y.toFixed(1)}`;
    pen = true;
  }
  return d;
}

/** Isolated points (a value with null neighbours) would be invisible as a path; return them for dot rendering. */
export function isolatedPoints(points: readonly PathPoint[]): { x: number; y: number }[] {
  const out: { x: number; y: number }[] = [];
  points.forEach((p, i) => {
    if (p.y == null) return;
    const prev = points[i - 1];
    const next = points[i + 1];
    if ((prev?.y ?? null) == null && (next?.y ?? null) == null) out.push({ x: p.x, y: p.y });
  });
  return out;
}

/** Clamp helper. */
export function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/** Pixel distance between adjacent ticks under scale `y` (0 for fewer than two ticks). */
export function tickSpacingPx(ticks: readonly number[], y: Scale): number {
  const a = ticks[0];
  const b = ticks[1];
  return a == null || b == null ? 0 : Math.abs(y(b) - y(a));
}

/** Pixel y of the highest tick (the top of the value axis). */
export function topTickPx(ticks: readonly number[], y: Scale, fallback: number): number {
  const last = ticks[ticks.length - 1];
  return last == null ? fallback : y(last);
}
