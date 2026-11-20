/**
 * Bar charts used across the dashboard: phase profile (± SD), simple counts,
 * grouped metric means (± SD) and the participant-vs-cohort phase profile.
 */
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ErrorBar,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { ReactNode } from 'react';
import { PHASE_COLORS, PHASE_LABELS } from '@surgeonpulse/core';
import type { PhaseKind } from '@surgeonpulse/core';
import { fmtNumber, fmtSigned } from '../../lib/format';
import type { PhaseAggregate } from '../../lib/phaseStats';
import { useTheme } from '../../lib/useTheme';
import { ChartFigure } from './ChartFigure';
import { axisProps, tooltipStyles } from './chartStyle';
import type { LegendItem } from './ChartFigure';

/** Short phase names for crowded category axes. */
const SHORT_PHASE: Readonly<Record<PhaseKind, string>> = {
  'pre-op': 'Pre-op',
  incision: 'Incision',
  dissection: 'Dissection',
  critical: 'Critical',
  closure: 'Closure',
  'post-op': 'Post-op',
};

// ---------------------------------------------------------------------------
// Mean HR Δ by phase (± SD)
// ---------------------------------------------------------------------------

export function PhaseDeltaChart({
  profile,
  title = 'Heart rate above baseline by phase',
  subtitle,
  testId,
}: {
  profile: readonly PhaseAggregate[];
  title?: string;
  subtitle?: string;
  testId?: string;
}) {
  const { colors } = useTheme();
  const tt = tooltipStyles(colors);
  const ax = axisProps(colors);
  const data = profile
    .filter((p) => p.n > 0 && p.mean !== null)
    .map((p) => ({ phase: p.phase, label: SHORT_PHASE[p.phase], mean: p.mean!, sd: p.sd ?? 0, n: p.n }));
  const top = [...data].sort((a, b) => b.mean - a.mean)[0];
  const summary =
    data.length === 0
      ? 'No phase data with a baseline available.'
      : `Mean heart rate above baseline per phase, with standard deviation across sessions. ` +
        data.map((d) => `${PHASE_LABELS[d.phase]} ${fmtSigned(d.mean, 1)} bpm (SD ${fmtNumber(d.sd, 1)}, n ${d.n})`).join('; ') +
        (top ? `. Highest in ${PHASE_LABELS[top.phase].toLowerCase()}.` : '.');

  const table = (
    <table className="data-table data-table--compact">
      <caption className="visually-hidden">Mean heart rate above baseline by phase</caption>
      <thead>
        <tr>
          <th scope="col">Phase</th>
          <th scope="col" className="num">Mean Δ (bpm)</th>
          <th scope="col" className="num">SD</th>
          <th scope="col" className="num">Median</th>
          <th scope="col" className="num">Sessions</th>
        </tr>
      </thead>
      <tbody>
        {profile.map((p) => (
          <tr key={p.phase}>
            <th scope="row">{PHASE_LABELS[p.phase]}</th>
            <td className="num">{fmtSigned(p.mean, 1)}</td>
            <td className="num">{fmtNumber(p.sd, 1)}</td>
            <td className="num">{fmtSigned(p.median, 1)}</td>
            <td className="num">{p.n}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );

  return (
    <ChartFigure
      title={title}
      subtitle={subtitle ?? 'Mean ± SD of per-session phase means, in bpm above the resting baseline.'}
      summary={summary}
      height={260}
      table={table}
      testId={testId}
    >
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ top: 12, right: 12, bottom: 4, left: 0 }} accessibilityLayer={false}>
          <CartesianGrid stroke={colors.grid} vertical={false} />
          <XAxis dataKey="label" {...ax} interval={0} />
          <YAxis width={44} {...ax} label={{ value: 'bpm', angle: -90, position: 'insideLeft', fill: colors.textMuted, fontSize: 11 }} />
          <ReferenceLine y={0} stroke={colors.axis} />
          <Tooltip
            {...tt}
            cursor={{ fill: colors.grid, opacity: 0.5 }}
            formatter={(v, _n, item) => {
              const row = (item as { payload?: { sd: number; n: number } }).payload;
              return [`${fmtSigned(Number(v), 1)} bpm (SD ${fmtNumber(row?.sd, 1)}, n ${row?.n ?? 0})`, 'Mean Δ'];
            }}
          />
          <Bar dataKey="mean" radius={[4, 4, 0, 0]} maxBarSize={56} isAnimationActive={false}>
            {data.map((d) => (
              <Cell key={d.phase} fill={PHASE_COLORS[d.phase]} />
            ))}
            <ErrorBar dataKey="sd" width={8} strokeWidth={1.5} stroke={colors.text} direction="y" />
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </ChartFigure>
  );
}

// ---------------------------------------------------------------------------
// Simple single-series bars (counts, histograms)
// ---------------------------------------------------------------------------

export interface SimpleBarDatum {
  key: string;
  label: string;
  value: number;
}

export function SimpleBarChart({
  title,
  subtitle,
  data,
  valueLabel,
  unit = '',
  summary,
  height = 220,
  testId,
  decimals = 0,
}: {
  title: string;
  subtitle?: string;
  data: readonly SimpleBarDatum[];
  valueLabel: string;
  unit?: string;
  summary: string;
  height?: number;
  testId?: string;
  decimals?: number;
}) {
  const { colors } = useTheme();
  const tt = tooltipStyles(colors);
  const ax = axisProps(colors);
  const table = (
    <table className="data-table data-table--compact">
      <caption className="visually-hidden">{title}</caption>
      <thead>
        <tr>
          <th scope="col">Category</th>
          <th scope="col" className="num">
            {valueLabel}
          </th>
        </tr>
      </thead>
      <tbody>
        {data.map((d) => (
          <tr key={d.key}>
            <th scope="row">{d.label}</th>
            <td className="num">{fmtNumber(d.value, decimals)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
  return (
    <ChartFigure title={title} subtitle={subtitle} summary={summary} height={height} table={table} testId={testId}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={[...data]} margin={{ top: 12, right: 12, bottom: 4, left: 0 }} accessibilityLayer={false}>
          <CartesianGrid stroke={colors.grid} vertical={false} />
          <XAxis dataKey="label" {...ax} minTickGap={4} />
          <YAxis width={40} allowDecimals={decimals > 0} {...ax} />
          <Tooltip
            {...tt}
            cursor={{ fill: colors.grid, opacity: 0.5 }}
            formatter={(v) => [`${fmtNumber(Number(v), decimals)}${unit}`, valueLabel]}
          />
          <Bar dataKey="value" fill={colors.series} radius={[4, 4, 0, 0]} maxBarSize={48} isAnimationActive={false} />
        </BarChart>
      </ResponsiveContainer>
    </ChartFigure>
  );
}

// ---------------------------------------------------------------------------
// Grouped metric means with SD whiskers (Analysis page)
// ---------------------------------------------------------------------------

export interface GroupBarDatum {
  key: string;
  label: string;
  mean: number;
  sd: number;
  n: number;
}

export function GroupMeanChart({
  title,
  subtitle,
  data,
  unit,
  decimals,
  summary,
  table,
  testId,
}: {
  title: string;
  subtitle?: string;
  data: readonly GroupBarDatum[];
  unit: string;
  decimals: number;
  summary: string;
  table: ReactNode;
  testId?: string;
}) {
  const { colors } = useTheme();
  const tt = tooltipStyles(colors);
  const ax = axisProps(colors);
  // Horizontal bars when there are many groups or long names (e.g. procedures, "Consultant / attending").
  const longest = data.reduce((m, d) => Math.max(m, d.label.length), 0);
  const many = data.length > 6 || (data.length > 3 && longest > 16);
  const height = many ? Math.max(260, data.length * 30 + 60) : 300;
  const unitSuffix = unit === '' ? '' : unit.startsWith('/') ? unit : ` ${unit}`;
  return (
    <ChartFigure title={title} subtitle={subtitle} summary={summary} height={height} table={table} testId={testId}>
      <ResponsiveContainer width="100%" height="100%">
        {many ? (
          <BarChart data={[...data]} layout="vertical" margin={{ top: 4, right: 24, bottom: 4, left: 8 }} accessibilityLayer={false}>
            <CartesianGrid stroke={colors.grid} horizontal={false} />
            <XAxis type="number" {...ax} />
            <YAxis type="category" dataKey="label" width={180} {...ax} interval={0} tickFormatter={(v: string) => truncate(v, 26)} />
            <Tooltip
              {...tt}
              cursor={{ fill: colors.grid, opacity: 0.5 }}
              formatter={(v, _n, item) => {
                const row = (item as { payload?: GroupBarDatum }).payload;
                return [`${fmtNumber(Number(v), decimals)}${unitSuffix} ± ${fmtNumber(row?.sd, decimals)} (n ${row?.n ?? 0})`, 'Mean ± SD'];
              }}
            />
            <Bar dataKey="mean" fill={colors.series} radius={[0, 4, 4, 0]} maxBarSize={20} isAnimationActive={false}>
              <ErrorBar dataKey="sd" width={6} strokeWidth={1.5} stroke={colors.text} direction="x" />
            </Bar>
          </BarChart>
        ) : (
          <BarChart data={[...data]} margin={{ top: 12, right: 12, bottom: 4, left: 0 }} accessibilityLayer={false}>
            <CartesianGrid stroke={colors.grid} vertical={false} />
            <XAxis dataKey="label" {...ax} interval={0} tickFormatter={(v: string) => truncate(v, 18)} />
            <YAxis width={48} {...ax} />
            <Tooltip
              {...tt}
              cursor={{ fill: colors.grid, opacity: 0.5 }}
              formatter={(v, _n, item) => {
                const row = (item as { payload?: GroupBarDatum }).payload;
                return [`${fmtNumber(Number(v), decimals)}${unitSuffix} ± ${fmtNumber(row?.sd, decimals)} (n ${row?.n ?? 0})`, 'Mean ± SD'];
              }}
            />
            <Bar dataKey="mean" fill={colors.series} radius={[4, 4, 0, 0]} maxBarSize={64} isAnimationActive={false}>
              <ErrorBar dataKey="sd" width={8} strokeWidth={1.5} stroke={colors.text} direction="y" />
            </Bar>
          </BarChart>
        )}
      </ResponsiveContainer>
    </ChartFigure>
  );
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

// ---------------------------------------------------------------------------
// Participant vs cohort median, per phase
// ---------------------------------------------------------------------------

export interface PhaseComparisonDatum {
  phase: PhaseKind;
  you: number | null;
  cohort: number | null;
}

export function PhaseComparisonChart({ data, summary }: { data: readonly PhaseComparisonDatum[]; summary: string }) {
  const { colors } = useTheme();
  const tt = tooltipStyles(colors);
  const ax = axisProps(colors);
  const rows = data.map((d) => ({ ...d, label: SHORT_PHASE[d.phase] }));
  const legend: LegendItem[] = [
    { label: 'Your sessions (median)', color: colors.series },
    { label: 'Cohort median', color: colors.comparison },
  ];
  const table = (
    <table className="data-table data-table--compact">
      <caption className="visually-hidden">Your phase profile compared with the cohort median</caption>
      <thead>
        <tr>
          <th scope="col">Phase</th>
          <th scope="col" className="num">You (bpm above baseline)</th>
          <th scope="col" className="num">Cohort median</th>
        </tr>
      </thead>
      <tbody>
        {data.map((d) => (
          <tr key={d.phase}>
            <th scope="row">{PHASE_LABELS[d.phase]}</th>
            <td className="num">{fmtSigned(d.you, 1)}</td>
            <td className="num">{fmtSigned(d.cohort, 1)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
  return (
    <ChartFigure
      title="Phase profile"
      subtitle="Median heart rate above baseline in each phase: your sessions next to the anonymised cohort median."
      summary={summary}
      height={260}
      legend={legend}
      table={table}
      testId="phase-profile"
    >
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={rows} margin={{ top: 12, right: 12, bottom: 4, left: 0 }} barGap={2} accessibilityLayer={false}>
          <CartesianGrid stroke={colors.grid} vertical={false} />
          <XAxis dataKey="label" {...ax} interval={0} />
          <YAxis width={44} {...ax} label={{ value: 'bpm', angle: -90, position: 'insideLeft', fill: colors.textMuted, fontSize: 11 }} />
          <ReferenceLine y={0} stroke={colors.axis} />
          <Tooltip {...tt} cursor={{ fill: colors.grid, opacity: 0.5 }} formatter={(v) => `${fmtSigned(Number(v), 1)} bpm`} />
          <Bar dataKey="you" name="You" fill={colors.series} radius={[4, 4, 0, 0]} maxBarSize={36} isAnimationActive={false} />
          <Bar dataKey="cohort" name="Cohort median" fill={colors.comparison} radius={[4, 4, 0, 0]} maxBarSize={36} isAnimationActive={false} />
        </BarChart>
      </ResponsiveContainer>
    </ChartFigure>
  );
}
