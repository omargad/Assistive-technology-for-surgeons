/**
 * Group comparison (e.g. by procedure): horizontal bars of the group mean with
 * mean ± SD whiskers and the group size. Input is core `aggregateMetric(...)`.
 */
import Svg, { G, Line, Rect } from 'react-native-svg';

import { useTheme } from '@/theme';

import { ChartFrame } from './ChartFrame';
import { ChartText } from './ChartText';
import { linearScale, niceDomain } from './scale';

export interface GroupStat {
  group: string;
  n: number;
  mean: number;
  sd: number;
}

export interface GroupBarChartProps {
  groups: readonly GroupStat[];
  label: string;
  unit: string;
  decimals?: number;
  title?: string;
  subtitle?: string;
  initialWidth?: number;
  testID?: string;
}

const ROW_H = 40;
const LABEL_H = 14;

export function describeGroups(groups: readonly GroupStat[], label: string, unit: string, decimals = 0): string {
  if (groups.length === 0) return `${label} by group: no data.`;
  const list = groups
    .map((g) => `${g.group}: mean ${g.mean.toFixed(decimals)} ${unit}, SD ${g.sd.toFixed(decimals)}, ${g.n} session${g.n === 1 ? '' : 's'}`)
    .join('; ');
  return `${label} by group. ${list}.`;
}

export function GroupBarChart({ groups, label, unit, decimals = 0, title, subtitle, initialWidth, testID }: GroupBarChartProps) {
  const theme = useTheme();
  const c = theme.colors;
  const height = Math.max(1, groups.length) * ROW_H + 18;

  return (
    <ChartFrame
      title={title}
      subtitle={subtitle}
      summary={describeGroups(groups, label, unit, decimals)}
      height={height}
      empty={groups.length === 0}
      emptyMessage="Not enough sessions to compare groups"
      initialWidth={initialWidth}
      testID={testID}
    >
      {(width) => {
        const lows = groups.map((g) => g.mean - g.sd);
        const highs = groups.map((g) => g.mean + g.sd);
        const domain = niceDomain(Math.min(0, ...lows), Math.max(0, ...highs), 4);
        const x0 = 4;
        const x1 = width - 56;
        const x = linearScale(domain.min, domain.max, x0, x1);
        const zero = x(Math.max(domain.min, Math.min(0, domain.max)));
        const axisY = height - 14;
        return (
          <Svg width={width} height={height}>
            {domain.ticks.map((v) => (
              <G key={`t-${v}`}>
                <Line x1={x(v)} x2={x(v)} y1={0} y2={axisY} stroke={c.chartGrid} strokeWidth={1} />
                <ChartText x={x(v)} y={height - 2} fontSize={9} fill={c.chartAxis} textAnchor="middle">
                  {String(Number(v.toFixed(2)))}
                </ChartText>
              </G>
            ))}
            {groups.map((g, i) => {
              const top = i * ROW_H;
              const barY = top + LABEL_H + 3;
              const xm = x(g.mean);
              const left = Math.min(zero, xm);
              const lo = x(g.mean - g.sd);
              const hi = x(g.mean + g.sd);
              const mid = barY + 8;
              return (
                <G key={g.group}>
                  <ChartText x={x0} y={top + 11} fontSize={11} fill={c.text}>
                    {g.group.length > 40 ? `${g.group.slice(0, 39)}…` : g.group}
                  </ChartText>
                  <Rect x={left} y={barY} width={Math.max(1.5, Math.abs(xm - zero))} height={16} rx={3} fill={c.chartSecondary} fillOpacity={0.75} />
                  {g.n > 1 && g.sd > 0 ? (
                    <G>
                      <Line x1={lo} x2={hi} y1={mid} y2={mid} stroke={c.text} strokeWidth={1.5} />
                      <Line x1={lo} x2={lo} y1={mid - 5} y2={mid + 5} stroke={c.text} strokeWidth={1.5} />
                      <Line x1={hi} x2={hi} y1={mid - 5} y2={mid + 5} stroke={c.text} strokeWidth={1.5} />
                    </G>
                  ) : null}
                  <ChartText x={width - 2} y={mid + 4} fontSize={11} fontWeight="600" fill={c.text} textAnchor="end">
                    {g.mean.toFixed(decimals)}
                  </ChartText>
                  <ChartText x={width - 2} y={top + 11} fontSize={9} fill={c.textMuted} textAnchor="end">
                    {`n=${g.n}`}
                  </ChartText>
                </G>
              );
            })}
            <Line x1={zero} x2={zero} y1={0} y2={axisY} stroke={c.chartAxis} strokeWidth={1} />
          </Svg>
        );
      }}
    </ChartFrame>
  );
}
