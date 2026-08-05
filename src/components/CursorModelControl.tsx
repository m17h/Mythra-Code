import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { Check, ChevronDown, Gauge, LoaderCircle, RefreshCw, Search, X } from "lucide-react";
import type { CursorModel } from "../lib/cursor";
import type { ReasoningEffort } from "./ModelPowerControl";
import { CursorProviderLogo } from "./BrandLogos";

const EFFORTS: Array<{ value: Exclude<ReasoningEffort, "ultra">; label: string }> = [
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
  { value: "xhigh", label: "Extra" },
  { value: "max", label: "Max" },
];

function modelFamily(model: CursorModel): string {
  const value = `${model.name} ${model.id}`.toLowerCase();
  if (value.includes("grok")) return "xAI";
  if (value.includes("claude")) return "Anthropic";
  if (value.includes("gemini")) return "Google";
  if (value.includes("gpt") || value.includes("openai")) return "OpenAI";
  if (value.includes("composer")) return "Cursor";
  if (model.id.toLowerCase() === "auto") return "Recommended";
  return "Cursor catalog";
}

function searchScore(model: CursorModel, query: string): number {
  if (!query) {
    const value = `${model.name} ${model.id}`.toLowerCase();
    if (/grok.?4\.5/.test(value)) return 1000;
    if (model.id.toLowerCase() === "auto") return 900;
    return 0;
  }
  const name = model.name.toLowerCase();
  const id = model.id.toLowerCase();
  const family = modelFamily(model).toLowerCase();
  const tokens = query.split(/\s+/).filter(Boolean);
  if (!tokens.every((token) => name.includes(token) || id.includes(token) || family.includes(token))) return -1;
  let score = 0;
  if (name === query || id === query) score += 1000;
  if (name.startsWith(query)) score += 400;
  if (id.startsWith(query)) score += 300;
  if (name.includes(query)) score += 200;
  score += tokens.reduce((total, token) => total + (name.startsWith(token) ? 30 : 0) + (id.startsWith(token) ? 20 : 0), 0);
  return score;
}

export function CursorModelControl({
  model,
  models,
  effort,
  loading,
  onRefresh,
  onModel,
  onEffort,
}: {
  model: string;
  models: CursorModel[];
  effort: ReasoningEffort;
  loading?: boolean;
  onRefresh: () => void;
  onModel: (model: string) => void;
  onEffort: (effort: ReasoningEffort) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const catalog = useMemo(() => models.length ? models : [{ id: "auto", name: "Auto", configOptions: [] }], [models]);
  const selected = catalog.find((entry) => entry.id === model) ?? { id: model || "auto", name: model || "Auto", configOptions: [] };
  const normalizedQuery = query.trim().toLowerCase();
  const filtered = useMemo(() => catalog
    .map((entry) => ({ entry, score: searchScore(entry, normalizedQuery) }))
    .filter(({ score }) => score >= 0)
    .sort((left, right) => right.score - left.score || left.entry.name.localeCompare(right.entry.name))
    .map(({ entry }) => entry), [catalog, normalizedQuery]);
  const normalizedEffort = effort === "ultra" ? "max" : effort;
  const effortIndex = Math.max(0, EFFORTS.findIndex((entry) => entry.value === normalizedEffort));
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

  useEffect(() => {
    if (open) requestAnimationFrame(() => searchRef.current?.focus());
    else setQuery("");
  }, [open]);

  return (
    <div className="openrouter-control cursor-control" ref={rootRef} style={{ "--router-fill": `${fill}%` } as CSSProperties}>
      <div className={`openrouter-picker ${open ? "open" : ""}`}>
        <button type="button" className="openrouter-trigger" aria-haspopup="menu" aria-expanded={open} aria-label={`Cursor model: ${selected.name}`} onClick={() => setOpen((value) => !value)} onKeyDown={(event) => { if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); setOpen(true); } }}>
          <span className="openrouter-logo cursor-logo"><CursorProviderLogo size={15} /></span>
          <span className="openrouter-trigger-copy">
            <small>Cursor subscription model</small>
            <strong>{selected.name}</strong>
            <em>{/grok.?4\.5/i.test(`${selected.name} ${selected.id}`) ? "Cursor’s frontier Grok model" : "Uses your Cursor Agent login"}</em>
          </span>
          <ChevronDown size={15} />
        </button>
        <div className="openrouter-menu cursor-model-menu">
          <div className="cursor-model-menu-heading">
            <span className="cursor-model-menu-logo"><CursorProviderLogo size={19} /></span>
            <span><strong>Choose a Cursor model</strong><small>Live catalog from your subscription</small></span>
            <kbd>esc</kbd>
          </div>
          <div className="cursor-model-search">
            <Search size={16} />
            <input ref={searchRef} aria-label="Search Cursor models" value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => { if (event.key === "ArrowDown") { event.preventDefault(); optionRefs.current.find((item) => item?.isConnected)?.focus(); } }} placeholder="Search by model, company, or ID…" />
            {query ? <button type="button" onClick={() => { setQuery(""); searchRef.current?.focus(); }} aria-label="Clear Cursor model search"><X size={14} /></button> : <button type="button" onClick={onRefresh} aria-label="Refresh Cursor model catalog" title="Refresh catalog" disabled={loading}>{loading ? <LoaderCircle className="spin" size={14} /> : <RefreshCw size={14} />}</button>}
          </div>
          <div className="cursor-model-results-meta">
            <span>{normalizedQuery ? `${filtered.length} match${filtered.length === 1 ? "" : "es"}` : `${catalog.length} models`}</span>
            <small>{normalizedQuery ? "Best matches first" : "Featured models and Auto appear first"}</small>
          </div>
          <div className="openrouter-options cursor-model-options" role="menu" aria-label="Cursor model selector">
            {filtered.map((entry) => (
              <button type="button" role="menuitemradio" aria-checked={entry.id === selected.id} aria-label={`${entry.name}, ${modelFamily(entry)}`} className={entry.id === selected.id ? "selected" : ""} key={entry.id} ref={(node) => { optionRefs.current[filtered.indexOf(entry)] = node; }} onKeyDown={(event) => {
                const enabled = optionRefs.current.filter((item): item is HTMLButtonElement => Boolean(item?.isConnected));
                const index = enabled.indexOf(event.currentTarget);
                const columns = window.matchMedia("(min-width: 720px)").matches ? 2 : 1;
                if (event.key === "ArrowDown") { event.preventDefault(); enabled[Math.min(enabled.length - 1, index + columns)]?.focus(); }
                if (event.key === "ArrowUp") { event.preventDefault(); index - columns < 0 ? searchRef.current?.focus() : enabled[index - columns]?.focus(); }
                if (event.key === "ArrowRight" && columns === 2) { event.preventDefault(); enabled[Math.min(enabled.length - 1, index + 1)]?.focus(); }
                if (event.key === "ArrowLeft" && columns === 2) { event.preventDefault(); enabled[Math.max(0, index - 1)]?.focus(); }
              }} onClick={() => { onModel(entry.id); setOpen(false); setQuery(""); }}>
                <span className="openrouter-provider-mark cursor-logo"><CursorProviderLogo size={13} /></span>
                <span><strong>{entry.name}</strong><small><em>{modelFamily(entry)}</em><code>{entry.id}</code></small></span>
                {entry.id === selected.id && <Check size={13} />}
              </button>
            ))}
            {!loading && filtered.length === 0 && <div className="cursor-model-empty"><Search size={20} /><strong>No models match “{query.trim()}”</strong><small>Try a company name like xAI, OpenAI, Anthropic, or Google.</small></div>}
          </div>
        </div>
      </div>
      <div className="openrouter-reasoning">
        <div className="openrouter-reasoning-heading"><Gauge size={13} /><span>Reasoning</span><strong>{EFFORTS[effortIndex].label}</strong></div>
        <div className="openrouter-reasoning-rail">
          <input aria-label="Cursor reasoning effort" type="range" min={0} max={EFFORTS.length - 1} step={1} value={effortIndex} onChange={(event) => onEffort(EFFORTS[Number(event.target.value)].value)} />
          <div className="openrouter-reasoning-ticks" aria-hidden="true">{EFFORTS.map((entry, index) => <i key={entry.value} className={index <= effortIndex ? "reached" : ""} />)}</div>
        </div>
        <div className="openrouter-reasoning-labels">{EFFORTS.map((entry, index) => <span key={entry.value} className={index === effortIndex ? "active" : ""}>{entry.label}</span>)}</div>
      </div>
    </div>
  );
}
