/**
 * Application shell: skip link, navigation (sidebar on wide screens, top bar
 * under 900 px), data status, theme switch and the main region.
 *
 * After each route change focus moves to the page's `<h1>` so screen-reader
 * and keyboard users land on the new content, as they would with a full
 * page load.
 */
import { useEffect, useRef } from 'react';
import type { ReactNode } from 'react';
import { hrefs, routeHref, sectionOf } from '../../router';
import type { Route, Section } from '../../router';
import { useTheme } from '../../lib/useTheme';
import type { ThemePreference } from '../../lib/useTheme';
import { useDashboardState, useDerived } from '../../state/hooks';
import { plural } from '../../lib/format';
import { SimulatedBadge } from '../ui';

interface NavItem {
  section: Section;
  label: string;
  href: string;
  icon: ReactNode;
}

const ICON_PROPS = {
  viewBox: '0 0 24 24',
  width: 20,
  height: 20,
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.8,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  'aria-hidden': true,
  focusable: 'false' as const,
};

const NAV_ITEMS: readonly NavItem[] = [
  {
    section: 'overview',
    label: 'Overview',
    href: hrefs.overview,
    icon: (
      <svg {...ICON_PROPS}>
        <rect x="3" y="3" width="7" height="9" rx="1.5" />
        <rect x="14" y="3" width="7" height="5" rx="1.5" />
        <rect x="14" y="12" width="7" height="9" rx="1.5" />
        <rect x="3" y="16" width="7" height="5" rx="1.5" />
      </svg>
    ),
  },
  {
    section: 'sessions',
    label: 'Sessions',
    href: hrefs.sessions,
    icon: (
      <svg {...ICON_PROPS}>
        <path d="M3 12h4l2-5 4 10 2-5h6" />
      </svg>
    ),
  },
  {
    section: 'participants',
    label: 'Participants',
    href: hrefs.participants,
    icon: (
      <svg {...ICON_PROPS}>
        <circle cx="9" cy="8" r="3.5" />
        <path d="M2.5 20c.8-3.6 3.4-5.5 6.5-5.5s5.7 1.9 6.5 5.5" />
        <path d="M16 4.6a3.5 3.5 0 0 1 0 6.8M18 14.8c1.8.8 3 2.6 3.5 5.2" />
      </svg>
    ),
  },
  {
    section: 'analysis',
    label: 'Analysis',
    href: hrefs.analysis,
    icon: (
      <svg {...ICON_PROPS}>
        <path d="M4 20V10M10 20V4M16 20v-7M22 20H2" />
      </svg>
    ),
  },
  {
    section: 'export',
    label: 'Export',
    href: hrefs.export,
    icon: (
      <svg {...ICON_PROPS}>
        <path d="M12 3v12M7 10l5 5 5-5M4 21h16" />
      </svg>
    ),
  },
  {
    section: 'data',
    label: 'Data',
    href: hrefs.data,
    icon: (
      <svg {...ICON_PROPS}>
        <ellipse cx="12" cy="5.5" rx="8" ry="2.5" />
        <path d="M4 5.5v13c0 1.4 3.6 2.5 8 2.5s8-1.1 8-2.5v-13M4 12c0 1.4 3.6 2.5 8 2.5s8-1.1 8-2.5" />
      </svg>
    ),
  },
];

function ThemeSelect() {
  const { preference, setPreference } = useTheme();
  return (
    <label className="theme-select">
      <span className="theme-select__label">Theme</span>
      <select value={preference} onChange={(e) => setPreference(e.target.value as ThemePreference)}>
        <option value="system">System</option>
        <option value="light">Light</option>
        <option value="dark">Dark</option>
      </select>
    </label>
  );
}

function DataStatus() {
  const state = useDashboardState();
  const { progress, summarizing } = useDerived();
  if (state.order.length === 0) {
    return <p className="data-status__empty">No data loaded</p>;
  }
  const pct = progress.total > 0 ? Math.round((progress.done / progress.total) * 100) : 100;
  return (
    <div className="data-status">
      <p className="data-status__counts">
        {plural(state.order.length, 'session')} · {plural(state.participants.size, 'participant')}
      </p>
      {state.simulated && <SimulatedBadge />}
      {summarizing && (
        <div className="data-status__progress" aria-hidden="true" title={`Summaries ${progress.done}/${progress.total}`}>
          <div className="data-status__bar" style={{ width: `${pct}%` }} />
        </div>
      )}
    </div>
  );
}

function BrandMark() {
  return (
    <svg viewBox="0 0 32 32" width="28" height="28" aria-hidden="true" focusable="false" className="brand__mark">
      <rect width="32" height="32" rx="7" fill="currentColor" />
      <path
        d="M4 17h6l2.5-6 4 12 3-9 2 3H28"
        fill="none"
        stroke="var(--brand-ink)"
        strokeWidth="2.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function AppShell({ route, children }: { route: Route; children: ReactNode }) {
  const mainRef = useRef<HTMLElement>(null);
  const active = sectionOf(route);
  const routeKey = routeHref(route);
  const firstRender = useRef(true);

  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    window.scrollTo({ top: 0 });
    const heading = mainRef.current?.querySelector<HTMLElement>('[data-page-title]');
    (heading ?? mainRef.current)?.focus({ preventScroll: true });
  }, [routeKey]);

  return (
    <div className="app">
      <button type="button" className="skip-link" onClick={() => mainRef.current?.focus()}>
        Skip to main content
      </button>
      <header className="sidebar">
        <a className="brand" href={hrefs.overview}>
          <BrandMark />
          <span className="brand__text">
            SurgeonPulse <span className="brand__sub">Dashboard</span>
          </span>
        </a>
        <nav className="nav" aria-label="Main">
          <ul className="nav__list">
            {NAV_ITEMS.map((item) => (
              <li key={item.section}>
                <a
                  className={`nav__link${active === item.section ? ' nav__link--active' : ''}`}
                  href={item.href}
                  aria-current={active === item.section ? 'page' : undefined}
                >
                  {item.icon}
                  <span>{item.label}</span>
                </a>
              </li>
            ))}
          </ul>
        </nav>
        <div className="sidebar__footer">
          <DataStatus />
          <ThemeSelect />
        </div>
      </header>
      <main id="main" ref={mainRef} tabIndex={-1} className="main">
        <div className="main__inner">{children}</div>
        <footer className="app-footer">
          SurgeonPulse is a university research tool, not a medical device. Data loaded from files stays in this
          browser.
        </footer>
      </main>
    </div>
  );
}
