/**
 * Root component: providers, error boundary and hash-routed pages.
 */
import { AppShell } from './components/layout/AppShell';
import { ErrorBoundary } from './components/ErrorBoundary';
import { ThemeProvider } from './lib/theme';
import { AnalysisPage } from './pages/AnalysisPage';
import { DataPage } from './pages/DataPage';
import { ExportPage } from './pages/ExportPage';
import { NotFoundPage } from './pages/NotFoundPage';
import { OverviewPage } from './pages/OverviewPage';
import { ParticipantDetailPage } from './pages/ParticipantDetailPage';
import { ParticipantsPage } from './pages/ParticipantsPage';
import { SessionDetailPage } from './pages/SessionDetailPage';
import { SessionsPage } from './pages/SessionsPage';
import { routeHref, useRoute } from './router';
import type { Route } from './router';
import { DashboardProvider } from './state/store';

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
            <Page route={route} />
          </ErrorBoundary>
        </AppShell>
      </DashboardProvider>
    </ThemeProvider>
  );
}
