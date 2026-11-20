/// <reference types="jest" />
import { render, screen } from '@testing-library/react-native';

import type { HeartRateSample, PhaseSegment, PhaseSummary, SessionEvent, ZoneTime } from '@surgeonpulse/core';

import { GroupBarChart } from '../charts/GroupBarChart';
import { HrTimelineChart, describeHrTimeline } from '../charts/HrTimelineChart';
import { PhaseBars, phaseBarData } from '../charts/PhaseBars';
import { RollingHrvChart } from '../charts/RollingHrvChart';
import { Sparkline } from '../charts/Sparkline';
import { TrendChart } from '../charts/TrendChart';
import { ZoneBar } from '../charts/ZoneBar';

const T0 = Date.UTC(2026, 0, 5, 8, 0);
const MIN = 60_000;

/** 30 minutes of 1-Hz HR: 70 bpm, rising to ~110 during the "critical" window (min 15–20), with a 60-s gap at min 25. */
function makeSamples(): HeartRateSample[] {
  const out: HeartRateSample[] = [];
  for (let i = 0; i < 30 * 60; i++) {
    if (i >= 25 * 60 && i < 26 * 60) continue; // dropout
    const critical = i >= 15 * 60 && i < 20 * 60;
    out.push({ t: T0 + i * 1000, bpm: critical ? 110 + (i % 5) : 70 + (i % 3) });
  }
  return out;
}

const SAMPLES = makeSamples();

const PHASES: PhaseSegment[] = [
  { phase: 'pre-op', index: 0, start: T0, end: T0 + 5 * MIN },
  { phase: 'dissection', index: 1, start: T0 + 5 * MIN, end: T0 + 15 * MIN },
  { phase: 'critical', index: 2, start: T0 + 15 * MIN, end: T0 + 20 * MIN },
  { phase: 'closure', index: 3, start: T0 + 20 * MIN, end: T0 + 30 * MIN },
];

const EVENTS: SessionEvent[] = [
  { id: 'p1', type: 'phase', phase: 'pre-op', t: T0 },
  { id: 'm1', type: 'marker', marker: 'complication', t: T0 + 16 * MIN },
  { id: 'm2', type: 'marker', marker: 'interruption', t: T0 + 22 * MIN },
];

function phaseSummary(seg: PhaseSegment, mean: number, delta: number | null): PhaseSummary {
  return {
    ...seg,
    durationSec: (seg.end - seg.start) / 1000,
    hr: { count: 10, mean, median: mean, min: mean - 5, max: mean + 5, sd: 2, p95: mean + 4 },
    hrv: null,
    meanHrDelta: delta,
  };
}

describe('HrTimelineChart', () => {
  it('renders with data and summarises it for screen readers', async () => {
    await render(
      <HrTimelineChart
        samples={SAMPLES}
        startedAt={T0}
        endedAt={T0 + 30 * MIN}
        phases={PHASES}
        events={EVENTS}
        baselineBpm={68}
        thresholdBpm={88}
        title="Heart rate"
        testID="hr"
      />,
    );
    const plot = screen.getByTestId('hr-plot');
    expect(plot.props.accessibilityLabel).toMatch(/^Heart rate from 70 to 114 bpm/);
    expect(plot.props.accessibilityLabel).toContain('highest during Critical step');
    expect(plot.props.accessibilityLabel).toContain('resting baseline 68 bpm');
    expect(plot.props.accessibilityLabel).toContain('2 events marked');
    // Legend pairs every phase colour with its label (WCAG 1.4.1).
    expect(screen.getByText('Critical step', { includeHiddenElements: true })).toBeOnTheScreen();
    expect(screen.getByText('Touch and drag on the chart to read values')).toBeOnTheScreen();
  });

  it('renders an empty state without data', async () => {
    await render(<HrTimelineChart samples={[]} startedAt={T0} testID="hr" />);
    expect(screen.getByText('No heart-rate data recorded')).toBeOnTheScreen();
    expect(screen.getByTestId('hr-plot').props.accessibilityLabel).toBe('Heart-rate chart: no heart-rate data recorded.');
  });

  it('describes data without phases', () => {
    expect(describeHrTimeline([{ t: 0, bpm: 60 }, { t: 1000, bpm: 80 }])).toBe('Heart rate from 60 to 80 bpm, average 70.');
  });
});

describe('Sparkline', () => {
  it('renders the last minutes of data', async () => {
    await render(<Sparkline samples={SAMPLES} testID="spark" />);
    expect(screen.getByTestId('spark').props.accessibilityLabel).toMatch(/last 10 minutes: \d+ to \d+ bpm/);
  });

  it('renders with no data', async () => {
    await render(<Sparkline samples={[]} testID="spark" />);
    expect(screen.getByTestId('spark').props.accessibilityLabel).toContain('no data yet');
  });
});

describe('RollingHrvChart', () => {
  const points = Array.from({ length: 20 }, (_, i) => ({ t: T0 + (i + 2) * 30_000, rmssd: i === 5 ? null : 30 + i }));

  it('renders with data', async () => {
    await render(<RollingHrvChart points={points} startedAt={T0} testID="hrv" />);
    expect(screen.getByTestId('hrv-plot').props.accessibilityLabel).toMatch(/ranged from 30 to 49 milliseconds/);
  });

  it('renders an empty state', async () => {
    await render(<RollingHrvChart points={[{ t: T0, rmssd: null }]} startedAt={T0} testID="hrv" />);
    expect(screen.getByText(/Not enough beat-to-beat/)).toBeOnTheScreen();
  });
});

describe('ZoneBar', () => {
  const zones: ZoneTime[] = [
    { id: 'rest', label: 'At rest', seconds: 600, fraction: 0.5 },
    { id: 'elevated', label: 'Elevated', seconds: 360, fraction: 0.3 },
    { id: 'high', label: 'High', seconds: 240, fraction: 0.2 },
    { id: 'very-high', label: 'Very high', seconds: 0, fraction: 0 },
  ];

  it('renders segments and a legend', async () => {
    await render(<ZoneBar zones={zones} testID="zones" />);
    expect(screen.getByTestId('zones-plot').props.accessibilityLabel).toBe(
      'Time in heart-rate zones: At rest 50%, Elevated 30%, High 20%, Very high 0%.',
    );
    // The legend is visual only (the summary above is what screen readers hear).
    expect(screen.getByText('Elevated', { includeHiddenElements: true })).toBeOnTheScreen();
    expect(screen.getByText('6m 00s', { includeHiddenElements: true })).toBeOnTheScreen();
  });

  it('renders an empty state when no time was recorded', async () => {
    await render(<ZoneBar zones={zones.map((z) => ({ ...z, seconds: 0, fraction: 0 }))} testID="zones" />);
    expect(screen.getByText(/Zones need a baseline/)).toBeOnTheScreen();
  });
});

describe('PhaseBars', () => {
  const [pre, dis, crit] = PHASES as [PhaseSegment, PhaseSegment, PhaseSegment, PhaseSegment];
  const phases = [phaseSummary(pre, 74, 6), phaseSummary(dis, 80, 12), phaseSummary(crit, 100, 32)];

  it('renders delta bars by phase', async () => {
    await render(<PhaseBars phases={phases} testID="pb" />);
    expect(screen.getByTestId('pb-plot').props.accessibilityLabel).toContain('Highest during Critical step');
    expect(screen.getByText('Mean change from resting baseline (bpm)')).toBeOnTheScreen();
  });

  it('falls back to mean HR without a baseline and combines repeated phases', () => {
    const repeated = [phaseSummary(dis, 80, null), { ...phaseSummary(dis, 90, null), index: 4 }];
    const { mode, data } = phaseBarData(repeated);
    expect(mode).toBe('mean');
    expect(data).toHaveLength(1);
    expect(data[0]?.value).toBeCloseTo(85);
  });

  it('renders an empty state', async () => {
    await render(<PhaseBars phases={[]} testID="pb" />);
    expect(screen.getByText(/Mark phases during the case/)).toBeOnTheScreen();
  });
});

describe('TrendChart', () => {
  const points = [12, 10, 11, 8, 7, 6].map((value, i) => ({ sessionId: `s${i}`, t: T0 + i * 7 * 86_400_000, value }));

  it('renders points with a trend line and caption', async () => {
    await render(<TrendChart points={points} label="Mean HR change" unit="bpm" testID="trend" />);
    expect(screen.getByTestId('trend-plot').props.accessibilityLabel).toMatch(/Mean HR change across 6 sessions, from 12 bpm to 6 bpm; trend falling/);
    expect(screen.getByText(/per session \(R²/)).toBeOnTheScreen();
  });

  it('renders an empty state', async () => {
    await render(<TrendChart points={[]} label="RMSSD" unit="ms" testID="trend" />);
    expect(screen.getByText('No sessions with “RMSSD” yet')).toBeOnTheScreen();
  });
});

describe('GroupBarChart', () => {
  it('renders groups with whiskers', async () => {
    await render(
      <GroupBarChart
        groups={[
          { group: 'Laparoscopic cholecystectomy', n: 4, mean: 12.5, sd: 3 },
          { group: 'Appendicectomy', n: 1, mean: 8, sd: 0 },
        ]}
        label="Mean HR change"
        unit="bpm"
        decimals={1}
        testID="groups"
      />,
    );
    expect(screen.getByTestId('groups-plot').props.accessibilityLabel).toContain(
      'Laparoscopic cholecystectomy: mean 12.5 bpm, SD 3.0, 4 sessions',
    );
  });

  it('renders an empty state', async () => {
    await render(<GroupBarChart groups={[]} label="Workload" unit="" testID="groups" />);
    expect(screen.getByText('Not enough sessions to compare groups')).toBeOnTheScreen();
  });
});
