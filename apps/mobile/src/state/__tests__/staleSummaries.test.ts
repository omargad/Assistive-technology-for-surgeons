/// <reference types="jest" />
/**
 * Cached summaries computed by older analytics definitions are recomputed in the background after a
 * refresh, so History, Insights and the summaries CSV never mix two definitions (follows RV-13: an
 * analytics change must reach every stored summary, on the phone as on the server).
 */
import { ANALYTICS_VERSION, simulateSession, summarizeSession } from '@surgeonpulse/core';
import { createMemoryRepository } from '../../services/storage/memory';
import { createSessionsStore } from '../sessions';

jest.mock('../../services/storage', () => ({ repository: {} }));

async function settle() {
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
}

describe('stale cached summaries', () => {
  it('recomputes summaries from an older analytics version and leaves current ones alone', async () => {
    const repo = createMemoryRepository();
    const old = { ...simulateSession({ seed: 3, durationMin: 10, participantCode: 'SP-001' }), id: 'old' };
    const current = { ...simulateSession({ seed: 4, durationMin: 10, participantCode: 'SP-001' }), id: 'current' };
    await repo.saveSession(old);
    await repo.saveSession(current);
    const legacy = { ...summarizeSession(old), stressIndex: 1 } as Record<string, unknown>;
    delete legacy.analyticsVersion;
    await repo.saveSummary(old.id, legacy as unknown as ReturnType<typeof summarizeSession>);
    const fresh = summarizeSession(current);
    await repo.saveSummary(current.id, fresh);
    const save = jest.spyOn(repo, 'saveSummary');

    const store = createSessionsStore({ repository: repo });
    await store.getState().refresh();
    await settle();

    const byId = new Map(store.getState().items.map((i) => [i.meta.id, i.summary]));
    expect(byId.get('old')?.analyticsVersion).toBe(ANALYTICS_VERSION);
    expect(byId.get('old')?.stressIndex).toBe(summarizeSession(old).stressIndex);
    expect(save).toHaveBeenCalledTimes(1);
    expect(save.mock.calls[0]![0]).toBe('old');
    expect(byId.get('current')).toEqual(fresh);
  });
});
