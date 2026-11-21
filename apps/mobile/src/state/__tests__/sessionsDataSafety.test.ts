/// <reference types="jest" />
/**
 * Data-safety rules of the sessions store:
 * - SP-MOB-5: importing a file never replaces a session that is already on the device (e.g. the app's
 *   own de-identified export would otherwise overwrite notes, custom procedure names and upload tags).
 * - SP-MOB-6: the session the recording flow owns cannot be deleted (alone or with "Delete all data").
 * - M2: "Remove demo data" deletes only demo-tagged sessions (never own or imported sessions, the profile, or the
 *   session the recording flow owns).
 */
import { createExportBundle, createSession } from '@surgeonpulse/core';
import type { SurgicalSession } from '@surgeonpulse/core';
import { createMemoryRepository } from '../../services/storage/memory';
import { CASE_IN_PROGRESS_ERROR, DEMO_TAG, createSessionsStore } from '../sessions';

jest.mock('../../services/storage', () => ({ repository: {} }));

const T0 = Date.UTC(2026, 2, 2, 8, 0, 0);

function session(id: string): SurgicalSession {
  return {
    ...createSession({
      id,
      participantCode: 'SP-014',
      procedure: { name: 'Whipple, pylorus-preserving (my variant)' },
      sensor: { source: 'ble', id: 'AA:BB:CC', name: 'Polar H10' },
      app: { version: '0.1.0', platform: 'ios' },
      startedAt: T0,
    }),
    status: 'completed',
    endedAt: T0 + 120_000,
    tags: ['uploaded:2026-03-02T09:00:00.000Z'],
    events: [{ id: 'e1', t: T0 + 10_000, type: 'marker', marker: 'complication', note: 'bleeding from the cystic artery' }],
    postOp: { notes: 'Difficult anatomy' },
    samples: Array.from({ length: 120 }, (_, i) => ({ t: T0 + i * 1000, bpm: 70 + (i % 10) })),
  };
}

describe('sessions store data safety', () => {
  it('importing the app’s own de-identified export keeps the local sessions unchanged (SP-MOB-5)', async () => {
    const repo = createMemoryRepository();
    const local = session('a');
    await repo.saveSession(local);
    const store = createSessionsStore({ repository: repo });

    const exported = createExportBundle({ sessions: [local], deidentify: true, now: T0 + 3_600_000 });
    const result = await store.getState().importBundle(JSON.stringify(exported));

    expect(result.imported).toBe(0);
    expect(result.warnings).toEqual(expect.arrayContaining([expect.stringMatching(/already on this device/)]));
    const kept = await repo.getSession('a');
    expect(kept?.procedure.name).toBe(local.procedure.name);
    expect(kept?.postOp?.notes).toBe('Difficult anatomy');
    expect(kept?.events[0]?.note).toBe('bleeding from the cystic artery');
    expect(kept?.sensor.id).toBe('AA:BB:CC');
    expect(kept?.tags).toEqual(local.tags);
  });

  it('still imports new sessions from the same file, and a duplicated id only once', async () => {
    const repo = createMemoryRepository();
    await repo.saveSession(session('a'));
    const store = createSessionsStore({ repository: repo });
    const bundle = createExportBundle({ sessions: [session('a'), session('b'), session('b')], now: T0 });
    const result = await store.getState().importBundle(JSON.stringify(bundle));
    expect(result.imported).toBe(1);
    expect((await repo.listSessions()).map((i) => i.meta.id).sort()).toEqual(['a', 'b']);
  });

  it('never imports over the session the recording flow owns', async () => {
    const repo = createMemoryRepository();
    const store = createSessionsStore({ repository: repo, activeSessionId: () => 'live' });
    const bundle = createExportBundle({ sessions: [session('live')], now: T0 });
    const result = await store.getState().importBundle(JSON.stringify(bundle));
    expect(result.imported).toBe(0);
    expect(await repo.getSession('live')).toBeNull();
  });

  it('refuses to delete the session being recorded, or all data while a case is in progress (SP-MOB-6)', async () => {
    const repo = createMemoryRepository();
    await repo.saveSession(session('live'));
    await repo.saveSession(session('old'));
    let active: string | null = 'live';
    const store = createSessionsStore({ repository: repo, activeSessionId: () => active });

    await expect(store.getState().deleteSession('live')).rejects.toThrow(CASE_IN_PROGRESS_ERROR);
    await expect(store.getState().deleteAll()).rejects.toThrow(CASE_IN_PROGRESS_ERROR);
    expect((await repo.listSessions()).map((i) => i.meta.id).sort()).toEqual(['live', 'old']);

    await store.getState().deleteSession('old'); // other sessions can still be deleted
    expect((await repo.listSessions()).map((i) => i.meta.id)).toEqual(['live']);

    active = null; // the case has ended
    await store.getState().deleteSession('live');
    expect(await repo.listSessions()).toEqual([]);
  });

  it('"Remove demo data" deletes only demo-tagged sessions and keeps own sessions and the profile (M2)', async () => {
    const repo = createMemoryRepository();
    await repo.saveProfile({ code: 'SP-014', consent: { version: 'PICF-1.0', givenAt: T0 } });
    await repo.saveSession(session('own'));
    await repo.saveSession({ ...session('simulator'), tags: ['simulated'], sensor: { source: 'simulated' } });
    const store = createSessionsStore({ repository: repo, now: () => T0 });
    await store.getState().loadDemoData();
    const demoCount = store.getState().items.filter((i) => i.meta.tags?.includes(DEMO_TAG)).length;
    expect(demoCount).toBeGreaterThan(0);

    await expect(store.getState().removeDemoData()).resolves.toBe(demoCount);
    expect(store.getState().items.map((i) => i.meta.id).sort()).toEqual(['own', 'simulator']);
    expect((await repo.listSessions()).map((i) => i.meta.id).sort()).toEqual(['own', 'simulator']);
    expect((await repo.getSession('own'))?.postOp?.notes).toBe('Difficult anatomy');
    expect(await repo.getProfile()).toEqual({ code: 'SP-014', consent: { version: 'PICF-1.0', givenAt: T0 } });
    await expect(store.getState().removeDemoData()).resolves.toBe(0); // nothing left to remove
  });

  it('"Remove demo data" never deletes the session the recording flow owns (M2)', async () => {
    const repo = createMemoryRepository();
    await repo.saveSession({ ...session('live'), status: 'recording', tags: [DEMO_TAG] });
    await repo.saveSession({ ...session('demo-old'), tags: [DEMO_TAG] });
    const store = createSessionsStore({ repository: repo, activeSessionId: () => 'live' });
    await expect(store.getState().removeDemoData()).resolves.toBe(1);
    expect((await repo.listSessions()).map((i) => i.meta.id)).toEqual(['live']);
  });

  it('"Remove demo data" that fails part-way still lists the sessions it already deleted as gone (M2)', async () => {
    const repo = createMemoryRepository();
    for (const id of ['d1', 'd2', 'd3']) await repo.saveSession({ ...session(id), tags: [DEMO_TAG] });
    const store = createSessionsStore({ repository: repo });
    await store.getState().refresh();
    expect(store.getState().items).toHaveLength(3);

    const deleteSession = repo.deleteSession.bind(repo);
    let calls = 0;
    repo.deleteSession = async (id) => {
      if (++calls === 2) throw new Error('disk I/O error');
      await deleteSession(id);
    };
    await expect(store.getState().removeDemoData()).rejects.toThrow('disk I/O error');
    expect(store.getState().items).toHaveLength(2); // the first delete went through; the list says so
    expect(store.getState().items.map((i) => i.meta.id)).toEqual((await repo.listSessions()).map((i) => i.meta.id));
  });
});
