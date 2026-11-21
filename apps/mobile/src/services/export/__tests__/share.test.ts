/// <reference types="jest" />
import { createSession, parseCsv, summarizeSession } from '@surgeonpulse/core';
import type { ExportBundle, SurgicalSession } from '@surgeonpulse/core';
import type { SessionListItem } from '../../storage/types';
import { deliverTextFile, pickTextFile } from '../files';
import { exportFileName, fileTimestamp, safeCode } from '../naming';
import {
  buildBundleExport,
  buildSessionCsv,
  buildSummariesCsv,
  pickImportFile,
  shareBundle,
  shareSessionCsv,
  shareSummariesCsv,
} from '../share';

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

function listItem(s: SurgicalSession): SessionListItem {
  const { samples: _samples, rr: _rr, ...meta } = s;
  return { meta, summary: summarizeSession(s), sampleCount: s.samples.length };
}

// PRIV-1: the summaries CSV used to write cached (raw) summaries: typed procedure names and demo rows.
describe('summaries CSV', () => {
  const custom = (id: string, extra: Partial<SurgicalSession> = {}): SurgicalSession => ({
    ...session(),
    id,
    procedure: { name: 'Lap chole for Mrs Jones UR 1234567', specialty: 'General surgery' },
    ...extra,
  });

  it('de-identifies procedure names and leaves out demo, simulator and non-study-code sessions', () => {
    const items = [
      listItem(custom('real')),
      listItem(session()), // catalogue procedure, typed name with a patient detail
      listItem(custom('demo', { tags: ['demo'] })),
      listItem(custom('sim', { sensor: { source: 'simulated', name: 'Simulator' } })),
      listItem(custom('bad', { participantCode: 'jane.doe@hospital.org' })),
      { ...listItem(custom('pending')), summary: null },
    ];
    const { csv, included, skipped, filename } = buildSummariesCsv(items, LOCAL);
    expect(filename).toBe('surgeonpulse-SP-014-20260302-0705-summaries.csv');
    expect(included).toBe(2);
    expect(skipped).toEqual({ demo: 1, simulated: 1, invalidCode: 1, noSummary: 1 });
    expect(csv).not.toMatch(/Jones|1234567|Bloggs|jane\.doe/);
    const rows = parseCsv(csv);
    const header = rows[0]!;
    const col = (name: string) => header.indexOf(name);
    expect(rows.slice(1).map((r) => [r[col('session_id')], r[col('procedure_name')], r[col('specialty')]])).toEqual([
      ['real', 'Unspecified procedure', 'General surgery'],
      ['s1', 'Laparoscopic cholecystectomy', ''],
    ]);
  });

  it('shares the de-identified CSV and reports what was left out', async () => {
    const res = await shareSummariesCsv([listItem(custom('real')), listItem(custom('demo', { tags: ['demo'] }))]);
    expect(res).toEqual({ included: 1, skipped: { demo: 1, simulated: 0, invalidCode: 0, noSummary: 0 } });
    const [, text] = (deliverTextFile as jest.Mock).mock.calls.at(-1)!;
    expect(text).not.toContain('Jones');
  });
});

// ROB-1: one session with a non-pseudonymous code used to make the whole export throw.
describe('bundle export with a non-study code', () => {
  it('skips that session and exports the rest', async () => {
    const bad = { ...session(), id: 'bad', participantCode: 'jane.doe@hospital.org' };
    const built = buildBundleExport([session(), bad], { profile: { code: 'SP-014' }, now: LOCAL });
    expect(built.skipped).toBe(1);
    expect(built.bundle.sessions.map((s) => s.id)).toEqual(['s1']);
    expect(built.json).not.toContain('jane.doe');
    await expect(shareBundle([session(), bad], { profile: { code: 'SP-014' } })).resolves.toEqual({ exported: 1, skipped: 1 });
    await expect(shareBundle([bad])).rejects.toThrow(/valid participant code/);
  });

  it('refuses a single-session CSV with a plain message instead of core\'s RangeError', async () => {
    const bad = { ...session(), participantCode: 'jane.doe@hospital.org' };
    expect(() => buildSessionCsv(bad, 'samples')).toThrow('This session has no valid participant code, so it cannot be exported de-identified.');
    expect(() => buildSessionCsv(bad, 'events')).not.toThrow(RangeError);
    await expect(shareSessionCsv(bad, 'rr')).rejects.toThrow(/valid participant code/);
    expect(deliverTextFile).not.toHaveBeenCalledWith(expect.anything(), expect.stringContaining('jane.doe'), expect.anything());
  });
});

