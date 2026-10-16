import { createContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { isSubAgentWorkerActive, type SubAgentWorker } from "../lib/subAgentActivity";

interface Controls {
  workers: SubAgentWorker[];
  /** Durable readouts for transcript cards; does not widen the live fleet. */
  historyWorkers?: SubAgentWorker[];
  onOpen: (worker: SubAgentWorker) => Promise<void>;
  onStop: (worker: SubAgentWorker) => Promise<void>;
  onAccept?: (worker: SubAgentWorker) => Promise<void>;
}
export const SubAgentControls = createContext<Controls | null>(null);
/** The ticking clock lives in its own context so only elapsed-time readouts
 * re-render each second, not every consumer of the controls (the timeline). */
export const SubAgentClock = createContext(0);

/** One clock for visible sub-agent cards, stopped when no child is active. */
export function SubAgentControlsProvider({ children, ...controls }: Controls & { children: ReactNode }) {
  const [now, setNow] = useState(Date.now);
  const active = controls.workers.some((worker) => isSubAgentWorkerActive(worker.status));
  useEffect(() => {
    if (!active) return;
    let timer: number | undefined;
    const refreshVisibility = () => {
      if (timer !== undefined) window.clearInterval(timer);
      timer = undefined;
      if (document.hidden) return;
      setNow(Date.now());
      timer = window.setInterval(() => setNow(Date.now()), 1000);
    };
    refreshVisibility();
    document.addEventListener("visibilitychange", refreshVisibility);
    return () => {
      if (timer !== undefined) window.clearInterval(timer);
      document.removeEventListener("visibilitychange", refreshVisibility);
    };
  }, [active]);
  const { workers, historyWorkers, onOpen, onStop, onAccept } = controls;
  const value = useMemo(() => ({ workers, historyWorkers, onOpen, onStop, onAccept }), [workers, historyWorkers, onOpen, onStop, onAccept]);
  return <SubAgentControls.Provider value={value}><SubAgentClock.Provider value={now}>{children}</SubAgentClock.Provider></SubAgentControls.Provider>;
}
