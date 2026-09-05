import { useEffect, useId, useRef, useState } from "react";
import { ChevronDown, Clock3, Gauge, X } from "lucide-react";
import { hasUsageCountdown, selectedUsageWindow, usageResetText, type AccountUsageView, type AccountUsageWindowView, type ProviderHeaderUsageView } from "../lib/providerUsage";
import "./UsagePopover.css";
import { usePopoverFade } from "../hooks/usePopoverFade";

/** Exit decoration keeps its text, but stops its clock as soon as closed. */
function UsageResetLabel({ window: usageWindow, active }: { window: AccountUsageWindowView; active: boolean }) {
  const [now, setNow] = useState(Date.now);
  const countdown = hasUsageCountdown(usageWindow);
  useEffect(() => {
    if (!active || !countdown) return;
    const refresh = () => setNow(Date.now());
    const onVisible = () => { if (!document.hidden) refresh(); };
    refresh();
    const timer = window.setInterval(refresh, 60_000);
    document.addEventListener("visibilitychange", onVisible);
    return () => { window.clearInterval(timer); document.removeEventListener("visibilitychange", onVisible); };
  }, [active, countdown, usageWindow.resetsAt]);
  return <small><Clock3 size={12} aria-hidden="true" />{usageResetText(usageWindow, now)}</small>;
}

/**
 * Opening asks for a fresh reading rather than rendering the last one blindly:
 * looking at the panel is the clearest signal that the number on screen is the
 * one the user cares about right now. The request is throttled upstream, so a
 * hover sweep or a panel opened twice in a row costs a single round trip.
 */
export function UsagePopover({ provider, usage, header, selectedLabel, onSelect, onDetails, onConnect, onOpen }: {
  provider: "openai" | "claude";
  usage: AccountUsageView;
  header: ProviderHeaderUsageView;
  selectedLabel?: string;
  onSelect: (label: string) => void;
  onDetails: () => void;
  onConnect: () => void;
  onOpen?: () => void;
}) {
  const [mode, setMode] = useState<"closed" | "hover" | "pinned">("closed");
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const id = useId();
  const open = mode !== "closed";
  const { ref: panelRef, present } = usePopoverFade(open);
  const windows = usage.windows ?? [];
  const selected = selectedUsageWindow(windows, selectedLabel);
  const clearTimer = () => { clearTimeout(timerRef.current); timerRef.current = undefined; };
  const close = (restoreFocus = false) => {
    clearTimer();
    if (restoreFocus || panelRef.current?.contains(document.activeElement)) triggerRef.current?.focus();
    setMode("closed");
  };

  useEffect(() => () => clearTimeout(timerRef.current), []);

  const onOpenRef = useRef(onOpen);
  onOpenRef.current = onOpen;
  useEffect(() => {
    if (open) onOpenRef.current?.();
  }, [open, panelRef]);


  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent | FocusEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) {
        clearTimeout(timerRef.current);
        if (panelRef.current?.contains(document.activeElement)) triggerRef.current?.focus();
        setMode("closed");
      }
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      // An incidental hover must not disable the app's stop-turn shortcut.
      // An explicitly opened/focused panel, however, owns its dismissal key.
      if (mode === "pinned" || panelRef.current?.contains(document.activeElement)) {
        event.preventDefault();
        event.stopPropagation();
      }
      clearTimeout(timerRef.current);
      setMode("closed");
      if (panelRef.current?.contains(document.activeElement)) triggerRef.current?.focus();
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("focusin", outside);
    document.addEventListener("keydown", escape, true);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("focusin", outside);
      document.removeEventListener("keydown", escape, true);
    };
  }, [mode, open, panelRef]);

  useEffect(() => {
    if (mode === "pinned") {
      (panelRef.current?.querySelector<HTMLInputElement>("input:checked")
        ?? panelRef.current?.querySelector<HTMLButtonElement>("button"))?.focus();
    }
  }, [mode, panelRef]);

  return (
    <div className="usage-popover-anchor" ref={rootRef}
      onFocusCapture={clearTimer}
      onPointerEnter={(event) => {
        if (event.pointerType === "touch") return;
        clearTimer();
        if (mode === "closed") {
          if (present) setMode("hover");
          else timerRef.current = setTimeout(() => setMode("hover"), 200);
        }
      }}
      onPointerLeave={() => {
        clearTimer();
        if (mode === "hover" && !panelRef.current?.contains(document.activeElement)) {
          timerRef.current = setTimeout(() => setMode("closed"), 180);
        }
      }}
    >
      <button ref={triggerRef} className={`topbar-usage-chip ${provider}`} type="button"
        aria-label={`${usage.label}: ${header.text}. Open usage details`}
        aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? id : undefined}
        onClick={() => { clearTimer(); if (mode === "pinned") close(true); else setMode("pinned"); }}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown") { event.preventDefault(); clearTimer(); setMode("pinned"); }
        }}
      >
        <Gauge size={13} aria-hidden="true" /><span>{header.text}</span><ChevronDown size={12} aria-hidden="true" />
      </button>
      {present && <div ref={panelRef} id={id} className="usage-popover" style={{ opacity: 0 }} role="dialog" aria-hidden={!open || undefined} inert={!open || undefined} aria-label={`${provider === "claude" ? "Claude" : "Codex"} usage details`}>
        <div className="usage-popover-heading">
          <div><strong>{provider === "claude" ? "Claude Code" : "Codex"} usage</strong><small>{usage.planLabel || "Subscription limits"}</small></div>
          <button type="button" className="icon-button" aria-label="Close usage details" onClick={() => close(true)}><X size={15} /></button>
        </div>
        {windows.length ? <fieldset className="usage-popover-windows">
          <legend>Show in top bar</legend>
          {windows.map((window, index) => <label key={`${window.label}-${index}`} className={`usage-popover-window ${window === selected ? "selected" : ""}`}>
            <input type="radio" name={`${id}-window`} checked={window === selected} aria-label={`Show ${window.label} in top bar`}
              onChange={() => { clearTimer(); setMode("pinned"); onSelect(window.label); }} />
            <span className="usage-popover-window-body">
              <span className="usage-popover-window-heading"><strong>{window.label}</strong><b>{window.percentLabel}</b></span>
              <span className="usage-popover-track" role="progressbar" aria-label={`${window.label} quota`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={window.percent} aria-valuetext={window.percentLabel}>
                <span style={{ width: `${window.percent}%` }} />
              </span>
              <UsageResetLabel window={window} active={open} />
            </span>
          </label>)}
        </fieldset> : <p className="usage-popover-empty">{usage.summary}</p>}
        <p className="usage-popover-note">Account-wide limits, shared across your threads. Only limits reported by the provider are shown.</p>
        <button type="button" className="usage-popover-details" onClick={() => { close(); if (header.needsConnection) onConnect(); else onDetails(); }}>
          {header.needsConnection ? "Models & accounts" : "More usage details"}
        </button>
      </div>}
    </div>
  );
}
