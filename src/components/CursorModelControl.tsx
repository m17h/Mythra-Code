import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { Check, ChevronDown, Gauge, Search, X } from "lucide-react";
import { ModelCatalogHeader } from "./ModelCatalogHeader";
import { EffortSlider, effortFlairStyle } from "./effortFlair";
import type { CursorModel } from "../lib/cursor";
import type { ReasoningEffort } from "./ModelPowerControl";
import { CursorProviderLogo } from "./BrandLogos";
import { ModelFavoriteStar, type ModelFavoriteProps } from "./ModelFavoriteStar";
import { favoriteCount, sortByFavorites } from "../lib/modelFavorites";
import { closesModelMenu } from "../lib/composerMenus";

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
  error,
  providerControl,
  favorites = [],
  onToggleFavorite,
  onRefresh,
  onModel,
  onEffort,
}: ModelFavoriteProps & {
  model: string;
  models: CursorModel[];
  effort: ReasoningEffort;
  loading?: boolean;
  error?: string;
  providerControl?: ReactNode;
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
  // Favorites are applied after scoring so a starred model leads the list
  // without disturbing the relative order of everything else.
  const filtered = useMemo(() => sortByFavorites(catalog
    .map((entry) => ({ entry, score: searchScore(entry, normalizedQuery) }))
    .filter(({ score }) => score >= 0)
    .sort((left, right) => right.score - left.score || left.entry.name.localeCompare(right.entry.name))
    .map(({ entry }) => entry), favorites, (entry) => entry.id), [catalog, favorites, normalizedQuery]);
  const starredVisible = favoriteCount(filtered, favorites, (entry) => entry.id);
  const normalizedEffort = effort === "ultra" ? "max" : effort;
  const effortIndex = Math.max(0, EFFORTS.findIndex((entry) => entry.value === normalizedEffort));
  const fill = (effortIndex / (EFFORTS.length - 1)) * 100;

  useEffect(() => {
    if (!open) return;
    const close = (event: Event) => {
      if (closesModelMenu(event, rootRef.current)) setOpen(false);
    };
    // Capture phase + stopPropagation: Escape closes only this menu and never
    // reaches the app-level handler that stops the running turn.
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        setOpen(false);
        rootRef.current?.querySelector<HTMLButtonElement>(".openrouter-trigger")?.focus();
      }
    };
    document.addEventListener("pointerdown", close);
    document.addEventListener("click", close);
    document.addEventListener("keydown", escape, true);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("click", close);
      document.removeEventListener("keydown", escape, true);
    };
  }, [open]);

  useEffect(() => {
    if (open) requestAnimationFrame(() => searchRef.current?.focus());
    else setQuery("");
  }, [open]);

  return (
    <div className="openrouter-control cursor-control" ref={rootRef} style={{ "--router-fill": `${fill}%` } as CSSProperties}>
      {providerControl}
      <div className={`openrouter-picker ${open ? "open" : ""}`}>
        <button type="button" className="openrouter-trigger" aria-haspopup="menu" aria-expanded={open} aria-label={`Cursor model: ${selected.name}`} onClick={() => setOpen((value) => !value)} onKeyDown={(event) => { if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); setOpen(true); } }}>
          <span className="openrouter-logo cursor-logo"><CursorProviderLogo size={15} /></span>
          <span className="openrouter-trigger-copy">
            <small>Model</small>
            <strong>{selected.name}</strong>
            <em>{/grok.?4\.5/i.test(`${selected.name} ${selected.id}`) ? "Cursor’s frontier Grok model" : "Uses your Cursor Agent login"}</em>
          </span>
          <ChevronDown size={15} />
        </button>
        <div className="openrouter-menu cursor-model-menu">
          <ModelCatalogHeader provider="Cursor" heading="Cursor models" description={models.length ? "Live catalog from your subscription" : "Auto fallback — catalog unavailable"} loading={loading} onRefresh={onRefresh} />
          <div className="cursor-model-search">
            <Search size={16} />
            <input ref={searchRef} aria-label="Search Cursor models" value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => { if (event.key === "ArrowDown") { event.preventDefault(); optionRefs.current.find((item) => item?.isConnected)?.focus(); } }} placeholder="Search by model, company, or ID…" />
            {query && <button type="button" onClick={() => { setQuery(""); searchRef.current?.focus(); }} aria-label="Clear Cursor model search"><X size={14} /></button>}
          </div>
          <div className="cursor-model-results-meta">
            <span>{normalizedQuery ? `${filtered.length} match${filtered.length === 1 ? "" : "es"}` : `${catalog.length} models`}</span>
            <small>{favorites.length ? "Favorites first" : normalizedQuery ? "Best matches first" : "Featured models and Auto appear first"}</small>
          </div>
          <div className="openrouter-options cursor-model-options" role="menu" aria-label="Cursor model selector">
            {filtered.map((entry, entryIndex) => (
              <div className="model-row" key={entry.id} role="none">
              <button type="button" role="menuitemradio" aria-checked={entry.id === selected.id} aria-label={`${entry.name}, ${modelFamily(entry)}`} className={`${entry.id === selected.id ? "selected" : ""}${starredVisible > 0 && entryIndex === starredVisible - 1 ? " favorite-group-end" : ""}`} ref={(node) => { optionRefs.current[entryIndex] = node; }} onKeyDown={(event) => {
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
              {onToggleFavorite && <ModelFavoriteStar model={entry.id} label={entry.name} favorite={favorites.includes(entry.id)} onToggle={onToggleFavorite} />}
              </div>
            ))}
            {!loading && filtered.length === 0 && <div className="cursor-model-empty"><Search size={20} /><strong>No models match “{query.trim()}”</strong><small>Try a company name like xAI, OpenAI, Anthropic, or Google.</small></div>}
          </div>
          {error && <div className="openrouter-catalog-warning" role={open ? "status" : undefined}>{error} · Refresh to try again.</div>}
        </div>
      </div>
      <div className={`openrouter-reasoning ${effortIndex === EFFORTS.length - 1 ? "effort-max" : ""}`} style={effortFlairStyle(effortIndex, EFFORTS.length)}>
        <div className="openrouter-reasoning-heading"><Gauge size={13} /><span>Reasoning</span><strong key={EFFORTS[effortIndex].value}>{EFFORTS[effortIndex].label}</strong></div>
        <EffortSlider variant="router" index={effortIndex} count={EFFORTS.length} ariaLabel="Cursor reasoning effort" valueText={EFFORTS[effortIndex].label} onIndex={(next) => onEffort(EFFORTS[next].value)} />
        <div className="openrouter-reasoning-labels">{EFFORTS.map((entry, index) => <span key={entry.value} className={index === effortIndex ? "active" : ""}>{entry.label}</span>)}</div>
      </div>
    </div>
  );
}
