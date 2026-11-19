import { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
  fallbackTitle?: string;
  fallbackBody?: string;
  retryLabel?: string;
}

interface State {
  error: Error | null;
}

/**
 * UI-01 — a root error boundary so a render crash does not white-screen
 * the whole Tauri window.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('Kindora: uncaught render error', error, info.componentStack);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    const title = this.props.fallbackTitle ?? 'Something went wrong';
    const body =
      this.props.fallbackBody ??
      'The screen crashed. Your data on disk was not modified. You can try again.';
    const retry = this.props.retryLabel ?? 'Try again';

    return (
      <main className="kindora-page" data-testid="error-boundary">
        <section className="kindora-card">
          <p className="kindora-eyebrow">Error</p>
          <h1 className="kindora-title mt-2">{title}</h1>
          <p className="kindora-muted mt-3">{body}</p>
          <pre className="mt-4 max-h-40 overflow-auto rounded-[6px] border border-pastel-red bg-pastel-red p-3 font-mono text-xs text-pastel-redInk">
            {error.message}
          </pre>
          <button
            type="button"
            className="kindora-button mt-6"
            onClick={() => this.setState({ error: null })}
          >
            {retry}
          </button>
        </section>
      </main>
    );
  }
}
