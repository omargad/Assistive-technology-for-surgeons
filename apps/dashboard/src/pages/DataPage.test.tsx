import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { STORAGE_KEYS } from '../lib/storage';
import { loadServerSettings, saveServerSettings } from '../lib/serverSettings';
import { initialState } from '../state/reducer';
import { DashboardProvider } from '../state/store';
import { DataPage } from './DataPage';

const TOKEN = 'admin-token-0123456789abcdef-0123456789';

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

// SEC-4: "Clear all data" left a remembered admin token in localStorage.
describe('Data page "Clear all data"', () => {
  it('forgets a remembered admin token, even when no data is loaded', () => {
    saveServerSettings({ url: 'https://study.example.edu', token: TOKEN, remember: true });
    expect(window.localStorage.getItem(STORAGE_KEYS.serverToken)).toBe(TOKEN);
    render(
      <DashboardProvider initial={initialState}>
        <DataPage />
      </DashboardProvider>,
    );
    const token = screen.getByLabelText('Admin token') as HTMLInputElement;
    expect(token.value).toBe(TOKEN);

    const clear = screen.getByRole('button', { name: 'Clear all data' }) as HTMLButtonElement;
    expect(clear.disabled).toBe(false);
    fireEvent.click(clear);
    fireEvent.click(screen.getByRole('button', { name: 'Yes, clear everything' }));

    expect(window.localStorage.getItem(STORAGE_KEYS.serverToken)).toBeNull();
    expect(loadServerSettings()).toEqual({ url: 'https://study.example.edu', token: '', remember: false });
    expect((screen.getByLabelText('Admin token') as HTMLInputElement).value).toBe('');
    expect((screen.getByRole('button', { name: 'Clear all data' }) as HTMLButtonElement).disabled).toBe(true);
  });
});
