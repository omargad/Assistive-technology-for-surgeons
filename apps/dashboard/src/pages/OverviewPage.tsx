/**
 * Overview: cohort KPIs, phase profile, activity, workload distribution and
 * data-quality flags for the (filtered) sessions.
 */
import { useMemo } from 'react';
import { aggregateMetric, median, metricValue } from '@surgeonpulse/core';
import type { SessionSummary } from '@surgeonpulse/core';
import { PhaseDeltaChart, SimpleBarChart } from '../components/charts/BarCharts';
import type { SimpleBarDatum } from '../components/charts/BarCharts';
import { FilterSummary, SummaryProgress } from '../components/Filters';
import { Card, EmptyState, KpiTile, PageHeader, SimulatedBadge } from '../components/ui';
import { useDocumentTitle } from '../lib/useDocumentTitle';
import { fmtDate, fmtMonthKey, fmtNumber, plural } from '../lib/format';
import { phaseProfile } from '../lib/phaseStats';
import { ARTEFACT_FLAG, COVERAGE_FLAG, qualityFlags } from '../lib/quality';
import { hrefs } from '../router';
import { useDashboardState, useDataActions, useDerived } from '../state/hooks';

/** Workload histogram in 10-point bins (0–9, …, 90–100). */
function workloadBins(summaries: readonly SessionSummary[]): SimpleBarDatum[] {
  const counts = new Array<number>(10).fill(0);
  for (const s of summaries) {
    const w = metricValue(s, 'workload');
    if (w === null) continue;
    const bin = Math.min(9, Math.max(0, Math.floor(w / 10)));
    counts[bin] = (counts[bin] ?? 0) + 1;
  }
  return counts.map((value, i) => ({ key: String(i), label: i === 9 ? '90–100' : `${i * 10}–${i * 10 + 9}`, value }));
}

function FirstRun() {
  const { loadDemo } = useDataActions();
  const { busy } = useDashboardState();
  return (
    <EmptyState
      title="Welcome to the SurgeonPulse dashboard"
      action={
        <>
          <a className="btn btn--primary" href={hrefs.data}>
            Open files or connect
          </a>
          <button type="button" className="btn" onClick={() => void loadDemo(1)} disabled={busy !== null}>
            {busy?.kind === 'demo' ? 'Generating…' : 'Try the simulated demo'}
          </button>
        </>
      }
    >
      <p>
        Explore intra-operative heart rate, HRV and SURG-TLX workload across your study cohort, or review one
        surgeon's feedback. Load SurgeonPulse export files, the simulated demo cohort, or your research server's data.
      </p>
      <p className="muted">Everything stays in this browser.</p>
    </EmptyState>
  );
}

export function OverviewPage() {
  useDocumentTitle(''); // the home page uses the plain app title
  const state = useDashboardState();
  const { filteredSummaries, filteredFacets, summarizing } = useDerived();

  const model = useMemo(() => {
    const participants = new Set(filteredFacets.map((f) => f.participantCode)).size;
    const hours = filteredSummaries.reduce((acc, s) => acc + s.durationSec, 0) / 3600;
    const coverage = median(filteredSummaries.map((s) => s.quality.coverage));
    const artefacts = median(
      filteredSummaries.flatMap((s) => (s.quality.rrArtifactRatio === null ? [] : [s.quality.rrArtifactRatio])),
    );
    const months = aggregateMetric(filteredSummaries, 'durationMin', 'month').map((r) => ({
      key: r.group,
      label: fmtMonthKey(r.group),
      value: r.n,
    }));
    const workload = workloadBins(filteredSummaries);
    const workloadN = workload.reduce((a, b) => a + b.value, 0);
    return {
      participants,
      hours,
      coverage,
      artefacts,
      phase: phaseProfile(filteredSummaries, 'meanHrDelta'),
      months,
      workload,
      workloadN,
      flags: qualityFlags(filteredSummaries),
    };
  }, [filteredSummaries, filteredFacets]);

  if (state.order.length === 0) {
    return (
      <>
        <PageHeader title="Overview" />
        <FirstRun />
      </>
    );
  }

  const busiest = [...model.months].sort((a, b) => b.value - a.value)[0];

  return (
    <>
      <PageHeader
        title="Overview"
        subtitle={`Cohort summary of ${plural(filteredFacets.length, 'session')}.`}
        actions={state.simulated ? <SimulatedBadge /> : undefined}
      />
      <FilterSummary />
      <SummaryProgress />
      {filteredFacets.length === 0 ? (
        <EmptyState title="No sessions match the filters" action={<a className="btn btn--primary" href={hrefs.sessions}>Edit filters</a>}>
          <p>Change or clear the filters to see the overview.</p>
        </EmptyState>
      ) : (
        <>
          <section className="kpi-grid" aria-label="Key figures" data-testid="kpis">
            <KpiTile label="Participants" value={model.participants} />
            <KpiTile label="Sessions" value={filteredFacets.length} />
            <KpiTile label="Hours recorded" value={fmtNumber(model.hours, 1)} unit="h" hint={summarizing ? 'Updating…' : undefined} />
            <KpiTile
              label="Median coverage"
              value={model.coverage === null ? '—' : fmtNumber(model.coverage * 100)}
              unit="%"
              tone={model.coverage !== null && model.coverage < COVERAGE_FLAG ? 'attention' : 'default'}
            />
            <KpiTile
              label="Median RR artefact"
              value={model.artefacts === null ? '—' : fmtNumber(model.artefacts * 100, 1)}
              unit="%"
              hint={model.artefacts === null ? 'No RR data' : undefined}
              tone={model.artefacts !== null && model.artefacts > ARTEFACT_FLAG ? 'attention' : 'default'}
            />
          </section>

          <div className="grid grid--2-1">
            <Card>
              <PhaseDeltaChart profile={model.phase} testId="phase-delta-chart" />
            </Card>
            <Card>
              <SimpleBarChart
                title="Workload distribution"
                subtitle={`Raw (unweighted) SURG-TLX / NASA-TLX scores, ${plural(model.workloadN, 'session')}.`}
                data={model.workload}
                valueLabel="Sessions"
                summary={`Workload scores of ${model.workloadN} sessions in 10-point bins: ${model.workload
                  .filter((d) => d.value > 0)
                  .map((d) => `${d.label}: ${d.value}`)
                  .join(', ')}.`}
                testId="workload-chart"
              />
            </Card>
          </div>

          <div className="grid grid--2-1">
            <Card>
              <SimpleBarChart
                title="Sessions per month"
                subtitle="By month of the session start (UTC)."
                data={model.months}
                valueLabel="Sessions"
                summary={`Sessions per month across ${model.months.length} months${
                  busiest ? `; busiest ${busiest.label} with ${busiest.value}` : ''
                }.`}
                testId="months-chart"
              />
            </Card>
            <Card
              title="Data-quality flags"
              description={`Sessions with coverage below ${COVERAGE_FLAG * 100}\u00a0% or RR artefact above ${ARTEFACT_FLAG * 100}\u00a0%.`}
            >
              {model.flags.length === 0 ? (
                <p className="muted" data-testid="quality-flags-empty">
                  {summarizing ? 'Checking sessions…' : 'No sessions flagged.'}
                </p>
              ) : (
                <ul className="flag-list" data-testid="quality-flags">
                  {model.flags.slice(0, 50).map(({ summary: s, reasons }) => (
                    <li key={s.sessionId}>
                      <a href={hrefs.session(s.sessionId)}>
                        {fmtDate(s.startedAt, state.sessions.get(s.sessionId)?.tzOffsetMin)} · {s.participantCode} ·{' '}
                        {s.procedureName}
                      </a>
                      <span className="flag-list__reason">{reasons.join(', ')}</span>
                    </li>
                  ))}
                  {model.flags.length > 50 && <li className="muted">…and {model.flags.length - 50} more.</li>}
                </ul>
              )}
            </Card>
          </div>
        </>
      )}
    </>
  );
}
