import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { Check, ChevronDown, Gauge, LoaderCircle, RefreshCw, Search } from "lucide-react";
import type { ReasoningEffort } from "./ModelPowerControl";
import { LmStudioLogo } from "./BrandLogos";

export interface LmStudioModel {
  id: string;
  object?: string;
  name?: string;
  owned_by?: string;
  context_length?: number;
  trained_for_tool_use?: boolean;
  reasoning?: { allowed_options?: string[]; default?: string } | null;
}

const EFFORTS: Array<{ value: Exclude<ReasoningEffort, "ultra">; label: string; shortLabel: string }> = [
  { value: "low", label: "Light", shortLabel: "Light" },
  { value: "medium", label: "Medium", shortLabel: "Medium" },
  { value: "high", label: "High", shortLabel: "High" },
  { value: "xhigh", label: "Extra high", shortLabel: "Extra" },
  { value: "max", label: "Maximum", shortLabel: "Max" },
];
const EFFORT_VALUES = new Set(EFFORTS.map((entry) => entry.value));

function lmStudioReasoningEffort(value: unknown): Exclude<ReasoningEffort, "ultra"> | undefined {
  return typeof value === "string" && EFFORT_VALUES.has(value as Exclude<ReasoningEffort, "ultra">)
    ? value as Exclude<ReasoningEffort, "ultra">
    : undefined;
}

export function LmStudioModelControl({
  model,
  effort,
  models,
  loading,
  error,
  onModel,
  onEffort,
  onRefresh,
}: {
  model: string;
  effort: ReasoningEffort;
  models: LmStudioModel[];
  loading: boolean;
  error: string;
  onModel: (model: string) => void;
  onEffort: (effort: ReasoningEffort) => void;
  onRefresh: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const selectedModel = models.find((entry) => entry.id === model);
  const reportedEfforts = (selectedModel?.reasoning?.allowed_options ?? [])
    .map(lmStudioReasoningEffort)
    .filter((entry): entry is Exclude<ReasoningEffort, "ultra"> => Boolean(entry));
  const availableEfforts = reportedEfforts.length
    ? EFFORTS.filter((entry) => reportedEfforts.includes(entry.value))
    : EFFORTS;
  const normalizedEffort = effort === "ultra" ? "max" : effort;
  const effortIndex = Math.max(0, availableEfforts.findIndex((entry) => entry.value === normalizedEffort));
  const fill = availableEfforts.length > 1 ? (effortIndex / (availableEfforts.length - 1)) * 100 : 100;
  const query = search.trim().toLowerCase();
  const filtered = useMemo(() => (
    query ? models.filter((entry) => `${entry.id} ${entry.name ?? ""} ${entry.owned_by ?? ""}`.toLowerCase().includes(query)) : models
  ).slice(0, 100), [models, query]);
  const customModel = search.trim();
  const canUseCustom = Boolean(customModel) && !models.some((entry) => entry.id.toLowerCase() === query);
  const selectModel = (entry: LmStudioModel) => {
    onModel(entry.id);
    const supported = (entry.reasoning?.allowed_options ?? [])
      .map(lmStudioReasoningEffort)
      .filter((value): value is Exclude<ReasoningEffort, "ultra"> => Boolean(value));
    if (supported.length && !supported.includes(normalizedEffort)) {
      const defaultEffort = lmStudioReasoningEffort(entry.reasoning?.default);
      onEffort(defaultEffort && supported.includes(defaultEffort) ? defaultEffort : supported[0]);
    }
    setSearch("");
    setOpen(false);
  };

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      setOpen(false);
      rootRef.current?.querySelector<HTMLButtonElement>(".openrouter-trigger")?.focus();
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown, true);
    };
  }, [open]);

  useEffect(() => {
    if (open) requestAnimationFrame(() => searchRef.current?.focus());
    else setSearch("");
  }, [open]);

  return (
    <div className="openrouter-control lmstudio-control" ref={rootRef} style={{ "--router-fill": `${fill}%` } as CSSProperties}>
      <div className={`openrouter-picker ${open ? "open" : ""}`}>
        <button type="button" className="openrouter-trigger" aria-haspopup="menu" aria-expanded={open} aria-label={`LM Studio model: ${model || "not selected"}`} onClick={() => setOpen((value) => !value)}>
          <span className="openrouter-logo lmstudio-logo"><LmStudioLogo size={15} /></span>
          <span className="openrouter-trigger-copy">
            <small>LM Studio model</small>
            <strong>{selectedModel?.name || model || "Choose a local model"}</strong>
            <em>{error ? "Server unavailable" : `${models.length} model${models.length === 1 ? "" : "s"} from your LM Studio server`}</em>
          </span>
          <ChevronDown size={15} />
        </button>

        <div className="openrouter-menu lmstudio-model-menu">
          <div className="openrouter-search-row">
            <Search size={14} />
            <input ref={searchRef} aria-label="Search LM Studio models" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search or enter a model identifier…" />
            <button type="button" onClick={onRefresh} title="Refresh LM Studio models" aria-label="Refresh LM Studio models" disabled={loading}>{loading ? <LoaderCircle className="spin" size={13} /> : <RefreshCw size={13} />}</button>
          </div>
          <div className="openrouter-menu-meta"><span>{query ? `${filtered.length} matches` : `${models.length} available`}</span><small>Local server catalog</small></div>
          <div className="openrouter-options" role="menu" aria-label="LM Studio model selector">
            {filtered.map((entry, index) => (
              <button
                type="button"
                role="menuitemradio"
                aria-checked={entry.id === model}
                className={entry.id === model ? "selected" : ""}
                key={entry.id}
                ref={(node) => { optionRefs.current[index] = node; }}
                onKeyDown={(event) => {
                  const enabled = optionRefs.current.filter((item): item is HTMLButtonElement => Boolean(item?.isConnected));
                  const current = enabled.indexOf(event.currentTarget);
                  if (event.key === "ArrowDown") { event.preventDefault(); enabled[(current + 1) % enabled.length]?.focus(); }
                  if (event.key === "ArrowUp") { event.preventDefault(); (current <= 0 ? searchRef.current : enabled[current - 1])?.focus(); }
                }}
                onClick={() => selectModel(entry)}
              >
                <span className="openrouter-provider-mark lmstudio-logo"><LmStudioLogo size={13} /></span>
                <span><strong>{entry.name || entry.id}</strong><small>{entry.id} · {entry.owned_by || "LM Studio"}</small></span>
                <span className="openrouter-model-meta">{entry.context_length ? `${Math.round(entry.context_length / 1000)}K ctx` : ""}{entry.trained_for_tool_use ? " · tools" : ""}</span>
                {entry.id === model && <Check size={13} />}
              </button>
            ))}
            {canUseCustom && (
              <button type="button" role="menuitemradio" aria-checked={false} className="custom-model-option" onClick={() => { onModel(customModel); setSearch(""); setOpen(false); }}>
                <span className="openrouter-provider-mark">+</span>
                <span><strong>Use model identifier</strong><small>{customModel}</small></span>
              </button>
            )}
            {!loading && !filtered.length && !canUseCustom && <div className="openrouter-empty"><strong>{error ? "LM Studio is unavailable" : "No models available"}</strong><span>{error || "Load a model in LM Studio, then refresh."}</span></div>}
          </div>
          {error && <div className="openrouter-catalog-warning">{error}</div>}
        </div>
      </div>

      <div className="openrouter-reasoning">
        <div className="openrouter-reasoning-heading"><Gauge size={13} /><span>Reasoning</span><strong>{availableEfforts[effortIndex].label}</strong></div>
        <div className="openrouter-reasoning-rail">
          <input aria-label="LM Studio reasoning effort" type="range" min={0} max={availableEfforts.length - 1} step={1} value={effortIndex} onChange={(event) => onEffort(availableEfforts[Number(event.target.value)].value)} />
          <div className="openrouter-reasoning-ticks" aria-hidden="true">{availableEfforts.map((entry, index) => <i key={entry.value} className={index <= effortIndex ? "reached" : ""} />)}</div>
        </div>
        <div className="openrouter-reasoning-labels">{availableEfforts.map((entry, index) => <span key={entry.value} className={index === effortIndex ? "active" : ""}>{entry.shortLabel}</span>)}</div>
      </div>
    </div>
  );
}
