// Historical production behavior at main 0682276252cd42b837d1ec1ad437057fd4ceef2d.
import { useEffect, useRef } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";

export function useBaselineClose(flush: () => Promise<void>, onError: (message: string) => void, confirmDiscard?: () => Promise<boolean>) {
  const current = useRef({ flush, onError, confirmDiscard });
  current.current = { flush, onError, confirmDiscard };
  useEffect(() => {
    let disposed = false;
    let closing = false;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    let unlisten: (() => void) | undefined;
    const onPageHide = () => { void current.current.flush().catch(() => {}); };
    window.addEventListener("pagehide", onPageHide);
    try {
      const desktop = getCurrentWindow();
      void desktop.onCloseRequested((event) => {
        event.preventDefault();
        if (closing) return;
        closing = true;
        const timedOut = new Promise<never>((_, reject) => {
          deadline = setTimeout(() => reject(new Error("Saving took longer than 15 seconds")), 15_000);
        });
        void Promise.race([current.current.flush(), timedOut]).then(async () => {
          if (disposed) return;
          await desktop.destroy();
        }).catch(async (error) => {
          if (disposed) return;
          current.current.onError(`Could not save pending changes. Please retry closing: ${String(error)}`);
          if (await current.current.confirmDiscard?.() && !disposed) await desktop.destroy();
        }).catch((error) => current.current.onError(String(error))).finally(() => {
          clearTimeout(deadline);
          closing = false;
        });
      }).then((stop) => { if (disposed) stop(); else unlisten = stop; }).catch(() => {});
    } catch { /* Native fixture only. */ }
    return () => { disposed = true; clearTimeout(deadline); unlisten?.(); window.removeEventListener("pagehide", onPageHide); };
  }, []);
}
