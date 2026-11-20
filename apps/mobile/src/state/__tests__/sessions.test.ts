/// <reference types="jest" />
import { createExportBundle, createSession } from '@surgeonpulse/core';
import type { SurgicalSession } from '@surgeonpulse/core';
import { createMemoryRepository } from '../../services/storage/memory';
import { DEMO_TAG, createSessionsStore } from '../sessions';

jest.mock('../../services/storage', () => ({ repository: {} }));

const T0 = Date.UTC(2026, 2, 2, 8, 0, 0);

function session(id: string, status: SurgicalSession['status'] = 'completed'): SurgicalSession {
  return {
    ...createSession({
      id,
      participantCode: 'SP-014',
      procedure: { name: 'Laparoscopic cholecystectomy', catalogId: 'laparoscopic-cholecystectomy' },
      sensor: { source: 'ble' },
      app: { version: '0.1.0', platform: 'ios' },
      startedAt: T0,
    }),
    status,
    ...(status === 'completed' ? { endedAt: T0 + 120_000 } : {}),
    samples: Array.from({ length: 120 }, (_, i) => ({ t: T0 + i * 1000, bpm: 70 + (i % 10) })),
  };
}

describe('sessions store', () => {
  it('refreshes the list and profile, saves the profile and deletes sessions', async () => {
    const repo = createMemoryRepository();
    await repo.saveSession(session('a'));
    const store = createSessionsStore({ repository: repo });
    await store.getState().refresh();
    expect(store.getState().items.map((i) => i.meta.id)).toEqual(['a']);
    expect(store.getState().loading).toBe(false);

    await store.getState().saveProfile({ code: 'SP-014' });
    expect(store.getState().profile).toEqual({ code: 'SP-014' });
    expect(await repo.getProfile()).toEqual({ code: 'SP-014' });

    await store.getState().deleteSession('a');
    expect(store.getState().items).toEqual([]);

    await repo.saveSession(session('b'));
    await store.getState().refresh();
    await store.getState().deleteAll();
    expect(store.getState().items).toEqual([]);
    expect(await repo.getProfile()).toEqual({ code: 'SP-014' }); // profile is kept
  });

  it('imports an export bundle, summarising each session', async () => {
    const repo = createMemoryRepository();
    const store = createSessionsStore({ repository: repo });
    const bundle = createExportBundle({ sessions: [session('x'), session('y', 'recording')], deidentify: true, now: T0 });
    const result = await store.getState().importBundle(JSON.stringify(bundle));
    expect(result.imported).toBe(2);
    expect(result.warnings.some((w) => w.includes('still recording'))).toBe(true);
    const items = store.getState().items;
    expect(items).toHaveLength(2);
    expect(items.every((i) => i.summary !== null && i.meta.status === 'completed')).toBe(true);
    // Imported sessions are never offered as interrupted recordings.
    expect(await repo.findInterrupted()).toEqual([]);
  });

  it('rejects files that are not SurgeonPulse exports', async () => {
    const store = createSessionsStore({ repository: createMemoryRepository() });
    await expect(store.getState().importBundle('not json')).rejects.toThrow(/not a valid SurgeonPulse export/);
  });

  it('loads tagged demo data for the current participant, replacing earlier demo data', async () => {
    const repo = createMemoryRepository();
    await repo.saveProfile({ code: 'SP-014' });
    await repo.saveSession(session('real'));
    const store = createSessionsStore({ repository: repo, now: () => T0 });
    await store.getState().loadDemoData();
    const demo = store.getState().items.filter((i) => i.meta.tags?.includes(DEMO_TAG));
    expect(demo.length).toBeGreaterThan(0);
    expect(demo.every((i) => i.meta.participantCode === 'SP-014' && i.summary !== null)).toBe(true);
    expect(demo.every((i) => i.meta.startedAt < T0)).toBe(true);

    await store.getState().loadDemoData();
    const again = store.getState().items.filter((i) => i.meta.tags?.includes(DEMO_TAG));
    expect(again).toHaveLength(demo.length);
    expect(store.getState().items.some((i) => i.meta.id === 'real')).toBe(true);
  });
});
