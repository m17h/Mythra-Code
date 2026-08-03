import { useEffect, useRef } from "react";
import { onCursorEvent } from "../lib/cursor";
import { routeCursorEvent, type CursorEventContext } from "../lib/cursorEvents";

export function useCursorEvents(context: CursorEventContext): void {
  const contextRef = useRef(context);
  contextRef.current = context;
  useEffect(() => {
    let disposed = false;
    let stop: (() => void) | undefined;
    onCursorEvent((event) => routeCursorEvent(event, contextRef.current)).then((unlisten) => {
      if (disposed) unlisten();
      else stop = unlisten;
    }).catch((reason) => contextRef.current.onError(`OpenKiwi could not subscribe to Cursor events: ${String(reason)}`));
    return () => { disposed = true; stop?.(); };
  }, []);
}
