/**
 * Root component: providers, error boundary and hash-routed pages.
 *
 * Pages are loaded on demand (`React.lazy`), so the first screen does not wait for every page and for
 * Recharts; a chunk that fails to load (e.g. offline after an update) is caught by the error boundary.
 */
import { Suspense, lazy } from 'react';
import { AppShell } from './components/layout/AppShell';
import { ErrorBoundary } from './components/ErrorBoundary';
import { ThemeProvider } from './lib/theme';
import { NotFoundPage } from './pages/NotFoundPage';
import { routeHref, useRoute } from './router';
import type { Route } from './router';
import { DashboardProvider } from './state/store';

const AnalysisPage = lazy(() => import('./pages/AnalysisPage').then((m) => ({ default: m.AnalysisPage })));
const DataPage = lazy(() => import('./pages/DataPage').then((m) => ({ default: m.DataPage })));
const ExportPage = lazy(() => import('./pages/ExportPage').then((m) => ({ default: m.ExportPage })));
const OverviewPage = lazy(() => import('./pages/OverviewPage').then((m) => ({ default: m.OverviewPage })));
const ParticipantDetailPage = lazy(() =>
  import('./pages/ParticipantDetailPage').then((m) => ({ default: m.ParticipantDetailPage })),
);
const ParticipantsPage = lazy(() => import('./pages/ParticipantsPage').then((m) => ({ default: m.ParticipantsPage })));
const SessionDetailPage = lazy(() => import('./pages/SessionDetailPage').then((m) => ({ default: m.SessionDetailPage })));
const SessionsPage = lazy(() => import('./pages/SessionsPage').then((m) => ({ default: m.SessionsPage })));

function PageLoading() {
  return (
    <p className="muted" role="status">
      Loading…
    </p>
  );
}

function Page({ route }: { route: Route }) {
  switch (route.name) {
    case 'overview':
      return <OverviewPage />;
    case 'sessions':
      return <SessionsPage />;
    case 'session':
      return <SessionDetailPage id={route.id} />;
    case 'participants':
      return <ParticipantsPage />;
    case 'participant':
      return <ParticipantDetailPage code={route.code} />;
    case 'analysis':
      return <AnalysisPage />;
    case 'export':
      return <ExportPage />;
    case 'data':
      return <DataPage />;
    case 'not-found':
      return <NotFoundPage path={route.path} />;
  }
}

export function App() {
  const route = useRoute();
  const key = routeHref(route);
  return (
    <ThemeProvider>
      <DashboardProvider>
        <AppShell route={route}>
          {/* Keyed by route: page state and any caught error reset on navigation. */}
          <ErrorBoundary key={key}>
            <Suspense fallback={<PageLoading />}>
              <Page route={route} />
            </Suspense>
          </ErrorBoundary>
        </AppShell>
      </DashboardProvider>
    </ThemeProvider>
  );
}
