/**
 * Session detail: header, stat tiles, HR timeline with phases/markers,
 * rolling RMSSD, zones, phase and episode tables, events, post-op report,
 * data quality and per-session CSV exports.
 */
import {
  APPROACH_LABELS,
  BASELINE_SOURCE_LABELS,
  COMPLEXITY_LABELS,
  EVENT_LOGGER_LABELS,
  MARKER_LABELS,
  NASA_TLX_DIMENSION_LABELS,
  OUTCOME_LABELS,
  PHASE_COLORS,
  PHASE_LABELS,
  ROLE_LABELS,
  SENSOR_SOURCE_LABELS,
  SESSION_STATUS_LABELS,
  SURG_TLX_DIMENSION_LABELS,
  TRAINING_LEVEL_LABELS,
  URGENCY_LABELS,
  WORKLOAD_INSTRUMENT_LABELS,
  eventsToCsv,
  formatClock,
  formatDuration,
  metricValue,
  rrToCsv,
  samplesToCsv,
} from '@surgeonpulse/core';
import type { CSSProperties, ReactNode } from 'react';
import type { PhaseSummary, SessionEvent, SessionSummary, StressEpisode, SurgicalSession } from '@surgeonpulse/core';
import { HrTimelineChart, RollingHrvChart, ZonesChart } from '../components/charts/SessionCharts';
import { DataTable } from '../components/DataTable';
import type { Column } from '../components/DataTable';
import { SummaryProgress } from '../components/Filters';
import { Card, EmptyState, KpiTile, Notice, PageHeader, SimulatedBadge } from '../components/ui';
import { useDocumentTitle } from '../lib/useDocumentTitle';
import { downloadCsv, exportFilename, safeFilename } from '../lib/download';
import {
  NO_DATA,
  fmtDateTime,
  fmtMetric,
  fmtNumber,
  fmtPercent,
  fmtSigned,
  fmtZone,
  lookup,
  plural,
} from '../lib/format';
import { hrefs } from '../router';
import { useDashboardState } from '../state/hooks';

function MetaList({ items }: { items: readonly [label: string, value: ReactNode][] }) {
  return (
    <dl className="meta-list">
      {items.map(([label, value]) => (
        <div key={label} className="meta-list__item">
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function eventLabel(e: SessionEvent): string {
  return e.type === 'phase' ? `Phase: ${PHASE_LABELS[e.phase]}` : MARKER_LABELS[e.marker];
}

function PhaseTable({ session, summary }: { session: SurgicalSession; summary: SessionSummary }) {
  const columns: Column<PhaseSummary>[] = [
    {
      id: 'phase',
      header: 'Phase',
      rowHeader: true,
      cell: (p) => (
        <span className="phase-name">
          <span className="phase-dot" style={{ '--dot': PHASE_COLORS[p.phase] } as CSSProperties} aria-hidden="true" />
          {PHASE_LABELS[p.phase]}
        </span>
      ),
    },
    { id: 'start', header: 'Start', align: 'right', cell: (p) => formatClock(p.start - session.startedAt) },
    { id: 'duration', header: 'Duration', align: 'right', cell: (p) => formatDuration(p.durationSec) },
    { id: 'hr', header: 'Mean HR', align: 'right', cell: (p) => fmtNumber(p.hr?.mean) },
    { id: 'peak', header: 'Peak HR', align: 'right', cell: (p) => fmtNumber(p.hr?.max) },
    { id: 'delta', header: 'Δ baseline', align: 'right', cell: (p) => fmtSigned(p.meanHrDelta, 1) },
    { id: 'rmssd', header: 'RMSSD', align: 'right', cell: (p) => fmtNumber(p.hrv?.rmssd, 1) },
  ];
  return (
    <Card title="Phases" description="Heart rate in bpm, RMSSD in ms; Δ is relative to the resting baseline.">
      <DataTable
        rows={summary.phases}
        columns={columns}
        rowKey={(p) => `${p.phase}-${p.index}`}
        caption="Operative phases"
        compact
        emptyMessage="No phases were marked in this session."
      />
    </Card>
  );
}

function EpisodesTable({ session, summary }: { session: SurgicalSession; summary: SessionSummary }) {
  const eventsById = new Map(session.events.map((e) => [e.id, e]));
  const columns: Column<StressEpisode>[] = [
    { id: 'start', header: 'Start', rowHeader: true, cell: (e) => formatClock(e.start - session.startedAt) },
    { id: 'duration', header: 'Duration', align: 'right', cell: (e) => formatDuration(e.durationSec) },
    { id: 'peak', header: 'Peak HR', align: 'right', cell: (e) => fmtNumber(e.peakBpm) },
    { id: 'mean', header: 'Mean HR', align: 'right', cell: (e) => fmtNumber(e.meanBpm) },
    { id: 'phase', header: 'Phase at peak', cell: (e) => (e.phase ? PHASE_LABELS[e.phase] : NO_DATA) },
    {
      id: 'related',
      header: 'Related events',
      cell: (e) => {
        const labels = e.relatedEventIds.flatMap((id) => {
          const ev = eventsById.get(id);
          return ev ? [eventLabel(ev)] : [];
        });
        return labels.length === 0 ? <span className="muted">None</span> : labels.join(', ');
      },
    },
  ];
  return (
    <Card
      title="Stress episodes"
      description="Sustained periods (≥ 60 s) above the episode threshold, with events logged up to 2 minutes before."
    >
      <DataTable
        rows={summary.episodes}
        columns={columns}
        rowKey={(e) => String(e.start)}
        caption="Stress episodes"
        compact
        emptyMessage="No stress episodes detected."
      />
    </Card>
  );
}

function EventsTable({ session }: { session: SurgicalSession }) {
  const columns: Column<SessionEvent>[] = [
    { id: 't', header: 'Time', rowHeader: true, cell: (e) => formatClock(e.t - session.startedAt) },
    { id: 'event', header: 'Event', cell: (e) => eventLabel(e) },
    { id: 'by', header: 'Logged by', cell: (e) => (e.loggedBy ? EVENT_LOGGER_LABELS[e.loggedBy] : NO_DATA) },
    { id: 'note', header: 'Note', cell: (e) => e.note ?? '' },
  ];
  return (
    <Card title="Events" description="Phase changes and markers logged during the case (elapsed time).">
      <DataTable
        rows={session.events}
        columns={columns}
        rowKey={(e) => e.id}
        caption="Logged events"
        compact
        emptyMessage="No events were logged."
      />
    </Card>
  );
}

function PostOpCard({ session, summary }: { session: SurgicalSession; summary: SessionSummary }) {
  const post = session.postOp;
  if (post === undefined) {
    return (
      <Card title="Post-op report">
        <p className="muted">No post-operative questionnaire was recorded for this session.</p>
      </Card>
    );
  }
  const workload = summary.workload;
  const dimLabels: Readonly<Record<string, string>> =
    workload?.instrument === 'nasa-tlx' ? NASA_TLX_DIMENSION_LABELS : SURG_TLX_DIMENSION_LABELS;
  return (
    <Card title="Post-op report" description="Self-reported after the case.">
      {workload !== null && (
        <>
          <p className="postop-score">
            <strong>{WORKLOAD_INSTRUMENT_LABELS[workload.instrument]}</strong> workload{' '}
            <span className="postop-score__value">{fmtNumber(workload.weighted ?? workload.raw)}</span>
            <span className="muted"> / 100 {workload.weighted !== null ? '(weighted)' : '(raw)'}</span>
          </p>
          <ul className="rating-list">
            {Object.entries(workload.dimensions).map(([dim, rating]) => (
              <li key={dim}>
                <span className="rating-list__label">{lookup(dimLabels, dim)}</span>
                <span className="rating-list__bar" aria-hidden="true">
                  <span style={{ width: `${Math.max(0, Math.min(100, rating))}%` }} />
                </span>
                <span className="rating-list__value">{fmtNumber(rating)}</span>
              </li>
            ))}
          </ul>
        </>
      )}
      <MetaList
        items={[
          ['Self-rated performance', post.performance !== undefined ? `${fmtNumber(post.performance, 1)} / 10` : NO_DATA],
          ['Perceived stress', post.perceivedStress !== undefined ? `${fmtNumber(post.perceivedStress, 1)} / 10` : NO_DATA],
          ['Outcome', post.outcome ? OUTCOME_LABELS[post.outcome] : NO_DATA],
          ['Sleep the night before', post.sleepHours !== undefined ? `${fmtNumber(post.sleepHours, 1)} h` : NO_DATA],
          ['Caffeine within 2 h', post.caffeine === undefined ? NO_DATA : post.caffeine ? 'Yes' : 'No'],
        ]}
      />
      {post.notes !== undefined && post.notes !== '' && (
        <div className="postop-notes">
          <h3 className="subheading">Notes</h3>
          <p>{post.notes}</p>
        </div>
      )}
    </Card>
  );
}

function QualityCard({ session, summary }: { session: SurgicalSession; summary: SessionSummary }) {
  const q = summary.quality;
  return (
    <Card title="Data quality">
      <MetaList
        items={[
          ['Signal coverage', fmtPercent(q.coverage)],
          ['Gaps over 5 s', String(q.gapCount)],
          ['Longest gap', q.longestGapSec > 0 ? formatDuration(q.longestGapSec) : NO_DATA],
          ['Sample rate', `${fmtNumber(q.sampleRateHz, 2)} Hz`],
          ['HR samples', String(session.samples.length)],
          ['RR intervals', String(session.rr.length)],
          ['RR artefact', fmtPercent(q.rrArtifactRatio, 1)],
          [
            'Baseline',
            summary.baseline
              ? `${fmtNumber(summary.baseline.restingHr)} bpm · ${BASELINE_SOURCE_LABELS[summary.baseline.source]}`
              : 'None',
          ],
        ]}
      />
      {session.rr.length === 0 && (
        <p className="hint">No RR intervals were recorded, so HRV (RMSSD, SDNN, stress index) is not available.</p>
      )}
      {q.coverage < 0.8 && (
        <Notice tone="warning">Coverage is below 80 %: check strap fit and Bluetooth range for future cases.</Notice>
      )}
    </Card>
  );
}

function ExportCard({ session }: { session: SurgicalSession }) {
  const stem = safeFilename(`${session.participantCode}-${session.id.slice(0, 8)}`);
  const save = (csv: string, what: string): void => downloadCsv(csv, exportFilename(`${stem}-${what}`, 'csv', new Date()));
  return (
    <Card title="Export this session" description="Long-format CSV (RFC 4180) for R, SPSS, Stata or Python.">
      <div className="button-row">
        <button type="button" className="btn" onClick={() => save(samplesToCsv(session), 'samples')}>
          Heart-rate samples CSV
        </button>
        <button
          type="button"
          className="btn"
          disabled={session.rr.length === 0}
          onClick={() => save(rrToCsv(session), 'rr')}
        >
          RR intervals CSV
        </button>
        <button type="button" className="btn" onClick={() => save(eventsToCsv(session), 'events')}>
          Events CSV
        </button>
      </div>
      {session.rr.length === 0 && <p className="hint">This session has no RR intervals.</p>}
    </Card>
  );
}

export function SessionDetailPage({ id }: { id: string }) {
  const state = useDashboardState();
  const session = state.sessions.get(id);
  const summary = state.summaries.get(id);
  const summaryError = state.summaryErrors.get(id);
  useDocumentTitle(session ? `${session.procedure.name} · ${session.participantCode}` : 'Session');

  if (session === undefined) {
    return (
      <>
        <PageHeader title="Session not found" />
        <EmptyState
          title={state.order.length === 0 ? 'No data loaded yet' : 'This session is not in the loaded data'}
          action={
            <a className="btn btn--primary" href={state.order.length === 0 ? hrefs.data : hrefs.sessions}>
              {state.order.length === 0 ? 'Go to Data' : 'Back to sessions'}
            </a>
          }
        />
      </>
    );
  }

  const p = session.procedure;
  const snap = session.participantSnapshot;
  const simulated = session.sensor.source === 'simulated';

  return (
    <>
      <PageHeader
        eyebrow={
          <>
            <a href={hrefs.sessions}>Sessions</a> / <a href={hrefs.participant(session.participantCode)}>{session.participantCode}</a>
          </>
        }
        title={p.name}
        subtitle={`${fmtDateTime(session.startedAt, session.tzOffsetMin)} · ${summary ? formatDuration(summary.durationSec) : '…'}`}
        actions={simulated ? <SimulatedBadge /> : undefined}
      />
      <Card>
        <MetaList
          items={[
            ['Participant', <a key="p" href={hrefs.participant(session.participantCode)} className="code">{session.participantCode}</a>],
            ['Training level', snap?.trainingLevel ? TRAINING_LEVEL_LABELS[snap.trainingLevel] : NO_DATA],
            ['Specialty', p.specialty ?? NO_DATA],
            ['Approach', p.approach ? APPROACH_LABELS[p.approach] : NO_DATA],
            ['Role', p.role ? ROLE_LABELS[p.role] : NO_DATA],
            ['Urgency', p.urgency ? URGENCY_LABELS[p.urgency] : NO_DATA],
            ['Complexity', p.complexity ? `${p.complexity} · ${COMPLEXITY_LABELS[p.complexity]}` : NO_DATA],
            ['Sensor', session.sensor.name ? `${session.sensor.name} (${SENSOR_SOURCE_LABELS[session.sensor.source]})` : SENSOR_SOURCE_LABELS[session.sensor.source]],
            ['Status', SESSION_STATUS_LABELS[session.status]],
            ['Timezone', fmtZone(session.tzOffsetMin)],
          ]}
        />
      </Card>

      {summary === undefined ? (
        summaryError !== undefined ? (
          <Notice tone="error" title="This session could not be summarised">
            {summaryError}
          </Notice>
        ) : (
          <SummaryProgress />
        )
      ) : (
        <>
          <section className="kpi-grid kpi-grid--wide" aria-label="Session statistics" data-testid="session-stats">
            <KpiTile label="Mean HR" value={fmtMetric('meanHr', metricValue(summary, 'meanHr'))} unit="bpm" />
            <KpiTile label="Peak HR" value={fmtMetric('peakHr', metricValue(summary, 'peakHr'))} unit="bpm" />
            <KpiTile label="Δ baseline" value={fmtSigned(summary.meanHrDelta, 1)} unit="bpm" />
            <KpiTile label="RMSSD" value={fmtMetric('rmssd', summary.hrv?.rmssd)} unit="ms" />
            <KpiTile label="SDNN" value={fmtMetric('sdnn', summary.hrv?.sdnn)} unit="ms" />
            <KpiTile label="Stress index" value={fmtMetric('stressIndex', summary.stressIndex)} />
            <KpiTile
              label="Stress episodes"
              value={summary.episodes.length}
              hint={summary.episodes.length > 0 ? `${fmtNumber(metricValue(summary, 'episodeMinutes'), 1)} min in total` : undefined}
            />
            <KpiTile
              label="Time ≥ 70 % max HR"
              value={fmtMetric('highIntensityPct', metricValue(summary, 'highIntensityPct'))}
              unit="%"
            />
            <KpiTile label="Workload" value={fmtNumber(metricValue(summary, 'workload'))} unit="/100" />
            <KpiTile
              label="Coverage"
              value={fmtNumber(summary.quality.coverage * 100)}
              unit="%"
              tone={summary.quality.coverage < 0.8 ? 'attention' : 'default'}
            />
          </section>

          <Card>
            <HrTimelineChart session={session} summary={summary} />
          </Card>
          {/* Full width, directly under the HR timeline, so the time axes line up. */}
          {session.rr.length > 0 && (
            <Card>
              <RollingHrvChart session={session} summary={summary} />
            </Card>
          )}

          <div className="grid grid--2">
            <Card>
              <ZonesChart summary={summary} />
            </Card>
            <PostOpCard session={session} summary={summary} />
          </div>

          <PhaseTable session={session} summary={summary} />
          <div className="grid grid--2">
            <EpisodesTable session={session} summary={summary} />
            <EventsTable session={session} />
          </div>
          <div className="grid grid--2">
            <QualityCard session={session} summary={summary} />
            <ExportCard session={session} />
          </div>
        </>
      )}
      {summary === undefined && <ExportCard session={session} />}
      <p className="muted small">
        {plural(session.samples.length, 'heart-rate sample')}, {plural(session.events.length, 'event')}. Session id{' '}
        <span className="code">{session.id}</span>.
      </p>
    </>
  );
}
