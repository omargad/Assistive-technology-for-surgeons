/**
 * Sorting helpers for tables: stable, locale-independent, missing values last.
 */
import { compareText } from '../state/filters';

export type SortDirection = 'asc' | 'desc';
export type SortValue = number | string | null | undefined;

/** Compare two sort values; missing values last in both directions. */
export function compareSortValues(a: SortValue, b: SortValue, direction: SortDirection): number {
  const aMissing = a === null || a === undefined || (typeof a === 'number' && !Number.isFinite(a)) || a === '';
  const bMissing = b === null || b === undefined || (typeof b === 'number' && !Number.isFinite(b)) || b === '';
  if (aMissing && bMissing) return 0;
  if (aMissing) return 1;
  if (bMissing) return -1;
  const sign = direction === 'asc' ? 1 : -1;
  if (typeof a === 'number' && typeof b === 'number') return sign * (a - b);
  return sign * compareText(String(a), String(b));
}

/** Stable sort of rows by a column. */
export function sortRows<T>(
  rows: readonly T[],
  getValue: ((row: T) => SortValue) | undefined,
  direction: SortDirection,
): T[] {
  if (getValue === undefined) return rows.slice();
  return rows
    .map((row, index) => ({ row, index, value: getValue(row) }))
    .sort((a, b) => compareSortValues(a.value, b.value, direction) || a.index - b.index)
    .map((x) => x.row);
}
