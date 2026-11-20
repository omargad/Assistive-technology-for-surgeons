/**
 * Human-readable labels, colours and formatters shared by the mobile app and
 * the research dashboard, so both present the domain model identically.
 *
 * Every `Record<Union, string>` below is exhaustive by construction: adding a
 * member to a union in `types.ts` makes this file fail to type-check until a
 * label is added.
 *
 * Strings are plain ASCII/Latin text (no emoji) so they render with the
 * default system fonts on iOS, Android and every browser.
 */
import type {
  Baseline,
  CaseOutcome,
  EventLogger,
  ExternalHrvReading,
  Insight,
  MarkerKind,
  NasaTlxDimension,
  PhaseKind,
  Platform,
  ProcedureInfo,
  SensorSourceKind,
  SessionEvent,
  SessionStatus,
  SurgeonRole,
  SurgicalApproach,
  SurgTlxDimension,
  TrainingLevel,
  Urgency,
  WorkloadInstrument,
} from '../types';

type Labels<K extends string | number> = Readonly<Record<K, string>>;

function frozen<K extends string | number>(labels: Record<K, string>): Labels<K> {
  return Object.freeze(labels);
}

// ---------------------------------------------------------------------------
// Operative timeline
// ---------------------------------------------------------------------------

/** Operative phase names. */
export const PHASE_LABELS: Labels<PhaseKind> = frozen({
  'pre-op': 'Pre-op',
  incision: 'Incision / access',
  dissection: 'Dissection',
  critical: 'Critical step',
  closure: 'Closure',
  'post-op': 'Post-op',
});

/**
 * Phase band colours from the Okabe–Ito palette (Okabe & Ito, 2008, "Color
 * Universal Design"), which stays distinguishable under protanopia,
 * deuteranopia and tritanopia. Yellow (#F0E442) and black are deliberately
 * omitted: yellow vanishes as a translucent band on white, black on dark mode.
 * The remaining hues have mid luminance, so a 15–30 % alpha band is visible on
 * both light and dark chart backgrounds. The critical step uses vermillion,
 * the most salient hue. Always pair colour with the phase label (WCAG 1.4.1).
 */
export const PHASE_COLORS: Labels<PhaseKind> = frozen({
  'pre-op': '#56B4E9', // sky blue
  incision: '#E69F00', // orange
  dissection: '#0072B2', // blue
  critical: '#D55E00', // vermillion
  closure: '#009E73', // bluish green
  'post-op': '#CC79A7', // reddish purple
});

/** Intra-operative marker names. */
export const MARKER_LABELS: Labels<MarkerKind> = frozen({
  complication: 'Complication',
  interruption: 'Interruption',
  equipment: 'Equipment issue',
  teaching: 'Teaching moment',
  takeover: 'Supervisor takeover',
  note: 'Note',
});

/**
 * Short, emoji-free ASCII glyphs for marker pins on charts (render in any
 * system font): `!` complication, `||` interruption (pause), `E` equipment,
 * `T` teaching, `S` supervisor takeover, `N` note.
 */
export const MARKER_ICONS: Labels<MarkerKind> = frozen({
  complication: '!',
  interruption: '||',
  equipment: 'E',
  teaching: 'T',
  takeover: 'S',
  note: 'N',
});

/** Event kinds. */
export const EVENT_TYPE_LABELS: Labels<SessionEvent['type']> = frozen({
  phase: 'Phase',
  marker: 'Marker',
});

/** Who logged an event. */
export const EVENT_LOGGER_LABELS: Labels<EventLogger> = frozen({
  self: 'Self-logged',
  team: 'Logged by team member',
  retrospective: 'Logged retrospectively',
});

// ---------------------------------------------------------------------------
// Procedure & participant
// ---------------------------------------------------------------------------

/** Surgical approaches. */
export const APPROACH_LABELS: Labels<SurgicalApproach> = frozen({
  open: 'Open',
  laparoscopic: 'Laparoscopic',
  robotic: 'Robotic',
  endoscopic: 'Endoscopic',
  percutaneous: 'Percutaneous / endovascular',
  microsurgical: 'Microsurgical',
  other: 'Other',
});

/** The participant's role in the case. */
export const ROLE_LABELS: Labels<SurgeonRole> = frozen({
  primary: 'Primary surgeon',
  assistant: 'Assistant',
  supervising: 'Supervising',
  observing: 'Observing',
});

/** Case urgency. */
export const URGENCY_LABELS: Labels<Urgency> = frozen({
  elective: 'Elective',
  urgent: 'Urgent',
  emergency: 'Emergency',
});

/** Anticipated complexity, 1–5. */
export const COMPLEXITY_LABELS: Labels<NonNullable<ProcedureInfo['complexity']>> = frozen({
  1: 'Routine',
  2: 'Straightforward',
  3: 'Moderate',
  4: 'Complex',
  5: 'Very complex',
});

/** Training levels (UK/Australasian terms, with the North American equivalent where it differs). */
export const TRAINING_LEVEL_LABELS: Labels<TrainingLevel> = frozen({
  consultant: 'Consultant / attending',
  fellow: 'Fellow',
  registrar: 'Registrar',
  resident: 'Resident',
  intern: 'Intern',
  student: 'Medical student',
  other: 'Other',
});

/** Self-reported case outcome. */
export const OUTCOME_LABELS: Labels<CaseOutcome> = frozen({
  'as-planned': 'As planned',
  'minor-deviation': 'Minor deviation from plan',
  'major-deviation': 'Major deviation from plan',
});

// ---------------------------------------------------------------------------
// Workload questionnaires
// ---------------------------------------------------------------------------

/** Workload instruments. */
export const WORKLOAD_INSTRUMENT_LABELS: Labels<WorkloadInstrument> = frozen({
  'surg-tlx': 'SURG-TLX',
  'nasa-tlx': 'NASA-TLX',
});

/** SURG-TLX dimension names (Wilson et al., 2011, Surg Endosc 25:2935). */
export const SURG_TLX_DIMENSION_LABELS: Labels<SurgTlxDimension> = frozen({
  mental: 'Mental Demands',
  physical: 'Physical Demands',
  temporal: 'Temporal Demands',
  complexity: 'Task Complexity',
  stress: 'Situational Stress',
  distraction: 'Distractions',
});

/** NASA-TLX dimension names (Hart & Staveland, 1988). */
export const NASA_TLX_DIMENSION_LABELS: Labels<NasaTlxDimension> = frozen({
  mental: 'Mental Demand',
  physical: 'Physical Demand',
  temporal: 'Temporal Demand',
  performance: 'Performance',
  effort: 'Effort',
  frustration: 'Frustration',
});

// ---------------------------------------------------------------------------
// Sensors, sessions & analytics
// ---------------------------------------------------------------------------

/** Where heart-rate data came from. */
export const SENSOR_SOURCE_LABELS: Labels<SensorSourceKind> = frozen({
  ble: 'Bluetooth heart-rate sensor',
  'web-bluetooth': 'Web Bluetooth heart-rate sensor',
  healthkit: 'Apple Health',
  'health-connect': 'Health Connect',
  simulated: 'Simulated',
  import: 'Imported file',
});

/** App platforms. */
export const PLATFORM_LABELS: Labels<Platform> = frozen({
  ios: 'iOS',
  android: 'Android',
  web: 'Web',
  unknown: 'Unknown',
});

/** Session lifecycle states. */
export const SESSION_STATUS_LABELS: Labels<SessionStatus> = frozen({
  recording: 'Recording',
  completed: 'Completed',
  aborted: 'Aborted',
});

/** Origin of the resting baseline. */
export const BASELINE_SOURCE_LABELS: Labels<Baseline['source']> = frozen({
  measured: 'Measured before the case',
  manual: 'Entered manually',
  profile: 'From participant profile',
});

/** HRV metrics (Task Force of the ESC/NASPE, 1996). */
export const HRV_METRIC_LABELS: Labels<ExternalHrvReading['metric']> = frozen({
  sdnn: 'SDNN',
  rmssd: 'RMSSD',
});

/** Insight categories. Worded neutrally: feedback is formative, not judgemental. */
export const INSIGHT_KIND_LABELS: Labels<Insight['kind']> = frozen({
  info: 'Observation',
  positive: 'Positive trend',
  attention: 'Worth a look',
});

// ---------------------------------------------------------------------------
// Formatters
// ---------------------------------------------------------------------------

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/**
 * Format a duration in seconds for display: `"1h 05m"` (≥ 1 h, seconds
 * dropped), `"12m 30s"` (≥ 1 min) or `"45s"`. Seconds are rounded to the
 * nearest whole second first; larger units are truncated, like a clock.
 * Negative durations get a leading `-`; non-finite input gives `"—"`.
 */
export function formatDuration(sec: number): string {
  if (!Number.isFinite(sec)) return '—';
  if (sec < 0) {
    const abs = formatDuration(-sec);
    return abs === '0s' ? abs : `-${abs}`;
  }
  const total = Math.round(sec);
  if (total >= 3600) {
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    return `${h}h ${pad2(m)}m`;
  }
  if (total >= 60) {
    const m = Math.floor(total / 60);
    const s = total % 60;
    return `${m}m ${pad2(s)}s`;
  }
  return `${total}s`;
}

/**
 * Format elapsed milliseconds as a stopwatch `"HH:MM:SS"` (truncated to whole
 * seconds; hours grow beyond two digits if needed). Negative values get a
 * leading `-`; non-finite input gives `"--:--:--"`.
 */
export function formatClock(ms: number): string {
  if (!Number.isFinite(ms)) return '--:--:--';
  if (ms < 0) {
    const abs = formatClock(-ms);
    return abs === '00:00:00' ? abs : `-${abs}`;
  }
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return `${pad2(h)}:${pad2(m)}:${pad2(s)}`;
}
