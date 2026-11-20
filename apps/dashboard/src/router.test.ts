import { describe, expect, it } from 'vitest';
import { hrefs, parseHash, routeHref, sectionOf } from './router';
import type { Route } from './router';

describe('hash router', () => {
  it('parses every route', () => {
    expect(parseHash('')).toEqual({ name: 'overview' });
    expect(parseHash('#/')).toEqual({ name: 'overview' });
    expect(parseHash('#/overview')).toEqual({ name: 'overview' });
    expect(parseHash('#/sessions')).toEqual({ name: 'sessions' });
    expect(parseHash('#/sessions/abc-123')).toEqual({ name: 'session', id: 'abc-123' });
    expect(parseHash('#/participants')).toEqual({ name: 'participants' });
    expect(parseHash('#/participants/SP-014')).toEqual({ name: 'participant', code: 'SP-014' });
    expect(parseHash('#/analysis')).toEqual({ name: 'analysis' });
    expect(parseHash('#/export')).toEqual({ name: 'export' });
    expect(parseHash('#/data')).toEqual({ name: 'data' });
    expect(parseHash('#/data?x=1')).toEqual({ name: 'data' });
  });

  it('reports unknown or malformed paths', () => {
    expect(parseHash('#/nope')).toEqual({ name: 'not-found', path: '/nope' });
    expect(parseHash('#/export/extra')).toMatchObject({ name: 'not-found' });
    expect(parseHash('#/sessions/a/b')).toMatchObject({ name: 'not-found' });
    expect(parseHash('#/sessions/%E0%A4%A')).toMatchObject({ name: 'not-found' });
  });

  it('round-trips hrefs, encoding ids', () => {
    const routes: Route[] = [
      { name: 'overview' },
      { name: 'sessions' },
      { name: 'session', id: 'a b/c' },
      { name: 'participants' },
      { name: 'participant', code: 'SP_01' },
      { name: 'analysis' },
      { name: 'export' },
      { name: 'data' },
    ];
    for (const r of routes) expect(parseHash(routeHref(r))).toEqual(r);
    expect(hrefs.session('a b')).toBe('#/sessions/a%20b');
  });

  it('maps detail pages to their nav section', () => {
    expect(sectionOf({ name: 'session', id: 'x' })).toBe('sessions');
    expect(sectionOf({ name: 'participant', code: 'x' })).toBe('participants');
    expect(sectionOf({ name: 'not-found', path: '' })).toBeNull();
  });
});
