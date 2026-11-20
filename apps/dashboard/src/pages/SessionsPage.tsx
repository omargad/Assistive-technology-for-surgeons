/**
 * Sessions: filterable, sortable table. Rows link to the session detail.
 */
import { useMemo, useState } from 'react';
import { formatDuration, metricValue } from '@surgeonpulse/core';
import type { SessionSummary } from '@surgeonpulse/core';
import { DataTable } from '../components/DataTable';
import type { Column, SortState } from '../components/DataTable';
import { FilterBar, SummaryProgress } from '../components/Filters';
import { EmptyState, PageHeader, SimulatedBadge } from '../components/ui';
import { useDocumentTitle } from '../lib/useDocumentTitle';
import { fmtDate, fmtMetric, fmtNumber, fmtPercent, fmtSigned, fmtTime } from '../lib/format';
import { hrefs, navigate } from '../router';
import type { SessionFacets } from '../state/filters';
import { useDashboardState, useDerived } from '../state/hooks';

interface Row {
  facet: SessionFacets;
  summary: SessionSummary | undefined;
}

/** Remember the sort between visits (per tab). */
let lastSort: SortState = { id: 'date', direction: 'desc' };

const pending = <span className="muted" aria-label="Computing">…</span>;

function metricCell(row: Row, render: (s: SessionSummary) => string) {
  return row.summary === undefined ? pending : render(row.summary);
}

function buildColumns(markSimulated: boolean): Column<Row>[] {
  return [
  {
    id: 'date',
    header: 'Date',
    rowHeader: true,
    sortValue: (r) => r.facet.startedAt,
    cell: (r) => (
      <a href={hrefs.session(r.facet.id)} className="cell-link">
        {fmtDate(r.facet.startedAt, r.facet.tzOffsetMin)}{' '}
        <span className="muted">{fmtTime(r.facet.startedAt, r.facet.tzOffsetMin)}</span>
      </a>
    ),
  },
  {
    id: 'participant',
    header: 'Participant',
    sortValue: (r) => r.facet.participantCode,
    cell: (r) => <span className="code">{r.facet.participantCode}</span>,
  },
  {
    id: 'procedure',
    header: 'Procedure',
    sortValue: (r) => r.facet.procedureName,
    cell: (r) => (
      <span className="cell-procedure">
        {r.facet.procedureName}
        {markSimulated && r.facet.simulated && (
          <>
            {' '}
            <SimulatedBadge />
          </>
        )}
      </span>
    ),
  },
  {
    id: 'duration',
    header: 'Duration',
    align: 'right',
    sortValue: (r) => r.summary?.durationSec,
    cell: (r) => metricCell(r, (s) => formatDuration(s.durationSec)),
  },
  {
    id: 'meanHr',
    header: 'Mean HR',
    title: 'Mean heart rate (bpm)',
    align: 'right',
    sortValue: (r) => (r.summary ? metricValue(r.summary, 'meanHr') : null),
    cell: (r) => metricCell(r, (s) => fmtMetric('meanHr', metricValue(s, 'meanHr'))),
  },
  {
    id: 'delta',
    header: 'Δ HR',
    title: 'Mean heart rate above baseline (bpm)',
    align: 'right',
    sortValue: (r) => (r.summary ? metricValue(r.summary, 'meanHrDelta') : null),
    cell: (r) => metricCell(r, (s) => fmtSigned(metricValue(s, 'meanHrDelta'), 1)),
  },
  {
    id: 'rmssd',
    header: 'RMSSD',
    title: 'RMSSD (ms)',
    align: 'right',
    sortValue: (r) => (r.summary ? metricValue(r.summary, 'rmssd') : null),
    cell: (r) => metricCell(r, (s) => fmtMetric('rmssd', metricValue(s, 'rmssd'))),
  },
  {
    id: 'si',
    header: 'SI',
    title: 'Baevsky stress index',
    align: 'right',
    sortValue: (r) => (r.summary ? metricValue(r.summary, 'stressIndex') : null),
    cell: (r) => metricCell(r, (s) => fmtMetric('stressIndex', metricValue(s, 'stressIndex'))),
  },
  {
    id: 'workload',
    header: 'Workload',
    title: 'TLX workload (0–100)',
    align: 'right',
    sortValue: (r) => (r.summary ? metricValue(r.summary, 'workload') : null),
    cell: (r) => metricCell(r, (s) => fmtNumber(metricValue(s, 'workload'))),
  },
  {
    id: 'coverage',
    header: 'Coverage',
    title: 'Heart-rate signal coverage',
    align: 'right',
    sortValue: (r) => r.summary?.quality.coverage,
    cell: (r) => metricCell(r, (s) => fmtPercent(s.quality.coverage)),
  },
  ];
}

export function SessionsPage() {
  useDocumentTitle('Sessions');
  const state = useDashboardState();
  const { filteredFacets, facets } = useDerived();
  const [sort, setSort] = useState<SortState>(lastSort);
  // Badge individual rows only when real and simulated sessions are mixed; otherwise once in the header.
  const allSimulated = facets.length > 0 && facets.every((f) => f.simulated);
  const anySimulated = facets.some((f) => f.simulated);
  const columns = useMemo(() => buildColumns(anySimulated && !allSimulated), [anySimulated, allSimulated]);

  const rows = useMemo<Row[]>(
    () => filteredFacets.map((facet) => ({ facet, summary: state.summaries.get(facet.id) })),
    [filteredFacets, state.summaries],
  );

  if (state.order.length === 0) {
    return (
      <>
        <PageHeader title="Sessions" />
        <EmptyState />
      </>
    );
  }

  return (
    <>
      <PageHeader
        title="Sessions"
        subtitle="Dates are the recording's local time (UTC when the timezone is unknown). Select a row for details."
        actions={allSimulated ? <SimulatedBadge /> : undefined}
      />
      <FilterBar />
      <SummaryProgress />
      <DataTable
        rows={rows}
        columns={columns}
        rowKey={(r) => r.facet.id}
        caption="Sessions"
        sort={sort}
        onSortChange={(s) => {
          lastSort = s;
          setSort(s);
        }}
        onRowClick={(r) => navigate(hrefs.session(r.facet.id))}
        emptyMessage="No sessions match the filters."
        testId="sessions-table"
      />
    </>
  );
}
