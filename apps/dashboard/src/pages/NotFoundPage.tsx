/**
 * Fallback for unknown hash routes.
 */
import { EmptyState, PageHeader } from '../components/ui';
import { useDocumentTitle } from '../lib/useDocumentTitle';
import { hrefs } from '../router';

export function NotFoundPage({ path }: { path: string }) {
  useDocumentTitle('Page not found');
  return (
    <>
      <PageHeader title="Page not found" />
      <EmptyState
        title="There is no page at this address"
        action={
          <a className="btn btn--primary" href={hrefs.overview}>
            Go to Overview
          </a>
        }
      >
        <p>
          <code>#{path}</code> does not match any dashboard page.
        </p>
      </EmptyState>
    </>
  );
}
