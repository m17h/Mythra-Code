import { useCallback, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { loadStored, storeValue } from "../lib/storage";

export interface PaneSizes {
  sidebar: number;
  dock: number;
}

const DEFAULT_PANE_SIZES: PaneSizes = { sidebar: 260, dock: 430 };

function clampPaneSize(pane: keyof PaneSizes, value: number): number {
  return pane === "sidebar"
    ? Math.min(420, Math.max(230, value))
    : Math.min(680, Math.max(340, value));
}

export function usePaneResize(uiScale: number) {
  const [paneSizes, setPaneSizes] = useState<PaneSizes>(() =>
    loadStored("kiwi.paneSizes", DEFAULT_PANE_SIZES),
  );
  const paneSizesRef = useRef(paneSizes);
  paneSizesRef.current = paneSizes;
  const uiScaleRef = useRef(uiScale);
  uiScaleRef.current = uiScale;

  const startPaneResize = useCallback(
    (pane: keyof PaneSizes) => (event: ReactPointerEvent) => {
      event.preventDefault();
      const startX = event.clientX;
      const startSize = paneSizesRef.current[pane];
      // Pointer devices deliver moves faster than the display refreshes (120Hz
      // trackpads, coalesced mouse events), and the pane width is read by the
      // whole App tree. Applying every event re-rendered the app more than once
      // per painted frame for no visible difference, so the latest position is
      // held and committed once per frame instead. The commit still happens
      // before paint, so the pane tracks the pointer with no added latency.
      let latestX = startX;
      let frame: number | null = null;

      const commit = () => {
        frame = null;
        // Pointer coordinates are screen pixels while pane widths live inside
        // the scaled container, so unscale the movement delta.
        const delta = (latestX - startX) / uiScaleRef.current;
        const nextSize = clampPaneSize(
          pane,
          pane === "sidebar" ? startSize + delta : startSize - delta,
        );
        const current = paneSizesRef.current;
        if (current[pane] === nextSize) return;
        const next = { ...current, [pane]: nextSize };
        // Keep the imperative snapshot current before scheduling React's
        // render. Pointer-up persists this ref immediately, and React may batch
        // the state update until after the native event handler returns.
        paneSizesRef.current = next;
        setPaneSizes(next);
      };

      const onMove = (moveEvent: PointerEvent) => {
        latestX = moveEvent.clientX;
        if (frame === null) frame = requestAnimationFrame(commit);
      };

      const onUp = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        window.removeEventListener("pointercancel", onUp);
        // Land on the exact position the pointer was released at, even if the
        // last move arrived after this frame's commit.
        if (frame !== null) cancelAnimationFrame(frame);
        commit();
        storeValue("kiwi.paneSizes", paneSizesRef.current);
      };

      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      window.addEventListener("pointercancel", onUp);
    },
    [],
  );

  return { paneSizes, startPaneResize };
}
