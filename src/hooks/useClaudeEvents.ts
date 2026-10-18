import { useCallback, useEffect, useRef } from "react";
import { onClaudeEvent, type ClaudeEvent } from "../lib/claude";
import { routeClaudeEvent, type ClaudeEventContext } from "../lib/claudeEvents";

/** Returns the same route the native listener uses, for recovered events. */
export function useClaudeEvents(context: ClaudeEventContext): (event: ClaudeEvent) => void {
  const contextRef = useRef(context);
  contextRef.current = context;

  useEffect(() => {
    let disposed = false;
    let stop: (() => void) | undefined;
    onClaudeEvent((event) => routeClaudeEvent(event, contextRef.current))
      .then((unlisten) => {
        if (disposed) unlisten();
        else stop = unlisten;
      })
      .catch((reason) => {
        contextRef.current.onError(
          `Mythra Code could not subscribe to Claude events: ${reason instanceof Error ? reason.message : String(reason)}`,
        );
      });
    return () => {
      disposed = true;
      stop?.();
    };
  }, []);
  return useCallback((event: ClaudeEvent) => routeClaudeEvent(event, contextRef.current), []);
}
