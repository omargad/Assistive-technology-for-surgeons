/// <reference types="jest" />
/**
 * Platform health stores with their native modules mocked: verifies the
 * HealthKit (iOS) and Health Connect (Android) API usage and mapping.
 */
import { healthStore as appleHealth } from '../index.ios';
import { healthStore as healthConnect } from '../index.android';

const mockT0 = Date.UTC(2026, 2, 2, 8, 0, 0);
const mockIso = (ms: number) => new Date(ms).toISOString();

jest.mock('@kingstinct/react-native-healthkit', () => ({
  isHealthDataAvailableAsync: jest.fn(async () => true),
  requestAuthorization: jest.fn(async () => true),
  queryQuantitySamples: jest.fn(async (id: string) =>
    id === 'HKQuantityTypeIdentifierHeartRate'
      ? [
          { startDate: new Date(mockT0 + 5000), quantity: 72 },
          { startDate: new Date(mockT0 + 1000), quantity: 70 },
        ]
      : [{ startDate: new Date(mockT0 + 2000), quantity: 45 }],
  ),
  queryHeartbeatSeriesSamples: jest.fn(async () => [
    {
      startDate: new Date(mockT0 + 10_000),
      heartbeats: [
        { timeSinceSeriesStart: 0, precededByGap: false },
        { timeSinceSeriesStart: 0.9, precededByGap: false },
      ],
    },
  ]),
}));

jest.mock('react-native-health-connect', () => ({
  SdkAvailabilityStatus: { SDK_UNAVAILABLE: 1, SDK_UNAVAILABLE_PROVIDER_UPDATE_REQUIRED: 2, SDK_AVAILABLE: 3 },
  getSdkStatus: jest.fn(async () => 3),
  initialize: jest.fn(async () => true),
  requestPermission: jest.fn(async (perms: unknown[]) => perms),
  getGrantedPermissions: jest.fn(async () => [{ accessType: 'read', recordType: 'HeartRate' }]),
  readRecords: jest.fn(async (type: string, opts: { pageToken?: string }) => {
    if (type === 'HeartRate') {
      return opts.pageToken
        ? { records: [{ samples: [{ time: mockIso(mockT0 + 9000), beatsPerMinute: 88 }] }] }
        : { records: [{ samples: [{ time: mockIso(mockT0 + 3000), beatsPerMinute: 80 }] }], pageToken: 'next' };
    }
    return { records: [{ time: mockIso(mockT0 + 4000), heartRateVariabilityMillis: 33 }] };
  }),
}));

describe('Apple Health store (iOS)', () => {
  it('requests read access to HR, SDNN and heartbeat series', async () => {
    const hk = jest.requireMock<{ requestAuthorization: jest.Mock }>('@kingstinct/react-native-healthkit');
    expect(appleHealth.source).toBe('healthkit');
    await expect(appleHealth.isAvailable()).resolves.toBe(true);
    await expect(appleHealth.requestAccess()).resolves.toBe(true);
    expect(hk.requestAuthorization).toHaveBeenCalledWith({
      toRead: [
        'HKQuantityTypeIdentifierHeartRate',
        'HKQuantityTypeIdentifierHeartRateVariabilitySDNN',
        'HKDataTypeIdentifierHeartbeatSeries',
      ],
    });
  });

  it('imports bpm, SDNN and RR from heartbeat series for the window', async () => {
    const hk = jest.requireMock<{ queryQuantitySamples: jest.Mock }>('@kingstinct/react-native-healthkit');
    const result = await appleHealth.importRange(mockT0, mockT0 + 60_000);
    expect(hk.queryQuantitySamples).toHaveBeenCalledWith('HKQuantityTypeIdentifierHeartRate', {
      limit: 0,
      ascending: true,
      unit: 'count/min',
      filter: { date: { startDate: new Date(mockT0), endDate: new Date(mockT0 + 60_000) } },
    });
    expect(result).toEqual({
      source: 'healthkit',
      samples: [
        { t: mockT0 + 1000, bpm: 70 },
        { t: mockT0 + 5000, bpm: 72 },
      ],
      rr: [{ t: mockT0 + 10_900, ms: 900 }],
      externalHrv: [{ t: mockT0 + 2000, metric: 'sdnn', ms: 45, source: 'healthkit' }],
    });
  });
});

describe('Health Connect store (Android)', () => {
  it('requests HR + RMSSD permissions and follows page tokens', async () => {
    expect(healthConnect.source).toBe('health-connect');
    await expect(healthConnect.isAvailable()).resolves.toBe(true);
    await expect(healthConnect.requestAccess()).resolves.toBe(true);
    const result = await healthConnect.importRange(mockT0, mockT0 + 60_000);
    expect(result.samples).toEqual([
      { t: mockT0 + 3000, bpm: 80 },
      { t: mockT0 + 9000, bpm: 88 },
    ]);
    expect(result.externalHrv).toEqual([{ t: mockT0 + 4000, metric: 'rmssd', ms: 33, source: 'health-connect' }]);
    expect(result.rr).toEqual([]);
    const hc = jest.requireMock<{ readRecords: jest.Mock }>('react-native-health-connect');
    expect(hc.readRecords.mock.calls[0]).toEqual([
      'HeartRate',
      {
        timeRangeFilter: { operator: 'between', startTime: mockIso(mockT0), endTime: mockIso(mockT0 + 60_000) },
        ascendingOrder: true,
        pageSize: 1000,
      },
    ]);
  });

  it('explains missing permission', async () => {
    const hc = jest.requireMock<{ getGrantedPermissions: jest.Mock }>('react-native-health-connect');
    hc.getGrantedPermissions.mockResolvedValueOnce([]);
    await expect(healthConnect.importRange(mockT0, mockT0 + 1000)).rejects.toThrow(/Allow SurgeonPulse to read heart rate/);
  });
});
