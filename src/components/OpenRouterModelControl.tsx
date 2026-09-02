import { Fragment, useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { Check, ChevronDown, Gauge, LoaderCircle, RefreshCw, Search } from "lucide-react";
import { EffortSlider, effortFlairStyle } from "./effortFlair";
import { ModelFavoriteStar, type ModelFavoriteProps } from "./ModelFavoriteStar";
import type { ReasoningEffort } from "./ModelPowerControl";
import { OpenRouterLogo } from "./BrandLogos";
import { filterOpenRouterModels, looksLikeModelSlug, type OpenRouterModel } from "../lib/openRouterCatalog";
import { favoriteCount, sortByFavorites } from "../lib/modelFavorites";
import { closesModelMenu } from "../lib/composerMenus";

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
  const provider = id.split("/")[0] || "OpenRouter";
  return provider.replace(/(^|-)([a-z])/g, (_, separator: string, letter: string) => `${separator}${letter.toUpperCase()}`);
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
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
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
    document.addEventListener("click", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown, true);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("click", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown, true);
    };
  }, [open]);

  useEffect(() => {
    if (open) requestAnimationFrame(() => searchRef.current?.focus());
    else setShowAll(false);
  }, [open]);

  // The account catalog is complete. Only a complete custom slug needs a
  // direct lookup; ordinary searches remain instant and exhaustive locally.
  useEffect(() => {
    if (!open || !looksLikeModelSlug(query) || !onDiscover) return;
    const timer = window.setTimeout(() => onDiscover(query), SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [onDiscover, open, query]);

  const chooseModel = (id: string) => {
    onModel(id);
    setSearch("");
    setOpen(false);
  };

  const handleOptionKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    // Filtering shrinks the list without truncating the ref array; only
    // connected nodes are real navigation targets.
    const enabled = optionRefs.current.filter((item): item is HTMLButtonElement => Boolean(item?.isConnected));
    const index = enabled.indexOf(event.currentTarget);
    if (event.key === "ArrowDown") { event.preventDefault(); enabled[(index + 1) % enabled.length]?.focus(); }
    if (event.key === "ArrowUp") { event.preventDefault(); (index <= 0 ? searchRef.current : enabled[index - 1])?.focus(); }
  };

  return (
    <div className="openrouter-control" ref={rootRef} style={{ "--router-fill": `${fill}%` } as CSSProperties}>
      {providerControl}
      <div className={`openrouter-picker ${open ? "open" : ""}`}>
        <button type="button" className="openrouter-trigger" aria-haspopup="menu" aria-expanded={open} aria-label={`OpenRouter model: ${selected?.name || model || "not selected"}`} onClick={() => setOpen((value) => !value)} onKeyDown={(event) => { if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); setOpen(true); } }}>
          <span className="openrouter-logo openrouter-brand-logo"><OpenRouterLogo size={16} /></span>
          <span className="openrouter-trigger-copy">
            <small>Model</small>
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
          <div className="openrouter-menu-meta">
            <span>{query ? `${matches.length} match${matches.length === 1 ? "" : "es"}` : `${models.length} available`}</span>
            <small>{searching ? "Searching OpenRouter…" : favorites.length ? "Favorites first · tool-capable catalog" : "Tool-capable catalog"}</small>
          </div>
          <div className="openrouter-options" role="menu" aria-label="OpenRouter model selector">
            {visible.map((entry, index) => (
              <Fragment key={entry.id}>
                {starredVisible > 0 && index === 0 && <p className="model-group-label">Favorites</p>}
                {starredVisible > 0 && index === starredVisible && <p className="model-group-label">All models</p>}
                <div className="model-row" role="none">
                <button
                  type="button"
                  role="menuitemradio"
                  aria-checked={entry.id === model}
                  aria-label={`${entry.name || entry.id}, ${providerName(entry.id)}`}
                  className={entry.id === model ? "selected" : ""}
                  ref={(node) => { optionRefs.current[index] = node; }}
                  onKeyDown={handleOptionKeyDown}
                  onClick={() => chooseModel(entry.id)}
                >
                  <span className="openrouter-provider-mark">{providerName(entry.id).slice(0, 2).toUpperCase()}</span>
                  <span><strong>{entry.name || entry.id}</strong><small>{entry.id}</small></span>
                  <span className="openrouter-model-meta">{compactContext(entry.context_length)}{entry.supported_parameters?.includes("reasoning") ? " · reasoning" : ""}</span>
                  {entry.id === model && <Check size={13} />}
                </button>
                {onToggleFavorite && <ModelFavoriteStar model={entry.id} label={entry.name || entry.id} favorite={favorites.includes(entry.id)} onToggle={onToggleFavorite} />}
                </div>
              </Fragment>
            ))}
            {hidden > 0 && (
              <button type="button" className="model-show-all" onClick={() => setShowAll(true)}>
                Show all {matches.length} models ({hidden} more)
              </button>
            )}
            {canUseCustom && (
              <button type="button" role="menuitemradio" aria-checked={false} className="custom-model-option" onClick={() => chooseModel(query)}>
                <span className="openrouter-provider-mark">+</span>
                <span><strong>Use model slug directly</strong><small>{query}</small></span>
              </button>
            )}
            {!loading && !searching && !visible.length && !canUseCustom && <div className="openrouter-empty"><strong>No matching models</strong><span>{error || "Enter a complete provider/model slug to use it directly."}</span></div>}
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
