import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { Check, ChevronDown, Gauge, LoaderCircle, RefreshCw, Search } from "lucide-react";
import { EffortSlider, effortFlairStyle } from "./effortFlair";
import type { LMStudioModel, LMStudioReasoningEffort } from "../lib/lmStudio";
import type { ReasoningEffort } from "./ModelPowerControl";
import { LmStudioLogo } from "./BrandLogos";

const EFFORTS: Array<{ value: LMStudioReasoningEffort; label: string }> = [
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
  { value: "xhigh", label: "Extra" },
  { value: "max", label: "Max" },
];

export function LMStudioModelControl({
  model,
  models,
  effort,
  loading,
  error,
  onRefresh,
  onModel,
  onEffort,
}: {
  model: string;
  models: LMStudioModel[];
  effort: ReasoningEffort;
  loading: boolean;
  error: string;
  onRefresh: () => void;
  onModel: (model: string) => void;
  onEffort: (effort: ReasoningEffort) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const normalizedQuery = query.trim().toLowerCase();
  const filtered = useMemo(() => models.filter((entry) => (
    `${entry.id} ${entry.displayName} ${entry.publisher}`.toLowerCase().includes(normalizedQuery)
  )), [models, normalizedQuery]);
  const selectedModel = models.find((entry) => entry.id === model);
  const customModel = query.trim();
  const canUseCustom = Boolean(customModel) && !models.some((entry) => entry.id.toLowerCase() === normalizedQuery);
  const availableEfforts = selectedModel?.reasoningEfforts.length
    ? EFFORTS.filter((entry) => selectedModel.reasoningEfforts.includes(entry.value))
    : EFFORTS;
  const normalizedEffort = effort === "ultra" ? "max" : effort as LMStudioReasoningEffort;
  const effortIndex = Math.max(0, availableEfforts.findIndex((entry) => entry.value === normalizedEffort));
  const fill = availableEfforts.length > 1 ? (effortIndex / (availableEfforts.length - 1)) * 100 : 100;

  const selectModel = (entry: LMStudioModel) => {
    onModel(entry.id);
    if (entry.reasoningEfforts.length && !entry.reasoningEfforts.includes(normalizedEffort)) {
      onEffort(entry.defaultReasoningEffort ?? entry.reasoningEfforts[0]);
    }
    setOpen(false);
  };

  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        setOpen(false);
        rootRef.current?.querySelector<HTMLButtonElement>(".openrouter-trigger")?.focus();
      }
    };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", escape, true);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", escape, true);
    };
  }, [open]);

  useEffect(() => {
    if (open) requestAnimationFrame(() => searchRef.current?.focus());
    else setQuery("");
  }, [open]);

  return (
    <div className="openrouter-control lmstudio-control" ref={rootRef} style={{ "--router-fill": `${fill}%` } as CSSProperties}>
      <div className={`openrouter-picker ${open ? "open" : ""}`}>
        <button type="button" className="openrouter-trigger" aria-haspopup="menu" aria-expanded={open} aria-label={`LM Studio model: ${model || "not selected"}`} onClick={() => setOpen((value) => !value)}>
          <span className="openrouter-logo lmstudio-logo"><LmStudioLogo size={15} /></span>
          <span className="openrouter-trigger-copy">
            <small>LM Studio local model</small>
            <strong>{selectedModel?.displayName || model || "Choose a local model"}</strong>
            <em>{models.length ? `${models.length} model${models.length === 1 ? "" : "s"} from your LM Studio server` : "Start the LM Studio local server"}</em>
          </span>
          <ChevronDown size={15} />
        </button>

        <div className="openrouter-menu lmstudio-model-menu">
          <div className="openrouter-search-row">
            <Search size={14} />
            <input ref={searchRef} aria-label="Search LM Studio models" value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => {
              if (event.key === "ArrowDown") {
                event.preventDefault();
                optionRefs.current.find((item) => item?.isConnected)?.focus();
              }
            }} placeholder="Search or enter a model identifier…" />
            <button type="button" onClick={onRefresh} title="Refresh local models" aria-label="Refresh LM Studio model catalog" disabled={loading}>{loading ? <LoaderCircle className="spin" size={13} /> : <RefreshCw size={13} />}</button>
          </div>
          <div className="openrouter-menu-meta"><span>{normalizedQuery ? `${filtered.length} matches` : `${models.length} available`}</span><small>Local server catalog</small></div>
          <div className="openrouter-options" role="menu" aria-label="LM Studio model selector">
            {filtered.map((entry, entryIndex) => (
              <button type="button" role="menuitemradio" aria-checked={entry.id === model} aria-label={entry.id} className={entry.id === model ? "selected" : ""} key={entry.id} ref={(node) => { optionRefs.current[entryIndex] = node; }} onKeyDown={(event) => {
                const enabled = optionRefs.current.filter((item): item is HTMLButtonElement => Boolean(item?.isConnected));
                const index = enabled.indexOf(event.currentTarget);
                if (event.key === "ArrowDown") { event.preventDefault(); enabled[(index + 1) % enabled.length]?.focus(); }
                if (event.key === "ArrowUp") { event.preventDefault(); (index <= 0 ? searchRef.current : enabled[index - 1])?.focus(); }
              }} onClick={() => selectModel(entry)}>
                <span className="openrouter-provider-mark lmstudio-logo"><LmStudioLogo size={13} /></span>
                <span><strong>{entry.displayName}</strong><small>{entry.id} · {entry.trainedForToolUse ? "Tool use" : "No tool-use training"}</small></span>
                {entry.id === model && <Check size={13} />}
              </button>
            ))}
            {canUseCustom && <button type="button" role="menuitemradio" aria-checked={false} className="custom-model-option" onClick={() => { onModel(customModel); setQuery(""); setOpen(false); }}><span className="openrouter-provider-mark">+</span><span><strong>Use model identifier</strong><small>{customModel}</small></span></button>}
            {!loading && filtered.length === 0 && !canUseCustom && <div className="openrouter-empty"><strong>{error ? "LM Studio is not connected" : "No matching models"}</strong><span>{error || "Download or load a model in LM Studio, then refresh this list."}</span></div>}
          </div>
        </div>
      </div>

      <div className={`openrouter-reasoning ${availableEfforts.length > 1 && effortIndex === availableEfforts.length - 1 ? "effort-max" : ""}`} style={effortFlairStyle(effortIndex, availableEfforts.length)}>
        <div className="openrouter-reasoning-heading"><Gauge size={13} /><span>Reasoning</span><strong key={availableEfforts[effortIndex].value}>{availableEfforts[effortIndex].label}</strong></div>
        <EffortSlider variant="router" index={effortIndex} count={availableEfforts.length} ariaLabel="LM Studio reasoning effort" valueText={availableEfforts[effortIndex].label} onIndex={(next) => onEffort(availableEfforts[next].value)} />
        <div className="openrouter-reasoning-labels">{availableEfforts.map((entry, index) => <span key={entry.value} className={index === effortIndex ? "active" : ""}>{entry.label}</span>)}</div>
      </div>
    </div>
  );
}
