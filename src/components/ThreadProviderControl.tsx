import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown, Settings } from "lucide-react";
import type { Provider } from "../types";
import { ProviderLogo } from "./BrandLogos";

const PROVIDERS: Array<{ id: Provider; label: string; detail: string }> = [
  { id: "openai", label: "OpenAI", detail: "ChatGPT subscription" },
  { id: "claude", label: "Claude", detail: "Claude Code subscription" },
  { id: "cursor", label: "Cursor", detail: "Cursor subscription models" },
  { id: "openrouter", label: "OpenRouter", detail: "API model routing" },
];

function providerLabel(provider: Provider): string {
  return PROVIDERS.find((entry) => entry.id === provider)?.label ?? "OpenAI";
}

export function ThreadProviderControl({
  provider,
  model,
  defaultProvider,
  threadStarted,
  disabled,
  onProvider,
  onDefaultSettings,
}: {
  provider: Provider;
  model: string;
  defaultProvider: Provider;
  threadStarted: boolean;
  disabled?: boolean;
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
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        // Escape closes only this menu — never the app-level stop-turn handler.
        event.stopPropagation();
        setOpen(false);
      }
    };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", escape, true);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", escape, true);
    };
  }, [open]);

  const label = providerLabel(provider);
  return (
    <div className="thread-provider-control" ref={rootRef}>
      <button
        className="provider-pill"
        onClick={() => setOpen((value) => !value)}
        aria-label={`${threadStarted ? "Thread" : "New thread"} provider: ${label}`}
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={disabled}
      >
        <span className={`provider-mark ${provider}`}><ProviderLogo provider={provider} size={13} /></span>
        <span className="provider-label">{label}</span>
        {model && <small>{model}</small>}
        <ChevronDown size={12} />
      </button>
      {open && (
        <div className="thread-provider-menu" role="menu" aria-label="Thread provider">
          <div className="thread-provider-menu-heading" role="presentation">
            <strong>{threadStarted ? "Thread provider" : "Provider for this thread"}</strong>
            <small>{threadStarted ? "Changing provider starts a new thread so conversation context stays correct." : "This choice does not change the app default."}</small>
          </div>
          {PROVIDERS.map((entry) => (
            <button
              key={entry.id}
              role="menuitemradio"
              aria-checked={entry.id === provider}
              className={entry.id === provider ? "selected" : ""}
              onClick={() => {
                setOpen(false);
                if (entry.id !== provider) onProvider(entry.id);
              }}
            >
              <span className={`provider-mark ${entry.id}`}><ProviderLogo provider={entry.id} size={14} /></span>
              <span><strong>{entry.label}</strong><small>{entry.id === provider ? (threadStarted ? "Current thread" : "Selected for this thread") : threadStarted ? `Start a new ${entry.label} thread` : entry.detail}</small></span>
              {entry.id === provider && <Check size={14} />}
            </button>
          ))}
          <button
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
      )}
    </div>
  );
}
