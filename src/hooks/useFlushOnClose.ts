import { useEffect, useRef } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";

/** Delay a desktop window close until buffered transcripts reach SQLite. */
export function useFlushOnClose(flush: () => Promise<void>, onError: (message: string) => void) {
  const current = useRef({ flush, onError });
  current.current = { flush, onError };
  useEffect(() => {
    let disposed = false;
    let closing = false;
    let unlisten: (() => void) | undefined;
    const onPageHide = () => { void current.current.flush().catch(() => {}); };
    window.addEventListener("pagehide", onPageHide);
    try {
      const desktop = getCurrentWindow();
      void desktop.onCloseRequested((event) => {
        event.preventDefault();
        if (closing) return;
        closing = true;
        void current.current.flush().then(async () => {
          if (disposed) return;
          await desktop.destroy();
        }).catch((error) => {
          closing = false;
          current.current.onError(`Could not save pending transcripts. Please retry closing: ${String(error)}`);
        });
      }).then((stop) => {
        if (disposed) stop();
        else unlisten = stop;
      }).catch(() => {});
    } catch { /* Browser development has no native window. */ }
    return () => {
      disposed = true;
      unlisten?.();
      window.removeEventListener("pagehide", onPageHide);
    };
  }, []);
}
