/**
 * Cross-session metrics, grouping and plain-language feedback ("insights").
 *
 * Determinism and portability: sessions are ordered with an engine-independent stable sort, group names are
 * compared by UTF-16 code units (never `localeCompare`/`Intl`, whose results differ between Hermes, browsers and
 * Node), and month keys use UTC getters only.
 */
import type { EpochMs, Insight, PhaseKind, SessionSummary, SurgicalSession } from '../types';
import { linearTrend, mean, median, pearsonCorrelation, sampleSd, stableSortBy } from './stats';

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

/** Metric metadata for labels, units, colouring and formatting. */
export const METRICS: Readonly<Record<MetricKey, Readonly<MetricInfo>>> = Object.freeze({
  meanHr: { label: 'Mean heart rate', unit: 'bpm', higherIsBetter: null, decimals: 0 },
  peakHr: { label: 'Peak heart rate', unit: 'bpm', higherIsBetter: null, decimals: 0 },
  meanHrDelta: { label: 'Mean HR above baseline', unit: 'bpm', higherIsBetter: false, decimals: 1 },
  peakHrDelta: { label: 'Peak HR above baseline', unit: 'bpm', higherIsBetter: false, decimals: 0 },
  rmssd: { label: 'RMSSD', unit: 'ms', higherIsBetter: true, decimals: 1 },
  sdnn: { label: 'SDNN', unit: 'ms', higherIsBetter: true, decimals: 1 },
  stressIndex: { label: 'Stress index (Baevsky)', unit: '', higherIsBetter: false, decimals: 0 },
  highIntensityPct: { label: 'Time ≥ 70 % of max HR', unit: '%', higherIsBetter: false, decimals: 0 },
  episodeCount: { label: 'Stress episodes', unit: '', higherIsBetter: false, decimals: 0 },
  episodeMinutes: { label: 'Time in stress episodes', unit: 'min', higherIsBetter: false, decimals: 1 },
  workload: { label: 'Workload (TLX)', unit: '/100', higherIsBetter: false, decimals: 0 },
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
 * `highIntensityPct = highIntensityFraction × 100`; `workload` is the weighted TLX score, else the raw score;
 * `criticalMeanHr` is the duration-weighted mean of `hr.mean` over the `critical` phases (and
 * `criticalMeanHrDelta` the same for the phases' `meanHrDelta`); `episodeMinutes = Σ durationSec / 60`;
 * `coveragePct = quality.coverage × 100`.
 */
export function metricValue(s: SessionSummary, key: MetricKey): number | null {
  switch (key) {
    case 'meanHr':
      return finiteOrNull(s.hr?.mean);
    case 'peakHr':
      return finiteOrNull(s.hr?.max);
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
      return s.workload === null ? null : finiteOrNull(s.workload.weighted ?? s.workload.raw);
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
      v = utcMonth(s.startedAt);
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
 * group field becomes `'Unspecified'`; `month` is the UTC `YYYY-MM` of `startedAt`; `none` puts every session in
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

/** Rule 1: the phase that most often has the highest mean HR. */
function peakPhaseInsight(sorted: readonly SessionSummary[]): Insight | null {
  const peaks: { id: string; phase: PhaseKind }[] = [];
  for (const s of sorted) {
    let best: { phase: PhaseKind; mean: number } | null = null;
    for (const p of s.phases) {
      if (p.hr === null || !Number.isFinite(p.hr.mean)) continue;
      if (best === null || p.hr.mean > best.mean) best = { phase: p.phase, mean: p.hr.mean };
    }
    if (best !== null) peaks.push({ id: s.sessionId, phase: best.phase });
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

/** Rule 2: linear trend of HR reactivity (meanHrDelta, else meanHr) against session order. */
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
    if (points.length < 5) continue;
    const fit = linearTrend(points);
    if (fit === null) return null;
    const what = key === 'meanHrDelta' ? 'heart-rate rise above your baseline' : 'average heart rate';
    const rate = `${signed(fit.slope, 1)} bpm per session`;
    if (fit.slope <= -0.5) {
      return {
        id: 'hr-trend',
        kind: 'positive',
        title: 'Your heart-rate response is settling with experience',
        detail:
          `Across ${points.length} sessions, your ${what} has changed by about ${rate}. ` +
          `A gradual settling like this is common as procedures become more familiar.`,
        evidence: ids,
      };
    }
    if (fit.slope >= 0.5) {
      return {
        id: 'hr-trend',
        kind: 'attention',
        title: 'Your heart-rate response has been rising',
        detail:
          `Across ${points.length} sessions, your ${what} has changed by about ${rate}. ` +
          `Case mix, workload, sleep and caffeine can all play a part; it may be worth reflecting on what has ` +
          `changed recently.`,
        evidence: ids,
      };
    }
    return null;
  }
  return null;
}

/** Rule 3: RMSSD of the last 3 sessions vs the earlier ones. */
function hrvInsight(sorted: readonly SessionSummary[]): Insight | null {
  const withHrv = sorted.filter((s) => metricValue(s, 'rmssd') !== null);
  if (withHrv.length < 5) return null;
  const values = withHrv.map((s) => metricValue(s, 'rmssd')!);
  const recent = mean(values.slice(-3))!;
  const earlier = mean(values.slice(0, -3))!;
  if (!(earlier > 0)) return null;
  const change = (recent - earlier) / earlier;
  const pct = fmt(Math.abs(change) * 100, 0);
  const evidence = withHrv.map((s) => s.sessionId);
  if (change <= -0.15) {
    return {
      id: 'hrv-trend',
      kind: 'attention',
      title: 'Heart-rate variability is lower in your recent sessions',
      detail:
        `Your average RMSSD over the last 3 sessions (${fmt(recent, 0)} ms) is about ${pct} % lower than in your ` +
        `earlier sessions (${fmt(earlier, 0)} ms). Lower HRV can reflect fatigue or accumulated strain; ` +
        `prioritising rest and recovery between demanding lists may help.`,
      evidence,
    };
  }
  if (change >= 0.15) {
    return {
      id: 'hrv-trend',
      kind: 'positive',
      title: 'Heart-rate variability is higher in your recent sessions',
      detail:
        `Your average RMSSD over the last 3 sessions (${fmt(recent, 0)} ms) is about ${pct} % higher than in ` +
        `your earlier sessions (${fmt(earlier, 0)} ms). Higher HRV is generally associated with good recovery.`,
      evidence,
    };
  }
  return null;
}

/** Rule 4: Pearson correlation between self-rated workload and HR rise above baseline. */
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
  if (points.length < 5) return null;
  const r = pearsonCorrelation(points);
  if (r === null || Math.abs(r) < 0.5) return null;
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
      `heart rate above baseline (Pearson r = ${fmt(r, 2)}). Comparing how a case felt with how your body ` +
      `responded can be a useful prompt for reflection.`,
    evidence: ids,
  };
}

/** Rule 5: signal coverage of the latest session. */
function qualityInsight(sorted: readonly SessionSummary[]): Insight | null {
  const latest = sorted[sorted.length - 1];
  if (latest === undefined) return null;
  const coverage = latest.quality.coverage;
  if (!Number.isFinite(coverage) || !(coverage < 0.8)) return null;
  return {
    id: 'data-quality',
    kind: 'attention',
    title: 'Heart-rate signal was patchy in your latest session',
    detail:
      `Heart-rate data covered about ${fmt(coverage * 100, 0)} % of your latest session. For a steadier ` +
      `signal, moisten the strap electrodes before scrubbing, wear the strap snugly just below the chest ` +
      `muscles, and keep the phone or receiver within range.`,
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
 * Sessions are first put in chronological order (stable for equal start times).
 *
 * 1. `peak-phase` (info): one phase has the highest mean HR in ≥ 50 % of the ≥ 3 sessions with phase data.
 * 2. `hr-trend`: with ≥ 5 sessions, OLS slope of meanHrDelta (else meanHr) vs session order;
 *    ≤ −0.5 bpm/session → positive, ≥ +0.5 → attention.
 * 3. `hrv-trend`: with ≥ 5 sessions with RMSSD, last-3 mean vs earlier mean; −15 % → attention, +15 % → positive.
 * 4. `workload-hr` (info): with ≥ 5 sessions with workload and meanHrDelta, |Pearson r| ≥ 0.5.
 * 5. `data-quality` (attention): latest session coverage < 0.8.
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
