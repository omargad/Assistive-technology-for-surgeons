/**
 * Analysis-page helpers: group membership (via core `aggregateMetric`) and the
 * copyable plain-text summary.
 */
import { METRICS, aggregateMetric } from '@surgeonpulse/core';
import type { GroupKey, MetricAggregate, MetricKey, SessionSummary } from '@surgeonpulse/core';
import { GROUP_LABELS, fmtNumber, groupValueLabel, metricLabel, plural } from './format';

/** The group a session falls in, using core's own grouping rules (via `aggregateMetric`). */
export function groupOfSummary(s: SessionSummary, groupBy: GroupKey): string {
  return aggregateMetric([s], 'durationMin', groupBy)[0]?.group ?? 'Unspecified';
}

/** Plain-text summary for pasting into notes or a manuscript draft. */
export function analysisSummaryText(input: {
  rows: readonly MetricAggregate[];
  metric: MetricKey;
  groupBy: GroupKey;
  x: MetricKey;
  y: MetricKey;
  fit: { n: number; r: number | null; trend: { slope: number; intercept: number; r2: number } | null };
  sessions: number;
  participants: number;
  filters: string;
  simulated: boolean;
  date: string;
}): string {
  const m = METRICS[input.metric];
  const lines: string[] = [];
  lines.push(`SurgeonPulse analysis (${input.date})`);
  lines.push(
    `Data: ${plural(input.sessions, 'session')} from ${plural(input.participants, 'participant')}; ${input.filters}.` +
      (input.simulated ? ' SIMULATED demo data.' : ''),
  );
  lines.push('');
  lines.push(`${metricLabel(input.metric)} by ${GROUP_LABELS[input.groupBy].toLowerCase()}:`);
  for (const r of input.rows) {
    lines.push(
      `- ${groupValueLabel(input.groupBy, r.group)}: mean ${fmtNumber(r.mean, m.decimals)} ± ${fmtNumber(r.sd, m.decimals)} SD, ` +
        `median ${fmtNumber(r.median, m.decimals)}, range ${fmtNumber(r.min, m.decimals)}–${fmtNumber(r.max, m.decimals)}, n = ${r.n}`,
    );
  }
  if (input.rows.length === 0) lines.push('- no values');
  lines.push('');
  const pair = `${METRICS[input.y].label} vs ${METRICS[input.x].label}`;
  if (input.fit.n < 3 || input.fit.r === null) {
    lines.push(`${pair}: too few paired values for a correlation (n = ${input.fit.n}).`);
  } else {
    lines.push(`${pair}: Pearson r = ${fmtNumber(input.fit.r, 2)}, n = ${input.fit.n}.`);
    if (input.fit.trend) {
      lines.push(
        `OLS: y = ${fmtNumber(input.fit.trend.intercept, 2)} ${input.fit.trend.slope < 0 ? '−' : '+'} ` +
          `${fmtNumber(Math.abs(input.fit.trend.slope), 3)}·x, R² = ${fmtNumber(input.fit.trend.r2, 2)}.`,
      );
    }
  }
  lines.push('Computed with the SurgeonPulse core analytics library.');
  return lines.join('\n');
}
