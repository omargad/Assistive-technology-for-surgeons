/**
 * Cross-session metrics, grouping and plain-language feedback ("insights").
 *
 * Determinism and portability: sessions are ordered with an engine-independent stable sort, group names are
 * compared by UTF-16 code units (never `localeCompare`/`Intl`, whose results differ between Hermes, browsers and
 * Node), and month keys use UTC getters only (on a timestamp shifted by the session's `tzOffsetMin`).
 */
import type { EpochMs, Insight, PhaseKind, SessionSummary, SurgicalSession } from '../types';
import { linearTrend, mean, median, pearsonCorrelation, sampleSd, stableSortBy } from './stats';
import type { LinearTrend } from './stats';

/** Per-session metrics available for trends and group comparisons. */
export type MetricKey =
  | 'meanHr'
  | 'peakHr'
  | 'meanHrDelta'
  | 'peakHrDelta'
  | 'rmssd'
  | 'sdnn'
  | 'stressIndex'
  | 'highIntensityPct'
  | 'episodeCount'
  | 'episodeMinutes'
  | 'workload'
  | 'performance'
  | 'perceivedStress'
  | 'durationMin'
  | 'criticalMeanHr'
  | 'criticalMeanHrDelta'
  | 'coveragePct';

/** Ways to group sessions in {@link aggregateMetric}. */
export type GroupKey =
  | 'participant'
  | 'procedure'
  | 'specialty'
  | 'approach'
  | 'role'
  | 'trainingLevel'
  | 'urgency'
  | 'month'
  | 'none';

/** Display metadata of a metric. */
export interface MetricInfo {
  label: string;
  unit: string;
  /** Direction usually considered favourable, or `null` when it depends on context. */
  higherIsBetter: boolean | null;
  /** Suggested number of decimals for display. */
  decimals: number;
}

/** One row of {@link aggregateMetric}. */
export interface MetricAggregate {
  group: string;
  n: number;
  mean: number;
  sd: number;
  median: number;
  min: number;
  max: number;
}

/** One point of {@link metricSeries}. */
export interface MetricPoint {
  sessionId: string;
  t: EpochMs;
  value: number;
}

/** Optional extra data for {@link generateInsights}. */
export interface InsightContext {
  /**
   * The sessions behind the summaries (matched by id). Needed for the "episodes after markers" rule, because a
   * summary stores only the ids of an episode's related events, not their marker kinds.
   */
  sessions?: readonly SurgicalSession[];
}

// ---------------------------------------------------------------------------
// Statistical evidence (used by the insight rules and by trend charts)
// ---------------------------------------------------------------------------

/** Two-sided 5 % critical values of Student's t for df = 1…30 (index = df). */
const T_CRIT_95: readonly number[] = [
  Number.NaN, 12.706, 4.303, 3.182, 2.776, 2.571, 2.447, 2.365, 2.306, 2.262, 2.228, 2.201, 2.179, 2.16, 2.145,
  2.131, 2.12, 2.11, 2.101, 2.093, 2.086, 2.08, 2.074, 2.069, 2.064, 2.06, 2.056, 2.052, 2.048, 2.045, 2.042,
];

/**
 * Two-sided 5 % critical value of Student's t with `df` degrees of freedom (`df` is floored; above 30 the value of
 * the next lower tabulated df among 30, 40, 60 and 120 is used, which is conservative; 1.96 from df ≥ 1000).
 * `null` when df < 1 or not finite. A table, not an approximation, so every JavaScript engine gives the same answer.
 */
export function tCritical95(df: number): number | null {
  if (!Number.isFinite(df) || df < 1) return null;
  const d = Math.floor(df);
  if (d <= 30) return T_CRIT_95[d]!;
  if (d < 40) return 2.042;
  if (d < 60) return 2.021;
  if (d < 120) return 2.0;
  if (d < 1000) return 1.98;
  return 1.96;
}

/** {@link linearTrend} plus a t-test of the slope, see {@link trendEvidence}. */
export interface TrendEvidence extends LinearTrend {
  /** t statistic of the slope (df = n − 2); `null` for n < 3 or an exact (residual-free) non-flat fit. */
  t: number | null;
  /** True when the slope differs from 0 at the two-sided 5 % level (|t| ≥ {@link tCritical95}(n − 2)). */
  significant: boolean;
}

/**
 * OLS trend with the usual t-test of `slope = 0`: `t = sign(slope)·√(r²·(n − 2)/(1 − r²))`, df = n − 2. With fewer
 * than 3 points nothing can be tested (`t: null, significant: false`). An exact, non-flat fit (r² = 1) is
 * `significant` with `t: null` (t is unbounded). This is evidence that the points are not flat, not that one thing
 * caused another, and it assumes independent sessions.
 */
export function trendEvidence(points: readonly { x: number; y: number }[]): TrendEvidence | null {
  const fit = linearTrend(points);
  if (fit === null) return null;
  if (fit.n < 3 || fit.slope === 0) return { ...fit, t: fit.n < 3 ? null : 0, significant: false };
  if (fit.r2 >= 1) return { ...fit, t: null, significant: true };
  const t = Math.sign(fit.slope) * Math.sqrt((fit.r2 * (fit.n - 2)) / (1 - fit.r2));
  const crit = tCritical95(fit.n - 2);
  return { ...fit, t: Number.isFinite(t) ? t : null, significant: crit !== null && Math.abs(t) >= crit };
}

/** True when a Pearson r from `n` pairs differs from 0 at the two-sided 5 % level (t = r·√(n − 2)/√(1 − r²)). */
function correlationSignificant(r: number, n: number): boolean {
  if (!Number.isFinite(r) || n < 3) return false;
  if (Math.abs(r) >= 1) return true;
  const crit = tCritical95(n - 2);
  return crit !== null && Math.abs(r) * Math.sqrt((n - 2) / (1 - r * r)) >= crit;
}

/** Welch's two-sample t-test of equal means at the two-sided 5 % level (each group needs ≥ 2 values). */
function welchSignificant(a: readonly number[], b: readonly number[]): boolean {
  if (a.length < 2 || b.length < 2) return false;
  const ma = mean(a)!;
  const mb = mean(b)!;
  const va = sampleSd(a)! ** 2 / a.length;
  const vb = sampleSd(b)! ** 2 / b.length;
  const se2 = va + vb;
  if (!(se2 > 0)) return ma !== mb;
  const t = (ma - mb) / Math.sqrt(se2);
  const df = (se2 * se2) / ((va * va) / (a.length - 1) + (vb * vb) / (b.length - 1));
  const crit = tCritical95(df);
  return crit !== null && Number.isFinite(t) && Math.abs(t) >= crit;
}

/** Metric metadata for labels, units, colouring and formatting. */
export const METRICS: Readonly<Record<MetricKey, Readonly<MetricInfo>>> = Object.freeze({
  meanHr: { label: 'Mean heart rate', unit: 'bpm', higherIsBetter: null, decimals: 0 },
  peakHr: { label: 'Peak heart rate', unit: 'bpm', higherIsBetter: null, decimals: 0 },
  meanHrDelta: { label: 'Mean HR above baseline', unit: 'bpm', higherIsBetter: false, decimals: 1 },
  peakHrDelta: { label: 'Peak HR above baseline', unit: 'bpm', higherIsBetter: false, decimals: 0 },
  rmssd: { label: 'RMSSD', unit: 'ms', higherIsBetter: true, decimals: 1 },
  // Whole-case SDNN grows with recording length (Task Force 1996: do not compare SDNN across durations).
  sdnn: { label: 'SDNN (depends on case length)', unit: 'ms', higherIsBetter: null, decimals: 1 },
  stressIndex: { label: 'Stress index (Baevsky, 5-min median)', unit: '', higherIsBetter: false, decimals: 0 },
  highIntensityPct: { label: 'Time ≥ 70 % of max HR', unit: '%', higherIsBetter: false, decimals: 0 },
  episodeCount: { label: 'Stress episodes', unit: '', higherIsBetter: false, decimals: 0 },
  episodeMinutes: { label: 'Time in stress episodes', unit: 'min', higherIsBetter: false, decimals: 1 },
  workload: { label: 'Workload (raw TLX)', unit: '/100', higherIsBetter: false, decimals: 0 },
  performance: { label: 'Self-rated performance', unit: '/10', higherIsBetter: true, decimals: 1 },
  perceivedStress: { label: 'Perceived stress', unit: '/10', higherIsBetter: false, decimals: 1 },
  durationMin: { label: 'Duration', unit: 'min', higherIsBetter: null, decimals: 0 },
  criticalMeanHr: { label: 'Mean HR in critical phase', unit: 'bpm', higherIsBetter: null, decimals: 0 },
  criticalMeanHrDelta: {
    label: 'Critical-phase HR above baseline',
    unit: 'bpm',
    higherIsBetter: false,
    decimals: 1,
  },
  coveragePct: { label: 'Signal coverage', unit: '%', higherIsBetter: true, decimals: 0 },
});

function finiteOrNull(x: number | null | undefined): number | null {
  return typeof x === 'number' && Number.isFinite(x) ? x : null;
}

/** Duration-weighted mean of `pick(phase)` over the critical phases; null when there is no weight. */
function criticalWeighted(
  s: SessionSummary,
  pick: (p: SessionSummary['phases'][number]) => number | null,
): number | null {
  let wSum = 0;
  let acc = 0;
  for (const p of s.phases) {
    if (p.phase !== 'critical') continue;
    const v = pick(p);
    if (v === null || !Number.isFinite(v) || !(p.durationSec > 0)) continue;
    wSum += p.durationSec;
    acc += v * p.durationSec;
  }
  return wSum > 0 ? acc / wSum : null;
}

/**
 * Value of one metric for one session, or `null` when unavailable.
 *
 * `highIntensityPct = highIntensityFraction × 100`; `peakHr` is the robust `summary.peakHr` (raw `hr.max` for
 * summaries without it); `workload` is the raw TLX score (never the weighted one, see SPEC);
 * `criticalMeanHr` is the duration-weighted mean of `hr.mean` over the `critical` phases (and
 * `criticalMeanHrDelta` the same for the phases' `meanHrDelta`); `episodeMinutes = Σ durationSec / 60`;
 * `coveragePct = quality.coverage × 100`.
 */
export function metricValue(s: SessionSummary, key: MetricKey): number | null {
  switch (key) {
    case 'meanHr':
      return finiteOrNull(s.hr?.mean);
    case 'peakHr':
      // Robust peak when the summary has one (older stored summaries only have the raw maximum).
      return finiteOrNull(s.peakHr !== undefined ? s.peakHr : s.hr?.max);
    case 'meanHrDelta':
      return finiteOrNull(s.meanHrDelta);
    case 'peakHrDelta':
      return finiteOrNull(s.peakHrDelta);
    case 'rmssd':
      return finiteOrNull(s.hrv?.rmssd);
    case 'sdnn':
      return finiteOrNull(s.hrv?.sdnn);
    case 'stressIndex':
      return finiteOrNull(s.stressIndex);
    case 'highIntensityPct':
      return s.highIntensityFraction === null ? null : finiteOrNull(s.highIntensityFraction * 100);
    case 'episodeCount':
      return s.episodes.length;
    case 'episodeMinutes': {
      let sec = 0;
      for (const e of s.episodes) sec += e.durationSec;
      return finiteOrNull(sec / 60);
    }
    case 'workload':
      // Always the raw (unweighted) score: weighting is optional per debrief, and mixing weighted and raw scores
      // in one series would change the values with the scoring method rather than the workload.
      return s.workload === null ? null : finiteOrNull(s.workload.raw);
    case 'performance':
      return finiteOrNull(s.performance);
    case 'perceivedStress':
      return finiteOrNull(s.perceivedStress);
    case 'durationMin':
      return finiteOrNull(s.durationSec / 60);
    case 'criticalMeanHr':
      return criticalWeighted(s, (p) => (p.hr === null ? null : p.hr.mean));
    case 'criticalMeanHrDelta':
      return criticalWeighted(s, (p) => p.meanHrDelta);
    case 'coveragePct':
      return finiteOrNull(s.quality.coverage * 100);
  }
}

const UNSPECIFIED = 'Unspecified';
/** Group name used by `groupBy: 'none'`. */
const ALL_GROUP = 'All';

/**
 * `YYYY-MM` of a session's start in the participant's local time when `tzOffsetMin` is known (minutes east of UTC),
 * else in UTC. Only UTC getters are used, on a shifted timestamp, so the result does not depend on the device's
 * time zone.
 */
function sessionMonth(t: EpochMs, tzOffsetMin: number | undefined): string | null {
  const offset = typeof tzOffsetMin === 'number' && Number.isFinite(tzOffsetMin) ? tzOffsetMin * 60000 : 0;
  return utcMonth(t + offset);
}

function utcMonth(t: EpochMs): string | null {
  if (!Number.isFinite(t)) return null;
  const d = new Date(t);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth() + 1;
  if (!Number.isFinite(y)) return null;
  const yyyy = y < 0 ? `-${String(-y).padStart(4, '0')}` : String(y).padStart(4, '0');
  return `${yyyy}-${String(m).padStart(2, '0')}`;
}

function groupOf(s: SessionSummary, groupBy: GroupKey): string {
  let v: string | null | undefined;
  switch (groupBy) {
    case 'participant':
      v = s.participantCode;
      break;
    case 'procedure':
      v = s.procedureName;
      break;
    case 'specialty':
      v = s.specialty;
      break;
    case 'approach':
      v = s.approach;
      break;
    case 'role':
      v = s.role;
      break;
    case 'trainingLevel':
      v = s.trainingLevel;
      break;
    case 'urgency':
      v = s.urgency;
      break;
    case 'month':
      v = sessionMonth(s.startedAt, s.tzOffsetMin);
      break;
    case 'none':
      v = ALL_GROUP;
      break;
  }
  return typeof v === 'string' && v.trim() !== '' ? v : UNSPECIFIED;
}

function compareCodeUnits(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Chronological sort key of a `YYYY-MM` month group (`Unspecified` last). */
function monthOrdinal(group: string): number {
  const m = /^(-?\d+)-(\d{2})$/.exec(group);
  if (m === null) return Number.POSITIVE_INFINITY;
  return Number(m[1]) * 12 + (Number(m[2]) - 1);
}

/**
 * Descriptive statistics of a metric per group.
 *
 * Sessions with a `null` value are skipped and groups without any value are dropped. A missing (or blank)
 * group field becomes `'Unspecified'`; `month` is the `YYYY-MM` of `startedAt` in local time when the summary has
 * `tzOffsetMin` (UTC otherwise), so a Melbourne case at 08:00 on the 1st is in that month; `none` puts every session in
 * one group named `'All'`. `sd` is the sample SD (0 for n = 1). Rows are sorted by group name (UTF-16 code
 * unit order, independent of locale), except `month`, which is chronological.
 */
export function aggregateMetric(
  summaries: readonly SessionSummary[],
  key: MetricKey,
  groupBy: GroupKey,
): MetricAggregate[] {
  const groups = new Map<string, number[]>();
  for (const s of summaries) {
    const v = metricValue(s, key);
    if (v === null) continue;
    const g = groupOf(s, groupBy);
    const list = groups.get(g);
    if (list) list.push(v);
    else groups.set(g, [v]);
  }
  const rows: MetricAggregate[] = [];
  groups.forEach((values, group) => {
    let min = values[0]!;
    let max = values[0]!;
    for (const v of values) {
      if (v < min) min = v;
      if (v > max) max = v;
    }
    rows.push({
      group,
      n: values.length,
      mean: mean(values)!,
      sd: sampleSd(values)!,
      median: median(values)!,
      min,
      max,
    });
  });
  if (groupBy === 'month') {
    return rows.sort((a, b) => {
      const d = monthOrdinal(a.group) - monthOrdinal(b.group);
      return Number.isNaN(d) || d === 0 ? compareCodeUnits(a.group, b.group) : d;
    });
  }
  return rows.sort((a, b) => compareCodeUnits(a.group, b.group));
}

function chronological(summaries: readonly SessionSummary[]): SessionSummary[] {
  return stableSortBy(summaries, (s) => s.startedAt);
}

/** Per-session values of a metric in chronological order (stable for equal start times); nulls dropped. */
export function metricSeries(summaries: readonly SessionSummary[], key: MetricKey): MetricPoint[] {
  const out: MetricPoint[] = [];
  for (const s of chronological(summaries)) {
    const value = metricValue(s, key);
    if (value !== null) out.push({ sessionId: s.sessionId, t: s.startedAt, value });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Insights
// ---------------------------------------------------------------------------

const PHASE_PHRASE: Record<PhaseKind, string> = {
  'pre-op': 'pre-op',
  incision: 'incision / access',
  dissection: 'dissection',
  critical: 'critical-step',
  closure: 'closure',
  'post-op': 'post-op',
};

const PHASE_RANK: Record<PhaseKind, number> = {
  'pre-op': 0,
  incision: 1,
  dissection: 2,
  critical: 3,
  closure: 4,
  'post-op': 5,
};

/** Rounds for display without locale-dependent APIs (`toLocaleString`/`Intl` differ across engines). */
function fmt(x: number, decimals: number): string {
  const f = decimals === 0 ? 1 : decimals === 1 ? 10 : decimals === 2 ? 100 : 1000;
  const r = Math.round(Math.abs(x) * f) / f;
  const body = String(r);
  return x < 0 && r !== 0 ? `-${body}` : body;
}

function signed(x: number, decimals: number): string {
  const s = fmt(x, decimals);
  return x > 0 && s !== '0' ? `+${s}` : s;
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** Minimum number of sessions before a trend or recent-vs-earlier insight is evaluated. */
const MIN_TREND_SESSIONS = 8;
/** Minimum number of paired sessions before the workload–HR correlation is evaluated. */
const MIN_CORRELATION_SESSIONS = 10;

/**
 * The phase with the highest mean HR in one session. Repeated segments of a phase are first combined into one
 * duration-weighted mean (as in the summaries CSV), so a short segment does not count as much as a long one; ties go
 * to the phase that comes first in the operative order (`PHASE_ORDER`).
 */
function sessionPeakPhase(s: SessionSummary): PhaseKind | null {
  const acc = new Map<PhaseKind, { w: number; wx: number; sum: number; n: number }>();
  for (const p of s.phases) {
    if (p.hr === null || !Number.isFinite(p.hr.mean)) continue;
    const a = acc.get(p.phase) ?? { w: 0, wx: 0, sum: 0, n: 0 };
    a.n++;
    a.sum += p.hr.mean;
    if (Number.isFinite(p.durationSec) && p.durationSec > 0) {
      a.w += p.durationSec;
      a.wx += p.durationSec * p.hr.mean;
    }
    acc.set(p.phase, a);
  }
  let best: { phase: PhaseKind; mean: number } | null = null;
  for (const [phase, a] of acc) {
    const m = a.n === 1 ? a.sum : a.w > 0 ? a.wx / a.w : a.sum / a.n;
    if (
      best === null ||
      m > best.mean ||
      (m === best.mean && PHASE_RANK[phase] < PHASE_RANK[best.phase])
    ) {
      best = { phase, mean: m };
    }
  }
  return best === null ? null : best.phase;
}

/** Rule 1: the phase that most often has the highest mean HR. */
function peakPhaseInsight(sorted: readonly SessionSummary[]): Insight | null {
  const peaks: { id: string; phase: PhaseKind }[] = [];
  for (const s of sorted) {
    const phase = sessionPeakPhase(s);
    if (phase !== null) peaks.push({ id: s.sessionId, phase });
  }
  const total = peaks.length;
  if (total < 3) return null;
  const counts = new Map<PhaseKind, number>();
  for (const p of peaks) counts.set(p.phase, (counts.get(p.phase) ?? 0) + 1);
  let phase: PhaseKind | null = null;
  let topCount = 0;
  for (const [candidate, c] of counts) {
    // Most frequent peak phase; ties go to the phase that comes first in the operative order.
    if (c > topCount || (c === topCount && phase !== null && PHASE_RANK[candidate] < PHASE_RANK[phase])) {
      phase = candidate;
      topCount = c;
    }
  }
  if (phase === null || topCount * 2 < total) return null;
  const name = PHASE_PHRASE[phase];
  return {
    id: 'peak-phase',
    kind: 'info',
    title: `Heart rate tends to peak in the ${name} phase`,
    detail:
      `In ${topCount} of ${total} sessions with marked phases, your average heart rate was highest during the ` +
      `${name} phase. Noticing when your body responds most can help you plan briefings, teaching or short ` +
      `pauses around that part of the case.`,
    evidence: peaks.filter((p) => p.phase === phase).map((p) => p.id),
  };
}

/**
 * Rule 2: linear trend of HR reactivity (meanHrDelta, else meanHr) against session order. Fires only with
 * ≥ {@link MIN_TREND_SESSIONS} sessions, a slope of at least 0.5 bpm/session and a slope that is statistically
 * distinguishable from flat (t-test, two-sided p < 0.05). The wording is descriptive: the data cannot say *why*.
 */
function trendInsight(sorted: readonly SessionSummary[]): Insight | null {
  for (const key of ['meanHrDelta', 'meanHr'] as const) {
    const points: { x: number; y: number }[] = [];
    const ids: string[] = [];
    sorted.forEach((s, i) => {
      const v = metricValue(s, key);
      if (v !== null) {
        points.push({ x: i, y: v });
        ids.push(s.sessionId);
      }
    });
    if (points.length < MIN_TREND_SESSIONS) continue;
    const fit = trendEvidence(points);
    if (fit === null) return null;
    if (!fit.significant || Math.abs(fit.slope) < 0.5) return null;
    const what = key === 'meanHrDelta' ? 'heart-rate rise above your baseline' : 'average heart rate';
    const rate = `${signed(fit.slope, 1)} bpm per session`;
    const caveat =
      `This is a statistical pattern across ${points.length} sessions (unlikely to be chance alone, p < 0.05), ` +
      `not an explanation: case mix, workload, baseline conditions, sleep and caffeine can all play a part.`;
    if (fit.slope < 0) {
      return {
        id: 'hr-trend',
        kind: 'positive',
        title: 'Your heart-rate response has been lower in recent sessions',
        detail: `Across ${points.length} sessions, your ${what} has changed by about ${rate}. ${caveat}`,
        evidence: ids,
      };
    }
    return {
      id: 'hr-trend',
      kind: 'attention',
      title: 'Your heart-rate response has been higher in recent sessions',
      detail:
        `Across ${points.length} sessions, your ${what} has changed by about ${rate}. ${caveat} ` +
        `It may be worth reflecting on what has changed recently.`,
      evidence: ids,
    };
  }
  return null;
}

/**
 * Rule 3: intra-operative RMSSD of the last 3 sessions vs the earlier ones. Needs ≥ {@link MIN_TREND_SESSIONS}
 * sessions with RMSSD, a change of at least 15 % and a Welch t-test with two-sided p < 0.05. Intra-operative HRV
 * mostly reflects heart rate and arousal during the case, so the message is descriptive (no recovery advice).
 */
function hrvInsight(sorted: readonly SessionSummary[]): Insight | null {
  const withHrv = sorted.filter((s) => metricValue(s, 'rmssd') !== null);
  if (withHrv.length < MIN_TREND_SESSIONS) return null;
  const values = withHrv.map((s) => metricValue(s, 'rmssd')!);
  const recentValues = values.slice(-3);
  const earlierValues = values.slice(0, -3);
  const recent = mean(recentValues)!;
  const earlier = mean(earlierValues)!;
  if (!(earlier > 0)) return null;
  const change = (recent - earlier) / earlier;
  if (Math.abs(change) < 0.15 || !welchSignificant(recentValues, earlierValues)) return null;
  const pct = fmt(Math.abs(change) * 100, 0);
  const evidence = withHrv.map((s) => s.sessionId);
  const lower = change < 0;
  return {
    id: 'hrv-trend',
    kind: 'info',
    title: `Heart-rate variability during surgery was ${lower ? 'lower' : 'higher'} in your recent sessions`,
    detail:
      `Your average RMSSD over the last 3 sessions (${fmt(recent, 0)} ms) is about ${pct} % ${lower ? 'lower' : 'higher'} ` +
      `than in your ${earlierValues.length} earlier sessions (${fmt(earlier, 0)} ms; unlikely to be chance alone, ` +
      `p < 0.05). HRV measured during a case mostly reflects heart rate and arousal at the time (case mix, ` +
      `physical effort, posture), so on its own it is not a measure of fatigue or recovery.`,
    evidence,
  };
}

/**
 * Rule 4: Pearson correlation between self-rated workload (raw TLX) and HR rise above baseline. Needs
 * ≥ {@link MIN_CORRELATION_SESSIONS} paired sessions, |r| ≥ 0.5 and a correlation that differs from 0 at the
 * two-sided 5 % level.
 */
function workloadInsight(sorted: readonly SessionSummary[]): Insight | null {
  const points: { x: number; y: number }[] = [];
  const ids: string[] = [];
  for (const s of sorted) {
    const w = metricValue(s, 'workload');
    const d = metricValue(s, 'meanHrDelta');
    if (w !== null && d !== null) {
      points.push({ x: w, y: d });
      ids.push(s.sessionId);
    }
  }
  if (points.length < MIN_CORRELATION_SESSIONS) return null;
  const r = pearsonCorrelation(points);
  if (r === null || Math.abs(r) < 0.5 || !correlationSignificant(r, points.length)) return null;
  const direction = r > 0 ? 'a larger' : 'a smaller';
  return {
    id: 'workload-hr',
    kind: 'info',
    title:
      r > 0
        ? 'Your workload ratings track your heart-rate response'
        : 'Your workload ratings and heart-rate response move in opposite directions',
    detail:
      `Across ${points.length} sessions, cases you rated as more demanding tended to show ${direction} rise in ` +
      `heart rate above baseline (Pearson r = ${fmt(r, 2)}, n = ${points.length}, p < 0.05). A correlation does not ` +
      `show that one causes the other, but comparing how a case felt with how your body responded can be a useful ` +
      `prompt for reflection.`,
    evidence: ids,
  };
}

/** Rule 5: signal coverage of the latest session, with advice that matches the sensor used. */
function qualityInsight(sorted: readonly SessionSummary[]): Insight | null {
  const latest = sorted[sorted.length - 1];
  if (latest === undefined) return null;
  const coverage = latest.quality.coverage;
  if (!Number.isFinite(coverage) || !(coverage < 0.8)) return null;
  const source = latest.sensorSource;
  if (source === 'simulated') return null;
  const tip =
    source === 'healthkit' || source === 'health-connect'
      ? `Watches often record heart rate only every few minutes unless a workout is running. For a denser ` +
        `signal, start a workout on the watch for the case (or use a chest strap), wear the watch snugly above the ` +
        `wrist bone, and let it sync before importing.`
      : `For a steadier signal, moisten the strap electrodes before scrubbing, wear the strap snugly just below the ` +
        `chest muscles, and keep the phone or receiver within range.`;
  return {
    id: 'data-quality',
    kind: 'attention',
    title: 'Heart-rate signal was patchy in your latest session',
    detail: `Heart-rate data covered about ${fmt(coverage * 100, 0)} % of your latest session. ${tip}`,
    evidence: [latest.sessionId],
  };
}

/** Rule 6: share of episodes with a related complication or interruption marker. */
function episodeMarkerInsight(
  sorted: readonly SessionSummary[],
  sessions: readonly SurgicalSession[] | undefined,
): Insight | null {
  if (sessions === undefined || sessions.length === 0) return null;
  const byId = new Map<string, SurgicalSession>();
  for (const sess of sessions) byId.set(sess.id, sess);
  let total = 0;
  let related = 0;
  const evidence: string[] = [];
  for (const s of sorted) {
    const sess = byId.get(s.sessionId);
    if (sess === undefined) continue;
    const triggerIds = new Set<string>();
    for (const e of sess.events) {
      if (e.type === 'marker' && (e.marker === 'complication' || e.marker === 'interruption')) {
        triggerIds.add(e.id);
      }
    }
    let any = false;
    for (const ep of s.episodes) {
      total++;
      if (ep.relatedEventIds.some((id) => triggerIds.has(id))) {
        related++;
        any = true;
      }
    }
    if (any) evidence.push(s.sessionId);
  }
  if (total < 3 || related * 2 < total) return null;
  return {
    id: 'episodes-after-markers',
    kind: 'info',
    title: 'Heart-rate rises often follow unexpected events',
    detail:
      `${related} of ${plural(total, 'sustained heart-rate rise', 'sustained heart-rate rises')} began within ` +
      `2 minutes of a logged complication or interruption, or overlapped one. Responding to the unexpected is a ` +
      `normal physiological reaction, and these moments can be useful to revisit in a debrief.`,
    evidence,
  };
}

/**
 * Deterministic, evidence-based feedback in plain, non-judgemental language (SPEC.md rules 1–6, in that order).
 * Sessions are first put in chronological order (stable for equal start times). Rules that look for change over
 * time or association need enough sessions and a two-sided p < 0.05 test, so that ordinary session-to-session
 * variation does not produce feedback; their wording describes the pattern without attributing a cause.
 *
 * 1. `peak-phase` (info): one phase has the highest mean HR in ≥ 50 % of the ≥ 3 sessions with phase data
 *    (segments of a phase combined duration-weighted; ties → earlier phase in `PHASE_ORDER`).
 * 2. `hr-trend`: with ≥ 8 sessions, OLS slope of meanHrDelta (else meanHr) vs session order; fires when
 *    |slope| ≥ 0.5 bpm/session and the slope t-test has p < 0.05 (falling → positive, rising → attention).
 * 3. `hrv-trend` (info): with ≥ 8 sessions with RMSSD, last-3 mean vs earlier mean; |change| ≥ 15 % and Welch
 *    t-test p < 0.05.
 * 4. `workload-hr` (info): with ≥ 10 sessions with workload and meanHrDelta, |Pearson r| ≥ 0.5 and p < 0.05.
 * 5. `data-quality` (attention): latest session coverage < 0.8 (not for simulated sessions); the tip depends on
 *    `sensorSource` (watch vs strap).
 * 6. `episodes-after-markers` (info): ≥ 50 % of ≥ 3 episodes have a related complication/interruption event.
 *    Summaries only store event ids, so this rule needs `context.sessions` and is skipped without it.
 *
 * @returns `[]` for no summaries.
 */
export function generateInsights(
  summaries: readonly SessionSummary[],
  context: InsightContext = {},
): Insight[] {
  if (summaries.length === 0) return [];
  const sorted = chronological(summaries);
  const out: Insight[] = [];
  const candidates = [
    peakPhaseInsight(sorted),
    trendInsight(sorted),
    hrvInsight(sorted),
    workloadInsight(sorted),
    qualityInsight(sorted),
    episodeMarkerInsight(sorted, context.sessions),
  ];
  for (const c of candidates) if (c !== null) out.push(c);
  return out;
}
