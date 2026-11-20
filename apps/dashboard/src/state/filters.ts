/**
 * Session filters shared by the Overview, Sessions, Analysis and Export pages.
 *
 * Filters run on lightweight per-session "facets" derived from the raw
 * session (not the summary), so the sessions table can filter rows while
 * summaries are still being computed.
 */
import { APPROACH_LABELS, ROLE_LABELS } from '@surgeonpulse/core';
import type { SurgeonRole, SurgicalApproach, SurgicalSession } from '@surgeonpulse/core';
import { fmtDate, lookup } from '../lib/format';

/** Filter values as entered in the filter bar. Empty string means "any". */
export interface SessionFilters {
  participant: string;
  procedure: string;
  specialty: string;
  approach: string;
  role: string;
  /** Inclusive start date, `YYYY-MM-DD` in the recording's local date. */
  from: string;
  /** Inclusive end date, `YYYY-MM-DD`. */
  to: string;
  /** Case-insensitive free-text search. */
  search: string;
}

export const EMPTY_FILTERS: Readonly<SessionFilters> = Object.freeze({
  participant: '',
  procedure: '',
  specialty: '',
  approach: '',
  role: '',
  from: '',
  to: '',
  search: '',
});

/** Fields of a session used for filtering, sorting and listing. */
export interface SessionFacets {
  id: string;
  participantCode: string;
  procedureName: string;
  specialty?: string;
  approach?: SurgicalApproach;
  role?: SurgeonRole;
  startedAt: number;
  tzOffsetMin?: number;
  /** `YYYY-MM-DD` in the recording's local date (UTC when unknown). */
  localDate: string;
  /** Lower-cased text the free-text search matches against. */
  searchText: string;
  simulated: boolean;
}

/** Derive {@link SessionFacets} from a session. */
export function sessionFacets(s: SurgicalSession): SessionFacets {
  const p = s.procedure;
  const facets: SessionFacets = {
    id: s.id,
    participantCode: s.participantCode,
    procedureName: p.name,
    startedAt: s.startedAt,
    localDate: fmtDate(s.startedAt, s.tzOffsetMin),
    searchText: [
      s.id,
      s.participantCode,
      p.name,
      p.specialty ?? '',
      p.approach ? lookup(APPROACH_LABELS, p.approach) : '',
      p.role ? lookup(ROLE_LABELS, p.role) : '',
      ...(s.tags ?? []),
    ]
      .join('\n')
      .toLowerCase(),
    simulated: s.sensor.source === 'simulated',
  };
  if (p.specialty !== undefined) facets.specialty = p.specialty;
  if (p.approach !== undefined) facets.approach = p.approach;
  if (p.role !== undefined) facets.role = p.role;
  if (s.tzOffsetMin !== undefined) facets.tzOffsetMin = s.tzOffsetMin;
  return facets;
}

/** Whether one session passes all filters. */
export function matchesFilters(f: SessionFacets, filters: SessionFilters): boolean {
  if (filters.participant !== '' && f.participantCode !== filters.participant) return false;
  if (filters.procedure !== '' && f.procedureName !== filters.procedure) return false;
  if (filters.specialty !== '' && (f.specialty ?? '') !== filters.specialty) return false;
  if (filters.approach !== '' && (f.approach ?? '') !== filters.approach) return false;
  if (filters.role !== '' && (f.role ?? '') !== filters.role) return false;
  if (filters.from !== '' && f.localDate < filters.from) return false;
  if (filters.to !== '' && f.localDate > filters.to) return false;
  const q = filters.search.trim().toLowerCase();
  if (q !== '') {
    // Every whitespace-separated term must match somewhere.
    for (const term of q.split(/\s+/)) if (!f.searchText.includes(term)) return false;
  }
  return true;
}

/** Keep the rows that pass all filters (order preserved). */
export function applyFilters<T extends SessionFacets>(rows: readonly T[], filters: SessionFilters): T[] {
  if (activeFilterCount(filters) === 0) return rows.slice();
  return rows.filter((r) => matchesFilters(r, filters));
}

/** Number of filters that are set. */
export function activeFilterCount(filters: SessionFilters): number {
  let n = 0;
  for (const key of Object.keys(EMPTY_FILTERS) as (keyof SessionFilters)[]) {
    if (filters[key].trim() !== '') n++;
  }
  return n;
}

/** Distinct values available for each select in the filter bar. */
export interface FilterOptions {
  participants: string[];
  procedures: string[];
  specialties: string[];
  approaches: SurgicalApproach[];
  roles: SurgeonRole[];
  minDate: string;
  maxDate: string;
}

/** Locale-independent string order (identical on every platform). */
export function compareText(a: string, b: string): number {
  const la = a.toLowerCase();
  const lb = b.toLowerCase();
  if (la < lb) return -1;
  if (la > lb) return 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

function distinct<T extends string>(values: Iterable<T | undefined>): T[] {
  const set = new Set<T>();
  for (const v of values) if (v !== undefined && v !== '') set.add(v);
  return [...set].sort(compareText);
}

/** Collect filter options from all sessions. */
export function filterOptions(rows: readonly SessionFacets[]): FilterOptions {
  let minDate = '';
  let maxDate = '';
  for (const r of rows) {
    if (minDate === '' || r.localDate < minDate) minDate = r.localDate;
    if (maxDate === '' || r.localDate > maxDate) maxDate = r.localDate;
  }
  return {
    participants: distinct(rows.map((r) => r.participantCode)),
    procedures: distinct(rows.map((r) => r.procedureName)),
    specialties: distinct(rows.map((r) => r.specialty)),
    approaches: distinct(rows.map((r) => r.approach)),
    roles: distinct(rows.map((r) => r.role)),
    minDate,
    maxDate,
  };
}

/** One-line description of the active filters, for banners and copied summaries. */
export function describeFilters(filters: SessionFilters): string {
  const parts: string[] = [];
  if (filters.participant) parts.push(`participant ${filters.participant}`);
  if (filters.procedure) parts.push(`procedure "${filters.procedure}"`);
  if (filters.specialty) parts.push(`specialty ${filters.specialty}`);
  if (filters.approach) parts.push(`approach ${lookup(APPROACH_LABELS, filters.approach)}`);
  if (filters.role) parts.push(`role ${lookup(ROLE_LABELS, filters.role)}`);
  if (filters.from && filters.to) parts.push(`${filters.from} to ${filters.to}`);
  else if (filters.from) parts.push(`from ${filters.from}`);
  else if (filters.to) parts.push(`until ${filters.to}`);
  if (filters.search.trim()) parts.push(`matching "${filters.search.trim()}"`);
  return parts.length === 0 ? 'all sessions' : parts.join(', ');
}
