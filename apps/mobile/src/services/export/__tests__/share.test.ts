/// <reference types="jest" />
import { createSession } from '@surgeonpulse/core';
import type { ExportBundle, SurgicalSession } from '@surgeonpulse/core';
import { deliverTextFile, pickTextFile } from '../files';
import { exportFileName, fileTimestamp, safeCode } from '../naming';
import { buildBundleExport, buildSessionCsv, pickImportFile, shareBundle, shareSessionCsv, shareSummariesCsv } from '../share';

jest.mock('../files', () => ({
  deliverTextFile: jest.fn(async () => undefined),
  pickTextFile: jest.fn(async () => '{"sessions":[]}'),
}));
jest.mock('../../platform', () => ({
  appInfo: () => ({ version: '0.1.0', platform: 'ios' }),
}));

/** Local wall-clock time (file names use the device's local time). */
const LOCAL = new Date(2026, 2, 2, 7, 5).getTime();

function session(): SurgicalSession {
  const s = createSession({
    id: 's1',
    participantCode: 'SP-014',
    procedure: { name: 'Lap chole — bed 4 J. Bloggs', catalogId: 'laparoscopic-cholecystectomy' },
    sensor: { source: 'ble', name: 'Polar H10', id: 'AA:BB' },
    app: { version: '0.1.0', platform: 'ios' },
    startedAt: LOCAL,
  });
  return {
    ...s,
    status: 'completed',
    endedAt: LOCAL + 120_000,
    samples: [
      { t: LOCAL, bpm: 70 },
      { t: LOCAL + 1000, bpm: 72 },
    ],
    rr: [{ t: LOCAL, ms: 850 }],
    events: [{ id: 'e', t: LOCAL + 500, type: 'marker', marker: 'note', note: 'Mr Bloggs bled', loggedBy: 'team' }],
  };
}

describe('export naming', () => {
  it('formats surgeonpulse-<code>-<yyyymmdd-hhmm>.<ext> in local time', () => {
    expect(fileTimestamp(LOCAL)).toBe('20260302-0705');
    expect(exportFileName('SP-014', LOCAL, 'json')).toBe('surgeonpulse-SP-014-20260302-0705.json');
    expect(exportFileName('SP-014', LOCAL, 'csv', 'rr')).toBe('surgeonpulse-SP-014-20260302-0705-rr.csv');
  });

  it('sanitises codes so file names cannot carry anything else', () => {
    expect(safeCode('SP 014/../x')).toBe('SP014x');
    expect(safeCode('')).toBe('export');
    expect(safeCode(null)).toBe('export');
  });
});

describe('shareBundle', () => {
  beforeEach(() => jest.clearAllMocks());

  it('builds a de-identified bundle named after the participant code', () => {
    const { filename, json, bundle } = buildBundleExport([session()], { profile: { code: 'SP-014' }, now: LOCAL });
    expect(filename).toBe('surgeonpulse-SP-014-20260302-0705.json');
    expect(bundle.deidentified).toBe(true);
    expect(bundle.app).toEqual({ version: '0.1.0', platform: 'ios' });
    const parsed = JSON.parse(json) as ExportBundle;
    expect(parsed.sessions[0]?.events[0]?.note).toBeUndefined();
    expect(parsed.sessions[0]?.sensor.id).toBeUndefined();
    expect(parsed.sessions[0]?.procedure.name).toBe('Laparoscopic cholecystectomy');
  });

  it('keeps identifiable fields only when explicitly asked', () => {
    const { bundle } = buildBundleExport([session()], { deidentify: false, now: LOCAL });
    expect(bundle.deidentified).toBe(false);
    expect(bundle.sessions[0]?.events[0]?.note).toBe('Mr Bloggs bled');
  });

  it('delivers JSON and CSV files', async () => {
    await shareBundle([session()]);
    expect(deliverTextFile).toHaveBeenCalledWith(
      expect.stringMatching(/^surgeonpulse-SP-014-\d{8}-\d{4}\.json$/),
      expect.any(String),
      'application/json',
    );
    await shareSessionCsv(session(), 'events');
    expect(deliverTextFile).toHaveBeenLastCalledWith(
      'surgeonpulse-SP-014-20260302-0705-events.csv',
      expect.any(String),
      'text/csv',
    );
    await expect(shareBundle([])).rejects.toThrow(/no sessions/);
    await expect(shareSummariesCsv([])).rejects.toThrow(/no session summaries/);
  });

  it('de-identifies single-session CSVs (no free-text notes)', () => {
    const { csv } = buildSessionCsv(session(), 'events');
    expect(csv.split('\r\n')[0]).toBe('session_id,participant_code,t_iso,t_offset_s,type,kind,logged_by,note');
    expect(csv).not.toContain('Bloggs');
    expect(buildSessionCsv(session(), 'samples').csv.split('\r\n').filter(Boolean)).toHaveLength(3);
  });

  it('picks import files as text', async () => {
    await expect(pickImportFile()).resolves.toBe('{"sessions":[]}');
    expect(pickTextFile).toHaveBeenCalledWith(expect.stringContaining('application/json'));
  });
});
