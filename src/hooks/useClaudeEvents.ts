import { useEffect, useRef } from "react";
import { onClaudeEvent } from "../lib/claude";
import { routeClaudeEvent, type ClaudeEventContext } from "../lib/claudeEvents";

export function useClaudeEvents(context: ClaudeEventContext): void {
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
          `OpenKiwi could not subscribe to Claude events: ${reason instanceof Error ? reason.message : String(reason)}`,
        );
      });
    return () => {
      disposed = true;
      stop?.();
    };
  }, []);
}
