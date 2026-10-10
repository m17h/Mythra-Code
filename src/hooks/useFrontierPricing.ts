import { useEffect, useState } from "react";
import { frontierPricingSnapshot, refreshFrontierPricing } from "../lib/frontierPricing";
import { subscribeUsage } from "../lib/usageLedger";

/** The App owns the nonblocking launch refresh. Opening Settings only reads
 * cached evidence and subscribes; its button explicitly refreshes the source. */
export function useFrontierPricing() {
  const [snapshot, setSnapshot] = useState(frontierPricingSnapshot);
  useEffect(() => {
    const read = () => setSnapshot(frontierPricingSnapshot());
    const unsubscribe = subscribeUsage(read);
    // A clock correction changes timestamp trust even when no pricing event
    // arrives. Re-read only the saved snapshot while this Settings pane is
    // mounted; this timer never downloads pricing or updates stored evidence.
    const timer = window.setInterval(read, 60_000);
    window.addEventListener("focus", read);
    document.addEventListener("visibilitychange", read);
    read();
    return () => {
      unsubscribe();
      window.clearInterval(timer);
      window.removeEventListener("focus", read);
      document.removeEventListener("visibilitychange", read);
    };
  }, []);
  return { ...snapshot, refresh: refreshFrontierPricing };
}
