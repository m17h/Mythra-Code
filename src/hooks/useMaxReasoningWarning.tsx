import { createContext, useContext, useEffect, useRef } from "react";
import { confirmDialog } from "../lib/confirmDialog";

/** Saved app-wide preference; scope prevents a delayed answer changing another conversation. */
export const MaxReasoningWarningContext = createContext({ enabled: true, scope: "" });

const MAX_REASONING_MESSAGE = "Are you sure?\n\nMax reasoning can use substantially more tokens and take much longer, using up your subscription allowance or increasing API costs. More thinking does not guarantee a better answer: gains may be small, and overthinking can make some results worse.\n\nHigh is a better starting point for everyday work. Reserve Max for unusually difficult tasks where the improvement is worth the extra time and usage.";

/** Only deliberate selection changes are guarded; loading saved settings never prompts. */
export function useMaxReasoningWarning({ value, maxValue, scope, onChange, canApply }: {
  value: string;
  maxValue?: string;
  scope: string;
  onChange: (value: string) => void;
  canApply?: (value: string) => boolean;
}): (next: string) => boolean {
  const context = useContext(MaxReasoningWarningContext);
  const owner = JSON.stringify([context.scope, scope]);
  const latest = useRef({ value, owner, onChange, canApply });
  latest.current = { value, owner, onChange, canApply };
  const pending = useRef<AbortController | null>(null);

  useEffect(() => () => {
    pending.current?.abort();
    pending.current = null;
  }, [value, owner, context.enabled, maxValue]);

  return (next) => {
    if (canApply && !canApply(next)) return false;
    if (next === value) return true;
    if (!context.enabled || next !== maxValue) {
      pending.current?.abort();
      pending.current = null;
      onChange(next);
      return true;
    }
    // Pointer, keyboard repeat and assistive input all share one pending question.
    if (pending.current) return false;
    const controller = new AbortController();
    pending.current = controller;
    void confirmDialog(MAX_REASONING_MESSAGE, {
      confirmLabel: "Yes, use Max",
      cancelLabel: "No, keep current level",
      inApp: true,
      signal: controller.signal,
      links: [
        { label: "Compare models on Artificial Analysis", url: "https://artificialanalysis.ai/" },
      ],
      footer: "You can turn this warning off in Settings → Interface → Reasoning warnings.",
    }).then((confirmed) => {
      if (pending.current !== controller) return;
      pending.current = null;
      const current = latest.current;
      if (confirmed && !controller.signal.aborted && current.owner === owner && current.value === value
        && (!current.canApply || current.canApply(next))) current.onChange(next);
    });
    return false;
  };
}
