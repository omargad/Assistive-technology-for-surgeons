/**
 * Catches rendering errors so one broken page or malformed session never
 * blanks the whole dashboard. The error message is shown, but no data and no
 * stack trace is logged anywhere (health data must not leak into logs).
 * Give it a `key` that changes on navigation to reset it per page.
 */
import { Component } from 'react';
import type { ErrorInfo, ReactNode } from 'react';
import { hrefs } from '../router';

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override componentDidCatch(_error: Error, _info: ErrorInfo): void {
    // Intentionally silent: component stacks can include session values.
  }

  override render(): ReactNode {
    const { error } = this.state;
    if (error === null) return this.props.children;
    return (
      <div className="error-panel" role="alert">
        <h1 tabIndex={-1} data-page-title>
          Something went wrong on this page
        </h1>
        <p>
          The dashboard hit an unexpected problem while displaying this view. Your loaded data is still in memory —
          try another page, or reload if the problem persists.
        </p>
        <p className="error-panel__detail">
          <span className="muted">Details:</span> {error.message || 'Unknown error'}
        </p>
        <div className="button-row">
          <button type="button" className="btn btn--primary" onClick={() => this.setState({ error: null })}>
            Try again
          </button>
          <a className="btn" href={hrefs.overview}>
            Go to Overview
          </a>
        </div>
      </div>
    );
  }
}
