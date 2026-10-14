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
export const SubAgentControls = createContext<(Controls & { now: number }) | null>(null);

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
  const value = useMemo(() => ({ workers, historyWorkers, onOpen, onStop, onAccept, now }), [workers, historyWorkers, onOpen, onStop, onAccept, now]);
  return <SubAgentControls.Provider value={value}>{children}</SubAgentControls.Provider>;
}
