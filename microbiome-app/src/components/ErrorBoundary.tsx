import { Component, type ErrorInfo, type ReactNode } from 'react';

/**
 * Catches a render or effect error and shows it, instead of letting React
 * unmount the application.
 *
 * Without a boundary anywhere, React 18 responds to an uncaught error by
 * tearing down the whole root — the user sees a blank white page, loses every
 * file they had loaded, and has no way back except reloading. Two ordinary
 * actions did that: analysing a second dataset whose metadata lacks the
 * column a panel had selected, and opening a tab in a browser that refuses to
 * construct a Web Worker.
 *
 * Both underlying causes are fixed. The boundary stays because it is the
 * difference between "this panel could not be drawn" and "the tool vanished",
 * and the people using it cannot open a console to find out which.
 */
interface Props {
  children: ReactNode;
  /** Shown above the error text; names what failed. */
  label?: string;
  /** Changing this value clears a caught error and retries the children. */
  resetKey?: unknown;
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override componentDidUpdate(previous: Props) {
    if (previous.resetKey !== this.props.resetKey && this.state.error) {
      this.setState({ error: null });
    }
  }

  override componentDidCatch(error: Error, info: ErrorInfo) {
    // Nothing is sent anywhere — this tool makes no network requests. The
    // console is the only place a developer can see the stack.
    console.error('Caught by ErrorBoundary:', error, info.componentStack);
  }

  override render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div className="notice error" role="alert">
        <strong>{this.props.label ?? 'Something went wrong'}</strong>
        <p>{error.message}</p>
        <p>
          The rest of the page still works. Loading your files again, or
          choosing a different grouping variable, usually clears this.
        </p>
        <button type="button" onClick={() => this.setState({ error: null })}>
          Try again
        </button>
      </div>
    );
  }
}
