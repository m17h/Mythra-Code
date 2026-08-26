import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { Check, ChevronDown, Gauge, LoaderCircle, RefreshCw } from "lucide-react";
import { EffortSlider, effortFlairStyle } from "./effortFlair";
import { ModelFavoriteStar, type ModelFavoriteProps } from "./ModelFavoriteStar";
import type { ReasoningEffort } from "./ModelPowerControl";
import { ClaudeProviderLogo } from "./BrandLogos";
import type { ClaudeModel } from "../lib/claude";
import { favoriteCount, sortByFavorites } from "../lib/modelFavorites";

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
  favorites = [],
  onToggleFavorite,
  onModel,
  onEffort,
  onRefresh,
}: ModelFavoriteProps & {
  model: string;
  effort: ReasoningEffort;
  /** Live catalog from the Claude Code CLI; empty falls back to the built-ins. */
  models?: ClaudeModel[];
  loading?: boolean;
  error?: string;
  onModel: (model: string) => void;
  onEffort: (effort: ReasoningEffort) => void;
  onRefresh?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const live = models.length > 0;
  const catalog = live ? models : CLAUDE_FALLBACK_MODELS;
  const ordered = useMemo(
    () => sortByFavorites(catalog, favorites, (entry) => entry.id),
    [catalog, favorites],
  );
  const starredVisible = favoriteCount(ordered, favorites, (entry) => entry.id);
  // A saved model that the live catalog no longer offers stays visible and
  // selected instead of the menu silently pointing somewhere else.
  const selected = ordered.find((entry) => entry.id === model)
    ?? (model ? { id: model, displayName: model, description: "Saved model", resolvedModel: model, disabled: false, supportedEfforts: [] } : ordered[0]);
  const normalizedEffort = effort === "ultra" ? "max" : effort;
  const effortIndex = Math.max(
    0,
    EFFORTS.findIndex((entry) => entry.value === normalizedEffort),
  );
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

  return (
    <div
      className="openrouter-control claude-control"
      ref={rootRef}
      style={{ "--router-fill": `${fill}%` } as CSSProperties}
    >
      <div className={`openrouter-picker ${open ? "open" : ""}`}>
        <button
          type="button"
          className="openrouter-trigger"
          aria-haspopup="menu"
          aria-expanded={open}
          aria-label={`Claude model: ${selected?.displayName ?? "not selected"}`}
          onClick={() => setOpen((value) => !value)}
        >
          <span className="openrouter-logo claude-logo">
            <ClaudeProviderLogo size={15} />
          </span>
          <span className="openrouter-trigger-copy">
            <small>Claude subscription model</small>
            <strong>{selected?.displayName ?? "Choose a model"}</strong>
            <em>{selected?.description || selected?.resolvedModel || "Uses your Claude Code login"}</em>
          </span>
          <ChevronDown size={15} />
        </button>
        <div className="openrouter-menu claude-model-menu">
          <div className="openrouter-menu-meta">
            <span>{catalog.length} Claude model{catalog.length === 1 ? "" : "s"}</span>
            <small>{live ? "Live catalog from your Claude Code CLI" : "Built-in list — CLI catalog unavailable"}</small>
            {onRefresh && (
              <button type="button" className="model-meta-refresh" onClick={onRefresh} title="Refresh Claude models" aria-label="Refresh Claude model catalog" disabled={loading}>
                {loading ? <LoaderCircle className="spin" size={13} /> : <RefreshCw size={13} />}
              </button>
            )}
          </div>
          <div
            className="openrouter-options"
            role="menu"
            aria-label="Claude model selector"
          >
            {ordered.map((entry, index) => (
              <div className="model-row" key={entry.id} role="none">
                <button
                  type="button"
                  role="menuitemradio"
                  aria-checked={entry.id === selected?.id}
                  aria-label={`${entry.displayName}${entry.disabled ? " (unavailable on your plan)" : ""}`}
                  className={`${entry.id === selected?.id ? "selected" : ""}${starredVisible > 0 && index === starredVisible - 1 ? " favorite-group-end" : ""}`}
                  disabled={entry.disabled}
                  title={entry.disabled ? "Your Claude plan cannot run this model" : entry.resolvedModel}
                  onClick={() => {
                    onModel(entry.id);
                    setOpen(false);
                  }}
                >
                  <span className="openrouter-provider-mark claude-logo">
                    <ClaudeProviderLogo size={13} />
                  </span>
                  <span>
                    <strong>{entry.displayName}</strong>
                    <small>{entry.description || entry.resolvedModel}</small>
                  </span>
                  <span className="openrouter-model-meta">{entry.resolvedModel}</span>
                  {entry.id === selected?.id && <Check size={13} />}
                </button>
                {onToggleFavorite && <ModelFavoriteStar model={entry.id} label={entry.displayName} favorite={favorites.includes(entry.id)} onToggle={onToggleFavorite} />}
              </div>
            ))}
          </div>
          {!live && (
            <div className="openrouter-catalog-warning">
              {error || "Could not read the Claude Code model catalog."} Showing Mythra Code’s built-in list, which may not match your plan.
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
          ariaLabel="Claude reasoning effort"
          valueText={EFFORTS[effortIndex].label}
          onIndex={(next) => onEffort(EFFORTS[next].value)}
        />
        <div className="openrouter-reasoning-labels">
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
