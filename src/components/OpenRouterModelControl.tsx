import { withShortcut } from "../lib/shortcuts";
import { Fragment, useEffect, useId, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { ChevronDown, Gauge, Search } from "lucide-react";
import { EffortSlider, effortFlairStyle } from "./effortFlair";
import { EmptyState } from "./EmptyState";
import { ModelCatalogHeader } from "./ModelCatalogHeader";
import type { ModelFavoriteProps } from "./ModelFavoriteStar";
import { ModelCatalogRow } from "./ModelCatalogRow";
import type { ReasoningEffort } from "./ModelPowerControl";
import { OpenRouterLogo } from "./BrandLogos";
import { filterOpenRouterModels, looksLikeModelSlug, openRouterVendor, type OpenRouterModel } from "../lib/openRouterCatalog";
import { favoriteCount, sortByFavorites } from "../lib/modelFavorites";
import { closesModelMenu } from "../lib/composerMenus";
import { useMenuKeyboard } from "../hooks/useMenuKeyboard";

export type { OpenRouterModel };

const EFFORTS: Array<{ value: Exclude<ReasoningEffort, "ultra">; label: string; shortLabel: string }> = [
  { value: "low", label: "Light", shortLabel: "Light" },
  { value: "medium", label: "Medium", shortLabel: "Medium" },
  { value: "high", label: "High", shortLabel: "High" },
  { value: "xhigh", label: "Extra high", shortLabel: "Extra" },
  { value: "max", label: "Maximum", shortLabel: "Max" },
];

/**
 * How much of the unfiltered catalog the menu renders before asking. Searching
 * is never capped, so this only limits idle browsing of several hundred rows.
 */
const BROWSE_LIMIT = 60;
const SEARCH_DEBOUNCE_MS = 320;

function compactContext(value?: number): string {
  if (!value) return "";
  if (value >= 1_000_000) return `${Math.round(value / 100_000) / 10}M ctx`;
  return `${Math.round(value / 1000)}K ctx`;
}

function providerName(id: string): string {
  return openRouterVendor(id).name;
}

export function OpenRouterModelControl({
  model,
  effort,
  models,
  loading,
  error,
  providerControl,
  favorites = [],
  searching = false,
  onToggleFavorite,
  onModel,
  onEffort,
  onRefresh,
  onDiscover,
}: ModelFavoriteProps & {
  model: string;
  effort: ReasoningEffort;
  models: OpenRouterModel[];
  loading: boolean;
  error: string;
  providerControl?: ReactNode;
  /** A remote lookup for the current query is in flight. */
  searching?: boolean;
  onModel: (model: string) => void;
  onEffort: (effort: ReasoningEffort) => void;
  onRefresh: () => void;
  /**
   * Asks the app to resolve a complete typed slug directly. The account
   * catalog itself is complete and ordinary search is exhaustive locally.
   */
  onDiscover?: (query: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [showAll, setShowAll] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const menuId = useId();
  const normalizedEffort = effort === "ultra" ? "max" : effort;
  const effortIndex = Math.max(0, EFFORTS.findIndex((entry) => entry.value === normalizedEffort));
  const fill = (effortIndex / (EFFORTS.length - 1)) * 100;
  const selected = models.find((entry) => entry.id === model);
  const query = search.trim();
  const lowerQuery = query.toLowerCase();

  const ordered = useMemo(
    () => sortByFavorites(models, favorites, (entry) => entry.id),
    [favorites, models],
  );
  const matches = useMemo(() => filterOpenRouterModels(ordered, query), [ordered, query]);
  // Browsing is capped for rendering cost only; a search always shows every
  // match, so a model can never be hidden behind a truncated result list.
  const visible = query || showAll ? matches : matches.slice(0, BROWSE_LIMIT);
  const hidden = matches.length - visible.length;
  const starredVisible = favoriteCount(visible, favorites, (entry) => entry.id);
  const canUseCustom = looksLikeModelSlug(query) && !models.some((entry) => entry.id.toLowerCase() === lowerQuery);

  useEffect(() => {
    if (!open) return;
    function handlePointerDown(event: PointerEvent) {
      if (closesModelMenu(event, rootRef.current)) setOpen(false);
    }
    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("click", handlePointerDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("click", handlePointerDown);
    };
  }, [open]);

  useEffect(() => { if (!open) setShowAll(false); }, [open]);

  // Shared search-first menu contract (see useMenuKeyboard).
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuKeys = useMenuKeyboard({ open, setOpen, menuRef, triggerRef, searchRef, answersModelShortcut: true });

  // The account catalog is complete. Only a complete custom slug needs a
  // direct lookup; ordinary searches remain instant and exhaustive locally.
  useEffect(() => {
    if (!open || !looksLikeModelSlug(query) || !onDiscover) return;
    const timer = window.setTimeout(() => onDiscover(query), SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [onDiscover, open, query]);

  const chooseModel = (id: string) => menuKeys.select(() => {
    onModel(id);
    setSearch("");
  });

  return (
    <div className="openrouter-control" ref={rootRef} style={{ "--router-fill": `${fill}%` } as CSSProperties}>
      {providerControl}
      <div className={`openrouter-picker ${open ? "open" : ""}`}>
        <button ref={triggerRef} type="button" className="openrouter-trigger" aria-haspopup="menu" aria-expanded={open} aria-controls={menuId} aria-label={`OpenRouter model: ${selected?.name || model || "not selected"}`} title={withShortcut(`Model: ${selected?.name || model || "not selected"}`, "modelPicker")} onPointerDown={menuKeys.onTriggerPointerDown} onClick={() => setOpen((value) => !value)} onKeyDown={menuKeys.onTriggerKeyDown}>
          <span className="openrouter-logo openrouter-brand-logo"><OpenRouterLogo size={16} /></span>
          <span className="openrouter-trigger-copy">
            <small>Model</small>
            <strong>{selected?.name || model || "Model"}</strong>
            <em>{model ? `${providerName(model)}${selected?.context_length ? ` · ${compactContext(selected.context_length)}` : ""}` : `${models.length || "Live"} tool-capable models`}</em>
          </span>
          <ChevronDown size={15} />
        </button>

        <div className="openrouter-menu" inert={!open || undefined} onKeyDown={menuKeys.onMenuKeyDown}>
          <ModelCatalogHeader provider="OpenRouter" heading={query ? `${matches.length} match${matches.length === 1 ? "" : "es"}` : `${models.length} available`} description={searching ? "Searching OpenRouter…" : favorites.length ? "Favorites first · tool-capable catalog" : "Tool-capable catalog"} loading={loading} onRefresh={onRefresh} />
          <div className="openrouter-search-row">
            <Search size={14} />
            <input ref={searchRef} aria-label="Search OpenRouter models" aria-controls={menuId} value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search models or enter provider/model…" />
          </div>
          <div ref={menuRef} id={menuId} className="openrouter-options" role="menu" aria-label="OpenRouter model selector">
            {visible.map((entry, index) => (
              <Fragment key={entry.id}>
                {starredVisible > 0 && index === 0 && <p className="model-group-label" role="presentation">Favorites</p>}
                {starredVisible > 0 && index === starredVisible && <p className="model-group-label" role="presentation">All models</p>}
                <ModelCatalogRow
                  id={entry.id}
                  name={entry.name || entry.id}
                  detail={entry.id}
                  art={<span className="openrouter-provider-mark">{(entry.id.split("/")[0] || "OpenRouter").slice(0, 2).toUpperCase()}</span>}
                  meta={`${compactContext(entry.context_length)}${entry.supported_parameters?.includes("reasoning") ? " · reasoning" : ""}`}
                  selected={entry.id === model}
                  groupEnd={false}
                  ariaLabel={`${entry.name || entry.id}, ${providerName(entry.id)}`}
                  favorite={onToggleFavorite ? favorites.includes(entry.id) : undefined}
                  onToggleFavorite={onToggleFavorite}
                  onSelect={() => chooseModel(entry.id)}
                />
              </Fragment>
            ))}
            {hidden > 0 && (
              <button type="button" role="menuitem" tabIndex={-1} className="model-show-all" onClick={() => setShowAll(true)}>
                Show all {matches.length} models ({hidden} more)
              </button>
            )}
            {canUseCustom && (
              <button type="button" role="menuitemradio" aria-checked={false} tabIndex={-1} className="custom-model-option" onClick={() => chooseModel(query)}>
                <span className="openrouter-provider-mark">+</span>
                <span><strong>Use model slug directly</strong><small>{query}</small></span>
              </button>
            )}
            {!loading && !searching && !visible.length && !canUseCustom && <EmptyState variant="compact" className="model-menu-empty" icon={Search} role="status" title="No matching models" text="Enter a complete provider/model slug to use it directly." />}
          </div>
          {error && <div className="openrouter-catalog-warning" role={open ? "status" : undefined}>{error} · Custom slugs still work.</div>}
        </div>
      </div>

      <div className={`openrouter-reasoning ${effortIndex === EFFORTS.length - 1 ? "effort-max" : ""}`} style={effortFlairStyle(effortIndex, EFFORTS.length)}>
        <div className="openrouter-reasoning-heading"><Gauge size={13} /><span>Reasoning</span><strong key={EFFORTS[effortIndex].value}>{EFFORTS[effortIndex].label}</strong></div>
        <EffortSlider variant="router" index={effortIndex} count={EFFORTS.length} effortValues={EFFORTS.map((entry) => entry.value)} ariaLabel="OpenRouter reasoning effort" valueText={EFFORTS[effortIndex].label} onIndex={(next) => onEffort(EFFORTS[next].value)} />
        <div className="openrouter-reasoning-labels" aria-hidden="true">{EFFORTS.map((entry, index) => <span key={entry.value} className={index === effortIndex ? "active" : ""}>{entry.shortLabel}</span>)}</div>
      </div>
    </div>
  );
}
