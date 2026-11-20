import { describe, expect, it } from 'vitest';
import { makeSession, withId } from '../test/fixtures';
import {
  EMPTY_FILTERS,
  activeFilterCount,
  applyFilters,
  compareText,
  describeFilters,
  filterOptions,
  matchesFilters,
  sessionFacets,
} from './filters';
import type { SessionFilters } from './filters';

const chole = withId(
  makeSession({
    seed: 1,
    participantCode: 'SP-001',
    dayOffset: 0,
    procedure: { name: 'Laparoscopic cholecystectomy', specialty: 'General surgery', approach: 'laparoscopic', role: 'primary' },
  }),
  'aaaa1111',
);
const hip = withId(
  makeSession({
    seed: 2,
    participantCode: 'SP-002',
    dayOffset: 10,
    procedure: { name: 'Total hip arthroplasty', specialty: 'Orthopaedics', approach: 'open', role: 'assistant' },
  }),
  'bbbb2222',
);
const rows = [chole, hip].map(sessionFacets);

function f(patch: Partial<SessionFilters>): SessionFilters {
  return { ...EMPTY_FILTERS, ...patch };
}

describe('session filters', () => {
  it('derives facets from the session', () => {
    expect(rows[0]).toMatchObject({
      id: 'aaaa1111',
      participantCode: 'SP-001',
      procedureName: 'Laparoscopic cholecystectomy',
      specialty: 'General surgery',
      approach: 'laparoscopic',
      role: 'primary',
      localDate: '2026-01-05',
      simulated: true,
    });
  });

  it('uses the recording timezone for the local date', () => {
    const late = { ...chole, startedAt: Date.UTC(2026, 0, 5, 22, 30), tzOffsetMin: 600 };
    expect(sessionFacets(late).localDate).toBe('2026-01-06');
  });

  it('passes everything with empty filters', () => {
    expect(applyFilters(rows, EMPTY_FILTERS)).toHaveLength(2);
    expect(activeFilterCount(EMPTY_FILTERS)).toBe(0);
  });

  it('filters by exact select values', () => {
    expect(applyFilters(rows, f({ participant: 'SP-002' })).map((r) => r.id)).toEqual(['bbbb2222']);
    expect(applyFilters(rows, f({ procedure: 'Laparoscopic cholecystectomy' })).map((r) => r.id)).toEqual(['aaaa1111']);
    expect(applyFilters(rows, f({ specialty: 'Orthopaedics' })).map((r) => r.id)).toEqual(['bbbb2222']);
    expect(applyFilters(rows, f({ approach: 'laparoscopic' })).map((r) => r.id)).toEqual(['aaaa1111']);
    expect(applyFilters(rows, f({ role: 'assistant' })).map((r) => r.id)).toEqual(['bbbb2222']);
    expect(applyFilters(rows, f({ role: 'supervising' }))).toEqual([]);
  });

  it('filters by an inclusive date range', () => {
    expect(applyFilters(rows, f({ from: '2026-01-05', to: '2026-01-05' })).map((r) => r.id)).toEqual(['aaaa1111']);
    expect(applyFilters(rows, f({ from: '2026-01-06' })).map((r) => r.id)).toEqual(['bbbb2222']);
    expect(applyFilters(rows, f({ to: '2026-01-14' })).map((r) => r.id)).toEqual(['aaaa1111']);
    expect(applyFilters(rows, f({ from: '2026-01-01', to: '2026-12-31' }))).toHaveLength(2);
  });

  it('searches case-insensitively across fields and requires every term', () => {
    expect(applyFilters(rows, f({ search: 'CHOLE' })).map((r) => r.id)).toEqual(['aaaa1111']);
    expect(applyFilters(rows, f({ search: 'sp-002' })).map((r) => r.id)).toEqual(['bbbb2222']);
    expect(applyFilters(rows, f({ search: 'open hip' })).map((r) => r.id)).toEqual(['bbbb2222']);
    expect(applyFilters(rows, f({ search: 'open chole' }))).toEqual([]);
    expect(applyFilters(rows, f({ search: 'bbbb' })).map((r) => r.id)).toEqual(['bbbb2222']);
    expect(matchesFilters(rows[0]!, f({ search: '   ' }))).toBe(true);
  });

  it('combines filters with AND', () => {
    expect(applyFilters(rows, f({ participant: 'SP-001', specialty: 'Orthopaedics' }))).toEqual([]);
    expect(activeFilterCount(f({ participant: 'SP-001', specialty: 'Orthopaedics', search: ' ' }))).toBe(2);
  });

  it('collects sorted distinct options and the date span', () => {
    const o = filterOptions(rows);
    expect(o.participants).toEqual(['SP-001', 'SP-002']);
    expect(o.procedures).toEqual(['Laparoscopic cholecystectomy', 'Total hip arthroplasty']);
    expect(o.approaches).toEqual(['laparoscopic', 'open']);
    expect(o.minDate).toBe('2026-01-05');
    expect(o.maxDate).toBe('2026-01-15');
  });

  it('describes active filters in words', () => {
    expect(describeFilters(EMPTY_FILTERS)).toBe('all sessions');
    expect(describeFilters(f({ participant: 'SP-001', approach: 'laparoscopic', from: '2026-01-01', to: '2026-02-01' }))).toBe(
      'participant SP-001, approach Laparoscopic, 2026-01-01 to 2026-02-01',
    );
  });

  it('orders text independently of locale', () => {
    expect(['b', 'B', 'a', 'Ä'].sort(compareText)).toEqual(['a', 'B', 'b', 'Ä']);
  });
});
