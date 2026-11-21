import { describe, expect, it } from 'vitest';
import type { HrStats, HrvTimeDomain, PhaseSummary, SessionSummary, SurgicalSession } from '../src/types';
import {
  SUMMARY_CSV_COLUMNS,
  eventsToCsv,
  parseCsv,
  rrToCsv,
  samplesToCsv,
  summariesToCsv,
  toCsv,
} from '../src/io/csv';
import { summarizeSession } from '../src/analytics/summary';

const T0 = Date.UTC(2026, 0, 5, 8, 0);
const iso = (t: number): string => new Date(t).toISOString();

describe('toCsv', () => {
  it('writes a header row and CRLF-terminated records', () => {
    expect(toCsv([{ a: 1, b: 'x' }, { a: 2, b: 'y' }])).toBe('a,b\r\n1,x\r\n2,y\r\n');
  });

  it('quotes fields containing commas, quotes, CR or LF and doubles embedded quotes', () => {
    const csv = toCsv([{ v: 'a,b' }, { v: 'say "hi"' }, { v: 'line1\nline2' }, { v: 'cr\rhere' }, { v: 'crlf\r\nx' }, { v: 'plain text' }]);
    expect(csv).toBe(
      'v\r\n"a,b"\r\n"say ""hi"""\r\n"line1\nline2"\r\n"cr\rhere"\r\n"crlf\r\nx"\r\nplain text\r\n',
    );
  });

  it('quotes header names that need it', () => {
    expect(toCsv([{ 'a,b': 1 }])).toBe('"a,b"\r\n1\r\n');
  });

  it('writes empty fields for null, undefined, missing keys and non-finite numbers', () => {
    const rows = [{ a: null, b: undefined, c: Number.NaN, d: Number.POSITIVE_INFINITY, e: 0 }, {}];
    expect(toCsv(rows, ['a', 'b', 'c', 'd', 'e'])).toBe('a,b,c,d,e\r\n,,,,0\r\n,,,,\r\n');
  });

  it('formats numbers with String(n), booleans, dates and objects', () => {
    const rows = [{ n: 792.969, big: 1e21, neg: -0.5, yes: true, no: false, when: new Date(T0), obj: { k: [1, 2] } }];
    expect(toCsv(rows)).toBe(`n,big,neg,yes,no,when,obj\r\n792.969,1e+21,-0.5,true,false,${iso(T0)},"{""k"":[1,2]}"\r\n`);
  });

  it('defaults columns to the union of keys in first-seen order; explicit columns select and order', () => {
    const rows = [{ b: 1, a: 2 }, { c: 3, a: 4 }];
    expect(toCsv(rows)).toBe('b,a,c\r\n1,2,\r\n,4,3\r\n');
    expect(toCsv(rows, ['c', 'b'])).toBe('c,b\r\n,1\r\n3,\r\n');
  });

  it('reads only own properties', () => {
    expect(toCsv([{ a: 1 }], ['a', 'constructor', 'toString'])).toBe('a,constructor,toString\r\n1,,\r\n');
  });

  it('returns a header-only document for no rows, and "" for no columns', () => {
    expect(toCsv([], ['a', 'b'])).toBe('a,b\r\n');
    expect(toCsv([])).toBe('');
  });
});

describe('parseCsv', () => {
  it('parses simple CRLF, LF and CR documents with or without a trailing newline', () => {
    const expected = [
      ['a', 'b'],
      ['1', '2'],
    ];
    expect(parseCsv('a,b\r\n1,2\r\n')).toEqual(expected);
    expect(parseCsv('a,b\r\n1,2')).toEqual(expected);
    expect(parseCsv('a,b\n1,2\n')).toEqual(expected);
    expect(parseCsv('a,b\r1,2')).toEqual(expected);
  });

  it('handles quoted fields with commas, doubled quotes and embedded line breaks', () => {
    expect(parseCsv('"a,b","say ""hi""","line1\r\nline2"\r\nx,"",y\r\n')).toEqual([
      ['a,b', 'say "hi"', 'line1\r\nline2'],
      ['x', '', 'y'],
    ]);
  });

  it('keeps empty fields and blank records', () => {
    expect(parseCsv(',a,\r\n\r\nb\r\n')).toEqual([['', 'a', ''], [''], ['b']]);
    expect(parseCsv('a,')).toEqual([['a', '']]);
    expect(parseCsv('""')).toEqual([['']]);
  });

  it('returns [] for empty input and strips a UTF-8 byte-order mark', () => {
    expect(parseCsv('')).toEqual([]);
    expect(parseCsv('﻿')).toEqual([]);
    expect(parseCsv('﻿id,bpm\r\n1,70\r\n')).toEqual([
      ['id', 'bpm'],
      ['1', '70'],
    ]);
  });

  it('is lenient with malformed quoting', () => {
    expect(parseCsv('ab"c,d')).toEqual([['ab"c', 'd']]);
    expect(parseCsv('"ab"c,d')).toEqual([['abc', 'd']]);
    expect(parseCsv('"unterminated,x\r\ny')).toEqual([['unterminated,x\r\ny']]);
  });

  it('round-trips arbitrary text through toCsv', () => {
    const alphabet = ['a', 'Z', '7', ',', '"', '\r', '\n', ' ', 'é', '\t', '""'];
    let seed = 42;
    const rand = (n: number): number => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed % n;
    };
    for (let trial = 0; trial < 200; trial++) {
      const cols = ['c1', 'c,2', 'c"3'];
      const rows = Array.from({ length: 1 + rand(5) }, () =>
        Object.fromEntries(cols.map((c) => [c, Array.from({ length: rand(8) }, () => alphabet[rand(alphabet.length)]).join('')])),
      );
      const parsed = parseCsv(toCsv(rows, cols));
      expect(parsed[0]).toEqual(cols);
      expect(parsed.slice(1)).toEqual(rows.map((r) => cols.map((c) => r[c])));
    }
  });

  it('round-trips a single empty column value (a blank record)', () => {
    expect(parseCsv(toCsv([{ a: '' }, { a: 'x' }]))).toEqual([['a'], [''], ['x']]);
  });
});

function session(): SurgicalSession {
  const rr = Array.from({ length: 14 }, (_, i) => ({ t: T0 + 3000 + i * 800, ms: 800 + (i % 3) * 10 }));
  rr[4] = { t: rr[4]!.t, ms: 250 }; // physiologically impossible → invalid (range rule)
  rr[9] = { t: rr[9]!.t, ms: 1200 }; // 50 % off the local median → invalid (ectopic rule)
  return {
    schemaVersion: 1,
    id: 'sess-1',
    participantCode: 'SP-014',
    procedure: { name: 'Laparoscopic cholecystectomy' },
    startedAt: T0,
    endedAt: T0 + 20_000,
    status: 'completed',
    sensor: { source: 'ble' },
    app: { version: '1', platform: 'ios' },
    samples: [
      { t: T0, bpm: 70, contact: true },
      { t: T0 + 2000, bpm: 71, contact: false },
      { t: T0 + 4999, bpm: 72 },
      { t: T0 + 5000, bpm: 73.5 },
      { t: T0 + 20_000, bpm: 74 },
    ],
    rr,
    events: [
      { id: 'e1', t: T0 + 2000, type: 'phase', phase: 'pre-op', loggedBy: 'self' },
      { id: 'e2', t: T0 + 3000, type: 'marker', marker: 'complication', note: 'bleeding, "minor"\nresolved', loggedBy: 'team' },
      { id: 'e3', t: T0 + 5000, type: 'phase', phase: 'incision' },
    ],
  };
}

describe('samplesToCsv', () => {
  it('writes one row per sample with offset, contact 1/0/empty and the phase in progress', () => {
    const rows = parseCsv(samplesToCsv(session()));
    expect(rows[0]).toEqual(['session_id', 'participant_code', 't_iso', 't_offset_s', 'bpm', 'contact', 'phase']);
    expect(rows.slice(1)).toEqual([
      ['sess-1', 'SP-014', iso(T0), '0', '70', '1', ''], // before the first phase event: no phase
      ['sess-1', 'SP-014', iso(T0 + 2000), '2', '71', '0', 'pre-op'],
      ['sess-1', 'SP-014', iso(T0 + 4999), '4.999', '72', '', 'pre-op'],
      ['sess-1', 'SP-014', iso(T0 + 5000), '5', '73.5', '', 'incision'],
      ['sess-1', 'SP-014', iso(T0 + 20_000), '20', '74', '', 'incision'], // t == session end → last phase
    ]);
  });

  it('uses CRLF line endings', () => {
    const csv = samplesToCsv(session());
    expect(csv.endsWith('\r\n')).toBe(true);
    expect(csv.split('\r\n')).toHaveLength(7);
  });
});

describe('rrToCsv', () => {
  it('writes one row per beat with the cleanRr validity flag', () => {
    const s = session();
    const rows = parseCsv(rrToCsv(s));
    expect(rows[0]).toEqual(['session_id', 'participant_code', 't_iso', 't_offset_s', 'rr_ms', 'valid', 'phase']);
    expect(rows).toHaveLength(15);
    const valid = rows.slice(1).map((r) => r[5]);
    expect(valid[4]).toBe('0');
    expect(valid[9]).toBe('0');
    expect(valid.filter((v) => v === '1')).toHaveLength(12);
    expect(rows[1]).toEqual(['sess-1', 'SP-014', iso(T0 + 3000), '3', '800', '1', 'pre-op']);
    expect(rows[5]?.[4]).toBe('250');
    expect(rows[14]?.[6]).toBe('incision');
  });
});

describe('eventsToCsv', () => {
  it('writes type, kind, logger and note, quoting notes safely', () => {
    const rows = parseCsv(eventsToCsv(session()));
    expect(rows).toEqual([
      ['session_id', 'participant_code', 't_iso', 't_offset_s', 'type', 'kind', 'logged_by', 'note'],
      ['sess-1', 'SP-014', iso(T0 + 2000), '2', 'phase', 'pre-op', 'self', ''],
      ['sess-1', 'SP-014', iso(T0 + 3000), '3', 'marker', 'complication', 'team', 'bleeding, "minor"\nresolved'],
      ['sess-1', 'SP-014', iso(T0 + 5000), '5', 'phase', 'incision', '', ''],
    ]);
  });

  it('writes only a header for a session without events', () => {
    expect(eventsToCsv({ ...session(), events: [] })).toBe(
      'session_id,participant_code,t_iso,t_offset_s,type,kind,logged_by,note\r\n',
    );
  });
});

// ---------------------------------------------------------------------------
// summariesToCsv
// ---------------------------------------------------------------------------

const hr = (mean: number): HrStats => ({ count: 10, mean, median: mean, min: mean - 5, max: mean + 10, sd: 3, p95: mean + 8 });
const hrv = (rmssd: number): HrvTimeDomain => ({ n: 40, pairs: 39, meanRr: 750, sdnn: 50, rmssd, pnn50: 12, meanHr: 80 });

function phase(
  p: PhaseSummary['phase'],
  index: number,
  durationSec: number,
  hrMean: number | null,
  delta: number | null,
  rmssd: number | null,
): PhaseSummary {
  return {
    phase: p,
    index,
    start: T0,
    end: T0 + durationSec * 1000,
    durationSec,
    hr: hrMean === null ? null : hr(hrMean),
    hrv: rmssd === null ? null : hrv(rmssd),
    meanHrDelta: delta,
  };
}

function summary(): SessionSummary {
  return {
    sessionId: 'sess-1',
    participantCode: 'SP-014',
    procedureName: 'Whipple, "pylorus-preserving"',
    specialty: 'Upper GI & HPB surgery',
    approach: 'open',
    role: 'primary',
    urgency: 'elective',
    complexity: 5,
    trainingLevel: 'fellow',
    startedAt: T0,
    endedAt: T0 + 5_400_000,
    durationSec: 5400,
    hr: { count: 5400, mean: 84.5, median: 83, min: 61, max: 131, sd: 9.25, p95: 101 },
    hrv: { n: 6000, pairs: 5900, meanRr: 712.4, sdnn: 48.2, rmssd: 27.9, pnn50: 8.1, meanHr: 84.2 },
    rrArtifacts: { total: 6100, removed: 61, ratio: 0.01 },
    stressIndex: 182.5,
    baseline: { startedAt: T0 - 300_000, endedAt: T0, restingHr: 65, source: 'measured' },
    meanHrDelta: 19.5,
    peakHrDelta: 66,
    maxHr: 182,
    zones: [],
    highIntensityFraction: 0.125,
    phases: [
      phase('pre-op', 0, 300, 70, 5, 40),
      phase('dissection', 1, 60, 80, 15, 30),
      phase('critical', 2, 100, 95, 30, null),
      phase('dissection', 3, 120, 90, 25, 20),
      phase('closure', 4, 200, 75, 10, null),
      phase('closure', 5, 100, 77, 12, 50),
    ],
    episodes: [
      { start: T0, end: T0 + 90_000, durationSec: 90, peakBpm: 131, peakT: T0 + 1000, meanBpm: 120, relatedEventIds: [] },
      { start: T0, end: T0 + 60_000, durationSec: 60, peakBpm: 125, peakT: T0 + 1000, meanBpm: 118, relatedEventIds: [] },
    ],
    markerCounts: { complication: 1 },
    workload: { instrument: 'surg-tlx', raw: 46.67, weighted: null, dimensions: {} },
    performance: 7,
    perceivedStress: 6,
    quality: { coverage: 0.987, gapCount: 1, longestGapSec: 12, rrArtifactRatio: 0.01, sampleRateHz: 1 },
  };
}

function emptySummary(): SessionSummary {
  return {
    sessionId: 'sess-2',
    participantCode: 'SP-015',
    procedureName: 'Tonsillectomy',
    startedAt: T0,
    endedAt: T0,
    durationSec: 0,
    hr: null,
    hrv: null,
    rrArtifacts: null,
    stressIndex: null,
    baseline: null,
    meanHrDelta: null,
    peakHrDelta: null,
    maxHr: null,
    zones: [],
    highIntensityFraction: null,
    phases: [],
    episodes: [],
    markerCounts: {},
    workload: null,
    performance: null,
    perceivedStress: null,
    quality: { coverage: 0, gapCount: 0, longestGapSec: 0, rrArtifactRatio: null, sampleRateHz: 0 },
  };
}

function asRecords(csv: string): Record<string, string>[] {
  const [header, ...rows] = parseCsv(csv);
  return rows.map((r) => Object.fromEntries((header ?? []).map((h, i) => [h, r[i] ?? ''])));
}

describe('summariesToCsv', () => {
  it('uses the fixed wide column layout from the spec', () => {
    const header = parseCsv(summariesToCsv([]))[0];
    expect(header).toEqual([...SUMMARY_CSV_COLUMNS]);
    const physiology = [
      'duration_min', 'hr_mean', 'hr_median', 'hr_min', 'hr_max', 'hr_sd', 'hr_p95', 'rmssd', 'sdnn', 'pnn50',
      'mean_rr', 'stress_index', 'rr_artifact_pct', 'baseline_hr', 'mean_hr_delta', 'peak_hr_delta',
      'high_intensity_pct', 'episode_count', 'episode_minutes', 'workload_instrument', 'workload_raw',
      'workload_weighted', 'performance', 'perceived_stress', 'coverage_pct',
    ];
    const at = SUMMARY_CSV_COLUMNS.indexOf('duration_min');
    expect(SUMMARY_CSV_COLUMNS.slice(at, at + physiology.length)).toEqual(physiology);
    expect(SUMMARY_CSV_COLUMNS.slice(0, 2)).toEqual(['session_id', 'participant_code']);
    expect(SUMMARY_CSV_COLUMNS.slice(at + physiology.length)).toEqual([
      ...['pre_op', 'incision', 'dissection', 'critical', 'closure', 'post_op'].flatMap((p) => [
        `${p}_duration_s`,
        `${p}_hr_mean`,
        `${p}_hr_delta`,
        `${p}_rmssd`,
      ]),
      // provenance and covariates (appended, RV-4/RV-7/RV-13)
      'sensor_source',
      'simulated',
      'tz_offset_min',
      'started_local',
      'baseline_source',
      'baseline_duration_s',
      'max_hr',
      'peak_hr',
      'hrv_n',
      'sleep_hours',
      'caffeine',
      'outcome',
      'analytics_version',
    ]);
    expect(new Set(SUMMARY_CSV_COLUMNS).size).toBe(SUMMARY_CSV_COLUMNS.length);
  });

  it('writes one row per session with derived percentages and minutes', () => {
    const [row] = asRecords(summariesToCsv([summary()]));
    expect(row).toMatchObject({
      session_id: 'sess-1',
      participant_code: 'SP-014',
      training_level: 'fellow',
      started_at: iso(T0),
      ended_at: iso(T0 + 5_400_000),
      procedure_name: 'Whipple, "pylorus-preserving"',
      specialty: 'Upper GI & HPB surgery',
      approach: 'open',
      role: 'primary',
      urgency: 'elective',
      complexity: '5',
      duration_min: '90',
      hr_mean: '84.5',
      hr_median: '83',
      hr_min: '61',
      hr_max: '131',
      hr_sd: '9.25',
      hr_p95: '101',
      rmssd: '27.9',
      sdnn: '48.2',
      pnn50: '8.1',
      mean_rr: '712.4',
      stress_index: '182.5',
      rr_artifact_pct: '1',
      baseline_hr: '65',
      mean_hr_delta: '19.5',
      peak_hr_delta: '66',
      high_intensity_pct: '12.5',
      episode_count: '2',
      episode_minutes: '2.5',
      workload_instrument: 'surg-tlx',
      workload_raw: '46.67',
      workload_weighted: '',
      performance: '7',
      perceived_stress: '6',
      coverage_pct: '98.7',
    });
  });

  it('duration-weights phases that occur several times and leaves absent phases empty', () => {
    const [row] = asRecords(summariesToCsv([summary()]));
    const num = (k: string): number => Number(row?.[k]);
    expect(row?.pre_op_duration_s).toBe('300');
    expect(row?.pre_op_hr_mean).toBe('70');
    expect(row?.pre_op_hr_delta).toBe('5');
    expect(row?.pre_op_rmssd).toBe('40');
    // dissection: 60 s @ 80 bpm and 120 s @ 90 bpm
    expect(num('dissection_duration_s')).toBe(180);
    expect(num('dissection_hr_mean')).toBeCloseTo((80 * 60 + 90 * 120) / 180, 10);
    expect(num('dissection_hr_delta')).toBeCloseTo((15 * 60 + 25 * 120) / 180, 10);
    expect(num('dissection_rmssd')).toBeCloseTo((30 * 60 + 20 * 120) / 180, 10);
    // critical has no HRV → empty, not 0
    expect(row?.critical_rmssd).toBe('');
    expect(row?.critical_hr_mean).toBe('95');
    // closure: RMSSD only from the segment that has it
    expect(num('closure_duration_s')).toBe(300);
    expect(num('closure_hr_mean')).toBeCloseTo((75 * 200 + 77 * 100) / 300, 10);
    expect(row?.closure_rmssd).toBe('50');
    for (const p of ['incision', 'post_op']) {
      for (const m of ['duration_s', 'hr_mean', 'hr_delta', 'rmssd']) expect(row?.[`${p}_${m}`]).toBe('');
    }
  });

  it('exports a phase that occurs once with exactly its PhaseSummary values', () => {
    // (w·x)/w is not always x in floating point (e.g. 109 s at 77.3 bpm), so a single segment must not be
    // "weighted" or the CSV would disagree with the summary in the last digit.
    expect((109 * 77.3) / 109).not.toBe(77.3);
    const s: SessionSummary = { ...summary(), phases: [phase('critical', 0, 109, 77.3, 13, 81.7)] };
    const [row] = asRecords(summariesToCsv([s]));
    expect(row?.critical_duration_s).toBe('109');
    expect(row?.critical_hr_mean).toBe('77.3');
    expect(row?.critical_hr_delta).toBe('13');
    expect(row?.critical_rmssd).toBe('81.7');
  });

  it('writes empty fields (never NaN) when data is missing', () => {
    const csv = summariesToCsv([emptySummary(), summary()]);
    expect(csv).not.toMatch(/NaN|Infinity|undefined|null/);
    const [row] = asRecords(csv);
    expect(row).toMatchObject({
      session_id: 'sess-2',
      specialty: '',
      hr_mean: '',
      rmssd: '',
      rr_artifact_pct: '',
      baseline_hr: '',
      high_intensity_pct: '',
      episode_count: '0',
      episode_minutes: '0',
      workload_instrument: '',
      coverage_pct: '0',
      duration_min: '0',
    });
  });

  it('works end-to-end on summarizeSession output', () => {
    const summaryRow = asRecords(summariesToCsv([summarizeSession(session())]))[0];
    expect(summaryRow?.session_id).toBe('sess-1');
    expect(summaryRow?.pre_op_duration_s).toBe('3');
    expect(summaryRow?.incision_duration_s).toBe('15');
    expect(Object.keys(summaryRow ?? {})).toEqual([...SUMMARY_CSV_COLUMNS]);
  });
});

describe('spreadsheet formula injection (OWASP CSV injection)', () => {
  it('toCsv leaves strings verbatim by default (round-trips with parseCsv)', () => {
    const text = toCsv([{ a: '=1+1', b: -3 }]);
    expect(parseCsv(text)).toEqual([
      ['a', 'b'],
      ['=1+1', '-3'],
    ]);
  });

  it('formulaGuard prefixes an apostrophe to strings starting with = + - @ TAB CR, never to numbers', () => {
    const rows = [{ a: '=HYPERLINK("http://x","click")', b: '+1', c: '-x', d: '@SUM(A1)', e: '\tx', f: '\rx', g: 'ok', h: -2.5 }];
    expect(parseCsv(toCsv(rows, undefined, { formulaGuard: true }))[1]).toEqual([
      `'=HYPERLINK("http://x","click")`,
      "'+1",
      "'-x",
      "'@SUM(A1)",
      "'\tx",
      "'\rx",
      'ok',
      '-2.5',
    ]);
  });

  it('the exporters guard free text (event notes, procedure names) but keep negative offsets numeric', () => {
    const s = session();
    s.events = [{ id: 'm', t: T0 - 1000, type: 'marker', marker: 'note', note: '=HYPERLINK("http://x","click")' }];
    const rows = parseCsv(eventsToCsv(s));
    expect(rows[1]![3]).toBe('-1');
    expect(rows[1]![7]).toBe(`'=HYPERLINK("http://x","click")`);
    const sum = summarizeSession({ ...s, procedure: { name: '@cmd' } });
    const header = parseCsv(summariesToCsv([sum]))[0]!;
    expect(parseCsv(summariesToCsv([sum]))[1]![header.indexOf('procedure_name')]).toBe("'@cmd");
  });
});
