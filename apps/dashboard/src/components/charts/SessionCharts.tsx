/**
 * Charts for a single session: heart-rate timeline, rolling RMSSD and time
 * in zones. All series come from core (`resampleHr`, `rollingHrv`,
 * `derivePhases`, `defaultEpisodeThreshold`, summary zones).
 */
import { useMemo } from 'react';
import {
  Bar,
  BarChart,
  Brush,
  CartesianGrid,
  Cell,
  ComposedChart,
  Line,
  LineChart,
  ReferenceArea,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import {
  MARKER_ICONS,
  MARKER_LABELS,
  PHASE_COLORS,
  PHASE_LABELS,
  defaultEpisodeThreshold,
  derivePhases,
  formatDuration,
  phaseAt,
  resampleHr,
  rollingHrv,
} from '@surgeonpulse/core';
import type { MarkerEvent, MarkerKind, PhaseKind, PhaseSegment, SessionSummary, SurgicalSession } from '@surgeonpulse/core';
import { fmtElapsedTick, fmtNumber, minutesSince } from '../../lib/format';
import { useTheme } from '../../lib/useTheme';
import type { ChartColors } from '../../lib/chartColors';
import { ChartFigure } from './ChartFigure';
import { axisProps, tooltipStyles } from './chartStyle';
import type { LegendItem } from './ChartFigure';

/** Resampling interval for the HR timeline (SPEC: 5 s). */
const HR_INTERVAL_MS = 5000;

interface Band {
  phase: PhaseKind;
  x1: number;
  x2: number;
  showLabel: boolean;
}

function phaseBands(segments: readonly PhaseSegment[], start: number, totalMin: number): Band[] {
  return segments.map((seg) => {
    const x1 = minutesSince(seg.start, start);
    const x2 = minutesSince(seg.end, start);
    return { phase: seg.phase, x1, x2, showLabel: totalMin > 0 && (x2 - x1) / totalMin >= 0.09 };
  });
}

function bandElements(bands: readonly Band[], colors: ChartColors, withLabels: boolean) {
  return bands.map((b) => (
    <ReferenceArea
      key={`band-${b.phase}-${b.x1}`}
      x1={b.x1}
      x2={b.x2}
      ifOverflow="hidden"
      fill={PHASE_COLORS[b.phase]}
      fillOpacity={0.16}
      stroke="none"
      label={
        withLabels && b.showLabel
          ? { value: PHASE_LABELS[b.phase], position: 'insideTopLeft', fill: colors.textMuted, fontSize: 11 }
          : undefined
      }
    />
  ));
}

function phaseLegend(segments: readonly PhaseSegment[]): LegendItem[] {
  const seen = new Set<PhaseKind>();
  const items: LegendItem[] = [];
  for (const s of segments) {
    if (seen.has(s.phase)) continue;
    seen.add(s.phase);
    items.push({ label: PHASE_LABELS[s.phase], color: PHASE_COLORS[s.phase], shape: 'band' });
  }
  return items;
}

function yDomain(values: readonly number[]): [number, number] {
  const finite = values.filter((v) => Number.isFinite(v));
  if (finite.length === 0) return [40, 140];
  const lo = Math.min(...finite);
  const hi = Math.max(...finite);
  return [Math.floor((lo - 5) / 10) * 10, Math.ceil((hi + 5) / 10) * 10];
}

// ---------------------------------------------------------------------------
// Heart-rate timeline
// ---------------------------------------------------------------------------

export function HrTimelineChart({ session, summary }: { session: SurgicalSession; summary: SessionSummary }) {
  const { colors } = useTheme();
  const tt = tooltipStyles(colors);
  const ax = axisProps(colors);
  const start = session.startedAt;

  const model = useMemo(() => {
    const totalMin = minutesSince(summary.endedAt, start);
    const points = resampleHr(session.samples, HR_INTERVAL_MS, { start, end: summary.endedAt }).map((p) => ({
      min: minutesSince(p.t, start),
      bpm: p.bpm === null ? null : Math.round(p.bpm * 10) / 10,
    }));
    const segments = derivePhases(session);
    const markers = session.events.filter((e): e is MarkerEvent => e.type === 'marker');
    const threshold = defaultEpisodeThreshold(summary.baseline, summary.hr);
    const baseline = summary.baseline?.restingHr ?? null;
    const values = points.flatMap((p) => (p.bpm === null ? [] : [p.bpm]));
    if (baseline !== null) values.push(baseline);
    if (threshold !== null) values.push(threshold);
    const perMinute = resampleHr(session.samples, 60_000, { start, end: summary.endedAt });
    return {
      totalMin,
      points,
      segments,
      bands: phaseBands(segments, start, totalMin),
      markers,
      threshold,
      baseline,
      domain: yDomain(values),
      perMinute,
    };
  }, [session, summary, start]);

  const markerKinds = [...new Set(model.markers.map((m) => m.marker))] as MarkerKind[];
  const legend: LegendItem[] = [
    { label: 'Heart rate (5 s mean)', color: colors.series, shape: 'line' },
    ...(model.baseline !== null ? [{ label: `Baseline ${fmtNumber(model.baseline)} bpm`, color: colors.baseline, shape: 'dashed' as const }] : []),
    ...(model.threshold !== null
      ? [{ label: `Episode threshold ${fmtNumber(model.threshold)} bpm`, color: colors.threshold, shape: 'dashed' as const }]
      : []),
    ...phaseLegend(model.segments),
    ...markerKinds.map((k) => ({ label: MARKER_LABELS[k], color: colors.marker, glyph: MARKER_ICONS[k] })),
  ];

  const peakPhase = summary.episodes[0]?.phase;
  const summaryText =
    `Heart rate over ${formatDuration(summary.durationSec)}. Mean ${fmtNumber(summary.hr?.mean)} bpm, ` +
    `peak ${fmtNumber(summary.hr?.max)} bpm` +
    (model.baseline !== null ? `, baseline ${fmtNumber(model.baseline)} bpm` : '') +
    `. ${summary.episodes.length} stress episode${summary.episodes.length === 1 ? '' : 's'}` +
    (peakPhase ? `, the first during ${PHASE_LABELS[peakPhase].toLowerCase()}` : '') +
    `. Phases: ${model.segments.map((s) => `${PHASE_LABELS[s.phase]} ${formatDuration((s.end - s.start) / 1000)}`).join(', ') || 'none marked'}. ` +
    `${model.markers.length} marker${model.markers.length === 1 ? '' : 's'} logged.`;

  const table = (
    <div className="table-wrap table-wrap--scroll" tabIndex={0} role="region" aria-label="Heart rate per minute">
      <table className="data-table data-table--compact">
        <caption className="visually-hidden">Heart rate per minute with operative phase</caption>
        <thead>
          <tr>
            <th scope="col">Minute</th>
            <th scope="col" className="num">
              Mean HR (bpm)
            </th>
            <th scope="col">Phase</th>
          </tr>
        </thead>
        <tbody>
          {model.perMinute.map((p) => {
            const phase = phaseAt(model.segments, p.t);
            return (
              <tr key={p.t}>
                <th scope="row">{fmtElapsedTick(minutesSince(p.t, start))}</th>
                <td className="num">{fmtNumber(p.bpm)}</td>
                <td>{phase ? PHASE_LABELS[phase] : '—'}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {model.markers.length > 0 && (
        <table className="data-table data-table--compact">
          <caption>Markers</caption>
          <thead>
            <tr>
              <th scope="col">Time</th>
              <th scope="col">Marker</th>
            </tr>
          </thead>
          <tbody>
            {model.markers.map((m) => (
              <tr key={m.id}>
                <th scope="row">{fmtElapsedTick(minutesSince(m.t, start))}</th>
                <td>{MARKER_LABELS[m.marker]}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );

  return (
    <ChartFigure
      title="Heart-rate timeline"
      subtitle="Minutes from start. Shaded bands are operative phases; vertical lines are logged markers. Drag the handles below the chart to zoom."
      summary={summaryText}
      height={360}
      legend={legend}
      table={table}
      testId="hr-timeline"
    >
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={model.points} margin={{ top: 22, right: 16, bottom: 4, left: 0 }} accessibilityLayer={false}>
          <CartesianGrid stroke={colors.grid} vertical={false} />
          {bandElements(model.bands, colors, true)}
          <XAxis
            dataKey="min"
            type="number"
            domain={['dataMin', 'dataMax']}
            tickFormatter={fmtElapsedTick}
            {...ax}
          />
          <YAxis domain={model.domain} width={44} {...ax} label={{ value: 'bpm', angle: -90, position: 'insideLeft', fill: colors.textMuted, fontSize: 11 }} />
          {model.baseline !== null && (
            <ReferenceLine y={model.baseline} stroke={colors.baseline} strokeDasharray="6 4" ifOverflow="extendDomain" />
          )}
          {model.threshold !== null && (
            <ReferenceLine y={model.threshold} stroke={colors.threshold} strokeDasharray="3 3" ifOverflow="extendDomain" />
          )}
          {model.markers.map((m) => (
            <ReferenceLine
              key={m.id}
              x={minutesSince(m.t, start)}
              stroke={colors.marker}
              strokeDasharray="2 3"
              ifOverflow="hidden"
              label={{ value: MARKER_ICONS[m.marker], position: 'top', fill: colors.text, fontSize: 12, fontWeight: 700 }}
            />
          ))}
          <Tooltip
            {...tt}
            labelFormatter={(v) => `${fmtElapsedTick(Number(v))} min`}
            formatter={(v) => [`${fmtNumber(Number(v), 0)} bpm`, 'Heart rate']}
          />
          <Line
            type="linear"
            dataKey="bpm"
            stroke={colors.series}
            strokeWidth={1.75}
            dot={false}
            activeDot={{ r: 4 }}
            connectNulls={false}
            isAnimationActive={false}
          />
          <Brush
            dataKey="min"
            height={26}
            travellerWidth={12}
            stroke={colors.series}
            fill={colors.surface}
            tickFormatter={fmtElapsedTick}
          />
        </ComposedChart>
      </ResponsiveContainer>
    </ChartFigure>
  );
}

// ---------------------------------------------------------------------------
// Rolling RMSSD
// ---------------------------------------------------------------------------

export function RollingHrvChart({ session, summary }: { session: SurgicalSession; summary: SessionSummary }) {
  const { colors } = useTheme();
  const tt = tooltipStyles(colors);
  const ax = axisProps(colors);
  const start = session.startedAt;

  const model = useMemo(() => {
    const totalMin = minutesSince(summary.endedAt, start);
    const points = rollingHrv(session.rr).map((p) => ({
      min: minutesSince(p.t, start),
      rmssd: p.rmssd === null ? null : Math.round(p.rmssd * 10) / 10,
    }));
    const segments = derivePhases(session);
    return { points, segments, bands: phaseBands(segments, start, totalMin), totalMin };
  }, [session, summary, start]);

  const valid = model.points.filter((p) => p.rmssd !== null);
  const baselineRmssd = summary.baseline?.rmssd ?? null;
  const summaryText =
    valid.length === 0
      ? 'Not enough clean RR data for rolling RMSSD.'
      : `Rolling RMSSD (60-second windows every 30 seconds): ${valid.length} windows, ranging ` +
        `${fmtNumber(Math.min(...valid.map((p) => p.rmssd!)), 1)} to ${fmtNumber(Math.max(...valid.map((p) => p.rmssd!)), 1)} ms` +
        (baselineRmssd !== null ? `; resting baseline ${fmtNumber(baselineRmssd, 1)} ms.` : '.');

  const legend: LegendItem[] = [
    { label: 'RMSSD (60 s window)', color: colors.series, shape: 'line' },
    ...(baselineRmssd !== null
      ? [{ label: `Baseline ${fmtNumber(baselineRmssd, 1)} ms`, color: colors.baseline, shape: 'dashed' as const }]
      : []),
    ...phaseLegend(model.segments),
  ];

  const table = (
    <div className="table-wrap table-wrap--scroll" tabIndex={0} role="region" aria-label="Rolling RMSSD">
      <table className="data-table data-table--compact">
        <caption className="visually-hidden">Rolling RMSSD by window end</caption>
        <thead>
          <tr>
            <th scope="col">Window end (min)</th>
            <th scope="col" className="num">
              RMSSD (ms)
            </th>
          </tr>
        </thead>
        <tbody>
          {model.points.map((p) => (
            <tr key={p.min}>
              <th scope="row">{fmtElapsedTick(p.min)}</th>
              <td className="num">{fmtNumber(p.rmssd, 1)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );

  return (
    <ChartFigure
      title="Rolling RMSSD"
      subtitle="Short-term heart-rate variability; lower values usually accompany higher arousal."
      summary={summaryText}
      height={240}
      legend={legend}
      table={table}
      testId="rolling-hrv"
    >
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={model.points} margin={{ top: 10, right: 16, bottom: 4, left: 0 }} accessibilityLayer={false}>
          <CartesianGrid stroke={colors.grid} vertical={false} />
          {bandElements(model.bands, colors, false)}
          <XAxis
            dataKey="min"
            type="number"
            domain={[0, Math.max(1, Math.ceil(model.totalMin))]}
            tickFormatter={fmtElapsedTick}
            {...ax}
          />
          <YAxis width={44} {...ax} label={{ value: 'ms', angle: -90, position: 'insideLeft', fill: colors.textMuted, fontSize: 11 }} />
          {baselineRmssd !== null && (
            <ReferenceLine y={baselineRmssd} stroke={colors.baseline} strokeDasharray="6 4" ifOverflow="extendDomain" />
          )}
          <Tooltip
            {...tt}
            labelFormatter={(v) => `${fmtElapsedTick(Number(v))} min`}
            formatter={(v) => [`${fmtNumber(Number(v), 1)} ms`, 'RMSSD']}
          />
          <Line
            type="linear"
            dataKey="rmssd"
            stroke={colors.series}
            strokeWidth={1.75}
            dot={false}
            connectNulls={false}
            isAnimationActive={false}
          />
        </LineChart>
      </ResponsiveContainer>
    </ChartFigure>
  );
}

// ---------------------------------------------------------------------------
// Time in zones
// ---------------------------------------------------------------------------

export function ZonesChart({ summary }: { summary: SessionSummary }) {
  const { colors } = useTheme();
  const tt = tooltipStyles(colors);
  const ax = axisProps(colors);
  const data = summary.zones.map((z) => ({
    id: z.id,
    label: z.label,
    minutes: Math.round((z.seconds / 60) * 10) / 10,
    pct: z.fraction * 100,
  }));
  const ramp = colors.ordinal;
  const colorFor = (i: number): string => {
    if (data.length <= 1) return ramp[3] ?? colors.series;
    const idx = Math.round(1 + (i / (data.length - 1)) * (ramp.length - 2));
    return ramp[idx] ?? colors.series;
  };
  const basis = summary.baseline ? 'relative to the resting baseline' : 'as a share of maximum heart rate';
  const summaryText =
    data.length === 0
      ? 'Zones unavailable: no baseline or maximum heart rate.'
      : `Time in heart-rate zones ${basis}: ` +
        data.map((d) => `${d.label} ${fmtNumber(d.minutes, 1)} min (${fmtNumber(d.pct)} %)`).join(', ') +
        '.';

  const table = (
    <table className="data-table data-table--compact">
      <caption className="visually-hidden">Time in heart-rate zones</caption>
      <thead>
        <tr>
          <th scope="col">Zone</th>
          <th scope="col" className="num">
            Minutes
          </th>
          <th scope="col" className="num">
            Share
          </th>
        </tr>
      </thead>
      <tbody>
        {data.map((d) => (
          <tr key={d.id}>
            <th scope="row">{d.label}</th>
            <td className="num">{fmtNumber(d.minutes, 1)}</td>
            <td className="num">{fmtNumber(d.pct)} %</td>
          </tr>
        ))}
      </tbody>
    </table>
  );

  return (
    <ChartFigure
      title="Time in zones"
      subtitle={`Zones ${basis}.`}
      summary={summaryText}
      height={Math.max(140, data.length * 40 + 40)}
      table={table}
      testId="zones-chart"
    >
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} layout="vertical" margin={{ top: 4, right: 24, bottom: 4, left: 8 }} accessibilityLayer={false}>
          <CartesianGrid stroke={colors.grid} horizontal={false} />
          <XAxis type="number" {...ax} tickFormatter={(v: number) => `${v}`} unit=" min" />
          <YAxis type="category" dataKey="label" width={92} {...ax} />
          <Tooltip {...tt} cursor={{ fill: colors.grid, opacity: 0.5 }} formatter={(v) => [`${fmtNumber(Number(v), 1)} min`, 'Time']} />
          <Bar dataKey="minutes" radius={[0, 4, 4, 0]} maxBarSize={22} isAnimationActive={false}>
            {data.map((d, i) => (
              <Cell key={d.id} fill={colorFor(i)} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </ChartFigure>
  );
}
