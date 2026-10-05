import { Component, useRef, type ErrorInfo, type ReactNode } from "react";
import { RotateCcw, TriangleAlert } from "lucide-react";
import { friendlyError } from "../lib/errors";
import { recordError } from "../lib/errorLog";
import { useModalFocus } from "../hooks/useModalFocus";

interface ErrorBoundaryProps {
  label: string;
  children: ReactNode;
  onRetry?: () => void;
  onDismiss?: () => void;
  onError?: (error: unknown, info: ErrorInfo) => void | Promise<void>;
  resetKey?: unknown;
  retryable?: boolean;
  overlay?: boolean;
  showError?: boolean;
}

interface ErrorBoundaryState {
  failure: { reason: unknown } | null;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { failure: null };

  static getDerivedStateFromError(error: unknown): ErrorBoundaryState {
    return { failure: { reason: error } };
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    // Mirror boundary catches into the error log so they surface in
    // Settings → Diagnostics and exports, not only in this fallback.
    try { recordError(`The ${this.props.label} view crashed: ${friendlyError(error)}`); } catch { /* Diagnostics must not crash the fallback. */ }
    try {
      const reported = this.props.onError?.(error, info);
      if (reported) void Promise.resolve(reported).catch(() => {});
    } catch { /* Reporting is best effort. */ }
  }

  componentDidUpdate(previous: ErrorBoundaryProps) {
    // Clear a failed view when its identity changes without remounting healthy
    // children (which would interrupt editors, streaming and in-progress input).
    if (this.state.failure && !Object.is(previous.resetKey, this.props.resetKey)) {
      this.setState({ failure: null });
    }
  }

  render() {
    if (!this.state.failure) return this.props.children;
    if (this.props.showError === false) return null;
    const fallback = (
      <div className="view-error" role="alert" style={this.props.overlay ? { flexWrap: "wrap" } : undefined} onKeyDown={(event) => {
        if (event.key === "Escape" && this.props.onDismiss) {
          event.preventDefault(); event.stopPropagation(); this.props.onDismiss();
        }
      }}>
        <TriangleAlert size={19} />
        <div>
          <strong>The {this.props.label} view hit a problem</strong>
          <small>{friendlyError(this.state.failure.reason)}</small>
          {this.props.retryable === false && <small>Restart Mythra Code to reload this view if it keeps failing.</small>}
        </div>
        {this.props.retryable !== false && <button className="secondary-button" autoFocus={Boolean(this.props.onDismiss) && !this.props.overlay} onClick={() => {
          if (this.props.onRetry) this.props.onRetry();
          else this.setState({ failure: null });
        }}>
          <RotateCcw size={13} /> Reload view
        </button>}
        {this.props.onDismiss && <button className="secondary-button" onClick={this.props.onDismiss}>Close {this.props.label} error</button>}
      </div>
    );
    return this.props.overlay ? <ErrorOverlay label={this.props.label}>{fallback}</ErrorOverlay> : fallback;
  }
}

function ErrorOverlay({ label, children }: { label: string; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useModalFocus(ref, true);
  return <div className="modal-backdrop">
    <div className="workflow-run-dialog" ref={ref} role="dialog" aria-modal="true" aria-label={`${label} error`}>
      {children}
    </div>
  </div>;
}
