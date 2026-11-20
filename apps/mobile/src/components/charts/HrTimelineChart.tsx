/**
 * Heart-rate timeline for a session: HR line (resampled with core
 * `resampleHr`; empty buckets break the line), translucent phase bands with
 * labels, marker ticks with glyphs, a dashed resting-baseline line, an
 * episode-threshold line, elapsed-time and bpm axes, and a touch/drag
 * crosshair with a time · bpm · phase readout.
 */
import { useMemo, useState } from 'react';
import { StyleSheet, View, type GestureResponderEvent } from 'react-native';
import Svg, { Circle, G, Line, Path, Rect } from 'react-native-svg';

import {
  MARKER_ICONS,
  MARKER_LABELS,
  PHASE_COLORS,
  PHASE_LABELS,
  hrStats,
  phaseAt,
  resampleHr,
} from '@surgeonpulse/core';
import type { HeartRateSample, MarkerEvent, PhaseKind, PhaseSegment, SessionEvent } from '@surgeonpulse/core';

import { formatAxisTime, formatElapsed, noTextSelect, useStyles, useTheme, withAlpha, type Theme } from '@/theme';

import { AppText } from '../AppText';
import { ChartFrame } from './ChartFrame';
import { AxisUnitLabel, ChartText } from './ChartText';
import { clamp, isolatedPoints, linePath, linearScale, niceDomain, tickSpacingPx, timeTicks, topTickPx } from './scale';

export interface HrTimelineChartProps {
  samples: readonly HeartRateSample[];
  startedAt: number;
  endedAt?: number;
  phases?: readonly PhaseSegment[];
  events?: readonly SessionEvent[];
  baselineBpm?: number | null;
  thresholdBpm?: number | null;
  height?: number;
  title?: string;
  subtitle?: string;
  /** Touch/drag crosshair (default true). */
  interactive?: boolean;
  /** Emphasise one event (e.g. selected in the event editor). */
  highlightEventId?: string | null;
  /** Show the phase legend under the chart (default true). */
  showLegend?: boolean;
  initialWidth?: number;
  testID?: string;
}

const PAD_LEFT = 40;
const PAD_RIGHT = 12;
const PAD_BOTTOM = 24;
const LABEL_ROW = 16;
const MARKER_ROW = 22;

function round(x: number): number {
  return Math.round(x);
}

/** Accessible one-sentence summary of a session's heart rate. */
export function describeHrTimeline(
  samples: readonly HeartRateSample[],
  phases: readonly PhaseSegment[] = [],
  baselineBpm?: number | null,
  markerCount = 0,
): string {
  const stats = hrStats(samples);
  if (!stats) return 'Heart-rate chart: no heart-rate data recorded.';
  let peak: HeartRateSample | undefined;
  for (const s of samples) {
    if (!Number.isFinite(s.bpm) || s.bpm < 25 || s.bpm > 250) continue;
    if (!peak || s.bpm > peak.bpm) peak = s;
  }
  const parts = [`Heart rate from ${round(stats.min)} to ${round(stats.max)} bpm, average ${round(stats.mean)}`];
  const phase = peak ? phaseAt(phases, peak.t) : undefined;
  if (phase) parts.push(`highest during ${PHASE_LABELS[phase]}`);
  if (typeof baselineBpm === 'number') parts.push(`resting baseline ${round(baselineBpm)} bpm`);
  if (markerCount > 0) parts.push(`${markerCount} event${markerCount === 1 ? '' : 's'} marked`);
  return `${parts.join('; ')}.`;
}

export function HrTimelineChart({
  samples,
  startedAt,
  endedAt,
  phases = [],
  events = [],
  baselineBpm,
  thresholdBpm,
  height = 220,
  title,
  subtitle,
  interactive = true,
  highlightEventId,
  showLegend = true,
  initialWidth,
  testID,
}: HrTimelineChartProps) {
  const theme = useTheme();
  const styles = useStyles(makeStyles);
  const [cursorT, setCursorT] = useState<number | null>(null);

  const markers = useMemo(
    () => events.filter((e): e is MarkerEvent => e.type === 'marker'),
    [events],
  );

  const start = startedAt;
  const end = useMemo(() => {
    if (typeof endedAt === 'number' && endedAt > startedAt) return endedAt;
    const lastSample = samples.length ? (samples[samples.length - 1]?.t ?? startedAt) : startedAt;
    const lastEvent = events.length ? (events[events.length - 1]?.t ?? startedAt) : startedAt;
    return Math.max(lastSample, lastEvent, startedAt + 60_000);
  }, [endedAt, startedAt, samples, events]);
  const duration = Math.max(1000, end - start);

  const summary = useMemo(
    () => describeHrTimeline(samples, phases, baselineBpm, markers.length),
    [samples, phases, baselineBpm, markers.length],
  );

  const phasesPresent = useMemo(() => {
    const seen: PhaseKind[] = [];
    for (const p of phases) if (!seen.includes(p.phase)) seen.push(p.phase);
    return seen;
  }, [phases]);

  const hasData = samples.length > 0;
  const top = (phases.length ? LABEL_ROW : 4) + (markers.length ? MARKER_ROW : 0) + 6;

  const cursor = useMemo(() => {
    if (cursorT == null) return null;
    const near = nearestSample(samples, cursorT, 5000);
    return { t: cursorT, bpm: near ? near.bpm : null, phase: phaseAt(phases, cursorT) };
  }, [cursorT, samples, phases]);

  const readout = interactive ? (
    <View style={styles.readout}>
      {cursor ? (
        <>
          <AppText variant="label" tabular style={styles.readoutText}>
            {formatElapsed(cursor.t - start, true)} · {cursor.bpm == null ? 'no data' : `${Math.round(cursor.bpm)} bpm`}
            {cursor.phase ? ` · ${PHASE_LABELS[cursor.phase]}` : ''}
          </AppText>
          <AppText variant="label" tone="primary" onPress={() => setCursorT(null)} accessibilityRole="button">
            Clear
          </AppText>
        </>
      ) : (
        <AppText variant="caption" tone="faint">
          Touch and drag on the chart to read values
        </AppText>
      )}
    </View>
  ) : null;

  return (
    <ChartFrame
      title={title}
      subtitle={subtitle}
      summary={summary}
      height={height}
      empty={!hasData}
      emptyMessage="No heart-rate data recorded"
      initialWidth={initialWidth}
      testID={testID}
      toolbar={readout}
      footer={
        showLegend && phasesPresent.length ? (
          <View style={styles.legend} aria-hidden>
            {phasesPresent.map((p) => (
              <View key={p} style={styles.legendItem}>
                <View style={[styles.swatch, { backgroundColor: withAlpha(PHASE_COLORS[p], 0.55), borderColor: PHASE_COLORS[p] }]} />
                <AppText variant="caption" tone="muted">
                  {PHASE_LABELS[p]}
                </AppText>
              </View>
            ))}
            {typeof baselineBpm === 'number' ? (
              <View style={styles.legendItem}>
                <View style={[styles.lineSwatch, { borderColor: theme.colors.chartBaseline }]} />
                <AppText variant="caption" tone="muted">
                  Baseline
                </AppText>
              </View>
            ) : null}
            {typeof thresholdBpm === 'number' ? (
              <View style={styles.legendItem}>
                <View style={[styles.lineSwatch, { borderColor: theme.colors.chartThreshold }]} />
                <AppText variant="caption" tone="muted">
                  Episode threshold
                </AppText>
              </View>
            ) : null}
          </View>
        ) : null
      }
    >
      {(width) => (
        <Plot
          width={width}
          height={height}
          top={top}
          start={start}
          end={end}
          duration={duration}
          samples={samples}
          phases={phases}
          markers={markers}
          baselineBpm={baselineBpm}
          thresholdBpm={thresholdBpm}
          interactive={interactive}
          highlightEventId={highlightEventId}
          cursor={cursor}
          onCursor={setCursorT}
          theme={theme}
        />
      )}
    </ChartFrame>
  );
}

interface PlotProps {
  width: number;
  height: number;
  top: number;
  start: number;
  end: number;
  duration: number;
  samples: readonly HeartRateSample[];
  phases: readonly PhaseSegment[];
  markers: readonly MarkerEvent[];
  baselineBpm?: number | null;
  thresholdBpm?: number | null;
  interactive: boolean;
  highlightEventId?: string | null;
  cursor: { t: number; bpm: number | null } | null;
  onCursor: (t: number | null) => void;
  theme: Theme;
}

function Plot({
  width,
  height,
  top,
  start,
  end,
  duration,
  samples,
  phases,
  markers,
  baselineBpm,
  thresholdBpm,
  interactive,
  highlightEventId,
  cursor,
  onCursor,
  theme,
}: PlotProps) {
  const c = theme.colors;
  const plotW = Math.max(10, width - PAD_LEFT - PAD_RIGHT);
  const plotH = Math.max(10, height - top - PAD_BOTTOM);
  const bottom = top + plotH;

  const bucketMs = useMemo(() => {
    const maxPoints = clamp(Math.floor(plotW / 2), 30, 400);
    return Math.max(1000, Math.ceil(duration / maxPoints / 1000) * 1000);
  }, [plotW, duration]);

  const series = useMemo(() => resampleHr(samples, bucketMs, { start, end }), [samples, bucketMs, start, end]);

  const domain = useMemo(() => {
    let lo = Infinity;
    let hi = -Infinity;
    for (const b of series) {
      if (b.bpm == null) continue;
      lo = Math.min(lo, b.bpm);
      hi = Math.max(hi, b.bpm);
    }
    for (const ref of [baselineBpm, thresholdBpm]) {
      if (typeof ref === 'number' && Number.isFinite(ref)) {
        lo = Math.min(lo, ref);
        hi = Math.max(hi, ref);
      }
    }
    if (!Number.isFinite(lo)) {
      lo = 60;
      hi = 100;
    }
    return niceDomain(lo - 4, hi + 4, 4);
  }, [series, baselineBpm, thresholdBpm]);

  const x = linearScale(start, end, PAD_LEFT, PAD_LEFT + plotW);
  const y = linearScale(domain.min, domain.max, bottom, top);

  const points = series.map((b) => ({ x: x(Math.min(end, b.t + bucketMs / 2)), y: b.bpm == null ? null : y(b.bpm) }));
  const path = linePath(points);
  const dots = isolatedPoints(points);
  const ticks = timeTicks(duration, Math.max(2, Math.floor(plotW / 70)));

  const bandOpacity = theme.isDark ? 0.24 : 0.16;

  const handleTouch = (e: GestureResponderEvent) => {
    const lx = e.nativeEvent.locationX;
    const t = start + ((clamp(lx, PAD_LEFT, PAD_LEFT + plotW) - PAD_LEFT) / plotW) * (end - start);
    onCursor(t);
  };

  const labelY = 12;
  const markerY = (phases.length ? LABEL_ROW : 4) + MARKER_ROW / 2;

  return (
    <View>
      <View
        style={[{ width, height }, noTextSelect]}
        onStartShouldSetResponder={() => interactive}
        onMoveShouldSetResponder={() => interactive}
        onResponderGrant={handleTouch}
        onResponderMove={handleTouch}
        onResponderTerminationRequest={() => true}
        testID="hr-timeline-touch"
      >
        <View pointerEvents="none">
          <Svg width={width} height={height}>
            {/* Phase bands + labels */}
            {phases.map((seg) => {
              const x0 = x(clamp(seg.start, start, end));
              const x1 = x(clamp(seg.end, start, end));
              const w = Math.max(0, x1 - x0);
              const color = PHASE_COLORS[seg.phase];
              return (
                <G key={`${seg.phase}-${seg.index}`}>
                  <Rect x={x0} y={top} width={w} height={plotH} fill={color} fillOpacity={bandOpacity} />
                  <Rect x={x0} y={top} width={Math.min(w, 3)} height={plotH} fill={color} fillOpacity={0.7} />
                  {w >= 48 ? (
                    <ChartText x={x0 + 4} y={labelY} fontSize={10} fontWeight="600" fill={c.textMuted}>
                      {truncate(PHASE_LABELS[seg.phase], Math.floor((w - 6) / 6))}
                    </ChartText>
                  ) : null}
                </G>
              );
            })}

            {/* Horizontal grid + bpm axis */}
            {domain.ticks.map((v) => (
              <G key={`y-${v}`}>
                <Line x1={PAD_LEFT} x2={PAD_LEFT + plotW} y1={y(v)} y2={y(v)} stroke={c.chartGrid} strokeWidth={1} />
                <ChartText x={PAD_LEFT - 6} y={y(v) + 4} fontSize={10} fill={c.chartAxis} textAnchor="end">
                  {String(Math.round(v))}
                </ChartText>
              </G>
            ))}
            <AxisUnitLabel
              unit="bpm"
              axisRight={PAD_LEFT - 6}
              topTickY={topTickPx(domain.ticks, y, top)}
              tickSpacing={tickSpacingPx(domain.ticks, y)}
              fill={c.chartAxis}
            />

            {/* Reference lines */}
            {typeof baselineBpm === 'number' ? (
              <G>
                <Line
                  x1={PAD_LEFT}
                  x2={PAD_LEFT + plotW}
                  y1={y(baselineBpm)}
                  y2={y(baselineBpm)}
                  stroke={c.chartBaseline}
                  strokeWidth={1.25}
                  strokeDasharray="6 4"
                />
                <ChartText x={PAD_LEFT + plotW - 2} y={y(baselineBpm) - 4} fontSize={9} fill={c.chartBaseline} textAnchor="end">
                  {`Baseline ${Math.round(baselineBpm)}`}
                </ChartText>
              </G>
            ) : null}
            {typeof thresholdBpm === 'number' ? (
              <G>
                <Line
                  x1={PAD_LEFT}
                  x2={PAD_LEFT + plotW}
                  y1={y(thresholdBpm)}
                  y2={y(thresholdBpm)}
                  stroke={c.chartThreshold}
                  strokeWidth={1.25}
                  strokeDasharray="2 4"
                />
                <ChartText x={PAD_LEFT + 4} y={y(thresholdBpm) - 4} fontSize={9} fill={c.chartThreshold}>
                  {`Threshold ${Math.round(thresholdBpm)}`}
                </ChartText>
              </G>
            ) : null}

            {/* Heart-rate line */}
            <Path d={path} stroke={c.chartLine} strokeWidth={2} fill="none" strokeLinejoin="round" strokeLinecap="round" />
            {dots.map((p) => (
              <Circle key={`dot-${p.x}`} cx={p.x} cy={p.y} r={1.8} fill={c.chartLine} />
            ))}

            {/* Marker ticks with glyphs */}
            {markers.map((m) => {
              const mx = x(clamp(m.t, start, end));
              const hl = m.id === highlightEventId;
              return (
                <G key={m.id}>
                  <Line
                    x1={mx}
                    x2={mx}
                    y1={markerY + 9}
                    y2={bottom}
                    stroke={hl ? c.primary : c.textFaint}
                    strokeWidth={hl ? 2 : 1}
                    strokeDasharray={hl ? undefined : '2 3'}
                  />
                  <Circle cx={mx} cy={markerY} r={hl ? 9 : 8} fill={hl ? c.primary : c.surface} stroke={hl ? c.primary : c.text} strokeWidth={1} />
                  <ChartText
                    x={mx}
                    y={markerY + 3.5}
                    fontSize={9}
                    fontWeight="700"
                    fill={hl ? c.onPrimary : c.text}
                    textAnchor="middle"
                  >
                    {MARKER_ICONS[m.marker]}
                  </ChartText>
                </G>
              );
            })}

            {/* Time axis */}
            <Line x1={PAD_LEFT} x2={PAD_LEFT + plotW} y1={bottom} y2={bottom} stroke={c.chartAxis} strokeWidth={1} />
            {ticks.map((tk) => {
              const tx = x(start + tk);
              if (tx > PAD_LEFT + plotW + 0.5) return null;
              return (
                <G key={`x-${tk}`}>
                  <Line x1={tx} x2={tx} y1={bottom} y2={bottom + 4} stroke={c.chartAxis} strokeWidth={1} />
                  <ChartText x={tx} y={height - 6} fontSize={10} fill={c.chartAxis} textAnchor="middle">
                    {formatAxisTime(tk, duration)}
                  </ChartText>
                </G>
              );
            })}

            {/* Crosshair */}
            {cursor ? (
              <G>
                <Line x1={x(cursor.t)} x2={x(cursor.t)} y1={top} y2={bottom} stroke={c.text} strokeWidth={1} strokeOpacity={0.6} />
                {cursor.bpm != null ? (
                  <Circle cx={x(cursor.t)} cy={y(cursor.bpm)} r={4.5} fill={c.chartLine} stroke={c.surface} strokeWidth={2} />
                ) : null}
              </G>
            ) : null}
          </Svg>
        </View>
      </View>
      {markers.length ? (
        <AppText variant="caption" tone="faint" style={plotStyles.markerKey} aria-hidden>
          {uniqueMarkerKey(markers)}
        </AppText>
      ) : null}
    </View>
  );
}

function truncate(s: string, max: number): string {
  if (max <= 1) return '';
  return s.length <= max ? s : `${s.slice(0, Math.max(1, max - 1))}…`;
}

function uniqueMarkerKey(markers: readonly MarkerEvent[]): string {
  const kinds = [...new Set(markers.map((m) => m.marker))];
  return kinds.map((k) => `${MARKER_ICONS[k]} ${MARKER_LABELS[k]}`).join('   ');
}

const plotStyles = StyleSheet.create({
  markerKey: { marginTop: 4 },
});

/** Sample nearest to `t` within `maxDistMs` (binary search; samples are sorted by t). */
function nearestSample(samples: readonly HeartRateSample[], t: number, maxDistMs: number): HeartRateSample | null {
  let lo = 0;
  let hi = samples.length - 1;
  if (hi < 0) return null;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((samples[mid]?.t ?? 0) < t) lo = mid + 1;
    else hi = mid;
  }
  const candidates = [samples[lo - 1], samples[lo]].filter((s): s is HeartRateSample => !!s);
  let best: HeartRateSample | null = null;
  for (const s of candidates) {
    if (Math.abs(s.t - t) <= maxDistMs && (!best || Math.abs(s.t - t) < Math.abs(best.t - t))) best = s;
  }
  return best;
}

const makeStyles = (t: Theme) =>
  StyleSheet.create({
    readout: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: t.space.sm, minHeight: 22 },
    readoutText: { flex: 1 },
    legend: { flexDirection: 'row', flexWrap: 'wrap', columnGap: t.space.md, rowGap: t.space.xs },
    legendItem: { flexDirection: 'row', alignItems: 'center', gap: t.space.xs },
    swatch: { width: 12, height: 12, borderRadius: 3, borderWidth: 1 },
    lineSwatch: { width: 16, height: 0, borderTopWidth: 2, borderStyle: 'dashed' },
  });
