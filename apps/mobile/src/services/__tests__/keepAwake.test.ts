/// <reference types="jest" />
/**
 * SP-MOB-8: on the web the browser releases the Screen Wake Lock whenever the page is hidden, so
 * the keep-awake controller requests it again each time the page becomes visible while recording.
 */
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';
import { createKeepAwake } from '../feedback';
import type { VisibilityTarget } from '../feedback';

jest.mock('expo-keep-awake', () => ({
  activateKeepAwakeAsync: jest.fn(async () => undefined),
  deactivateKeepAwake: jest.fn(async () => undefined),
}));
jest.mock('expo-haptics', () => ({}));

function fakeDocument() {
  const listeners = new Set<() => void>();
  const doc = {
    visibilityState: 'visible',
    addEventListener: jest.fn((_type: 'visibilitychange', l: () => void) => void listeners.add(l)),
    removeEventListener: jest.fn((_type: 'visibilitychange', l: () => void) => void listeners.delete(l)),
    set(state: 'visible' | 'hidden') {
      doc.visibilityState = state;
      for (const l of [...listeners]) l();
    },
    count: () => listeners.size,
  };
  return doc;
}

const activate = activateKeepAwakeAsync as jest.Mock;
const deactivate = deactivateKeepAwake as jest.Mock;

beforeEach(() => jest.clearAllMocks());

describe('keep-awake controller', () => {
  it('re-acquires the wake lock each time the page becomes visible while active', () => {
    const doc = fakeDocument();
    const keepAwake = createKeepAwake('recording', doc as VisibilityTarget);
    keepAwake.activate();
    keepAwake.activate(); // idempotent
    expect(activate).toHaveBeenCalledTimes(1);

    doc.set('hidden'); // the browser releases the lock
    expect(activate).toHaveBeenCalledTimes(1);
    doc.set('visible');
    expect(activate).toHaveBeenCalledTimes(2);
    expect(activate).toHaveBeenLastCalledWith('recording');

    doc.set('hidden');
    doc.set('visible');
    expect(activate).toHaveBeenCalledTimes(3);
  });

  it('stops listening and releases the lock when deactivated', () => {
    const doc = fakeDocument();
    const keepAwake = createKeepAwake('recording', doc as VisibilityTarget);
    keepAwake.activate();
    keepAwake.deactivate();
    expect(deactivate).toHaveBeenCalledWith('recording');
    expect(doc.count()).toBe(0);
    doc.set('hidden');
    doc.set('visible');
    expect(activate).toHaveBeenCalledTimes(1);
  });

  it('a request rejected while the page was hidden is retried when it becomes visible', async () => {
    const doc = fakeDocument();
    doc.visibilityState = 'hidden';
    activate.mockRejectedValueOnce(new Error('NotAllowedError: page not visible'));
    const keepAwake = createKeepAwake('recording', doc as VisibilityTarget);
    keepAwake.activate();
    await Promise.resolve();
    doc.set('visible');
    expect(activate).toHaveBeenCalledTimes(2);
  });

  it('works without a document (iOS / Android)', () => {
    const keepAwake = createKeepAwake('recording', null);
    keepAwake.activate();
    keepAwake.deactivate();
    expect(activate).toHaveBeenCalledTimes(1);
    expect(deactivate).toHaveBeenCalledTimes(1);
  });
});
