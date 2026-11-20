/**
 * Minimal hash router.
 *
 * Hash URLs (`#/sessions/abc`) work on any static host, in a sub-directory,
 * and without server rewrites, which suits university web space and
 * intranet shares. Routes:
 * `#/overview`, `#/sessions`, `#/sessions/:id`, `#/participants`,
 * `#/participants/:code`, `#/analysis`, `#/export`, `#/data`.
 */
import { useSyncExternalStore } from 'react';

export type Route =
  | { name: 'overview' }
  | { name: 'sessions' }
  | { name: 'session'; id: string }
  | { name: 'participants' }
  | { name: 'participant'; code: string }
  | { name: 'analysis' }
  | { name: 'export' }
  | { name: 'data' }
  | { name: 'not-found'; path: string };

/** Top-level sections shown in the navigation. */
export type Section = 'overview' | 'sessions' | 'participants' | 'analysis' | 'export' | 'data';

function safeDecode(segment: string): string | null {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}

/** Parse a location hash (with or without the leading `#`). */
export function parseHash(hash: string): Route {
  const path = hash.replace(/^#/, '').replace(/[?].*$/, '');
  const parts = path.split('/').filter((p) => p !== '');
  if (parts.length === 0) return { name: 'overview' };
  const [head, arg, ...rest] = parts;
  if (rest.length > 0) return { name: 'not-found', path };
  switch (head) {
    case 'overview':
    case 'analysis':
    case 'export':
    case 'data':
      return arg === undefined ? { name: head } : { name: 'not-found', path };
    case 'sessions': {
      if (arg === undefined) return { name: 'sessions' };
      const id = safeDecode(arg);
      return id === null ? { name: 'not-found', path } : { name: 'session', id };
    }
    case 'participants': {
      if (arg === undefined) return { name: 'participants' };
      const code = safeDecode(arg);
      return code === null ? { name: 'not-found', path } : { name: 'participant', code };
    }
    default:
      return { name: 'not-found', path };
  }
}

/** The `href` for a route (`#/…`). */
export function routeHref(route: Route): string {
  switch (route.name) {
    case 'session':
      return `#/sessions/${encodeURIComponent(route.id)}`;
    case 'participant':
      return `#/participants/${encodeURIComponent(route.code)}`;
    case 'not-found':
      return `#/${route.path.replace(/^\//, '')}`;
    default:
      return `#/${route.name}`;
  }
}

/** Shorthand hrefs. */
export const hrefs = {
  overview: '#/overview',
  sessions: '#/sessions',
  participants: '#/participants',
  analysis: '#/analysis',
  export: '#/export',
  data: '#/data',
  session: (id: string) => routeHref({ name: 'session', id }),
  participant: (code: string) => routeHref({ name: 'participant', code }),
} as const;

/** The navigation section a route belongs to. */
export function sectionOf(route: Route): Section | null {
  switch (route.name) {
    case 'session':
      return 'sessions';
    case 'participant':
      return 'participants';
    case 'not-found':
      return null;
    default:
      return route.name;
  }
}

/** Navigate to a route or href (adds a history entry). */
export function navigate(to: Route | string): void {
  const href = typeof to === 'string' ? to : routeHref(to);
  if (window.location.hash !== href) window.location.hash = href;
}

function subscribe(onChange: () => void): () => void {
  window.addEventListener('hashchange', onChange);
  return () => window.removeEventListener('hashchange', onChange);
}

const getHash = (): string => window.location.hash;
const getServerHash = (): string => '';

/** Current route, re-rendering on `hashchange`. */
export function useRoute(): Route {
  const hash = useSyncExternalStore(subscribe, getHash, getServerHash);
  return parseHash(hash);
}
