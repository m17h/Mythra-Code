import { useEffect, useRef, useState, type CSSProperties } from "react";
import { Check, ChevronDown, Gauge } from "lucide-react";
import type { ReasoningEffort } from "./ModelPowerControl";
import { ClaudeLogo } from "./BrandLogos";

const MODELS = [
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
  const selected = MODELS.find((entry) => entry.id === model) ?? MODELS[0];
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
            <ClaudeLogo size={15} />
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
            {MODELS.map((entry) => (
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
                  <ClaudeLogo size={13} />
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
      <div className="openrouter-reasoning">
        <div className="openrouter-reasoning-heading">
          <Gauge size={13} />
          <span>Reasoning</span>
          <strong>{EFFORTS[effortIndex].label}</strong>
        </div>
        <div className="openrouter-reasoning-rail">
          <input
            aria-label="Claude reasoning effort"
            type="range"
            min={0}
            max={EFFORTS.length - 1}
            step={1}
            value={effortIndex}
            aria-valuetext={EFFORTS[effortIndex].label}
            onChange={(event) =>
              onEffort(EFFORTS[Number(event.target.value)].value)
            }
          />
          <div className="openrouter-reasoning-ticks" aria-hidden="true">
            {EFFORTS.map((entry, index) => (
              <i
                key={entry.value}
                className={index <= effortIndex ? "reached" : ""}
              />
            ))}
          </div>
        </div>
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
