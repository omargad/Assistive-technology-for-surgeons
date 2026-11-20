/**
 * Relationship and trend charts: a scatter with an OLS fit and Pearson r
 * (Analysis, feedback view) and a learning curve (feedback view). Fits and
 * correlations come from core (`linearTrend`, `pearsonCorrelation`).
 */
import { useMemo } from 'react';
import type { ReactNode } from 'react';
import {
  CartesianGrid,
  ComposedChart,
  Line,
  ReferenceLine,
  ResponsiveContainer,
  Scatter,
  ScatterChart,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { linearTrend } from '@surgeonpulse/core';
import { categoricalColor, MAX_COLOURED_GROUPS } from '../../lib/chartColors';
import { describeR, fitPoints } from '../../lib/fit';
import { fmtNumber, fmtSigned } from '../../lib/format';
import { useTheme } from '../../lib/useTheme';
import { ChartFigure } from './ChartFigure';
import { axisProps, tooltipStyles } from './chartStyle';
import type { LegendItem } from './ChartFigure';

export interface ScatterPoint {
  id: string;
  x: number;
  y: number;
  /** Group key (e.g. procedure name); '' for ungrouped. */
  group: string;
  /** Short label for tooltips/tables (e.g. a date). */
  label?: string;
}

export interface ScatterTrendChartProps {
  title: string;
  subtitle?: string;
  points: readonly ScatterPoint[];
  /** Ordered groups (colour follows the group, not its rank among visible points). */
  groups?: readonly { key: string; label: string }[];
  xLabel: string;
  yLabel: string;
  xDecimals?: number;
  yDecimals?: number;
  height?: number;
  testId?: string;
}

export function ScatterTrendChart({
  title,
  subtitle,
  points,
  groups,
  xLabel,
  yLabel,
  xDecimals = 0,
  yDecimals = 0,
  height = 320,
  testId,
}: ScatterTrendChartProps) {
  const { colors } = useTheme();
  const tt = tooltipStyles(colors);
  const ax = axisProps(colors);
  const fit = useMemo(() => fitPoints(points), [points]);

  const series = useMemo(() => {
    const ordered = groups ?? [{ key: '', label: 'Sessions' }];
    const coloured = ordered.slice(0, MAX_COLOURED_GROUPS);
    const colouredKeys = new Set(coloured.map((g) => g.key));
    const out = coloured.map((g, i) => ({
      key: g.key,
      label: g.label,
      color: categoricalColor(colors, i),
      data: points.filter((p) => p.group === g.key),
    }));
    const rest = points.filter((p) => !colouredKeys.has(p.group));
    if (rest.length > 0) out.push({ key: '__other', label: 'Other groups', color: colors.other, data: rest });
    return out.filter((s) => s.data.length > 0);
  }, [groups, points, colors]);

  const xs = points.map((p) => p.x);
  const xMin = xs.length ? Math.min(...xs) : 0;
  const xMax = xs.length ? Math.max(...xs) : 1;
  const segment =
    fit.trend !== null && xMax > xMin
      ? ([
          { x: xMin, y: fit.trend.intercept + fit.trend.slope * xMin },
          { x: xMax, y: fit.trend.intercept + fit.trend.slope * xMax },
        ] as const)
      : null;

  const fitText =
    fit.n < 3
      ? `Only ${fit.n} paired value${fit.n === 1 ? '' : 's'}; no fit shown.`
      : `Pearson r = ${fmtNumber(fit.r, 2)} (${describeR(fit.r)}), n = ${fit.n}` +
        (fit.trend ? `; OLS slope ${fmtSigned(fit.trend.slope, 2)} per unit, R² = ${fmtNumber(fit.trend.r2, 2)}.` : '.');
  const summary = `Scatter of ${yLabel} against ${xLabel}. ${fitText}`;

  const legend: LegendItem[] = [
    ...(series.length > 1 || groups !== undefined ? series.map((s) => ({ label: s.label, color: s.color, shape: 'circle' as const })) : []),
    ...(segment !== null && fit.n >= 3 ? [{ label: 'OLS fit', color: colors.comparison, shape: 'dashed' as const }] : []),
  ];

  const table = (
    <div className="table-wrap table-wrap--scroll" tabIndex={0} role="region" aria-label={`${title} data`}>
      <p className="table-note">{fitText}</p>
      <table className="data-table data-table--compact">
        <caption className="visually-hidden">{title}</caption>
        <thead>
          <tr>
            {groups !== undefined && <th scope="col">Group</th>}
            <th scope="col">Session</th>
            <th scope="col" className="num">{xLabel}</th>
            <th scope="col" className="num">{yLabel}</th>
          </tr>
        </thead>
        <tbody>
          {points.map((p) => (
            <tr key={p.id}>
              {groups !== undefined && <td>{groups.find((g) => g.key === p.group)?.label ?? p.group}</td>}
              <th scope="row">{p.label ?? p.id.slice(0, 8)}</th>
              <td className="num">{fmtNumber(p.x, xDecimals)}</td>
              <td className="num">{fmtNumber(p.y, yDecimals)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );

  return (
    <ChartFigure
      title={title}
      subtitle={subtitle ?? fitText}
      summary={summary}
      height={height}
      legend={legend}
      table={table}
      testId={testId}
    >
      <ResponsiveContainer width="100%" height="100%">
        <ScatterChart margin={{ top: 12, right: 20, bottom: 24, left: 4 }} accessibilityLayer={false}>
          <CartesianGrid stroke={colors.grid} />
          <XAxis
            type="number"
            dataKey="x"
            name={xLabel}
            domain={['auto', 'auto']}
            {...ax}
            tickFormatter={(v: number) => fmtNumber(v, xDecimals)}
            label={{ value: xLabel, position: 'insideBottom', offset: -14, fill: colors.textMuted, fontSize: 12 }}
          />
          <YAxis
            type="number"
            dataKey="y"
            name={yLabel}
            domain={['auto', 'auto']}
            width={56}
            {...ax}
            tickFormatter={(v: number) => fmtNumber(v, yDecimals)}
            label={{ value: yLabel, angle: -90, position: 'insideLeft', offset: 8, fill: colors.textMuted, fontSize: 12, style: { textAnchor: 'middle' } }}
          />
          <Tooltip
            {...tt}
            cursor={{ strokeDasharray: '3 3', stroke: colors.axis }}
            formatter={(v, name) => [fmtNumber(Number(v), name === xLabel ? xDecimals : yDecimals), String(name)]}
          />
          {segment !== null && fit.n >= 3 && (
            <ReferenceLine
              segment={[segment[0], segment[1]]}
              stroke={colors.comparison}
              strokeWidth={2}
              strokeDasharray="6 4"
              ifOverflow="hidden"
            />
          )}
          {series.map((s) => (
            <Scatter
              key={s.key}
              name={s.label}
              data={s.data}
              fill={s.color}
              stroke={colors.surface}
              strokeWidth={1}
              isAnimationActive={false}
            />
          ))}
        </ScatterChart>
      </ResponsiveContainer>
    </ChartFigure>
  );
}

// ---------------------------------------------------------------------------
// Learning curve
// ---------------------------------------------------------------------------

export interface CurvePoint {
  /** 1-based session number. */
  n: number;
  value: number;
  /** Date label for tables/tooltips. */
  date: string;
  sessionId: string;
}

export function LearningCurveChart({
  points,
  metricLabel,
  unit,
  decimals,
  actions,
}: {
  points: readonly CurvePoint[];
  metricLabel: string;
  unit: string;
  decimals: number;
  /** Controls shown next to the title (e.g. the metric selector). */
  actions?: ReactNode;
}) {
  const { colors } = useTheme();
  const tt = tooltipStyles(colors);
  const ax = axisProps(colors);
  const trend = useMemo(() => linearTrend(points.map((p) => ({ x: p.n, y: p.value }))), [points]);
  const first = points[0]?.n ?? 1;
  const last = points[points.length - 1]?.n ?? 1;
  const unitSuffix = unit === '' ? '' : unit.startsWith('/') ? unit : ` ${unit}`;
  const trendText =
    trend === null || points.length < 3
      ? 'Too few sessions for a trend line.'
      : `Trend ${fmtSigned(trend.slope, decimals + 1)}${unitSuffix} per session over ${points.length} sessions (R² ${fmtNumber(trend.r2, 2)}).`;
  const summary = `${metricLabel} across ${points.length} sessions in chronological order. ${trendText}`;
  const data = points.map((p) => ({ ...p }));
  const legend: LegendItem[] = [
    { label: metricLabel, color: colors.series, shape: 'line' },
    ...(trend !== null && points.length >= 3 ? [{ label: 'Linear trend', color: colors.comparison, shape: 'dashed' as const }] : []),
  ];
  const table = (
    <div className="table-wrap table-wrap--scroll" tabIndex={0} role="region" aria-label={`${metricLabel} by session`}>
      <p className="table-note">{trendText}</p>
      <table className="data-table data-table--compact">
        <caption className="visually-hidden">{metricLabel} by session</caption>
        <thead>
          <tr>
            <th scope="col">Session</th>
            <th scope="col">Date</th>
            <th scope="col" className="num">
              {metricLabel}
            </th>
          </tr>
        </thead>
        <tbody>
          {points.map((p) => (
            <tr key={p.sessionId}>
              <th scope="row">#{p.n}</th>
              <td>{p.date}</td>
              <td className="num">{fmtNumber(p.value, decimals)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
  return (
    <ChartFigure
      title="Learning curve"
      subtitle={trendText}
      summary={summary}
      actions={actions}
      height={280}
      legend={legend}
      table={table}
      testId="learning-curve"
    >
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={data} margin={{ top: 12, right: 20, bottom: 20, left: 4 }} accessibilityLayer={false}>
          <CartesianGrid stroke={colors.grid} vertical={false} />
          <XAxis
            type="number"
            dataKey="n"
            domain={[first, last]}
            allowDecimals={false}
            {...ax}
            label={{ value: 'Session number', position: 'insideBottom', offset: -10, fill: colors.textMuted, fontSize: 12 }}
          />
          <YAxis width={52} domain={['auto', 'auto']} {...ax} tickFormatter={(v: number) => fmtNumber(v, decimals)} />
          <Tooltip
            {...tt}
            labelFormatter={(v, payload) => {
              const row = (payload?.[0] as { payload?: CurvePoint } | undefined)?.payload;
              return `Session #${String(v)}${row ? ` · ${row.date}` : ''}`;
            }}
            formatter={(v) => [`${fmtNumber(Number(v), decimals)}${unitSuffix}`, metricLabel]}
          />
          {trend !== null && points.length >= 3 && last > first && (
            <ReferenceLine
              segment={[
                { x: first, y: trend.intercept + trend.slope * first },
                { x: last, y: trend.intercept + trend.slope * last },
              ]}
              stroke={colors.comparison}
              strokeWidth={2}
              strokeDasharray="6 4"
              ifOverflow="extendDomain"
            />
          )}
          <Line
            type="linear"
            dataKey="value"
            stroke={colors.series}
            strokeWidth={2}
            dot={{ r: 4, fill: colors.series, stroke: colors.surface, strokeWidth: 1.5 }}
            activeDot={{ r: 6 }}
            isAnimationActive={false}
          />
        </ComposedChart>
      </ResponsiveContainer>
    </ChartFigure>
  );
}
