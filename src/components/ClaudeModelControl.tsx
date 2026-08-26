import { useEffect, useRef, useState, type CSSProperties } from "react";
import { Check, ChevronDown, Gauge } from "lucide-react";
import { EffortSlider, effortFlairStyle } from "./effortFlair";
import type { ReasoningEffort } from "./ModelPowerControl";
import { ClaudeProviderLogo } from "./BrandLogos";

export const CLAUDE_MODELS = [
  { id: "claude-fable-5", name: "Fable 5", tagline: "Frontier coding" },
  { id: "claude-opus-5", name: "Opus 5", tagline: "Deepest reasoning" },
  { id: "claude-sonnet-5", name: "Sonnet 5", tagline: "Balanced power" },
  { id: "claude-haiku-4-5", name: "Haiku 4.5", tagline: "Fast and efficient" },
];

const EFFORTS: Array<{
  value: Exclude<ReasoningEffort, "ultra">;
  label: string;
  shortLabel: string;
}> = [
  { value: "low", label: "Light", shortLabel: "Light" },
  { value: "medium", label: "Medium", shortLabel: "Medium" },
  { value: "high", label: "High", shortLabel: "High" },
  { value: "xhigh", label: "Extra high", shortLabel: "Extra" },
  { value: "max", label: "Maximum", shortLabel: "Max" },
];

export function ClaudeModelControl({
  model,
  effort,
  onModel,
  onEffort,
}: {
  model: string;
  effort: ReasoningEffort;
  onModel: (model: string) => void;
  onEffort: (effort: ReasoningEffort) => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const selected = CLAUDE_MODELS.find((entry) => entry.id === model) ?? CLAUDE_MODELS[0];
  const normalizedEffort = effort === "ultra" ? "max" : effort;
  const effortIndex = Math.max(
    0,
    EFFORTS.findIndex((entry) => entry.value === normalizedEffort),
  );
  const fill = (effortIndex / (EFFORTS.length - 1)) * 100;

  useEffect(() => {
    const close = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, []);

  useEffect(() => {
    if (!open) return;
    // Capture phase + stopPropagation: Escape closes only this menu and never
    // reaches the app-level handler that stops the running turn.
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        setOpen(false);
        rootRef.current?.querySelector<HTMLButtonElement>(".openrouter-trigger")?.focus();
      }
    };
    document.addEventListener("keydown", escape, true);
    return () => document.removeEventListener("keydown", escape, true);
  }, [open]);

  return (
    <div
      className="openrouter-control claude-control"
      ref={rootRef}
      style={{ "--router-fill": `${fill}%` } as CSSProperties}
    >
      <div className={`openrouter-picker ${open ? "open" : ""}`}>
        <button
          type="button"
          className="openrouter-trigger"
          aria-haspopup="menu"
          aria-expanded={open}
          aria-label={`Claude model: ${selected.name}`}
          onClick={() => setOpen((value) => !value)}
        >
          <span className="openrouter-logo claude-logo">
            <ClaudeProviderLogo size={15} />
          </span>
          <span className="openrouter-trigger-copy">
            <small>Claude subscription model</small>
            <strong>{selected.name}</strong>
            <em>{selected.tagline}</em>
          </span>
          <ChevronDown size={15} />
        </button>
        <div className="openrouter-menu claude-model-menu">
          <div className="openrouter-menu-meta">
            <span>Claude models</span>
            <small>Uses your Claude Code login</small>
          </div>
          <div
            className="openrouter-options"
            role="menu"
            aria-label="Claude model selector"
          >
            {CLAUDE_MODELS.map((entry) => (
              <button
                type="button"
                role="menuitemradio"
                aria-checked={entry.id === selected.id}
                className={entry.id === selected.id ? "selected" : ""}
                key={entry.id}
                onClick={() => {
                  onModel(entry.id);
                  setOpen(false);
                }}
              >
                <span className="openrouter-provider-mark claude-logo">
                  <ClaudeProviderLogo size={13} />
                </span>
                <span>
                  <strong>{entry.name}</strong>
                  <small>{entry.tagline}</small>
                </span>
                <span className="openrouter-model-meta">{entry.id}</span>
                {entry.id === selected.id && <Check size={13} />}
              </button>
            ))}
          </div>
        </div>
      </div>
      <div
        className={`openrouter-reasoning ${effortIndex === EFFORTS.length - 1 ? "effort-max" : ""}`}
        style={effortFlairStyle(effortIndex, EFFORTS.length)}
      >
        <div className="openrouter-reasoning-heading">
          <Gauge size={13} />
          <span>Reasoning</span>
          {/* Keyed so each effort change replays the readout pop. */}
          <strong key={EFFORTS[effortIndex].value}>{EFFORTS[effortIndex].label}</strong>
        </div>
        <EffortSlider
          variant="router"
          index={effortIndex}
          count={EFFORTS.length}
          ariaLabel="Claude reasoning effort"
          valueText={EFFORTS[effortIndex].label}
          onIndex={(next) => onEffort(EFFORTS[next].value)}
        />
        <div className="openrouter-reasoning-labels">
          {EFFORTS.map((entry, index) => (
            <span
              key={entry.value}
              className={index === effortIndex ? "active" : ""}
            >
              {entry.shortLabel}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}
