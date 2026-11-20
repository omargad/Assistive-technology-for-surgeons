/**
 * Accessible, sortable, paginated table.
 *
 * - Sortable headers are real `<button>`s inside `<th aria-sort>`, so sorting
 *   works with keyboard, touch and screen readers.
 * - Missing values always sort last, whatever the direction.
 * - Above `paginateAbove` rows (default 200) the table paginates.
 * - The scroll container is focusable so keyboard users can scroll wide
 *   tables horizontally (WCAG 2.1.1).
 */
import { useMemo, useState } from 'react';
import type { MouseEvent, ReactNode } from 'react';
import { sortRows } from '../lib/sort';
import type { SortDirection, SortValue } from '../lib/sort';

export interface Column<T> {
  id: string;
  header: ReactNode;
  /** Accessible name / tooltip for abbreviated headers. */
  title?: string;
  cell: (row: T) => ReactNode;
  /** Value used for sorting; omit to make the column unsortable. */
  sortValue?: (row: T) => SortValue;
  align?: 'left' | 'right';
  /** Render as a row header (`<th scope="row">`). */
  rowHeader?: boolean;
}

export interface SortState {
  id: string;
  direction: SortDirection;
}

export interface DataTableProps<T> {
  rows: readonly T[];
  columns: readonly Column<T>[];
  rowKey: (row: T) => string;
  /** Table caption (visually hidden unless `showCaption`). */
  caption: string;
  showCaption?: boolean;
  initialSort?: SortState;
  /** Controlled sort (optional). */
  sort?: SortState;
  onSortChange?: (sort: SortState) => void;
  /** Paginate when there are more rows than this. Default 200. */
  paginateAbove?: number;
  pageSize?: number;
  /** Mouse/touch convenience; keyboard users use the link inside the row. */
  onRowClick?: (row: T) => void;
  emptyMessage?: ReactNode;
  compact?: boolean;
  /** Extra class on the wrapper. */
  className?: string;
  testId?: string;
}

/** Sortable, paginated data table. */
export function DataTable<T>({
  rows,
  columns,
  rowKey,
  caption,
  showCaption = false,
  initialSort,
  sort: controlledSort,
  onSortChange,
  paginateAbove = 200,
  pageSize = 100,
  onRowClick,
  emptyMessage = 'No rows to show.',
  compact = false,
  className,
  testId,
}: DataTableProps<T>) {
  const [ownSort, setOwnSort] = useState<SortState | undefined>(initialSort);
  const sort = controlledSort ?? ownSort;
  const [page, setPage] = useState(0);

  const sorted = useMemo(() => {
    if (sort === undefined) return rows.slice();
    return sortRows(rows, columns.find((c) => c.id === sort.id)?.sortValue, sort.direction);
  }, [rows, columns, sort]);

  const paginated = sorted.length > paginateAbove;
  const pageCount = paginated ? Math.ceil(sorted.length / pageSize) : 1;
  const currentPage = Math.min(page, pageCount - 1);
  const visible = paginated ? sorted.slice(currentPage * pageSize, (currentPage + 1) * pageSize) : sorted;

  const toggleSort = (col: Column<T>): void => {
    const next: SortState =
      sort?.id === col.id
        ? { id: col.id, direction: sort.direction === 'asc' ? 'desc' : 'asc' }
        : { id: col.id, direction: 'asc' };
    if (onSortChange) onSortChange(next);
    if (controlledSort === undefined) setOwnSort(next);
    setPage(0);
  };

  const handleRowClick = (event: MouseEvent<HTMLTableRowElement>, row: T): void => {
    if (onRowClick === undefined) return;
    // Let real interactive elements (links, buttons) handle their own clicks.
    if ((event.target as HTMLElement).closest('a, button, input, select, textarea, label')) return;
    // Do not hijack text selection.
    if (window.getSelection()?.toString()) return;
    onRowClick(row);
  };

  return (
    <div className={`table-block${className ? ` ${className}` : ''}`} data-testid={testId}>
      <div className="table-wrap" tabIndex={0} role="region" aria-label={caption}>
        <table className={`data-table${compact ? ' data-table--compact' : ''}${onRowClick ? ' data-table--clickable' : ''}`}>
          <caption className={showCaption ? 'data-table__caption' : 'visually-hidden'}>{caption}</caption>
          <thead>
            <tr>
              {columns.map((col) => {
                const active = sort?.id === col.id;
                const ariaSort = active ? (sort.direction === 'asc' ? 'ascending' : 'descending') : undefined;
                return (
                  <th
                    key={col.id}
                    scope="col"
                    aria-sort={col.sortValue ? (ariaSort ?? 'none') : undefined}
                    className={col.align === 'right' ? 'num' : undefined}
                    title={col.title}
                  >
                    {col.sortValue ? (
                      <button type="button" className="sort-button" onClick={() => toggleSort(col)}>
                        <span>{col.header}</span>
                        <span className={`sort-indicator${active ? ' sort-indicator--active' : ''}`} aria-hidden="true">
                          {active ? (sort.direction === 'asc' ? '▲' : '▼') : '↕'}
                        </span>
                      </button>
                    ) : (
                      col.header
                    )}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {visible.length === 0 ? (
              <tr>
                <td colSpan={columns.length} className="data-table__empty">
                  {emptyMessage}
                </td>
              </tr>
            ) : (
              visible.map((row) => (
                <tr key={rowKey(row)} onClick={onRowClick ? (e) => handleRowClick(e, row) : undefined}>
                  {columns.map((col) =>
                    col.rowHeader ? (
                      <th key={col.id} scope="row" className={col.align === 'right' ? 'num' : undefined}>
                        {col.cell(row)}
                      </th>
                    ) : (
                      <td key={col.id} className={col.align === 'right' ? 'num' : undefined}>
                        {col.cell(row)}
                      </td>
                    ),
                  )}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
      {paginated && (
        <nav className="pagination" aria-label={`${caption} pages`}>
          <button type="button" className="btn btn--small" onClick={() => setPage(0)} disabled={currentPage === 0}>
            First
          </button>
          <button
            type="button"
            className="btn btn--small"
            onClick={() => setPage(currentPage - 1)}
            disabled={currentPage === 0}
          >
            Previous
          </button>
          <span className="pagination__status" aria-live="polite">
            Page {currentPage + 1} of {pageCount} · rows {currentPage * pageSize + 1}–
            {Math.min(sorted.length, (currentPage + 1) * pageSize)} of {sorted.length}
          </span>
          <button
            type="button"
            className="btn btn--small"
            onClick={() => setPage(currentPage + 1)}
            disabled={currentPage >= pageCount - 1}
          >
            Next
          </button>
          <button
            type="button"
            className="btn btn--small"
            onClick={() => setPage(pageCount - 1)}
            disabled={currentPage >= pageCount - 1}
          >
            Last
          </button>
        </nav>
      )}
    </div>
  );
}
