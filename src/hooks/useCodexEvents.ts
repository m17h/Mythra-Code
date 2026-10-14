import { useEffect, useRef } from "react";
import { onCodexEvent, type CodexEvent } from "../lib/codex";
import { routeCodexEvent, type CodexEventContext } from "../lib/codexEvents";

/**
 * Subscribes to Codex events exactly once for the component's lifetime.
 * The context is read through a ref on every event, so settings changes and
 * fresh callbacks apply immediately without tearing down the subscription
 * (which would drop events arriving during the re-subscribe window).
 */
export function useCodexEvents(context: CodexEventContext & {
  admitRuntimeEvent?: (event: CodexEvent) => boolean | "defer";
  resolveRuntimeEpoch?: (candidateInstance?: string) => Promise<void>;
}): void {
  const contextRef = useRef(context);
  contextRef.current = context;

  useEffect(() => {
    let disposed = false;
    let stop: (() => void) | undefined;
    const earlyEvents: CodexEvent[] = [];
    let resolvingEpoch = false;
    let overflowReported = false;
    const drainEarlyEvents = async () => {
      if (resolvingEpoch) return;
      resolvingEpoch = true;
      try {
        while (!disposed && earlyEvents.length) {
          const event = earlyEvents.shift()!;
          let current = contextRef.current;
          if (current.admitRuntimeEvent?.(event) === "defer") {
            await current.resolveRuntimeEpoch?.((event as CodexEvent & { runtimeInstance?: string }).runtimeInstance);
            current = contextRef.current;
          }
          if (!disposed && (!current.admitRuntimeEvent || current.admitRuntimeEvent(event) === true)) routeCodexEvent(event, current);
        }
      } catch (reason) {
        contextRef.current.onError(`Runtime event ownership could not be confirmed: ${reason instanceof Error ? reason.message : String(reason)}`);
      } finally {
        resolvingEpoch = false;
      }
    };
    onCodexEvent((event) => {
      const current = contextRef.current;
      const admission = current.admitRuntimeEvent?.(event) ?? true;
      if (admission === false) return;
      if (admission === "defer" || resolvingEpoch || earlyEvents.length) {
        // Bound bootstrap buffering; an unavailable runtime must not retain
        // an unlimited stream while its native identity is unresolved.
        if (earlyEvents.length >= 512) {
          if (!overflowReported) current.onError("Runtime ownership is unresolved and its early-event buffer filled. Some output could not be applied; reopen the conversation to recover its saved history.");
          overflowReported = true;
          return;
        }
        earlyEvents.push(event);
        void drainEarlyEvents();
        return;
      }
      routeCodexEvent(event, current);
    })
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
      earlyEvents.length = 0;
      stop?.();
    };
  }, []);
}
