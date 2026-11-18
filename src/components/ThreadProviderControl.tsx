import { useEffect, useRef, useState } from "react";
import { useMenuKeyboard } from "../hooks/useMenuKeyboard";
import { Check, ChevronDown, Settings } from "lucide-react";
import type { Provider } from "../types";
import { ProviderLogo } from "./BrandLogos";

const PROVIDERS: Array<{ id: Provider; label: string; detail: string }> = [
  { id: "openai", label: "OpenAI", detail: "ChatGPT plan or API key" },
  { id: "claude", label: "Claude", detail: "Claude Code · subscription or API key" },
  { id: "cursor", label: "Cursor", detail: "Cursor subscription models" },
  { id: "openrouter", label: "OpenRouter", detail: "API model routing" },
  { id: "lmstudio", label: "LM Studio", detail: "Local models on your computer" },
];

function providerLabel(provider: Provider): string {
  return PROVIDERS.find((entry) => entry.id === provider)?.label ?? "OpenAI";
}

export function ThreadProviderControl({
  provider,
  defaultProvider,
  threadStarted,
  disabled,
  unavailable,
  onUnavailable,
  onProvider,
  onDefaultSettings,
}: {
  provider: Provider;
  defaultProvider: Provider;
  threadStarted: boolean;
  disabled?: boolean;
  unavailable?: Partial<Record<Provider, string>>;
  onUnavailable?: (message: string) => void;
  onProvider: (provider: Provider) => void;
  onDefaultSettings: () => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    // Arrow keys open a model catalog straight from its trigger, emitting no
    // pointer or click event, so that path needs its own dismissal or both
    // popovers end up open at once. Escape is handled by useMenuKeyboard.
    const keys = (event: KeyboardEvent) => {
      if ((event.key === "ArrowDown" || event.key === "ArrowUp") && !rootRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("pointerdown", close);
    document.addEventListener("click", close);
    document.addEventListener("keydown", keys, true);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("click", close);
      document.removeEventListener("keydown", keys, true);
    };
  }, [open]);

  const label = providerLabel(provider);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuKeys = useMenuKeyboard({ open, setOpen, menuRef, triggerRef });
  return (
    <div className={`thread-provider-control composer-provider-control ${open ? "open" : ""}`} ref={rootRef}>
      <button
        ref={triggerRef}
        type="button"
        className={`provider-pill openrouter-trigger ${unavailable?.[provider] ? "unavailable" : ""}`}
        onClick={() => setOpen((value) => !value)}
        onPointerDown={menuKeys.onTriggerPointerDown}
        onKeyDown={menuKeys.onTriggerKeyDown}
        title={`Provider: ${label}`}
        aria-label={`${threadStarted ? "Thread" : "New thread"} provider: ${label}`}
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={disabled}
      >
        <span className={`provider-mark ${provider}`} aria-hidden="true"><ProviderLogo provider={provider} size={provider === "claude" ? 16 : 13} /></span>
        <span className="openrouter-trigger-copy"><small>Provider</small><strong>{label}</strong></span>
        <ChevronDown size={12} aria-hidden="true" />
      </button>
      <div ref={menuRef} className="thread-provider-menu" role="menu" aria-hidden={!open || undefined} inert={!open || undefined} aria-label="Provider" onKeyDown={menuKeys.onMenuKeyDown}>
          <div className="composer-menu-heading thread-provider-menu-heading" role="presentation">
            <strong>Provider</strong>
            <small>{threadStarted ? "Another provider continues in a new linked thread." : "For this thread only."}</small>
          </div>
          {PROVIDERS.map((entry) => (
            <button
              type="button"
              key={entry.id}
              tabIndex={-1}
              role="menuitemradio"
              aria-checked={entry.id === provider}
              className={`${entry.id === provider ? "selected" : ""} ${unavailable?.[entry.id] ? "unavailable" : ""}`}
              aria-disabled={Boolean(unavailable?.[entry.id]) || undefined}
              onClick={() => {
                const issue = unavailable?.[entry.id];
                if (issue) { onUnavailable?.(issue); return; }
                menuKeys.select(() => { if (entry.id !== provider) onProvider(entry.id); });
                // A new provider swaps the whole model control, and this pill
                // with it: give focus to the pill that replaced it.
                if (entry.id !== provider) requestAnimationFrame(() => requestAnimationFrame(() => {
                  const active = document.activeElement;
                  if (active && active !== document.body && active.isConnected) return;
                  document.querySelector<HTMLElement>(".composer-zone .provider-pill")?.focus();
                }));
              }}
            >
              <span className={`provider-mark ${entry.id}`}><ProviderLogo provider={entry.id} size={entry.id === "claude" ? 16 : 14} /></span>
              <span><strong>{entry.label}</strong><small>{entry.id === provider ? (threadStarted ? "Current thread" : "Selected for this thread") : threadStarted ? `Hand off to ${entry.label}` : entry.detail}</small></span>
              {entry.id === provider && <Check size={14} />}
            </button>
          ))}
          <button
            type="button"
            tabIndex={-1}
            className="thread-provider-default"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              onDefaultSettings();
            }}
          >
            <Settings size={14} />
            <span><strong>Default for new threads</strong><small>{providerLabel(defaultProvider)} · change in Settings</small></span>
          </button>
      </div>
    </div>
  );
}
