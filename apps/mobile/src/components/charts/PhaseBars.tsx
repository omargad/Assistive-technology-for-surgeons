/**
 * Mean heart-rate change from baseline by operative phase (horizontal bars
 * around a zero line). Phases that occur several times are combined with a
 * duration-weighted mean. Without a baseline, absolute mean HR is shown.
 */
import { useMemo } from 'react';
import Svg, { G, Line, Rect } from 'react-native-svg';

import { PHASE_COLORS, PHASE_LABELS, PHASE_ORDER } from '@surgeonpulse/core';
import type { PhaseKind, PhaseSummary } from '@surgeonpulse/core';

import { formatDelta, useTheme } from '@/theme';

import { ChartFrame } from './ChartFrame';
import { ChartText } from './ChartText';
import { linearScale, niceDomain } from './scale';

export interface PhaseBarsProps {
  phases: readonly PhaseSummary[];
  title?: string;
  subtitle?: string;
  initialWidth?: number;
  testID?: string;
}

export interface PhaseBarDatum {
  phase: PhaseKind;
  value: number;
  durationSec: number;
}

/** Duration-weighted value per phase kind, in PHASE_ORDER. `mode` = delta vs baseline or absolute mean HR. */
export function phaseBarData(phases: readonly PhaseSummary[]): { mode: 'delta' | 'mean'; data: PhaseBarDatum[] } {
  const hasDelta = phases.some((p) => p.meanHrDelta != null);
  const mode: 'delta' | 'mean' = hasDelta ? 'delta' : 'mean';
  const data: PhaseBarDatum[] = [];
  for (const phase of PHASE_ORDER) {
    let wSum = 0;
    let vSum = 0;
    for (const p of phases) {
      if (p.phase !== phase) continue;
      const v = mode === 'delta' ? p.meanHrDelta : (p.hr?.mean ?? null);
      if (v == null || !Number.isFinite(v)) continue;
      const w = Math.max(p.durationSec, 1);
      wSum += w;
      vSum += v * w;
    }
    if (wSum > 0) data.push({ phase, value: vSum / wSum, durationSec: wSum });
  }
  return { mode, data };
}

export function describePhaseBars(phases: readonly PhaseSummary[]): string {
  const { mode, data } = phaseBarData(phases);
  if (data.length === 0) return 'Heart rate by phase: no phase data.';
  const unit = mode === 'delta' ? 'bpm above baseline' : 'bpm';
  const top = data.reduce((a, b) => (b.value > a.value ? b : a));
  const list = data.map((d) => `${PHASE_LABELS[d.phase]} ${mode === 'delta' ? formatDelta(d.value) : Math.round(d.value)}`).join(', ');
  return `Mean heart rate by phase (${unit}): ${list}. Highest during ${PHASE_LABELS[top.phase]}.`;
}

const LABEL_W = 108;
const VALUE_W = 44;
const ROW_H = 30;

export function PhaseBars({ phases, title, subtitle, initialWidth, testID }: PhaseBarsProps) {
  const theme = useTheme();
  const c = theme.colors;
  const { mode, data } = useMemo(() => phaseBarData(phases), [phases]);
  const height = Math.max(ROW_H, data.length * ROW_H) + 4;

  return (
    <ChartFrame
      title={title}
      subtitle={subtitle ?? (mode === 'delta' ? 'Mean change from resting baseline (bpm)' : 'Mean heart rate (bpm)')}
      summary={describePhaseBars(phases)}
      height={height}
      empty={data.length === 0}
      emptyMessage="Mark phases during the case to see heart rate by phase"
      initialWidth={initialWidth}
      testID={testID}
    >
      {(width) => {
        const plotX0 = LABEL_W;
        const plotX1 = Math.max(plotX0 + 20, width - VALUE_W);
        const vals = data.map((d) => d.value);
        const lo = mode === 'delta' ? Math.min(0, ...vals) : 0;
        const hi = Math.max(mode === 'delta' ? 0 : 1, ...vals);
        const domain = niceDomain(lo, hi, 3);
        const x = linearScale(domain.min, domain.max, plotX0, plotX1);
        const zeroX = x(Math.max(domain.min, 0));
        return (
          <Svg width={width} height={height}>
            {data.map((d, i) => {
              const yMid = i * ROW_H + ROW_H / 2 + 2;
              const xv = x(d.value);
              const x0 = Math.min(zeroX, xv);
              const w = Math.max(1.5, Math.abs(xv - zeroX));
              return (
                <G key={d.phase}>
                  <ChartText x={0} y={yMid + 4} fontSize={11} fill={c.text}>
                    {PHASE_LABELS[d.phase].length > 17 ? `${PHASE_LABELS[d.phase].slice(0, 16)}…` : PHASE_LABELS[d.phase]}
                  </ChartText>
                  <Rect x={x0} y={yMid - 8} width={w} height={16} rx={3} fill={PHASE_COLORS[d.phase]} />
                  <ChartText x={width - 2} y={yMid + 4} fontSize={11} fontWeight="600" fill={c.text} textAnchor="end">
                    {mode === 'delta' ? formatDelta(d.value) : String(Math.round(d.value))}
                  </ChartText>
                </G>
              );
            })}
            <Line x1={zeroX} x2={zeroX} y1={0} y2={height} stroke={c.chartAxis} strokeWidth={1} />
          </Svg>
        );
      }}
    </ChartFrame>
  );
}
