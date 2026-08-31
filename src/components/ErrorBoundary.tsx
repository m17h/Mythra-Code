import { Component, type ErrorInfo, type ReactNode } from "react";
import { RotateCcw, TriangleAlert } from "lucide-react";
import { friendlyError } from "../lib/errors";
import { recordError } from "../lib/errorLog";

interface ErrorBoundaryProps {
  label: string;
  children: ReactNode;
  onRetry?: () => void;
}

interface ErrorBoundaryState {
  error: Error | null;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, _info: ErrorInfo) {
    // Mirror boundary catches into the error log so they surface in
    // Settings → Diagnostics and exports, not only in this fallback.
    recordError(`The ${this.props.label} view crashed: ${friendlyError(error)}`);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="view-error" role="alert">
        <TriangleAlert size={19} />
        <div>
          <strong>The {this.props.label} view hit a problem</strong>
          <small>{friendlyError(this.state.error)}</small>
        </div>
        <button className="secondary-button" onClick={() => {
          if (this.props.onRetry) this.props.onRetry();
          else this.setState({ error: null });
        }}>
          <RotateCcw size={13} /> Reload view
        </button>
      </div>
    );
  }
}
