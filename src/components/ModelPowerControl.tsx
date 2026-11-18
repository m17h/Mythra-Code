import { withShortcut } from "../lib/shortcuts";
import { useEffect, useId, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { ChevronDown, Gauge, Search, X, Zap } from "lucide-react";
import { EffortSlider, effortFlairStyle } from "./effortFlair";
import { ProviderLogo } from "./BrandLogos";
import type { ModelFavoriteProps } from "./ModelFavoriteStar";
import { ModelCatalogRow } from "./ModelCatalogRow";
import { favoriteCount, sortByFavorites } from "../lib/modelFavorites";
import { closesModelMenu } from "../lib/composerMenus";
import { ModelCatalogHeader } from "./ModelCatalogHeader";
import { useMenuKeyboard } from "../hooks/useMenuKeyboard";

export type ModelKind = "sol" | "terra" | "luna" | "astra" | "generic";
export type ReasoningEffort = "low" | "medium" | "high" | "xhigh" | "max" | "ultra";

export interface RuntimeModel {
  id: string;
  model: string;
  displayName: string;
  description: string;
  supportedReasoningEfforts: Array<{ reasoningEffort: string; description: string }>;
  defaultReasoningEffort: string;
  isDefault: boolean;
}

/**
 * The named OpenAI tiers Mythra Code has artwork and copy for. The menu is
 * driven by the account's live `model/list` response; this only supplies the
 * icon, accent, and tagline when a runtime model matches one of them, and
 * stands in as the whole list when the runtime reports nothing at all.
 */
export const OPENAI_MODELS: Array<{ kind: ModelKind; name: string; id: string; tagline: string; iconSrc: string }> = [
  { kind: "sol", name: "GPT-5.6 Sol", id: "gpt-5.6-sol", tagline: "Detail & polish", iconSrc: "/model-icons/sol.png" },
  { kind: "terra", name: "GPT-5.6 Terra", id: "gpt-5.6-terra", tagline: "Everyday power", iconSrc: "/model-icons/terra.png" },
  { kind: "luna", name: "GPT-5.6 Luna", id: "gpt-5.6-luna", tagline: "Fast & focused", iconSrc: "/model-icons/luna.png" },
  { kind: "astra", name: "GPT-6 Astra", id: "gpt-6-astra", tagline: "Frontier intelligence", iconSrc: "/model-icons/astra.png" },
];

function namedModelArtwork(id: string) {
  const known = OPENAI_MODELS.find((entry) => entry.id === id);
  if (known) return known;
  // Runtime model IDs carry the family after a numeric GPT version. Match
  // complete IDs, including future variants, without borrowing artwork for
  // unrelated names that happen to contain a family name.
  const family = /^gpt-\d+(?:\.\d+)*-(sol|terra|luna)(?:-[a-z0-9]+)*$/.exec(id)?.[1];
  return family ? OPENAI_MODELS.find((entry) => entry.kind === family) : undefined;
}

interface ModelOption {
  id: string;
  name: string;
  tagline: string;
  kind: ModelKind;
  iconSrc?: string;
  isDefault: boolean;
}

const EFFORTS: Array<{ value: Exclude<ReasoningEffort, "ultra">; label: string; shortLabel: string }> = [
  { value: "low", label: "Light", shortLabel: "Light" },
  { value: "medium", label: "Medium", shortLabel: "Medium" },
  { value: "high", label: "High", shortLabel: "High" },
  { value: "xhigh", label: "Extra high", shortLabel: "Extra" },
  { value: "max", label: "Maximum", shortLabel: "Max" },
];

export function modelKind(model: string): ModelKind {
  return namedModelArtwork(model)?.kind ?? "generic";
}

/** Every model the account can actually run, decorated where Mythra Code knows one. */
export function openAiModelOptions(runtimeModels: RuntimeModel[]): ModelOption[] {
  if (!runtimeModels.length) {
    return OPENAI_MODELS.map((entry) => ({ ...entry, isDefault: entry.kind === "sol" }));
  }
  const options: ModelOption[] = [];
  const seen = new Set<string>();
  for (const entry of runtimeModels) {
    const id = (entry.model || entry.id || "").trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const known = namedModelArtwork(id);
    options.push({
      id,
      name: entry.displayName?.trim() || known?.name || id,
      tagline: entry.description?.trim() || known?.tagline || id,
      kind: known?.kind ?? modelKind(id),
      iconSrc: known?.iconSrc,
      isDefault: Boolean(entry.isDefault),
    });
  }
  return options;
}

export function ModelPowerControl({
  model,
  effort,
  fast,
  providerControl,
  runtimeModels,
  disabled,
  signedIn,
  onSignInRequired,
  loading,
  error,
  onRefresh,
  favorites = [],
  onToggleFavorite,
  onModel,
  onEffort,
  onFast,
}: ModelFavoriteProps & {
  model: string;
  effort: ReasoningEffort;
  fast: boolean;
  providerControl?: ReactNode;
  runtimeModels: RuntimeModel[];
  disabled?: boolean;
  signedIn?: boolean;
  onSignInRequired?: () => void;
  loading?: boolean;
  error?: string;
  onRefresh?: () => void;
  onModel: (model: string) => void;
  onEffort: (effort: ReasoningEffort) => void;
  onFast: (enabled: boolean) => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [query, setQuery] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const listId = useId();
  const catalog = useMemo(() => openAiModelOptions(runtimeModels), [runtimeModels]);
  // A filter appears once the catalog is longer than a glance (G8).
  const searchable = catalog.length > 6;
  const normalizedQuery = searchable ? query.trim().toLowerCase() : "";
  const options = useMemo(
    () => sortByFavorites(catalog.filter((entry) => !normalizedQuery || `${entry.name} ${entry.id} ${entry.tagline}`.toLowerCase().includes(normalizedQuery)), favorites, (entry) => entry.id),
    [catalog, favorites, normalizedQuery],
  );
  useEffect(() => { if (!menuOpen) setQuery(""); }, [menuOpen]);
  const starredVisible = favoriteCount(options, favorites, (entry) => entry.id);
  // A saved model the runtime no longer lists stays selected and visible; the
  // menu never silently rewrites the user's choice.
  const selectedModel = catalog.find((entry) => entry.id === model)
    ?? (model ? { id: model, name: model, tagline: "Saved model", kind: modelKind(model), iconSrc: namedModelArtwork(model)?.iconSrc, isDefault: false } : catalog[0]);
  const kind = selectedModel?.kind ?? "generic";
  const effortIndex = Math.max(0, EFFORTS.findIndex((entry) => entry.value === (effort === "ultra" ? "max" : effort)));
  const reasoningFill = (effortIndex / (EFFORTS.length - 1)) * 100;
  const selectedModelIconSrc = selectedModel?.iconSrc;

  useEffect(() => {
    if (!menuOpen) return;
    function handlePointerDown(event: PointerEvent) {
      if (closesModelMenu(event, rootRef.current)) setMenuOpen(false);
    }
    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("click", handlePointerDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("click", handlePointerDown);
    };
  }, [menuOpen]);

  // Shared menu contract: ↓/↑ open, focus lands on the selected model, ↑/↓
  // wrap, Home/End, type-ahead, Escape returns to the trigger, ⇧⌘M opens.
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuKeys = useMenuKeyboard({
    open: menuOpen,
    setOpen: setMenuOpen,
    menuRef,
    triggerRef,
    searchRef: searchable ? searchRef : undefined,
    answersModelShortcut: !disabled,
    canOpen: () => {
      if (signedIn === false) { onSignInRequired?.(); return false; }
      return !disabled;
    },
  });

  return (
    <div
      ref={rootRef}
      className={`model-power-control ${kind} ${menuOpen ? "menu-open" : ""} ${disabled ? "disabled" : ""} ${effortIndex === EFFORTS.length - 1 ? "effort-max" : ""}`}
      style={{ "--reasoning-fill": `${reasoningFill}%`, "--model-accent": kind === "generic" ? "var(--muted-2)" : undefined, ...effortFlairStyle(effortIndex, EFFORTS.length) } as CSSProperties}
    >
      {providerControl}
      <div className={`model-picker ${signedIn === false ? "unavailable" : ""}`}>
        <button
          type="button"
          className="model-picker-trigger"
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          aria-label={`OpenAI model: ${selectedModel?.name ?? "not selected"}`}
          title={withShortcut(`Model: ${selectedModel?.name ?? "not selected"}`, "modelPicker")}
          disabled={disabled}
          aria-disabled={signedIn === false || undefined}
          onClick={() => {
            if (signedIn === false) { onSignInRequired?.(); return; }
            setMenuOpen((open) => !open);
          }}
          ref={triggerRef}
          onPointerDown={menuKeys.onTriggerPointerDown}
          onKeyDown={menuKeys.onTriggerKeyDown}
        >
          {/* Keyed by model so a switch replays the arrival burst. */}
          <span className={`model-orb ${selectedModelIconSrc ? "named-model-art" : "provider-model-art"}`} key={selectedModel?.id ?? kind}>
            {selectedModelIconSrc
              ? <img src={selectedModelIconSrc} alt="" aria-hidden="true" draggable={false} />
              : <ProviderLogo provider="openai" size={13} />}
            {/* Astra alone drifts stars off its logo, and only here on the
                trigger: the menu's rows stay perfectly still. Purely decorative
                overlay — absolutely positioned inside the orb, hidden from
                assistive tech and transparent to pointer input, so the trigger's
                layout and hit target are untouched. */}
            {kind === "astra" && (
              <span className="model-orb-stars" aria-hidden="true"><i /><i /><i /><i /><i /><i /><i /><i /><i /></span>
            )}
          </span>
          <span className="model-picker-copy">
            <small>Model</small>
            <strong>{selectedModel?.name ?? "Choose a model"}</strong>
            <em>{selectedModel?.tagline ?? ""}</em>
          </span>
          <ChevronDown className="model-picker-chevron" size={15} />
        </button>

        <div ref={menuRef} className="model-menu" role="menu" aria-label="OpenAI model selector" onKeyDown={menuKeys.onMenuKeyDown}>
          <ModelCatalogHeader provider="OpenAI" heading="OpenAI models" description={runtimeModels.length ? "From your account" : "Built-in list"} loading={loading} disabled={disabled} onRefresh={onRefresh} />
          {searchable && <div className="openrouter-search-row model-menu-search">
            <Search size={14} aria-hidden="true" />
            <input ref={searchRef} aria-label="Filter OpenAI models" aria-controls={listId} value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Filter models…" />
            {query && <button type="button" onClick={() => { setQuery(""); searchRef.current?.focus(); }} aria-label="Clear model filter"><X size={13} /></button>}
          </div>}
          <div className="model-menu-list" id={listId} role="presentation">
          {options.map((entry, index) => (
            <ModelCatalogRow
              key={entry.id}
              id={entry.id}
              name={entry.name}
              detail={entry.tagline}
              art={<span className={`menu-model-orb ${entry.iconSrc ? "named-model-art" : "provider-model-art"}`}>
                {entry.iconSrc
                  ? <img src={entry.iconSrc} alt="" draggable={false} />
                  : <ProviderLogo provider="openai" size={13} />}
              </span>}
              selected={selectedModel?.id === entry.id}
              groupEnd={starredVisible > 0 && index === starredVisible - 1}
              ariaLabel={`${entry.name}: ${entry.tagline}`}
              title={`${entry.name}: ${entry.tagline}`}
              className={`model-menu-option ${entry.kind}`}
              style={{ "--option-accent": entry.kind === "generic" ? "var(--muted-2)" : undefined } as CSSProperties}
              disabled={disabled}
              ariaDisabled={signedIn === false}
              favorite={onToggleFavorite ? favorites.includes(entry.id) : undefined}
              onToggleFavorite={onToggleFavorite}
              onSelect={() => {
                if (signedIn === false) { onSignInRequired?.(); return; }
                menuKeys.select(() => onModel(entry.id));
              }}
            />
          ))}
          {searchable && !options.length && <p className="model-menu-no-match" role="status">No models match “{query.trim()}”.</p>}
          </div>
          {error && signedIn !== false && <div className="openrouter-catalog-warning" role={menuOpen ? "status" : undefined}>{error} · {runtimeModels.length ? "Showing the last loaded catalog." : "Showing the built-in list."}</div>}
        </div>
      </div>

      <div className="reasoning-control">
        <div className="reasoning-heading"><Gauge size={13} /><span>Reasoning</span><button type="button" className={`fast-tier ${fast ? "on" : ""}`} aria-pressed={fast} aria-label="Use OpenAI fast priority service tier" onClick={() => onFast(!fast)} title="Use OpenAI priority service tier"><Zap size={9} /> Fast</button>{/* Keyed by effort so each change replays the pop-in. */}<strong key={EFFORTS[effortIndex].value}>{EFFORTS[effortIndex].label}</strong></div>
        <EffortSlider
          variant="codex"
          index={effortIndex}
          count={EFFORTS.length}
          effortValues={EFFORTS.map((entry) => entry.value)}
          ariaLabel="Reasoning effort"
          valueText={EFFORTS[effortIndex].label}
          disabled={disabled}
          onIndex={(next) => onEffort(EFFORTS[next].value)}
        />
        <div className="reasoning-labels" aria-hidden="true">
          {EFFORTS.map((entry, index) => <span key={entry.value} className={index === effortIndex ? "active" : ""}>{entry.shortLabel}</span>)}
        </div>
      </div>
    </div>
  );
}
