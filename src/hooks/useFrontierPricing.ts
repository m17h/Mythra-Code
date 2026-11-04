import { useEffect, useState } from "react";
import { frontierPricingSnapshot, refreshFrontierPricing } from "../lib/frontierPricing";
import { subscribeUsage } from "../lib/usageLedger";

/** The App owns the nonblocking launch refresh. Opening Settings only reads
 * cached evidence and subscribes; its button explicitly refreshes the source. */
export function useFrontierPricing() {
  const [snapshot, setSnapshot] = useState(frontierPricingSnapshot);
  useEffect(() => {
    // Usage notifications mostly report token ledger writes, so an unchanged
    // snapshot keeps its identity here and the table does not render.
    const read = () => setSnapshot(frontierPricingSnapshot());
    // A clock correction changes timestamp trust even when no pricing event
    // arrives. Re-read only the saved snapshot while this Settings pane is
    // mounted; this timer never downloads pricing or updates stored evidence.
    // These reads always render because the view's "today" labels depend on
    // the clock, not on the snapshot.
    const readClock = () => setSnapshot({ ...frontierPricingSnapshot() });
    const unsubscribe = subscribeUsage(read);
    const timer = window.setInterval(readClock, 60_000);
    window.addEventListener("focus", readClock);
    document.addEventListener("visibilitychange", readClock);
    read();
    return () => {
      unsubscribe();
      window.clearInterval(timer);
      window.removeEventListener("focus", readClock);
      document.removeEventListener("visibilitychange", readClock);
    };
  }, []);
  return { ...snapshot, refresh: refreshFrontierPricing };
}
