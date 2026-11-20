import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { compareSortValues, sortRows } from '../lib/sort';
import { DataTable } from './DataTable';
import type { Column } from './DataTable';

interface Row {
  id: string;
  name: string;
  value: number | null;
}

const rows: Row[] = [
  { id: '1', name: 'Bravo', value: 2 },
  { id: '2', name: 'alpha', value: null },
  { id: '3', name: 'Charlie', value: 1 },
];

const columns: Column<Row>[] = [
  { id: 'name', header: 'Name', rowHeader: true, sortValue: (r) => r.name, cell: (r) => <a href={`#/x/${r.id}`}>{r.name}</a> },
  { id: 'value', header: 'Value', align: 'right', sortValue: (r) => r.value, cell: (r) => (r.value === null ? '—' : r.value) },
  { id: 'plain', header: 'Plain', cell: () => 'x' },
];

function names(): string[] {
  return within(screen.getByRole('table')).getAllByRole('rowheader').map((c) => c.textContent ?? '');
}

describe('sorting helpers', () => {
  it('puts missing values last in both directions', () => {
    expect(compareSortValues(null, 1, 'asc')).toBeGreaterThan(0);
    expect(compareSortValues(null, 1, 'desc')).toBeGreaterThan(0);
    expect(compareSortValues(2, 1, 'desc')).toBeLessThan(0);
    expect(sortRows(rows, columns[1]!.sortValue, 'desc').map((r) => r.id)).toEqual(['1', '3', '2']);
    expect(sortRows(rows, columns[0]!.sortValue, 'asc').map((r) => r.id)).toEqual(['2', '1', '3']);
  });
});

describe('<DataTable>', () => {
  it('sorts with header buttons and exposes aria-sort', async () => {
    const user = userEvent.setup();
    render(<DataTable rows={rows} columns={columns} rowKey={(r) => r.id} caption="Test rows" />);
    expect(names()).toEqual(['Bravo', 'alpha', 'Charlie']);

    const valueHeader = screen.getByRole('columnheader', { name: /Value/ });
    expect(valueHeader.getAttribute('aria-sort')).toBe('none');
    await user.click(within(valueHeader).getByRole('button'));
    expect(valueHeader.getAttribute('aria-sort')).toBe('ascending');
    expect(names()).toEqual(['Charlie', 'Bravo', 'alpha']);

    await user.click(within(valueHeader).getByRole('button'));
    expect(valueHeader.getAttribute('aria-sort')).toBe('descending');
    expect(names()).toEqual(['Bravo', 'Charlie', 'alpha']);

    // Unsortable columns have no button and no aria-sort.
    const plain = screen.getByRole('columnheader', { name: 'Plain' });
    expect(plain.getAttribute('aria-sort')).toBeNull();
    expect(within(plain).queryByRole('button')).toBeNull();
  });

  it('is keyboard operable', async () => {
    const user = userEvent.setup();
    render(<DataTable rows={rows} columns={columns} rowKey={(r) => r.id} caption="Test rows" />);
    await user.tab(); // scroll region
    expect(document.activeElement?.getAttribute('role')).toBe('region');
    await user.tab(); // first sort button
    expect(document.activeElement?.textContent).toContain('Name');
    await user.keyboard('{Enter}');
    expect(names()).toEqual(['alpha', 'Bravo', 'Charlie']);
  });

  it('paginates above the threshold', async () => {
    const user = userEvent.setup();
    const many: Row[] = Array.from({ length: 25 }, (_, i) => ({ id: String(i), name: `Row ${String(i).padStart(2, '0')}`, value: i }));
    render(<DataTable rows={many} columns={columns} rowKey={(r) => r.id} caption="Many" paginateAbove={20} pageSize={10} />);
    expect(names()).toHaveLength(10);
    expect(screen.getByText(/Page 1 of 3/)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Next' }));
    expect(names()[0]).toBe('Row 10');
    await user.click(screen.getByRole('button', { name: 'Last' }));
    expect(names()).toHaveLength(5);
    expect((screen.getByRole('button', { name: 'Next' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('calls onRowClick for row clicks but not for links inside the row', async () => {
    const user = userEvent.setup();
    const onRowClick = vi.fn();
    render(<DataTable rows={rows} columns={columns} rowKey={(r) => r.id} caption="Rows" onRowClick={onRowClick} />);
    await user.click(screen.getAllByText('x')[0]!);
    expect(onRowClick).toHaveBeenCalledWith(rows[0]);
    await user.click(screen.getByRole('link', { name: 'alpha' }));
    expect(onRowClick).toHaveBeenCalledTimes(1);
  });

  it('shows an empty message', () => {
    render(<DataTable rows={[]} columns={columns} rowKey={(r) => r.id} caption="None" emptyMessage="Nothing here" />);
    expect(screen.getByText('Nothing here')).toBeTruthy();
  });
});
