import { auditEvent } from "./codex";
import { safeErrorText } from "./errors";

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
  try {
    const text = safeErrorText(message, "");
    if (!text) return;
    const at = Date.now();
    const last = buffer[buffer.length - 1];
    if (last && last.message === text && at - last.at < 2000) return;
    buffer.push({ message: text, at });
    if (buffer.length > MAX_BUFFERED_ERRORS) buffer.shift();
    void Promise.resolve(auditEvent("ui.error", { message: text })).catch(() => {});
  } catch {
    // Diagnostics are best effort; they must never replace the original error.
  }
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
  if (typeof window === "undefined") return;
  try {
    window.addEventListener("error", (event) => {
      let message = "unknown error";
      try { message = safeErrorText(event.message || event.error, message); } catch { /* Unreadable event. */ }
      recordError(`Uncaught: ${message}`);
    });
  } catch { /* A diagnostics listener must not prevent startup. */ }
  try {
    window.addEventListener("unhandledrejection", (event) => {
      let message = "unknown reason";
      try { message = safeErrorText(event.reason, message); } catch { /* Unreadable event. */ }
      recordError(`Unhandled rejection: ${message}`);
    });
  } catch { /* A diagnostics listener must not prevent startup. */ }
}
