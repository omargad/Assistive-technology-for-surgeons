/// <reference types="jest" />
/**
 * UX-10: a sensor that streams heart rate without beat-to-beat (RR) intervals
 * must be visible before and during a case (HRV outcomes need RR).
 */
import { render, screen } from '@testing-library/react-native';

import { BeatToBeatNote } from '@/components/BeatToBeatNote';
import { SensorStatusPill } from '@/components/SensorStatusPill';
import { RR_GRACE_MS, RR_RECENT_MS, beatToBeatStatus } from '@/hooks/useBeatToBeat';
import { useRecording } from '@/state/recording';

jest.mock('@/state/recording', () => ({ useRecording: require('@/components/__testutils__/mockStores').makeRecordingStore() }));

const NOW = Date.UTC(2026, 2, 2, 9, 0);

describe('beatToBeatStatus', () => {
  const streaming = { state: 'streaming' as const };
  it('is null until the sensor has streamed for the grace period', () => {
    expect(beatToBeatStatus({ state: 'connecting' }, NOW - 60_000, null, NOW)).toBeNull();
    expect(beatToBeatStatus(streaming, null, null, NOW)).toBeNull();
    expect(beatToBeatStatus(streaming, NOW - RR_GRACE_MS + 1, null, NOW)).toBeNull();
  });
  it('reports missing RR after the grace period, receiving when RR arrived recently', () => {
    expect(beatToBeatStatus(streaming, NOW - RR_GRACE_MS, null, NOW)).toBe('missing');
    expect(beatToBeatStatus(streaming, NOW - 60_000, NOW - 1000, NOW)).toBe('receiving');
    expect(beatToBeatStatus(streaming, NOW - 60_000, NOW - RR_RECENT_MS - 1, NOW)).toBe('missing');
  });
});

describe('RR indicators', () => {
  beforeEach(() => {
    jest.spyOn(Date, 'now').mockReturnValue(NOW);
  });
  afterEach(() => jest.restoreAllMocks());

  it('the sensor pill warns "No RR" and says so to screen readers', async () => {
    await render(<SensorStatusPill status={{ state: 'streaming', battery: 90 }} rr="missing" compact testID="pill" />);
    expect(screen.getByText('No RR')).toBeOnTheScreen();
    expect(screen.getByTestId('pill').props.accessibilityLabel).toBe('Sensor Live, battery 90 percent, no beat-to-beat (RR) data');
  });

  it('the sensors note explains missing RR, and confirms when it arrives', async () => {
    useRecording.setState({ sensorStatus: { state: 'streaming' }, streamSince: NOW - 30_000, rrSeenAt: null });
    const view = await render(<BeatToBeatNote />);
    expect(screen.getByTestId('sensor-rr')).toHaveTextContent(/not received\. Heart rate is recorded, but HRV/);

    useRecording.setState({ rrSeenAt: NOW - 1000 });
    await view.rerender(<BeatToBeatNote />);
    expect(screen.getByTestId('sensor-rr')).toHaveTextContent(/Beat-to-beat \(RR\) intervals: receiving\./);
  });
});
