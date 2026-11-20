import { describe, expect, it } from 'vitest';
import { MARKER_KINDS, PHASE_ORDER } from '../src/types';
import type {
  CaseOutcome,
  EventLogger,
  NasaTlxDimension,
  PhaseKind,
  Platform,
  SensorSourceKind,
  SessionStatus,
  SurgeonRole,
  SurgicalApproach,
  SurgTlxDimension,
  TrainingLevel,
  Urgency,
  WorkloadInstrument,
} from '../src/types';
import {
  APPROACH_LABELS,
  BASELINE_SOURCE_LABELS,
  COMPLEXITY_LABELS,
  EVENT_LOGGER_LABELS,
  EVENT_TYPE_LABELS,
  HRV_METRIC_LABELS,
  INSIGHT_KIND_LABELS,
  MARKER_ICONS,
  MARKER_LABELS,
  NASA_TLX_DIMENSION_LABELS,
  OUTCOME_LABELS,
  PHASE_COLORS,
  PHASE_LABELS,
  PLATFORM_LABELS,
  ROLE_LABELS,
  SENSOR_SOURCE_LABELS,
  SESSION_STATUS_LABELS,
  SURG_TLX_DIMENSION_LABELS,
  TRAINING_LEVEL_LABELS,
  URGENCY_LABELS,
  WORKLOAD_INSTRUMENT_LABELS,
  formatClock,
  formatDuration,
} from '../src/presentation/labels';

/**
 * Compile-time exhaustive list of a union's members: fails to type-check if a
 * member is missing, so these lists track `types.ts`.
 */
function allOf<U extends string>() {
  return <const L extends readonly U[]>(list: L & ([Exclude<U, L[number]>] extends [never] ? unknown : never)): L => list;
}

const UNIONS: [string, Readonly<Record<string, string>>, readonly string[]][] = [
  ['PHASE_LABELS', PHASE_LABELS, PHASE_ORDER],
  ['MARKER_LABELS', MARKER_LABELS, MARKER_KINDS],
  ['MARKER_ICONS', MARKER_ICONS, MARKER_KINDS],
  ['PHASE_COLORS', PHASE_COLORS, PHASE_ORDER],
  ['SENSOR_SOURCE_LABELS', SENSOR_SOURCE_LABELS, allOf<SensorSourceKind>()(['ble', 'web-bluetooth', 'healthkit', 'health-connect', 'simulated', 'import'])],
  ['PLATFORM_LABELS', PLATFORM_LABELS, allOf<Platform>()(['ios', 'android', 'web', 'unknown'])],
  ['EVENT_LOGGER_LABELS', EVENT_LOGGER_LABELS, allOf<EventLogger>()(['self', 'team', 'retrospective'])],
  ['EVENT_TYPE_LABELS', EVENT_TYPE_LABELS, ['phase', 'marker']],
  ['APPROACH_LABELS', APPROACH_LABELS, allOf<SurgicalApproach>()(['open', 'laparoscopic', 'robotic', 'endoscopic', 'percutaneous', 'microsurgical', 'other'])],
  ['ROLE_LABELS', ROLE_LABELS, allOf<SurgeonRole>()(['primary', 'assistant', 'supervising', 'observing'])],
  ['URGENCY_LABELS', URGENCY_LABELS, allOf<Urgency>()(['elective', 'urgent', 'emergency'])],
  ['TRAINING_LEVEL_LABELS', TRAINING_LEVEL_LABELS, allOf<TrainingLevel>()(['consultant', 'fellow', 'registrar', 'resident', 'intern', 'student', 'other'])],
  ['OUTCOME_LABELS', OUTCOME_LABELS, allOf<CaseOutcome>()(['as-planned', 'minor-deviation', 'major-deviation'])],
  ['WORKLOAD_INSTRUMENT_LABELS', WORKLOAD_INSTRUMENT_LABELS, allOf<WorkloadInstrument>()(['surg-tlx', 'nasa-tlx'])],
  ['SURG_TLX_DIMENSION_LABELS', SURG_TLX_DIMENSION_LABELS, allOf<SurgTlxDimension>()(['mental', 'physical', 'temporal', 'complexity', 'stress', 'distraction'])],
  ['NASA_TLX_DIMENSION_LABELS', NASA_TLX_DIMENSION_LABELS, allOf<NasaTlxDimension>()(['mental', 'physical', 'temporal', 'performance', 'effort', 'frustration'])],
  ['SESSION_STATUS_LABELS', SESSION_STATUS_LABELS, allOf<SessionStatus>()(['recording', 'completed', 'aborted'])],
  ['BASELINE_SOURCE_LABELS', BASELINE_SOURCE_LABELS, ['measured', 'manual', 'profile']],
  ['HRV_METRIC_LABELS', HRV_METRIC_LABELS, ['sdnn', 'rmssd']],
  ['INSIGHT_KIND_LABELS', INSIGHT_KIND_LABELS, ['info', 'positive', 'attention']],
  ['COMPLEXITY_LABELS', COMPLEXITY_LABELS, ['1', '2', '3', '4', '5']],
];

describe('label maps', () => {
  it.each(UNIONS)('%s covers exactly the union members', (_name, labels, members) => {
    expect(Object.keys(labels).sort()).toEqual([...members].sort());
  });

  it.each(UNIONS)('%s values are non-empty, trimmed and unique', (_name, labels) => {
    const values = Object.values(labels);
    for (const v of values) {
      expect(v.length).toBeGreaterThan(0);
      expect(v.trim()).toBe(v);
    }
    expect(new Set(values).size).toBe(values.length);
  });

  it('has a label, colour and icon for every phase and marker in the canonical lists', () => {
    for (const phase of PHASE_ORDER) {
      expect(PHASE_LABELS[phase], phase).toBeTruthy();
      expect(PHASE_COLORS[phase], phase).toBeTruthy();
    }
    for (const marker of MARKER_KINDS) {
      expect(MARKER_LABELS[marker], marker).toBeTruthy();
      expect(MARKER_ICONS[marker], marker).toBeTruthy();
    }
  });

  it('uses the SURG-TLX dimension names of Wilson et al. (2011)', () => {
    expect(Object.values(SURG_TLX_DIMENSION_LABELS)).toEqual([
      'Mental Demands',
      'Physical Demands',
      'Temporal Demands',
      'Task Complexity',
      'Situational Stress',
      'Distractions',
    ]);
  });

  it('is frozen', () => {
    expect(Object.isFrozen(PHASE_LABELS)).toBe(true);
    expect(Object.isFrozen(PHASE_COLORS)).toBe(true);
  });
});

describe('MARKER_ICONS', () => {
  it('are short, printable ASCII (no emoji) and unique', () => {
    const icons = MARKER_KINDS.map((k) => MARKER_ICONS[k]);
    for (const icon of icons) {
      expect(icon.length).toBeGreaterThanOrEqual(1);
      expect(icon.length).toBeLessThanOrEqual(2);
      expect(icon).toMatch(/^[\x21-\x7e]+$/);
      expect(icon).not.toMatch(/\p{Extended_Pictographic}/u);
    }
    expect(new Set(icons).size).toBe(icons.length);
  });
});

// ---------------------------------------------------------------------------
// Colour accessibility: simulate colour-vision deficiencies (Machado, Oliveira &
// Fernandes 2009, severity 1.0, applied in linear sRGB) and measure CIELAB ΔE*76.
// ---------------------------------------------------------------------------

type Vec3 = [number, number, number];
type Mat3 = [Vec3, Vec3, Vec3];

const CVD: Record<string, Mat3> = {
  normal: [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ],
  protanopia: [
    [0.152286, 1.052583, -0.204868],
    [0.114503, 0.786281, 0.099216],
    [-0.003882, -0.048116, 1.051998],
  ],
  deuteranopia: [
    [0.367322, 0.860646, -0.227968],
    [0.280085, 0.672501, 0.047413],
    [-0.01182, 0.04294, 0.968881],
  ],
  tritanopia: [
    [1.255528, -0.076749, -0.178779],
    [-0.078411, 0.930809, 0.147602],
    [0.004733, 0.691367, 0.3039],
  ],
};

const srgbToLinear = (c: number): number => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const hexToLinear = (hex: string): Vec3 =>
  [1, 3, 5].map((i) => srgbToLinear(parseInt(hex.slice(i, i + 2), 16) / 255)) as Vec3;

function linearToLab([r, g, b]: Vec3): Vec3 {
  const x = (0.4124564 * r + 0.3575761 * g + 0.1804375 * b) / 0.95047;
  const y = 0.2126729 * r + 0.7151522 * g + 0.072175 * b;
  const z = (0.0193339 * r + 0.119192 * g + 0.9503041 * b) / 1.08883;
  const f = (t: number): number => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116);
  return [116 * f(y) - 16, 500 * (f(x) - f(y)), 200 * (f(y) - f(z))];
}

/** Colour as seen with a deficiency, optionally as an `alpha` band over `background`. */
function perceived(hex: string, m: Mat3, alpha = 1, background = '#FFFFFF'): Vec3 {
  const fg = hexToLinear(hex);
  const bg = hexToLinear(background);
  const mixed = fg.map((v, i) => alpha * v + (1 - alpha) * (bg[i] as number)) as Vec3;
  const sim = m.map((row) => Math.min(1, Math.max(0, row[0] * mixed[0] + row[1] * mixed[1] + row[2] * mixed[2]))) as Vec3;
  return linearToLab(sim);
}

const deltaE = (a: Vec3, b: Vec3): number => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

describe('PHASE_COLORS', () => {
  const colours = PHASE_ORDER.map((p) => PHASE_COLORS[p]);

  it('are unique #RRGGBB hex colours', () => {
    for (const c of colours) expect(c).toMatch(/^#[0-9A-Fa-f]{6}$/);
    expect(new Set(colours.map((c) => c.toUpperCase())).size).toBe(colours.length);
  });

  it.each(Object.keys(CVD))('stay distinguishable from each other with %s vision (ΔE*76 ≥ 15)', (kind) => {
    const m = CVD[kind] as Mat3;
    let min = Infinity;
    for (let i = 0; i < colours.length; i++) {
      for (let j = i + 1; j < colours.length; j++) {
        min = Math.min(min, deltaE(perceived(colours[i] as string, m), perceived(colours[j] as string, m)));
      }
    }
    expect(min).toBeGreaterThanOrEqual(15);
  });

  it.each(Object.keys(CVD))('are visible as 25 %% bands on light and dark backgrounds with %s vision', (kind) => {
    const m = CVD[kind] as Mat3;
    for (const background of ['#FFFFFF', '#121212']) {
      const bg = perceived(background, m, 1, background);
      for (const c of colours) {
        expect(deltaE(perceived(c, m, 0.25, background), bg), `${c} on ${background}`).toBeGreaterThanOrEqual(6);
      }
    }
  });
});

describe('formatDuration', () => {
  it('formats the spec examples', () => {
    expect(formatDuration(3900)).toBe('1h 05m');
    expect(formatDuration(750)).toBe('12m 30s');
    expect(formatDuration(45)).toBe('45s');
  });

  it('handles boundaries, padding and rounding', () => {
    expect(formatDuration(0)).toBe('0s');
    expect(formatDuration(59.4)).toBe('59s');
    expect(formatDuration(59.6)).toBe('1m 00s');
    expect(formatDuration(65)).toBe('1m 05s');
    expect(formatDuration(3599)).toBe('59m 59s');
    expect(formatDuration(3600)).toBe('1h 00m');
    expect(formatDuration(3959)).toBe('1h 05m');
    expect(formatDuration(10 * 3600 + 7 * 60)).toBe('10h 07m');
  });

  it('handles negative and non-finite input without NaN', () => {
    expect(formatDuration(-45)).toBe('-45s');
    expect(formatDuration(-0.2)).toBe('0s');
    expect(formatDuration(Number.NaN)).toBe('—');
    expect(formatDuration(Number.POSITIVE_INFINITY)).toBe('—');
  });
});

describe('formatClock', () => {
  it('formats elapsed milliseconds as HH:MM:SS', () => {
    expect(formatClock(0)).toBe('00:00:00');
    expect(formatClock(999)).toBe('00:00:00');
    expect(formatClock(1000)).toBe('00:00:01');
    expect(formatClock(3_723_000)).toBe('01:02:03');
    expect(formatClock(5_400_000)).toBe('01:30:00');
    expect(formatClock(100 * 3_600_000)).toBe('100:00:00');
  });

  it('handles negative and non-finite input', () => {
    expect(formatClock(-61_000)).toBe('-00:01:01');
    expect(formatClock(-500)).toBe('00:00:00');
    expect(formatClock(Number.NaN)).toBe('--:--:--');
  });
});
