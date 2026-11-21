/**
 * Participant feedback view.
 *
 * Written for the surgeon themself: reflective, not evaluative. Cohort
 * comparisons use only an anonymised cohort median; no other participant's
 * code (or any per-participant cohort value) is ever rendered on this page.
 */
import { useMemo, useState } from 'react';
import {
  INSIGHT_KIND_LABELS,
  METRICS,
  PHASE_LABELS,
  PHASE_ORDER,
  TRAINING_LEVEL_LABELS,
  aggregateMetric,
  formatDuration,
  generateInsights,
  median,
  metricSeries,
  metricValue,
} from '@surgeonpulse/core';
import type { Insight, MetricKey, SessionSummary, SurgicalSession } from '@surgeonpulse/core';
import { PhaseComparisonChart } from '../components/charts/BarCharts';
import type { PhaseComparisonDatum } from '../components/charts/BarCharts';
import { LearningCurveChart, ScatterTrendChart } from '../components/charts/TrendCharts';
import type { CurvePoint, ScatterPoint } from '../components/charts/TrendCharts';
import { DataTable } from '../components/DataTable';
import type { Column } from '../components/DataTable';
import { SummaryProgress } from '../components/Filters';
import { Card, EmptyState, KpiTile, PageHeader, SelectField, SimulatedBadge } from '../components/ui';
import { useDocumentTitle } from '../lib/useDocumentTitle';
import { fmtDate, fmtNumber, fmtSigned, lookup, metricLabel, plural } from '../lib/format';
import { MIN_COHORT_PARTICIPANTS, cohortPhaseMedians, phaseValues } from '../lib/phaseStats';
import { hrefs } from '../router';
import { useDashboardState, useDerived } from '../state/hooks';

/** Metrics offered in the learning-curve selector. */
const CURVE_METRICS: readonly MetricKey[] = [
  'meanHrDelta',
  'meanHr',
  'peakHrDelta',
  'criticalMeanHrDelta',
  'rmssd',
  'stressIndex',
  'episodeMinutes',
  'workload',
  'performance',
  'perceivedStress',
  'durationMin',
];

function InsightCard({ insight, sessions }: { insight: Insight; sessions: ReadonlyMap<string, SurgicalSession> }) {
  const evidence = insight.evidence.filter((id) => sessions.has(id));
  return (
    <article className={`insight insight--${insight.kind}`}>
      <p className="insight__kind">{INSIGHT_KIND_LABELS[insight.kind]}</p>
      <h3 className="insight__title">{insight.title}</h3>
      <p className="insight__detail">{insight.detail}</p>
      {evidence.length > 0 && (
        <details className="insight__evidence">
          <summary>Based on {plural(evidence.length, 'session')}</summary>
          <ul>
            {evidence.map((id) => {
              const s = sessions.get(id)!;
              return (
                <li key={id}>
                  <a href={hrefs.session(id)}>
                    {fmtDate(s.startedAt, s.tzOffsetMin)} · {s.procedure.name}
                  </a>
                </li>
              );
            })}
          </ul>
        </details>
      )}
    </article>
  );
}

interface ProcedureRow {
  procedure: string;
  n: number;
  delta: number | null;
  deltaSd: number | null;
  workload: number | null;
  duration: number | null;
}

/** Per-procedure breakdown from core `aggregateMetric`. */
function procedureBreakdown(summaries: readonly SessionSummary[]): ProcedureRow[] {
  const counts = new Map<string, number>();
  for (const s of summaries) counts.set(s.procedureName, (counts.get(s.procedureName) ?? 0) + 1);
  const delta = new Map(aggregateMetric(summaries, 'meanHrDelta', 'procedure').map((r) => [r.group, r]));
  const workload = new Map(aggregateMetric(summaries, 'workload', 'procedure').map((r) => [r.group, r]));
  const duration = new Map(aggregateMetric(summaries, 'durationMin', 'procedure').map((r) => [r.group, r]));
  return [...counts.entries()].map(([procedure, n]) => ({
    procedure,
    n,
    delta: delta.get(procedure)?.mean ?? null,
    deltaSd: delta.get(procedure)?.sd ?? null,
    workload: workload.get(procedure)?.mean ?? null,
    duration: duration.get(procedure)?.median ?? null,
  }));
}

const PROCEDURE_COLUMNS: Column<ProcedureRow>[] = [
  { id: 'procedure', header: 'Procedure', rowHeader: true, sortValue: (r) => r.procedure, cell: (r) => r.procedure },
  { id: 'n', header: 'Sessions', align: 'right', sortValue: (r) => r.n, cell: (r) => r.n },
  {
    id: 'delta',
    header: 'Mean Δ HR (± SD)',
    align: 'right',
    sortValue: (r) => r.delta,
    cell: (r) => (r.delta === null ? '—' : `${fmtSigned(r.delta, 1)} ± ${fmtNumber(r.deltaSd, 1)}`),
  },
  { id: 'workload', header: 'Mean workload', align: 'right', sortValue: (r) => r.workload, cell: (r) => fmtNumber(r.workload) },
  {
    id: 'duration',
    header: 'Median duration',
    align: 'right',
    sortValue: (r) => r.duration,
    cell: (r) => (r.duration === null ? '—' : formatDuration(r.duration * 60)),
  },
];

export function ParticipantDetailPage({ code }: { code: string }) {
  useDocumentTitle(`Feedback · ${code}`);
  const state = useDashboardState();
  const { summaries: allSummaries } = useDerived();
  const [metric, setMetric] = useState<MetricKey>('meanHrDelta');

  const mySessions = useMemo(() => {
    const map = new Map<string, SurgicalSession>();
    for (const id of state.order) {
      const s = state.sessions.get(id);
      if (s !== undefined && s.participantCode === code) map.set(id, s);
    }
    return map;
  }, [state.order, state.sessions, code]);

  const mine = useMemo(() => allSummaries.filter((s) => s.participantCode === code), [allSummaries, code]);

  const model = useMemo(() => {
    const insights = generateInsights(mine, { sessions: [...mySessions.values()] });
    // Phase profile: participant median vs the cohort median of OTHER participants' sessions, shown
    // only for phases with enough other participants that no colleague's value can be worked out.
    const myPhases = phaseValues(mine, 'meanHrDelta');
    const cohortPhases = cohortPhaseMedians(allSummaries, code, 'meanHrDelta');
    const comparison: PhaseComparisonDatum[] = PHASE_ORDER.map((phase) => ({
      phase,
      you: median(myPhases.get(phase) ?? []),
      cohort: cohortPhases.get(phase)?.median ?? null,
    })).filter((d) => d.you !== null || d.cohort !== null);
    const scatter: ScatterPoint[] = mine.flatMap((s) => {
      const x = metricValue(s, 'workload');
      const y = metricValue(s, 'meanHrDelta');
      if (x === null || y === null) return [];
      const tz = mySessions.get(s.sessionId)?.tzOffsetMin;
      return [{ id: s.sessionId, x, y, group: '', label: `${fmtDate(s.startedAt, tz)} ${s.procedureName}` }];
    });
    return {
      insights,
      comparison,
      scatter,
      procedures: procedureBreakdown(mine),
      cohortShown: comparison.some((d) => d.cohort !== null),
      cohortSuppressed: comparison.some((d) => d.cohort === null),
    };
  }, [mine, mySessions, allSummaries, code]);

  const curve = useMemo<CurvePoint[]>(
    () =>
      metricSeries(mine, metric).map((p, i) => ({
        n: i + 1,
        value: p.value,
        sessionId: p.sessionId,
        date: fmtDate(p.t, mySessions.get(p.sessionId)?.tzOffsetMin),
      })),
    [mine, metric, mySessions],
  );

  if (mySessions.size === 0) {
    return (
      <>
        <PageHeader title={`Participant ${code}`} />
        <EmptyState
          title={state.order.length === 0 ? 'No data loaded yet' : 'No sessions for this participant'}
          action={
            <a className="btn btn--primary" href={state.order.length === 0 ? hrefs.data : hrefs.participants}>
              {state.order.length === 0 ? 'Go to Data' : 'Back to participants'}
            </a>
          }
        />
      </>
    );
  }

  const profile = state.participants.get(code);
  const sessionsList = [...mySessions.values()];
  const first = sessionsList[0]!;
  const last = sessionsList[sessionsList.length - 1]!;
  const simulated = sessionsList.some((s) => s.sensor.source === 'simulated');
  const comparisonSummary =
    model.comparison.length === 0
      ? 'No phase data with a baseline.'
      : 'Median heart rate above baseline per phase, yours then the cohort median: ' +
        model.comparison
          .map((d) => `${PHASE_LABELS[d.phase]} ${fmtSigned(d.you, 1)} vs ${fmtSigned(d.cohort, 1)} bpm`)
          .join('; ') +
        '.';

  const info = METRICS[metric];
  const metricSelect = (
    <SelectField
      label="Metric"
      value={metric}
      onChange={setMetric}
      options={CURVE_METRICS.map((k) => ({ value: k, label: metricLabel(k) }))}
      className="field--inline"
      id="curve-metric"
    />
  );
  const medianDelta = median(mine.flatMap((s) => (s.meanHrDelta === null ? [] : [s.meanHrDelta])));
  const medianWorkload = median(mine.flatMap((s) => {
    const w = metricValue(s, 'workload');
    return w === null ? [] : [w];
  }));
  const totalHours = mine.reduce((a, s) => a + s.durationSec, 0) / 3600;

  return (
    <>
      <PageHeader
        eyebrow={<a href={hrefs.participants}>Participants</a>}
        title={
          <>
            Feedback for <span className="code">{code}</span>
          </>
        }
        subtitle={`${plural(mySessions.size, 'session')} from ${fmtDate(first.startedAt, first.tzOffsetMin)} to ${fmtDate(
          last.startedAt,
          last.tzOffsetMin,
        )}${profile?.trainingLevel ? ` · ${lookup(TRAINING_LEVEL_LABELS, profile.trainingLevel)}` : ''}`}
        actions={simulated ? <SimulatedBadge /> : undefined}
      />
      <p className="lead">
        These observations describe patterns in your own recordings. They are prompts for reflection and debriefing,
        not an assessment of skill or performance.
      </p>
      <SummaryProgress />

      <section className="kpi-grid" aria-label="Your figures" data-testid="participant-kpis">
        <KpiTile label="Sessions" value={mySessions.size} />
        <KpiTile label="Hours recorded" value={fmtNumber(totalHours, 1)} unit="h" />
        <KpiTile label="Median Δ HR" value={fmtSigned(medianDelta, 1)} unit="bpm" hint="Mean HR above your resting baseline" />
        <KpiTile label="Median workload" value={fmtNumber(medianWorkload)} unit="/100" />
      </section>

      <Card title="Insights" description="Generated from your sessions with transparent, rule-based checks." className="card--insights">
        {model.insights.length === 0 ? (
          <p className="muted">
            {mine.length < 5
              ? 'More sessions are needed before trends can be described (most insights need at least five).'
              : 'No notable patterns stand out in these sessions.'}
          </p>
        ) : (
          <div className="insight-grid" data-testid="insights">
            {model.insights.map((insight) => (
              <InsightCard key={insight.id} insight={insight} sessions={mySessions} />
            ))}
          </div>
        )}
      </Card>

      <Card>
        {curve.length === 0 ? (
          <>
            <div className="chart__head">
              <h3 className="chart__title">Learning curve</h3>
              {metricSelect}
            </div>
            <p className="muted">No values of {info.label.toLowerCase()} in your sessions.</p>
          </>
        ) : (
          <LearningCurveChart
            points={curve}
            metricLabel={info.label}
            unit={info.unit}
            decimals={info.decimals}
            actions={metricSelect}
          />
        )}
      </Card>

      <div className="grid grid--2">
        <Card>
          <PhaseComparisonChart data={model.comparison} summary={comparisonSummary} />
          <p className="hint">
            {model.cohortShown
              ? `The cohort median uses other participants’ sessions only and is shown for a phase only when at least ${MIN_COHORT_PARTICIPANTS} other participants contribute, so no colleague’s values can be worked out. It is not adjusted for training level, procedure mix or how baselines were taken, so a difference from it reflects case mix as much as anything about you.`
              : `Too few other participants in the loaded data for a cohort comparison (at least ${MIN_COHORT_PARTICIPANTS} are needed per phase, so no colleague’s values can be worked out).`}
            {model.cohortShown && model.cohortSuppressed ? ' “—” marks phases below that threshold.' : ''}
          </p>
        </Card>
        <Card>
          <ScatterTrendChart
            title="Workload and heart rate"
            points={model.scatter}
            xLabel="Workload (TLX, 0–100)"
            yLabel="Mean HR above baseline (bpm)"
            yDecimals={1}
            testId="workload-scatter"
          />
        </Card>
      </div>

      <Card title="By procedure" description="Your sessions grouped by procedure.">
        <DataTable
          rows={model.procedures}
          columns={PROCEDURE_COLUMNS}
          rowKey={(r) => r.procedure}
          caption="Your sessions by procedure"
          initialSort={{ id: 'n', direction: 'desc' }}
          compact
        />
      </Card>

      <Card title="Your sessions">
        <ul className="session-list">
          {[...sessionsList].reverse().map((s) => {
            const sum = state.summaries.get(s.id);
            return (
              <li key={s.id}>
                <a href={hrefs.session(s.id)}>
                  <span className="session-list__date">{fmtDate(s.startedAt, s.tzOffsetMin)}</span>
                  <span className="session-list__name">{s.procedure.name}</span>
                </a>
                <span className="session-list__meta">
                  {sum ? `${formatDuration(sum.durationSec)} · Δ ${fmtSigned(sum.meanHrDelta, 1)} bpm` : '…'}
                </span>
              </li>
            );
          })}
        </ul>
      </Card>
    </>
  );
}
