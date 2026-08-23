import { auditEvent } from "./codex";

export interface LoggedError {
  message: string;
  at: number;
}

const MAX_BUFFERED_ERRORS = 50;
const buffer: LoggedError[] = [];

/**
 * Every user-visible error is kept in a small in-memory ring buffer and
 * mirrored into the persistent audit log, so "it broke earlier" reports can
 * be answered from Settings → Diagnostics or the diagnostics export.
 */
export function recordError(message: string): void {
  if (!message) return;
  const last = buffer[buffer.length - 1];
  if (last && last.message === message && Date.now() - last.at < 2000) return;
  buffer.push({ message, at: Date.now() });
  if (buffer.length > MAX_BUFFERED_ERRORS) buffer.shift();
  void auditEvent("ui.error", { message }).catch(() => {});
}

export function recentErrors(): LoggedError[] {
  return [...buffer];
}

export function clearErrorLog(): void {
  buffer.length = 0;
}

/**
 * Failures that never reach a surfaced banner — uncaught exceptions and
 * unhandled promise rejections — would otherwise vanish; capture them into
 * the same diagnostics buffer so "it broke earlier" stays answerable.
 */
export function installGlobalErrorCapture(): void {
  window.addEventListener("error", (event) => {
    recordError(`Uncaught: ${event.message || String(event.error ?? "unknown error")}`);
  });
  window.addEventListener("unhandledrejection", (event) => {
    const reason = event.reason;
    const message = reason instanceof Error ? reason.message : String(reason ?? "unknown reason");
    recordError(`Unhandled rejection: ${message}`);
  });
}
