import { create } from "zustand";

export interface ConfirmRequest {
  id: number;
  message: string;
  confirmLabel: string;
  cancelLabel: string;
  links?: Array<{ label: string; url: string }>;
  footer?: string;
  resolve: (confirmed: boolean) => void;
}

export interface ConfirmOptions {
  confirmLabel?: string;
  cancelLabel?: string;
  links?: Array<{ label: string; url: string }>;
  footer?: string;
  inApp?: boolean;
  signal?: AbortSignal;
}

let nextConfirmId = 0;

/** Queue behind the in-app confirmation modal (ConfirmDialogModal). */
export const useConfirmStore = create<{ queue: ConfirmRequest[] }>(() => ({ queue: [] }));

export function settleConfirm(id: number, confirmed: boolean): void {
  const request = useConfirmStore.getState().queue.find((entry) => entry.id === id);
  if (!request) return;
  useConfirmStore.setState((state) => ({ queue: state.queue.filter((entry) => entry.id !== id) }));
  request.resolve(confirmed);
}

/**
 * Every confirmation must go through here, never `window.confirm`.
 *
 * In the packaged app the Tauri dialog plugin replaces `window.confirm`
 * with an async function, so a browser-style `if (!window.confirm(...))`
 * guard receives a Promise — always truthy — and the "confirmation"
 * silently auto-accepts while no dialog ever appears. Inside Tauri this
 * shows Mythra Code's own in-app modal and awaits the real answer; outside
 * Tauri (tests, plain-browser dev) the environment's native synchronous
 * confirm still works and is kept.
 */
export function confirmDialog(message: string, options: ConfirmOptions = {}): Promise<boolean> {
  if (options.signal?.aborted) return Promise.resolve(false);
  if (!options.inApp && !("__TAURI_INTERNALS__" in window)) return Promise.resolve(window.confirm(message));
  return new Promise((resolve) => {
    const id = ++nextConfirmId;
    const abort = () => settleConfirm(id, false);
    useConfirmStore.setState((state) => ({
      queue: [...state.queue, {
        id,
        message,
        confirmLabel: options.confirmLabel?.trim() || "Confirm",
        cancelLabel: options.cancelLabel?.trim() || "Cancel",
        links: options.links,
        footer: options.footer,
        resolve: (confirmed) => {
          options.signal?.removeEventListener("abort", abort);
          resolve(confirmed);
        },
      }],
    }));
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) abort();
  });
}
