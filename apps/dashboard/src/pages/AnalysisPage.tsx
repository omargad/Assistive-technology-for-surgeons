/**
 * Analysis: a metric × group-by comparison (core `aggregateMetric`) as a
 * table and a bar chart with SD whiskers, plus a scatter of two metrics
 * coloured by group with an OLS line and Pearson r, and a copyable summary.
 */
import { useId, useMemo, useState } from 'react';
import { METRICS, aggregateMetric, metricValue } from '@surgeonpulse/core';
import type { GroupKey, MetricAggregate, MetricKey } from '@surgeonpulse/core';
import { GroupMeanChart } from '../components/charts/BarCharts';
import type { GroupBarDatum } from '../components/charts/BarCharts';
import { ScatterTrendChart } from '../components/charts/TrendCharts';
import type { ScatterPoint } from '../components/charts/TrendCharts';
import { DataTable } from '../components/DataTable';
import type { Column } from '../components/DataTable';
import { FilterSummary, SummaryProgress } from '../components/Filters';
import { Card, EmptyState, PageHeader, SelectField, SimulatedBadge } from '../components/ui';
import { useDocumentTitle } from '../lib/useDocumentTitle';
import { analysisSummaryText, groupOfSummary } from '../lib/analysis';
import { copyText } from '../lib/clipboard';
import { fitPoints } from '../lib/fit';
import { GROUP_LABELS, fmtDate, fmtNumber, fmtSigned, groupValueLabel, metricLabel, plural } from '../lib/format';
import { describeFilters } from '../state/filters';
import { useDashboardState, useDerived } from '../state/hooks';

const METRIC_KEYS = Object.keys(METRICS) as MetricKey[];
const GROUP_KEYS: readonly GroupKey[] = [
  'none',
  'participant',
  'procedure',
  'specialty',
  'approach',
  'role',
  'trainingLevel',
  'urgency',
  'month',
];

/** Session state of the Analysis selectors (kept when navigating away and back). */
let saved: { metric: MetricKey; groupBy: GroupKey; x: MetricKey; y: MetricKey } = {
  metric: 'meanHrDelta',
  groupBy: 'trainingLevel',
  x: 'workload',
  y: 'meanHrDelta',
};

export function AnalysisPage() {
  useDocumentTitle('Analysis');
  const state = useDashboardState();
  const { filteredSummaries, filteredFacets } = useDerived();
  const [metric, setMetricState] = useState<MetricKey>(saved.metric);
  const [groupBy, setGroupByState] = useState<GroupKey>(saved.groupBy);
  const [x, setXState] = useState<MetricKey>(saved.x);
  const [y, setYState] = useState<MetricKey>(saved.y);
  const [copied, setCopied] = useState<'idle' | 'ok' | 'failed'>('idle');
  const [today] = useState(() => fmtDate(Date.now()));
  const summaryId = useId();

  const remember = (patch: Partial<typeof saved>): void => {
    saved = { ...saved, ...patch };
  };
  const setMetric = (v: MetricKey): void => (remember({ metric: v }), setMetricState(v));
  const setGroupBy = (v: GroupKey): void => (remember({ groupBy: v }), setGroupByState(v));
  const setX = (v: MetricKey): void => (remember({ x: v }), setXState(v));
  const setY = (v: MetricKey): void => (remember({ y: v }), setYState(v));

  const info = METRICS[metric];
  const rows = useMemo(() => aggregateMetric(filteredSummaries, metric, groupBy), [filteredSummaries, metric, groupBy]);

  const scatter = useMemo(() => {
    // Group order (and therefore colour) follows the full group list, sorted by core.
    const groups = aggregateMetric(filteredSummaries, 'durationMin', groupBy).map((r) => ({
      key: r.group,
      label: groupValueLabel(groupBy, r.group),
    }));
    const points: ScatterPoint[] = [];
    for (const s of filteredSummaries) {
      const xv = metricValue(s, x);
      const yv = metricValue(s, y);
      if (xv === null || yv === null) continue;
      const tz = state.sessions.get(s.sessionId)?.tzOffsetMin;
      points.push({
        id: s.sessionId,
        x: xv,
        y: yv,
        group: groupOfSummary(s, groupBy),
        label: `${fmtDate(s.startedAt, tz)} · ${s.participantCode}`,
      });
    }
    return { groups, points, fit: fitPoints(points) };
  }, [filteredSummaries, groupBy, x, y, state.sessions]);

  const participants = new Set(filteredFacets.map((f) => f.participantCode)).size;
  const text = analysisSummaryText({
    rows,
    metric,
    groupBy,
    x,
    y,
    fit: scatter.fit,
    sessions: filteredSummaries.length,
    participants,
    filters: describeFilters(state.filters),
    simulated: state.simulated,
    date: today,
  });

  if (state.order.length === 0) {
    return (
      <>
        <PageHeader title="Analysis" />
        <EmptyState />
      </>
    );
  }

  const columns: Column<MetricAggregate>[] = [
    {
      id: 'group',
      header: GROUP_LABELS[groupBy] === GROUP_LABELS.none ? 'Group' : GROUP_LABELS[groupBy],
      rowHeader: true,
      sortValue: (r) => r.group,
      cell: (r) => groupValueLabel(groupBy, r.group),
    },
    { id: 'n', header: 'n', align: 'right', sortValue: (r) => r.n, cell: (r) => r.n },
    { id: 'mean', header: 'Mean', align: 'right', sortValue: (r) => r.mean, cell: (r) => fmtNumber(r.mean, info.decimals) },
    { id: 'sd', header: 'SD', align: 'right', sortValue: (r) => r.sd, cell: (r) => fmtNumber(r.sd, info.decimals) },
    { id: 'median', header: 'Median', align: 'right', sortValue: (r) => r.median, cell: (r) => fmtNumber(r.median, info.decimals) },
    { id: 'min', header: 'Min', align: 'right', sortValue: (r) => r.min, cell: (r) => fmtNumber(r.min, info.decimals) },
    { id: 'max', header: 'Max', align: 'right', sortValue: (r) => r.max, cell: (r) => fmtNumber(r.max, info.decimals) },
  ];

  const chartData: GroupBarDatum[] = rows.map((r) => ({
    key: r.group,
    label: groupValueLabel(groupBy, r.group),
    mean: r.mean,
    sd: r.sd,
    n: r.n,
  }));
  const top = [...rows].sort((a, b) => b.mean - a.mean)[0];
  const chartSummary =
    rows.length === 0
      ? `No values of ${info.label.toLowerCase()} in the selected sessions.`
      : `${metricLabel(metric)} by ${GROUP_LABELS[groupBy].toLowerCase()}, mean with SD whiskers across ${plural(rows.length, 'group')}. ` +
        (top ? `Highest mean: ${groupValueLabel(groupBy, top.group)} at ${fmtNumber(top.mean, info.decimals)}.` : '');

  const metricOptions = METRIC_KEYS.map((k) => ({ value: k, label: metricLabel(k) }));

  return (
    <>
      <PageHeader
        title="Analysis"
        subtitle="Compare a metric across groups and explore relationships between metrics."
        actions={state.simulated ? <SimulatedBadge /> : undefined}
      />
      <FilterSummary />
      <SummaryProgress />

      <Card title="Group comparison">
        <div className="controls-row">
          <SelectField label="Metric" value={metric} onChange={setMetric} options={metricOptions} id="analysis-metric" />
          <SelectField
            label="Group by"
            value={groupBy}
            onChange={setGroupBy}
            options={GROUP_KEYS.map((g) => ({ value: g, label: GROUP_LABELS[g] }))}
            id="analysis-group"
          />
        </div>
        <div className="grid grid--2 grid--flush">
          <GroupMeanChart
            title={`${info.label} by ${GROUP_LABELS[groupBy].toLowerCase()}`}
            subtitle={`Mean ± SD${info.unit ? ` (${info.unit})` : ''}.`}
            data={chartData}
            unit={info.unit}
            decimals={info.decimals}
            summary={chartSummary}
            testId="group-chart"
            table={
              <table className="data-table data-table--compact">
                <caption className="visually-hidden">Group means shown in the chart</caption>
                <thead>
                  <tr>
                    <th scope="col">Group</th>
                    <th scope="col" className="num">Mean</th>
                    <th scope="col" className="num">SD</th>
                    <th scope="col" className="num">n</th>
                  </tr>
                </thead>
                <tbody>
                  {chartData.map((d) => (
                    <tr key={d.key}>
                      <th scope="row">{d.label}</th>
                      <td className="num">{fmtNumber(d.mean, info.decimals)}</td>
                      <td className="num">{fmtNumber(d.sd, info.decimals)}</td>
                      <td className="num">{d.n}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            }
          />
          <DataTable
            rows={rows}
            columns={columns}
            rowKey={(r) => r.group}
            caption={`${metricLabel(metric)} by ${GROUP_LABELS[groupBy].toLowerCase()}`}
            showCaption
            compact
            emptyMessage="No values for this metric."
            testId="group-table"
          />
        </div>
      </Card>

      <Card title="Relationship between metrics">
        <div className="controls-row">
          <SelectField label="X axis" value={x} onChange={setX} options={metricOptions} id="analysis-x" />
          <SelectField label="Y axis" value={y} onChange={setY} options={metricOptions} id="analysis-y" />
          <p className="controls-row__note">Points are coloured by “{GROUP_LABELS[groupBy]}”.</p>
        </div>
        <ScatterTrendChart
          title={`${METRICS[y].label} vs ${METRICS[x].label}`}
          points={scatter.points}
          groups={groupBy === 'none' ? undefined : scatter.groups}
          xLabel={metricLabel(x)}
          yLabel={metricLabel(y)}
          xDecimals={METRICS[x].decimals}
          yDecimals={METRICS[y].decimals}
          height={380}
          testId="analysis-scatter"
        />
        <p className="hint">
          r = {fmtNumber(scatter.fit.r, 2)}, n = {scatter.fit.n}
          {scatter.fit.trend ? `, slope ${fmtSigned(scatter.fit.trend.slope, 3)}` : ''}. Correlation is not causation;
          sessions from the same participant are not independent.
          {scatter.groups.length > 8 && groupBy !== 'none' ? ' Groups beyond the first eight share the “Other groups” colour.' : ''}
        </p>
      </Card>

      <Card
        title="Summary text"
        description="Plain-text description of the current analysis, ready to paste into notes."
        actions={
          <button
            type="button"
            className="btn"
            onClick={() => {
              void copyText(text).then((ok) => setCopied(ok ? 'ok' : 'failed'));
            }}
          >
            Copy summary
          </button>
        }
      >
        <label htmlFor={summaryId} className="visually-hidden">
          Analysis summary
        </label>
        <textarea id={summaryId} className="summary-text" readOnly value={text} rows={Math.min(16, text.split('\n').length + 1)} />
        <p className="hint" aria-live="polite">
          {copied === 'ok' ? 'Copied to the clipboard.' : copied === 'failed' ? 'Copy failed — select the text and copy it manually.' : ''}
        </p>
      </Card>
    </>
  );
}
