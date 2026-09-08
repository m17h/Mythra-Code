import { createContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { isSubAgentWorkerActive, type SubAgentWorker } from "../lib/subAgentActivity";

interface Controls {
  workers: SubAgentWorker[];
  onOpen: (worker: SubAgentWorker) => Promise<void>;
  onStop: (worker: SubAgentWorker) => Promise<void>;
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
  const { workers, onOpen, onStop } = controls;
  const value = useMemo(() => ({ workers, onOpen, onStop, now }), [workers, onOpen, onStop, now]);
  return <SubAgentControls.Provider value={value}>{children}</SubAgentControls.Provider>;
}
