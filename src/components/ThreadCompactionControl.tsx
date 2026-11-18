import { useEffect, useMemo, useState, type ReactNode } from "react";
import { AlertTriangle } from "lucide-react";
import { AppSelectMenu, type AppSelectOption } from "./AppSelectMenu";
import { autoCompactTokensError } from "../lib/threadSubagentSettings";
import { frontierCompactionPricingEntries, type FrontierCompactionPricingEntry } from "../lib/frontierPricing";
import { compactionPriceBoundary, compactionPricingEntry, describeCompactionPriceBoundary, modelCompactionWindows } from "../lib/modelCompactionPricing";
import { subscribeUsage } from "../lib/usageLedger";
import type { Provider } from "../types";

/**
 * This conversation's automatic compaction window. It used to sit at the
 * bottom of the composer's Sub-agents popover; it is a context setting, so it
 * now lives in Tools → Usage beside the manual Compact context action.
 * Same value, same setter and same lock as before: only the place changed.
 */

function describeTokenWindow(tokens: number): string {
  if (tokens % 1_000_000 === 0) return `${tokens / 1_000_000}M tokens`;
  if (tokens % 1_000 === 0) return `${tokens / 1_000}K tokens`;
  return `${tokens.toLocaleString("en-US")} tokens`;
}

/** Select value for a stored window that is present but not a valid choice. */
const INVALID_COMPACTION = "invalid";

function compactionValue(saved: number | undefined): string {
  if (saved === undefined) return "";
  return autoCompactTokensError(saved) ? INVALID_COMPACTION : String(saved);
}

/** Provider default, the model's published windows, and any saved custom value. */
function compactionChoices(saved: number | undefined, entry: FrontierCompactionPricingEntry | undefined, unavailable?: string): AppSelectOption[] {
  const windows = modelCompactionWindows(entry);
  const priceBoundary = compactionPriceBoundary(entry);
  const options: AppSelectOption[] = [
    { value: "", label: "Provider default", detail: "The provider decides when to compact" },
    ...windows.map((tokens) => ({
      value: String(tokens),
      label: describeTokenWindow(tokens),
      ...(tokens === priceBoundary ? { detail: "Published API price boundary; not a cost cap" }
        : tokens === 1_000_000 ? { detail: "Requested window; model limits still apply" } : {}),
    })),
  ];
  if (saved !== undefined && autoCompactTokensError(saved)) {
    options.splice(1, 0, { value: INVALID_COMPACTION, label: "Invalid saved value", detail: "Choose a window or Provider default", disabled: true });
  } else if (saved !== undefined && !windows.includes(saved)) {
    options.splice(1, 0, { value: String(saved), label: describeTokenWindow(saved), detail: "Previously configured" });
  }
  return unavailable
    ? options.map((option) => (option.value === "" ? option : { ...option, detail: unavailable, disabled: true }))
    : options;
}

function compactionIssue(saved: number | undefined, unsupportedBy?: string): string | null {
  if (saved === undefined) return null;
  if (autoCompactTokensError(saved)) return "The saved compaction window is not valid. Choose a window or Provider default.";
  return unsupportedBy ? `${unsupportedBy} has no compaction setting. Choose Provider default to clear the saved window.` : null;
}

/** Providers whose runtime exposes no configurable compaction window. */
function compactionUnsupportedBy(provider: Provider | undefined): string | undefined {
  return provider === "cursor" ? "Cursor" : undefined;
}

export interface ThreadCompactionSetting {
  /** The thread's saved window; undefined means Provider default. */
  value?: number;
  provider?: Provider;
  /** The thread's model, for the published price boundary. */
  model?: string;
  /** Running sub-agents were admitted with the current window, so it holds still. */
  locked?: boolean;
  onChange: (tokens?: number) => void;
}

export function ThreadCompactionControl({ value, provider, model, locked, onChange, action }: ThreadCompactionSetting & {
  /** The manual Compact context button, shown beside the heading. */
  action?: ReactNode;
}) {
  const [pricing, setPricing] = useState<readonly FrontierCompactionPricingEntry[]>([]);
  useEffect(() => {
    const read = () => setPricing(frontierCompactionPricingEntries());
    const unsubscribe = subscribeUsage(read);
    read();
    return unsubscribe;
  }, []);
  const unsupportedBy = compactionUnsupportedBy(provider);
  const entry = compactionPricingEntry(provider, model?.trim() ?? "", pricing);
  const choices = useMemo(
    () => compactionChoices(value, entry, unsupportedBy && `Not available for ${unsupportedBy}`),
    [entry, unsupportedBy, value],
  );
  const issue = compactionIssue(value, unsupportedBy);
  return (
    <div className="thread-compaction">
      <div className="thread-compaction-head">
        <span className="thread-compaction-copy">
          <strong>Auto-compact</strong>
          <small>{locked
            ? "Locked while this thread or its sub-agents are running."
            : unsupportedBy ? `${unsupportedBy} manages its own.` : "This thread · applies from the next turn"}</small>
        </span>
        {action}
      </div>
      <fieldset className="thread-compaction-field" disabled={locked} title={unsupportedBy ? undefined : `Automatic compaction, not a spending cap. ${describeCompactionPriceBoundary(entry)}`}>
        <legend className="sr-only">This conversation's automatic compaction</legend>
        <AppSelectMenu
          portal
          ariaLabel="Auto-compact this conversation"
          value={compactionValue(value)}
          options={choices}
          onChange={(next) => { if (!locked) onChange(next ? Number(next) : undefined); }}
        />
      </fieldset>
      {issue && (
        <p className="thread-compaction-issue">
          <AlertTriangle size={11} aria-hidden="true" />
          <span>{issue}</span>
        </p>
      )}
    </div>
  );
}
