import { useEffect, useRef } from "react";
import { onCodexEvent } from "../lib/codex";
import { routeCodexEvent, type CodexEventContext } from "../lib/codexEvents";

/**
 * Subscribes to Codex events exactly once for the component's lifetime.
 * The context is read through a ref on every event, so settings changes and
 * fresh callbacks apply immediately without tearing down the subscription
 * (which would drop events arriving during the re-subscribe window).
 */
export function useCodexEvents(context: CodexEventContext): void {
  const contextRef = useRef(context);
  contextRef.current = context;

  useEffect(() => {
    let disposed = false;
    let stop: (() => void) | undefined;
    onCodexEvent((event) => routeCodexEvent(event, contextRef.current))
      .then((unlisten) => {
        if (disposed) {
          unlisten();
        } else {
          stop = unlisten;
        }
      })
      .catch((reason) => {
        contextRef.current.onError(
          `Mythra Code could not subscribe to runtime events: ${reason instanceof Error ? reason.message : String(reason)}`,
        );
      });
    return () => {
      disposed = true;
      stop?.();
    };
  }, []);
}
