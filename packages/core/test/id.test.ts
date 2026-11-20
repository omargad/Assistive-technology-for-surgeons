import { afterEach, describe, expect, it, vi } from 'vitest';
import { createId } from '../src/util/id';

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('createId', () => {
  it('returns RFC 4122 v4 UUIDs in canonical lowercase form', () => {
    for (let i = 0; i < 200; i++) expect(createId()).toMatch(UUID_V4);
  });

  it('does not repeat', () => {
    const ids = new Set(Array.from({ length: 5000 }, () => createId()));
    expect(ids.size).toBe(5000);
  });

  it('prefers crypto.randomUUID when present (called as a method)', () => {
    const fake = {
      randomUUID(this: unknown) {
        if (this !== fake) throw new TypeError('Illegal invocation');
        return '6F9619FF-8B86-4D01-B42D-00CF4FC964FF';
      },
      getRandomValues: vi.fn(),
    };
    vi.stubGlobal('crypto', fake);
    expect(createId()).toBe('6f9619ff-8b86-4d01-b42d-00cf4fc964ff');
    expect(fake.getRandomValues).not.toHaveBeenCalled();
  });

  it('falls back to crypto.getRandomValues and sets version/variant bits', () => {
    vi.stubGlobal('crypto', {
      getRandomValues<T extends Uint8Array>(a: T): T {
        a.fill(0xff);
        return a;
      },
    });
    expect(createId()).toBe('ffffffff-ffff-4fff-bfff-ffffffffffff');

    vi.stubGlobal('crypto', {
      getRandomValues<T extends Uint8Array>(a: T): T {
        a.fill(0x00);
        return a;
      },
    });
    expect(createId()).toBe('00000000-0000-4000-8000-000000000000');
  });

  it('falls back when randomUUID throws or returns something that is not a v4 UUID', () => {
    const getRandomValues = <T extends Uint8Array>(a: T): T => {
      for (let i = 0; i < a.length; i++) a[i] = i * 16 + i;
      return a;
    };
    vi.stubGlobal('crypto', {
      randomUUID: () => {
        throw new Error('not a secure context');
      },
      getRandomValues,
    });
    expect(createId()).toBe('00112233-4455-4677-8899-aabbccddeeff');

    vi.stubGlobal('crypto', { randomUUID: () => 'not-a-uuid', getRandomValues });
    expect(createId()).toBe('00112233-4455-4677-8899-aabbccddeeff');
  });

  it('falls back to Math.random when there is no crypto at all (bare Hermes)', () => {
    vi.stubGlobal('crypto', undefined);
    const random = vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const id = createId();
    expect(random).toHaveBeenCalledTimes(16);
    expect(id).toBe('80808080-8080-4080-8080-808080808080');
    expect(id).toMatch(UUID_V4);
  });

  it('falls back to Math.random when getRandomValues throws', () => {
    vi.stubGlobal('crypto', {
      getRandomValues: () => {
        throw new Error('no entropy');
      },
    });
    vi.spyOn(Math, 'random').mockReturnValue(0);
    expect(createId()).toBe('00000000-0000-4000-8000-000000000000');
  });
});
