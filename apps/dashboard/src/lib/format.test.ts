import { describe, expect, it } from 'vitest';
import {
  fmtCount,
  fmtDate,
  fmtDateTime,
  fmtElapsedTick,
  fmtMetricWithUnit,
  fmtMonthKey,
  fmtNumber,
  fmtPercent,
  fmtSigned,
  fmtZone,
  groupValueLabel,
  metricLabel,
} from './format';

describe('formatters', () => {
  it('formats numbers with a placeholder for missing values', () => {
    expect(fmtNumber(null)).toBe('—');
    expect(fmtNumber(Number.NaN)).toBe('—');
    expect(fmtNumber(3.14159, 2)).toBe('3.14');
    expect(fmtNumber(-2.5, 1)).toBe('−2.5');
    expect(fmtNumber(-0.04, 1)).toBe('0.0');
    expect(fmtSigned(7.46, 1)).toBe('+7.5');
    expect(fmtSigned(-1, 0)).toBe('−1');
    expect(fmtSigned(0, 1)).toBe('0.0');
    expect(fmtPercent(0.923)).toBe('92 %');
    expect(fmtCount(132328)).toBe('132,328');
  });

  it('formats metrics with units from core METRICS', () => {
    expect(fmtMetricWithUnit('meanHr', 72.4)).toBe('72 bpm');
    expect(fmtMetricWithUnit('workload', 41.6)).toBe('42/100');
    expect(metricLabel('rmssd')).toBe('RMSSD (ms)');
    expect(metricLabel('workload')).toBe('Workload (TLX), 0–100');
    expect(metricLabel('episodeCount')).toBe('Stress episodes');
  });

  it('formats dates in the recording timezone, independent of the viewer', () => {
    const t = Date.UTC(2026, 0, 5, 22, 30);
    expect(fmtDate(t)).toBe('2026-01-05');
    expect(fmtDate(t, 600)).toBe('2026-01-06');
    expect(fmtDateTime(t, 600)).toBe('2026-01-06 08:30 UTC+10');
    expect(fmtDateTime(t)).toBe('2026-01-05 22:30 UTC');
    expect(fmtZone(-330)).toBe('UTC−05:30');
  });

  it('formats axis ticks and group labels', () => {
    expect(fmtElapsedTick(45)).toBe('45');
    expect(fmtElapsedTick(90)).toBe('1:30');
    expect(fmtMonthKey('2026-03')).toBe('Mar 2026');
    expect(groupValueLabel('approach', 'laparoscopic')).toBe('Laparoscopic');
    expect(groupValueLabel('trainingLevel', 'consultant')).toBe('Consultant / attending');
    expect(groupValueLabel('approach', 'Unspecified')).toBe('Unspecified');
    expect(groupValueLabel('procedure', 'Whipple')).toBe('Whipple');
  });
});
