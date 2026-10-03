import { useEffect } from "react";
import { useClaudeContinuationStore, type ClaudeContinuation } from "../lib/claudeContinuation";

/** Only a currently running, matching turn may advertise live continuation. */
export function useClaudeContinuation(threadId: string | null | undefined, turnId: string | undefined, running: boolean): ClaudeContinuation | null {
  const continuation = useClaudeContinuationStore((state) => threadId ? state.byThread[threadId] : undefined);
  useEffect(() => {
    if (!threadId || !continuation?.expiresAt) return;
    let timer: ReturnType<typeof setTimeout>;
    const expire = () => {
      const remaining = continuation.expiresAt! - Date.now();
      if (remaining <= 0) useClaudeContinuationStore.getState().clear(threadId, continuation.turnId);
      // Long resets must not overflow the browser's signed 32-bit timer.
      else timer = setTimeout(expire, Math.min(remaining, 2_147_483_647));
    };
    expire();
    const onWake = () => { clearTimeout(timer); expire(); };
    window.addEventListener("focus", onWake);
    document.addEventListener("visibilitychange", onWake);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("focus", onWake);
      document.removeEventListener("visibilitychange", onWake);
    };
  }, [threadId, continuation]);
  if (!running || !continuation || continuation.turnId !== turnId) return null;
  if (continuation.expiresAt !== undefined && continuation.expiresAt <= Date.now()) return null;
  return continuation;
}
