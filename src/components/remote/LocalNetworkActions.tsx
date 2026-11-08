import { useState } from "react";
import { ExternalLink, RefreshCw } from "lucide-react";
import { openLocalNetworkSettings } from "../../lib/remote/client";

/** The two things to do when macOS keeps Mythra Code off the local network: go to
 * the exact settings page, then try again. `row` matches the switcher's menu rows. */
export function LocalNetworkActions({ onRetry, retrying, row = false }: { onRetry: () => void; retrying: boolean; row?: boolean }) {
  const [failed, setFailed] = useState(false);
  const open = () => { setFailed(false); void openLocalNetworkSettings().catch(() => setFailed(true)); };
  const className = row ? "machine-row" : "secondary-button";
  return <>
    <button type="button" className={className} onClick={open}>
      <ExternalLink size={14} aria-hidden="true" />
      {row ? <span className="machine-row-name">Open Local Network settings</span> : "Open Local Network settings"}
    </button>
    <button type="button" className={className} disabled={retrying} onClick={onRetry}>
      <RefreshCw size={14} aria-hidden="true" />
      {row ? <span className="machine-row-name">Try again</span> : "Try again"}
    </button>
    {failed && <span className={row ? "machine-menu-note error" : "local-network-failed"} role="alert">Open System Settings yourself, then Privacy &amp; Security → Local Network.</span>}
  </>;
}
