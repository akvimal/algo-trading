import React from "react";

interface Props {
  children: React.ReactNode;
}

interface State {
  error: Error | null;
}

// Catches render-phase exceptions anywhere below it - without this, an
// uncaught error unmounts the whole React tree, leaving #root blank with
// no indication why (the shell tab-nav is a separate frontend/container,
// so this page's content going blank doesn't affect it). Doesn't catch
// errors inside event handlers (e.g. handleBacktest's own try/catch
// already covers those) - only render/lifecycle exceptions.
export class ErrorBoundary extends React.Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error("signal-generation UI crashed:", error, info.componentStack);
  }

  render() {
    if (this.state.error) {
      return (
        <div style={{ padding: "2.5rem 1.5rem", maxWidth: 1080, margin: "0 auto" }}>
          <p className="error">
            Something went wrong rendering this page: {this.state.error.message}
          </p>
          <button onClick={() => this.setState({ error: null })}>Try again</button>
        </div>
      );
    }
    return this.props.children;
  }
}
