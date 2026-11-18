import { withShortcut } from "../lib/shortcuts";
import { useCallback, useEffect, useId, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { ChevronDown, Gauge, Search, X } from "lucide-react";
import { EffortSlider, effortFlairStyle } from "./effortFlair";
import { EmptyState } from "./EmptyState";
import { ModelCatalogHeader } from "./ModelCatalogHeader";
import type { CursorModel } from "../lib/cursor";
import type { ReasoningEffort } from "./ModelPowerControl";
import { CursorProviderLogo } from "./BrandLogos";
import type { ModelFavoriteProps } from "./ModelFavoriteStar";
import { ModelCatalogRow } from "./ModelCatalogRow";
import { favoriteCount, sortByFavorites } from "../lib/modelFavorites";
import { closesModelMenu } from "../lib/composerMenus";
import { useMenuKeyboard } from "../hooks/useMenuKeyboard";

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
  const menuId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
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
    document.addEventListener("pointerdown", close);
    document.addEventListener("click", close);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("click", close);
    };
  }, [open]);

  useEffect(() => { if (!open) setQuery(""); }, [open]);

  // Shared search-first menu contract (see useMenuKeyboard). The catalog is a
  // two-column grid on wide windows, so ↑/↓ step a whole row there.
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const columns = useCallback(() => {
    // Count the rows that share the first row's top edge: right whatever the
    // stylesheet does (one column in narrow windows, two in wide ones).
    const rows = Array.from(menuRef.current?.querySelectorAll<HTMLElement>(".model-row") ?? []);
    if (rows.length < 2) return 1;
    const top = rows[0].getBoundingClientRect().top;
    return Math.max(1, rows.filter((row) => Math.abs(row.getBoundingClientRect().top - top) < 2).length);
  }, []);
  const menuKeys = useMenuKeyboard({ open, setOpen, menuRef, triggerRef, searchRef, columns, answersModelShortcut: true });

  return (
    <div className="openrouter-control cursor-control" ref={rootRef} style={{ "--router-fill": `${fill}%` } as CSSProperties}>
      {providerControl}
      <div className={`openrouter-picker ${open ? "open" : ""}`}>
        <button ref={triggerRef} type="button" className="openrouter-trigger" aria-haspopup="menu" aria-expanded={open} aria-controls={menuId} aria-label={`Cursor model: ${selected.name}`} title={withShortcut(`Model: ${selected.name}`, "modelPicker")} onPointerDown={menuKeys.onTriggerPointerDown} onClick={() => setOpen((value) => !value)} onKeyDown={menuKeys.onTriggerKeyDown}>
          <span className="openrouter-logo cursor-logo"><CursorProviderLogo size={15} /></span>
          <span className="openrouter-trigger-copy">
            <small>Model</small>
            <strong>{selected.name}</strong>
            <em>{/grok.?4\.5/i.test(`${selected.name} ${selected.id}`) ? "Cursor’s frontier Grok model" : "Uses your Cursor Agent login"}</em>
          </span>
          <ChevronDown size={15} />
        </button>
        <div className="openrouter-menu cursor-model-menu" inert={!open || undefined} onKeyDown={menuKeys.onMenuKeyDown}>
          <ModelCatalogHeader provider="Cursor" heading="Cursor models" description={models.length ? "Live catalog from your subscription" : "Auto fallback — catalog unavailable"} loading={loading} onRefresh={onRefresh} />
          <div className="cursor-model-search">
            <Search size={16} />
            <input ref={searchRef} aria-label="Search Cursor models" aria-controls={menuId} value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search by model, company or ID…" />
            {query && <button type="button" onClick={() => { setQuery(""); searchRef.current?.focus(); }} aria-label="Clear Cursor model search"><X size={14} /></button>}
          </div>
          <div className="cursor-model-results-meta">
            <span>{normalizedQuery ? `${filtered.length} match${filtered.length === 1 ? "" : "es"}` : `${catalog.length} models`}</span>
            <small>{favorites.length ? "Favorites first" : normalizedQuery ? "Best matches first" : "Featured models and Auto appear first"}</small>
          </div>
          <div ref={menuRef} id={menuId} className="openrouter-options cursor-model-options" role="menu" aria-label="Cursor model selector">
            {filtered.map((entry, entryIndex) => (
              <ModelCatalogRow
                key={entry.id}
                id={entry.id}
                name={entry.name}
                detail={<><em>{modelFamily(entry)}</em><code>{entry.id}</code></>}
                art={<span className="openrouter-provider-mark cursor-logo"><CursorProviderLogo size={13} /></span>}
                selected={entry.id === selected.id}
                groupEnd={starredVisible > 0 && entryIndex === starredVisible - 1}
                ariaLabel={`${entry.name}, ${modelFamily(entry)}`}
                className="cursor-logo-row"
                favorite={onToggleFavorite ? favorites.includes(entry.id) : undefined}
                onToggleFavorite={onToggleFavorite}
                onSelect={() => menuKeys.select(() => { onModel(entry.id); setQuery(""); })}
              />
            ))}
            {!loading && filtered.length === 0 && <EmptyState variant="compact" className="model-menu-empty" icon={Search} role="status" title={<>No models match “{query.trim()}”</>} text="Try a company name like xAI, OpenAI, Anthropic or Google." />}
          </div>
          {error && <div className="openrouter-catalog-warning" role={open ? "status" : undefined}>{error} · Refresh to try again.</div>}
        </div>
      </div>
      <div className={`openrouter-reasoning ${effortIndex === EFFORTS.length - 1 ? "effort-max" : ""}`} style={effortFlairStyle(effortIndex, EFFORTS.length)}>
        <div className="openrouter-reasoning-heading"><Gauge size={13} /><span>Reasoning</span><strong key={EFFORTS[effortIndex].value}>{EFFORTS[effortIndex].label}</strong></div>
        <EffortSlider variant="router" index={effortIndex} count={EFFORTS.length} effortValues={EFFORTS.map((entry) => entry.value)} ariaLabel="Cursor reasoning effort" valueText={EFFORTS[effortIndex].label} onIndex={(next) => onEffort(EFFORTS[next].value)} />
        <div className="openrouter-reasoning-labels" aria-hidden="true">{EFFORTS.map((entry, index) => <span key={entry.value} className={index === effortIndex ? "active" : ""}>{entry.label}</span>)}</div>
      </div>
    </div>
  );
}
