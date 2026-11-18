import { withShortcut } from "../lib/shortcuts";
import { useEffect, useId, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { ChevronDown, Gauge, Search, X } from "lucide-react";
import { EffortSlider, effortFlairStyle } from "./effortFlair";
import { useMenuKeyboard } from "../hooks/useMenuKeyboard";
import { ModelCatalogHeader } from "./ModelCatalogHeader";
import type { ModelFavoriteProps } from "./ModelFavoriteStar";
import { ModelCatalogRow } from "./ModelCatalogRow";
import type { ReasoningEffort } from "./ModelPowerControl";
import { ClaudeProviderLogo } from "./BrandLogos";
import { visibleClaudeModels, type ClaudeModel } from "../lib/claude";
import { favoriteCount, sortByFavorites } from "../lib/modelFavorites";
import { closesModelMenu } from "../lib/composerMenus";

/**
 * Offered only when the CLI's own catalog cannot be read.
 *
 * Claude Code has no `models` subcommand; the live catalog comes from the
 * stream-json `list_models` control request. An older CLI, a signed-out
 * install, or a launch failure leaves this list, which is labelled as a
 * built-in guess in the menu rather than presented as the account's real
 * entitlements.
 */
export const CLAUDE_MODELS = [
  { id: "claude-fable-5", name: "Fable 5", tagline: "Frontier coding" },
  { id: "claude-opus-5", name: "Opus 5", tagline: "Deepest reasoning" },
  { id: "claude-sonnet-5", name: "Sonnet 5", tagline: "Balanced power" },
  { id: "claude-haiku-4-5", name: "Haiku 4.5", tagline: "Fast and efficient" },
];

export const CLAUDE_FALLBACK_MODELS: ClaudeModel[] = CLAUDE_MODELS.map((entry) => ({
  id: entry.id,
  displayName: entry.name,
  description: entry.tagline,
  resolvedModel: entry.id,
  disabled: false,
  supportedEfforts: [],
}));

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
  models = [],
  loading = false,
  error = "",
  signedIn,
  providerControl,
  favorites = [],
  onToggleFavorite,
  onModel,
  onEffort,
  onRefresh,
  onUnavailableModel,
  onSignInRequired,
}: ModelFavoriteProps & {
  model: string;
  effort: ReasoningEffort;
  /** Live catalog from the Claude Code CLI; empty falls back to the built-ins. */
  models?: ClaudeModel[];
  loading?: boolean;
  error?: string;
  signedIn?: boolean;
  providerControl?: ReactNode;
  onModel: (model: string) => void;
  onEffort: (effort: ReasoningEffort) => void;
  onRefresh?: () => void;
  onUnavailableModel?: (model: ClaudeModel) => void;
  onSignInRequired?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const listId = useId();
  const live = models.length > 0;
  const sourceModels = live ? models : CLAUDE_FALLBACK_MODELS;
  const catalog = visibleClaudeModels(sourceModels);
  const searchable = catalog.length > 6;
  const normalizedQuery = searchable ? query.trim().toLowerCase() : "";
  const ordered = useMemo(
    () => sortByFavorites(catalog.filter((entry) => !normalizedQuery
      || `${entry.displayName} ${entry.id} ${entry.description ?? ""} ${entry.resolvedModel ?? ""}`.toLowerCase().includes(normalizedQuery)), favorites, (entry) => entry.id),
    [catalog, favorites, normalizedQuery],
  );
  useEffect(() => { if (!open) setQuery(""); }, [open]);
  const starredVisible = favoriteCount(ordered, favorites, (entry) => entry.id);
  // A saved model that the live catalog no longer offers stays visible and
  // selected instead of the menu silently pointing somewhere else.
  const catalogMatch = catalog.find((entry) => entry.id === model) ?? sourceModels.find((entry) => entry.id === model);
  const selected = catalogMatch
    // Supersession can intentionally hide the old row while it remains the
    // saved selection. Preserve the live catalog's friendly name in the
    // closed trigger instead of exposing its raw CLI id.
    ?? (model ? { id: model, displayName: model, description: "Saved model", resolvedModel: model, disabled: false, supportedEfforts: [] } : catalog[0]);
  // Saved concrete IDs may not match the CLI's aliases, including before its
  // catalog arrives. Keep the trigger terse without changing the selected ID
  // or hiding version/context details in the expanded menu.
  const family = [model, selected?.resolvedModel, selected?.displayName]
    .map((value) => value?.match(/^(?:claude(?:[-_ .]\d+)*[-_ ])?(fable|opus|sonnet|haiku)(?![a-z])/i)?.[1])
    .find(Boolean);
  // The catalog's own display name everywhere (G7); the family alone only
  // stands in for a raw saved id the catalog doesn't name.
  const buttonLabel = catalogMatch?.displayName
    ?? (family ? `Claude ${family.charAt(0).toUpperCase()}${family.slice(1).toLowerCase()}` : selected?.displayName ?? "Choose a model");
  const normalizedEffort = effort === "ultra" ? "max" : effort;
  const effortIndex = Math.max(
    0,
    EFFORTS.findIndex((entry) => entry.value === normalizedEffort),
  );
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

  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuKeys = useMenuKeyboard({ open, setOpen, menuRef, triggerRef, searchRef: searchable ? searchRef : undefined, answersModelShortcut: true, canOpen: () => signedIn !== false });

  return (
    <div
      className="openrouter-control claude-control"
      ref={rootRef}
      style={{ "--router-fill": `${fill}%` } as CSSProperties}
    >
      {providerControl}
      <div className={`openrouter-picker ${open ? "open" : ""} ${signedIn === false ? "unavailable" : ""}`}>
        <button
          ref={triggerRef}
          type="button"
          className="openrouter-trigger"
          aria-haspopup="menu"
          aria-expanded={open}
          aria-label={`Claude model: ${buttonLabel}`}
          title={withShortcut(`Model: ${selected?.displayName ?? buttonLabel}`, "modelPicker")}
          onPointerDown={menuKeys.onTriggerPointerDown}
          onKeyDown={(event) => {
            if (signedIn === false && (event.key === "ArrowDown" || event.key === "ArrowUp")) { event.preventDefault(); onSignInRequired?.(); return; }
            menuKeys.onTriggerKeyDown(event);
          }}
          aria-disabled={signedIn === false || undefined}
          onClick={() => {
            if (signedIn === false) { onSignInRequired?.(); return; }
            setOpen((value) => !value);
          }}
        >
          <span className="openrouter-logo claude-logo" aria-hidden="true">
            <ClaudeProviderLogo size={16} />
          </span>
          <span className="openrouter-trigger-copy">
            <small>Model</small>
            <strong>{buttonLabel}</strong>
          </span>
          <ChevronDown size={15} />
        </button>
        <div className="openrouter-menu claude-model-menu" inert={!open || undefined} onKeyDown={menuKeys.onMenuKeyDown}>
          <ModelCatalogHeader provider="Claude" heading="Claude models" description={live
              ? signedIn === false ? "Sign in for your plan's models" : "From Claude Code"
              : "Built-in list"} loading={loading} onRefresh={onRefresh} />
          {searchable && <div className="openrouter-search-row model-menu-search">
            <Search size={14} aria-hidden="true" />
            <input ref={searchRef} aria-label="Filter Claude models" aria-controls={listId} value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Filter models…" />
            {query && <button type="button" onClick={() => { setQuery(""); searchRef.current?.focus(); }} aria-label="Clear model filter"><X size={13} /></button>}
          </div>}
          <div
            ref={menuRef}
            id={listId}
            className="openrouter-options"
            role="menu"
            aria-label="Claude model"
          >
            {ordered.map((entry, index) => {
              const updateRequired = entry.unavailableReason === "update-required";
              return <ModelCatalogRow
                key={entry.id}
                id={entry.id}
                name={entry.displayName}
                detail={entry.description || entry.resolvedModel}
                art={<span className="openrouter-provider-mark claude-logo"><ClaudeProviderLogo size={16} /></span>}
                meta={updateRequired ? "Update required" : undefined}
                role={updateRequired ? "menuitem" : "menuitemradio"}
                selected={entry.id === selected?.id}
                groupEnd={starredVisible > 0 && index === starredVisible - 1}
                ariaLabel={`${entry.displayName}${updateRequired ? " (Claude Code update required)" : entry.disabled ? " (unavailable on your plan)" : ""}`}
                ariaDisabled={signedIn === false || (entry.disabled && !updateRequired)}
                className={`claude-logo-row${updateRequired ? " update-required" : ""}`}
                disabled={signedIn !== false && entry.disabled && !updateRequired}
                title={updateRequired ? `Update Claude Code${entry.requiredVersion ? ` to ${entry.requiredVersion} or newer` : ""}` : entry.disabled ? "Your Claude plan cannot run this model" : `${entry.displayName} · ${entry.resolvedModel}`}
                favorite={!entry.disabled && onToggleFavorite ? favorites.includes(entry.id) : undefined}
                onToggleFavorite={onToggleFavorite}
                onSelect={() => {
                  if (signedIn === false) { onSignInRequired?.(); return; }
                  if (entry.disabled) {
                    onUnavailableModel?.(entry);
                    setOpen(false);
                    return;
                  }
                  menuKeys.select(() => onModel(entry.id));
                }}
              />;
            })}
            {searchable && !ordered.length && <p className="model-menu-no-match" role="status">No models match “{query.trim()}”.</p>}
          </div>
          {signedIn !== false && (error || !live) && (
            <div className="openrouter-catalog-warning" role={open ? "status" : undefined}>
              {error || "Could not read the Claude Code model catalog."} {live ? "Showing the last loaded catalog." : "Showing Mythra Code’s built-in list, which may not match your plan."}
            </div>
          )}
        </div>
      </div>
      <div
        className={`openrouter-reasoning ${effortIndex === EFFORTS.length - 1 ? "effort-max" : ""}`}
        style={effortFlairStyle(effortIndex, EFFORTS.length)}
      >
        <div className="openrouter-reasoning-heading">
          <Gauge size={13} />
          <span>Reasoning</span>
          {/* Keyed so each effort change replays the readout pop. */}
          <strong key={EFFORTS[effortIndex].value}>{EFFORTS[effortIndex].label}</strong>
        </div>
        <EffortSlider
          variant="router"
          index={effortIndex}
          count={EFFORTS.length}
          effortValues={EFFORTS.map((entry) => entry.value)}
          ariaLabel="Claude reasoning effort"
          valueText={EFFORTS[effortIndex].label}
          onIndex={(next) => onEffort(EFFORTS[next].value)}
        />
        <div className="openrouter-reasoning-labels" aria-hidden="true">
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
