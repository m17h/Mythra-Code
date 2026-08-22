import { useEffect, useRef, useState, type CSSProperties } from "react";
import { Check, ChevronDown, Earth, Gauge, Moon, Sun, Zap, type LucideIcon } from "lucide-react";

export type ModelKind = "sol" | "terra" | "luna";
export type ReasoningEffort = "low" | "medium" | "high" | "xhigh" | "max" | "ultra";

export interface RuntimeModel {
  id: string;
  model: string;
  displayName: string;
  description: string;
  supportedReasoningEfforts: Array<{ reasoningEffort: string; description: string }>;
  defaultReasoningEffort: string;
  isDefault: boolean;
}

const MODELS: Array<{ kind: ModelKind; name: string; id: string; tagline: string; icon: LucideIcon }> = [
  { kind: "sol", name: "Sol", id: "gpt-5.6-sol", tagline: "Detail & polish", icon: Sun },
  { kind: "terra", name: "Terra", id: "gpt-5.6-terra", tagline: "Everyday power", icon: Earth },
  { kind: "luna", name: "Luna", id: "gpt-5.6-luna", tagline: "Fast & focused", icon: Moon },
];

const EFFORTS: Array<{ value: Exclude<ReasoningEffort, "ultra">; label: string; shortLabel: string }> = [
  { value: "low", label: "Light", shortLabel: "Light" },
  { value: "medium", label: "Medium", shortLabel: "Medium" },
  { value: "high", label: "High", shortLabel: "High" },
  { value: "xhigh", label: "Extra high", shortLabel: "Extra" },
  { value: "max", label: "Maximum", shortLabel: "Max" },
];

export function modelKind(model: string): ModelKind {
  if (model.includes("terra")) return "terra";
  if (model.includes("luna")) return "luna";
  return "sol";
}

export function ModelPowerControl({
  model,
  effort,
  fast,
  runtimeModels,
  disabled,
  onModel,
  onEffort,
  onFast,
}: {
  model: string;
  effort: ReasoningEffort;
  fast: boolean;
  runtimeModels: RuntimeModel[];
  disabled?: boolean;
  onModel: (model: string) => void;
  onEffort: (effort: ReasoningEffort) => void;
  onFast: (enabled: boolean) => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const kind = modelKind(model);
  const selectedModel = MODELS.find((entry) => entry.kind === kind) ?? MODELS[0];
  const effortIndex = Math.max(0, EFFORTS.findIndex((entry) => entry.value === (effort === "ultra" ? "max" : effort)));
  const reasoningFill = (effortIndex / (EFFORTS.length - 1)) * 100;
  const SelectedModelIcon = selectedModel.icon;

  useEffect(() => {
    if (!menuOpen) return;
    function handlePointerDown(event: PointerEvent) {
      if (!rootRef.current?.contains(event.target as Node)) setMenuOpen(false);
    }
    // Capture phase + stopPropagation: Escape closes only this menu and never
    // reaches the app-level handler that stops the running turn.
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.stopPropagation();
        setMenuOpen(false);
        rootRef.current?.querySelector<HTMLButtonElement>(".model-picker-trigger")?.focus();
      }
    }
    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown, true);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown, true);
    };
  }, [menuOpen]);

  useEffect(() => {
    if (!menuOpen) return;
    const selectedIndex = Math.max(0, MODELS.findIndex((entry) => entry.kind === kind));
    requestAnimationFrame(() => optionRefs.current[selectedIndex]?.focus());
  }, [kind, menuOpen]);

  const moveOptionFocus = (direction: number) => {
    const enabled = optionRefs.current.filter((entry): entry is HTMLButtonElement => Boolean(entry && !entry.disabled));
    if (!enabled.length) return;
    const current = enabled.indexOf(document.activeElement as HTMLButtonElement);
    enabled[(current + direction + enabled.length) % enabled.length]?.focus();
  };

  return (
    <div
      ref={rootRef}
      className={`model-power-control ${kind} ${menuOpen ? "menu-open" : ""} ${disabled ? "disabled" : ""}`}
      style={{ "--reasoning-fill": `${reasoningFill}%` } as CSSProperties}
    >
      <div className="model-picker">
        <button
          type="button"
          className="model-picker-trigger"
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          aria-label={`OpenAI model: ${selectedModel.name}`}
          disabled={disabled}
          onClick={() => setMenuOpen((open) => !open)}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              setMenuOpen(true);
            }
          }}
        >
          <span className="model-orb"><SelectedModelIcon size={13} strokeWidth={2.2} /></span>
          <span className="model-picker-copy">
            <small>GPT-5.6 model</small>
            <strong>{selectedModel.name}</strong>
            <em>{selectedModel.tagline}</em>
          </span>
          <ChevronDown className="model-picker-chevron" size={15} />
        </button>

        <div className="model-menu" role="menu" aria-label="OpenAI model selector" onKeyDown={(event) => {
          if (event.key === "ArrowDown") { event.preventDefault(); moveOptionFocus(1); }
          if (event.key === "ArrowUp") { event.preventDefault(); moveOptionFocus(-1); }
          if (event.key === "Home") { event.preventDefault(); optionRefs.current.find((entry) => entry && !entry.disabled)?.focus(); }
          if (event.key === "End") { event.preventDefault(); [...optionRefs.current].reverse().find((entry) => entry && !entry.disabled)?.focus(); }
        }}>
          <div className="model-menu-heading"><span>Choose your model</span><small>OpenAI subscription</small></div>
          {MODELS.map((entry) => {
            const available = runtimeModels.length === 0 || runtimeModels.some((candidate) => candidate.model === entry.id || candidate.id === entry.id);
            const selected = kind === entry.kind;
            const ModelIcon = entry.icon;
            return (
              <button
                type="button"
                role="menuitemradio"
                aria-checked={selected}
                aria-label={`${entry.name}: ${entry.tagline}${available ? "" : " (unavailable)"}`}
                key={entry.kind}
                ref={(node) => { optionRefs.current[MODELS.indexOf(entry)] = node; }}
                className={`model-menu-option ${entry.kind} ${selected ? "selected" : ""}`}
                disabled={disabled || !available}
                onClick={() => {
                  onModel(entry.id);
                  setMenuOpen(false);
                }}
                title={available ? `${entry.name}: ${entry.tagline}` : `${entry.name} is not available for this account`}
              >
                <span className="menu-model-orb"><ModelIcon size={13} strokeWidth={2.2} /></span>
                <span><strong>{entry.name}</strong><small>{entry.tagline}</small></span>
                {selected && <Check size={14} />}
              </button>
            );
          })}
        </div>
      </div>

      <div className="reasoning-control">
        <div className="reasoning-heading"><Gauge size={13} /><span>Reasoning</span><button type="button" className={`fast-tier ${fast ? "on" : ""}`} aria-pressed={fast} aria-label="Use OpenAI fast priority service tier" onClick={() => onFast(!fast)} title="Use OpenAI priority service tier"><Zap size={9} /> Fast</button><strong>{EFFORTS[effortIndex].label}</strong></div>
        <div className="reasoning-rail">
          <input
            aria-label="Reasoning effort"
            type="range"
            min={0}
            max={EFFORTS.length - 1}
            step={1}
            value={effortIndex}
            disabled={disabled}
            onChange={(event) => onEffort(EFFORTS[Number(event.target.value)].value)}
          />
          <div className="reasoning-ticks" aria-hidden="true">
            {EFFORTS.map((entry, index) => <i key={entry.value} className={index <= effortIndex ? "reached" : ""} />)}
          </div>
        </div>
        <div className="reasoning-labels">
          {EFFORTS.map((entry, index) => <span key={entry.value} className={index === effortIndex ? "active" : ""}>{entry.shortLabel}</span>)}
        </div>
      </div>
    </div>
  );
}
