import { useEffect, useRef } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { invoke } from "@tauri-apps/api/core";

/** Give every independent store a chance to save, even if another fails. */
export async function flushBeforeClose(flushes: Array<() => Promise<void>>): Promise<void> {
  const results = await Promise.allSettled(flushes.map((flush) => Promise.resolve().then(flush)));
  const failures = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
  if (failures.length) throw new Error(failures.map((failure) => String(failure.reason)).join("; "));
}

/** Delay a desktop window close until buffered transcripts reach SQLite. */
export function useFlushOnClose(flush: () => Promise<void>, onError: (message: string) => void) {
  const current = useRef({ flush, onError });
  current.current = { flush, onError };
  useEffect(() => {
    let disposed = false;
    let active: { requestId?: number } | undefined;
    let claimAgain = false;
    // Native request IDs increase for the lifetime of the process. Remember
    // cancellation even if it arrives before a delayed claim response.
    let cancelledThrough = 0;
    let stopClose: (() => void) | undefined;
    let stopCancel: (() => void) | undefined;
    const reportError = (message: string) => {
      // Reporting must not stop native completion or reject an event task.
      try { current.current.onError(message); } catch { /* Native watchdog remains available. */ }
    };
    const onPageHide = () => { void Promise.resolve().then(() => current.current.flush()).catch(() => {}); };
    window.addEventListener("pagehide", onPageHide);
    const claimPending = () => {
      if (disposed) return;
      if (active) {
        if (active.requestId === undefined) claimAgain = true;
        return;
      }
      const operation: { requestId?: number } = {};
      active = operation;
      const isCurrent = () => !disposed && active === operation
        && (operation.requestId === undefined || operation.requestId > cancelledThrough);
      void (async () => {
        try {
          const request = await invoke<{ requestId: number } | null>("close_guard_claim");
          if (!isCurrent() || !request || request.requestId <= cancelledThrough) return;
          operation.requestId = request.requestId;
          claimAgain = false;
          let result: "saved" | "failed" = "saved";
          let error: string | undefined;
          try {
            await current.current.flush();
          } catch (failure) {
            result = "failed";
            error = String(failure);
            if (isCurrent()) reportError(`Could not save pending changes: ${error}`);
          }
          if (!isCurrent()) return;
          // Rust alone owns the deadline, discard consent, and destruction.
          // A false response means native consent/cancellation already won.
          await invoke<boolean>("close_guard_finish", {
            requestId: operation.requestId,
            result,
            ...(error === undefined ? {} : { error }),
          });
        } catch (error) {
          if (isCurrent()) reportError(`Could not complete the close request: ${String(error)}`);
        } finally {
          if (active === operation) {
            active = undefined;
            const retry = claimAgain;
            claimAgain = false;
            if (retry && !disposed) claimPending();
          }
        }
      })();
    };
    try {
      const desktop = getCurrentWindow();
      void (async () => {
        try {
          const cancel = await desktop.listen<{ requestId: number }>("mythra://close-cancelled", ({ payload }) => {
            if (disposed) return;
            cancelledThrough = Math.max(cancelledThrough, payload.requestId);
            if (active?.requestId !== undefined && active.requestId <= cancelledThrough) {
              active = undefined;
              claimAgain = false;
              // A new OS close can precede this queued cancellation event.
              claimPending();
            }
          });
          if (disposed) { cancel(); return; }
          stopCancel = cancel;
          const close = await desktop.onCloseRequested((event) => {
            // Tauri's JS wrapper destroys after this callback returns unless
            // prevented, including duplicate clicks and failed IPC requests.
            event.preventDefault();
            claimPending();
          });
          if (disposed) { close(); return; }
          stopClose = close;
          // Recover an OS request spanning listener setup or a React remount.
          claimPending();
        } catch (error) {
          stopCancel?.();
          stopCancel = undefined;
          if (!disposed) reportError(`Could not register close handling: ${String(error)}`);
        }
      })();
    } catch { /* Browser development has no native window. */ }
    return () => {
      disposed = true;
      active = undefined;
      stopClose?.();
      stopCancel?.();
      window.removeEventListener("pagehide", onPageHide);
    };
  }, []);
}
