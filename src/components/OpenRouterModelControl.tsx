import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { Check, ChevronDown, Gauge, LoaderCircle, RefreshCw, Search } from "lucide-react";
import { EffortSlider, effortFlairStyle } from "./effortFlair";
import type { ReasoningEffort } from "./ModelPowerControl";
import { OpenRouterLogo } from "./BrandLogos";

export interface OpenRouterModel {
  id: string;
  name: string;
  description?: string;
  context_length?: number;
  supported_parameters?: string[];
  pricing?: { prompt?: string; completion?: string };
}

const EFFORTS: Array<{ value: Exclude<ReasoningEffort, "ultra">; label: string; shortLabel: string }> = [
  { value: "low", label: "Light", shortLabel: "Light" },
  { value: "medium", label: "Medium", shortLabel: "Medium" },
  { value: "high", label: "High", shortLabel: "High" },
  { value: "xhigh", label: "Extra high", shortLabel: "Extra" },
  { value: "max", label: "Maximum", shortLabel: "Max" },
];

function compactContext(value?: number): string {
  if (!value) return "";
  if (value >= 1_000_000) return `${Math.round(value / 100_000) / 10}M ctx`;
  return `${Math.round(value / 1000)}K ctx`;
}

function providerName(id: string): string {
  const provider = id.split("/")[0] || "OpenRouter";
  return provider.replace(/(^|-)([a-z])/g, (_, separator: string, letter: string) => `${separator}${letter.toUpperCase()}`);
}

export function OpenRouterModelControl({
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
  models: OpenRouterModel[];
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
  const normalizedEffort = effort === "ultra" ? "max" : effort;
  const effortIndex = Math.max(0, EFFORTS.findIndex((entry) => entry.value === normalizedEffort));
  const fill = (effortIndex / (EFFORTS.length - 1)) * 100;
  const selected = models.find((entry) => entry.id === model);
  const query = search.trim().toLowerCase();
  const filtered = useMemo(() => {
    if (!query) return models.slice(0, 80);
    return models
      .filter((entry) => `${entry.name} ${entry.id} ${entry.description ?? ""}`.toLowerCase().includes(query))
      .slice(0, 80);
  }, [models, query]);
  const canUseCustom = search.trim().includes("/") && !models.some((entry) => entry.id.toLowerCase() === query);

  useEffect(() => {
    if (!open) return;
    function handlePointerDown(event: PointerEvent) {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    }
    // Capture phase + stopPropagation: Escape closes only this menu and never
    // reaches the app-level handler that stops the running turn.
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.stopPropagation();
        setOpen(false);
        rootRef.current?.querySelector<HTMLButtonElement>(".openrouter-trigger")?.focus();
      }
    }
    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown, true);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown, true);
    };
  }, [open]);

  useEffect(() => {
    if (open) requestAnimationFrame(() => searchRef.current?.focus());
  }, [open]);

  return (
    <div className="openrouter-control" ref={rootRef} style={{ "--router-fill": `${fill}%` } as CSSProperties}>
      <div className={`openrouter-picker ${open ? "open" : ""}`}>
        <button type="button" className="openrouter-trigger" aria-haspopup="menu" aria-expanded={open} aria-label={`OpenRouter model: ${selected?.name || model || "not selected"}`} onClick={() => setOpen((value) => !value)} onKeyDown={(event) => { if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); setOpen(true); } }}>
          <span className="openrouter-logo openrouter-brand-logo"><OpenRouterLogo size={16} /></span>
          <span className="openrouter-trigger-copy">
            <small>OpenRouter model</small>
            <strong>{selected?.name || model || "Choose a model"}</strong>
            <em>{model ? `${providerName(model)}${selected?.context_length ? ` · ${compactContext(selected.context_length)}` : ""}` : `${models.length || "Live"} tool-capable models`}</em>
          </span>
          <ChevronDown size={15} />
        </button>

        <div className="openrouter-menu">
          <div className="openrouter-search-row">
            <Search size={14} />
            <input ref={searchRef} aria-label="Search OpenRouter models" value={search} onChange={(event) => setSearch(event.target.value)} onKeyDown={(event) => { if (event.key === "ArrowDown") { event.preventDefault(); optionRefs.current.find((item) => item?.isConnected)?.focus(); } }} placeholder="Search models or enter provider/model…" />
            <button type="button" onClick={onRefresh} title="Refresh catalog" aria-label="Refresh OpenRouter model catalog" disabled={loading}>{loading ? <LoaderCircle className="spin" size={13} /> : <RefreshCw size={13} />}</button>
          </div>
          <div className="openrouter-menu-meta"><span>{query ? `${filtered.length} matches` : `${models.length} available`}</span><small>Tool-capable catalog</small></div>
          <div className="openrouter-options" role="menu" aria-label="OpenRouter model selector">
            {filtered.map((entry) => (
              <button
                type="button"
                role="menuitemradio"
                aria-checked={entry.id === model}
                aria-label={`${entry.name || entry.id}, ${providerName(entry.id)}`}
                className={entry.id === model ? "selected" : ""}
                key={entry.id}
                ref={(node) => { optionRefs.current[filtered.indexOf(entry)] = node; }}
                onKeyDown={(event) => {
                  // Filtering shrinks the list without truncating the ref
                  // array; only connected nodes are real navigation targets.
                  const enabled = optionRefs.current.filter((item): item is HTMLButtonElement => Boolean(item?.isConnected));
                  const index = enabled.indexOf(event.currentTarget);
                  if (event.key === "ArrowDown") { event.preventDefault(); enabled[(index + 1) % enabled.length]?.focus(); }
                  if (event.key === "ArrowUp") { event.preventDefault(); (index <= 0 ? searchRef.current : enabled[index - 1])?.focus(); }
                }}
                onClick={() => {
                  onModel(entry.id);
                  setSearch("");
                  setOpen(false);
                }}
              >
                <span className="openrouter-provider-mark">{providerName(entry.id).slice(0, 2).toUpperCase()}</span>
                <span><strong>{entry.name || entry.id}</strong><small>{entry.id}</small></span>
                <span className="openrouter-model-meta">{compactContext(entry.context_length)}{entry.supported_parameters?.includes("reasoning") ? " · reasoning" : ""}</span>
                {entry.id === model && <Check size={13} />}
              </button>
            ))}
            {canUseCustom && (
              <button type="button" role="menuitemradio" aria-checked={false} className="custom-model-option" onClick={() => { onModel(search.trim()); setSearch(""); setOpen(false); }}>
                <span className="openrouter-provider-mark">+</span>
                <span><strong>Use custom model slug</strong><small>{search.trim()}</small></span>
              </button>
            )}
            {!loading && !filtered.length && !canUseCustom && <div className="openrouter-empty"><strong>No matching models</strong><span>{error || "Enter a complete provider/model slug to use it directly."}</span></div>}
          </div>
          {error && <div className="openrouter-catalog-warning">{error} · Custom slugs still work.</div>}
        </div>
      </div>

      <div className={`openrouter-reasoning ${effortIndex === EFFORTS.length - 1 ? "effort-max" : ""}`} style={effortFlairStyle(effortIndex, EFFORTS.length)}>
        <div className="openrouter-reasoning-heading"><Gauge size={13} /><span>Reasoning</span><strong key={EFFORTS[effortIndex].value}>{EFFORTS[effortIndex].label}</strong></div>
        <EffortSlider variant="router" index={effortIndex} count={EFFORTS.length} ariaLabel="OpenRouter reasoning effort" valueText={EFFORTS[effortIndex].label} onIndex={(next) => onEffort(EFFORTS[next].value)} />
        <div className="openrouter-reasoning-labels">{EFFORTS.map((entry, index) => <span key={entry.value} className={index === effortIndex ? "active" : ""}>{entry.shortLabel}</span>)}</div>
      </div>
    </div>
  );
}
