import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { Check, ChevronDown, Gauge, Zap } from "lucide-react";
import { EffortSlider, effortFlairStyle } from "./effortFlair";
import { ProviderLogo } from "./BrandLogos";
import { ModelFavoriteStar, type ModelFavoriteProps } from "./ModelFavoriteStar";
import { favoriteCount, sortByFavorites } from "../lib/modelFavorites";
import { closesModelMenu } from "../lib/composerMenus";
import { ModelCatalogHeader } from "./ModelCatalogHeader";

export type ModelKind = "sol" | "terra" | "luna" | "astra";
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
  { kind: "sol", name: "Sol", id: "gpt-5.6-sol", tagline: "Detail & polish", iconSrc: "/model-icons/sol.png" },
  { kind: "terra", name: "Terra", id: "gpt-5.6-terra", tagline: "Everyday power", iconSrc: "/model-icons/terra.png" },
  { kind: "luna", name: "Luna", id: "gpt-5.6-luna", tagline: "Fast & focused", iconSrc: "/model-icons/luna.png" },
  { kind: "astra", name: "Astra", id: "gpt-6-astra", tagline: "Frontier intelligence", iconSrc: "/model-icons/astra.png" },
];

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
  if (model.includes("astra")) return "astra";
  if (model.includes("terra")) return "terra";
  if (model.includes("luna")) return "luna";
  return "sol";
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
    const known = OPENAI_MODELS.find((candidate) => candidate.id === id);
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
  loading?: boolean;
  error?: string;
  onRefresh?: () => void;
  onModel: (model: string) => void;
  onEffort: (effort: ReasoningEffort) => void;
  onFast: (enabled: boolean) => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const catalog = useMemo(() => openAiModelOptions(runtimeModels), [runtimeModels]);
  const options = useMemo(
    () => sortByFavorites(catalog, favorites, (entry) => entry.id),
    [catalog, favorites],
  );
  const starredVisible = favoriteCount(options, favorites, (entry) => entry.id);
  // A saved model the runtime no longer lists stays selected and visible; the
  // menu never silently rewrites the user's choice.
  const selectedModel = options.find((entry) => entry.id === model)
    ?? (model ? { id: model, name: model, tagline: "Saved model", kind: modelKind(model), isDefault: false } : options[0]);
  const kind = selectedModel?.kind ?? "sol";
  const effortIndex = Math.max(0, EFFORTS.findIndex((entry) => entry.value === (effort === "ultra" ? "max" : effort)));
  const reasoningFill = (effortIndex / (EFFORTS.length - 1)) * 100;
  const selectedModelIconSrc = selectedModel?.iconSrc;

  useEffect(() => {
    if (!menuOpen) return;
    function handlePointerDown(event: PointerEvent) {
      if (closesModelMenu(event, rootRef.current)) setMenuOpen(false);
    }
    // Capture phase + stopPropagation: Escape closes only this menu and never
    // reaches the app-level handler that stops the running turn.
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.stopPropagation();
        setMenuOpen(false);
        rootRef.current?.querySelector<HTMLButtonElement>(".model-picker-trigger")?.focus();
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
  }, [menuOpen]);

  useEffect(() => {
    if (!menuOpen) return;
    const frame = requestAnimationFrame(() => {
      // Focus once on opening, not again when a refresh changes the catalog.
      if (!rootRef.current?.querySelector(".model-menu")?.contains(document.activeElement)) {
        const selected = optionRefs.current.find((option) => option?.getAttribute("aria-checked") === "true");
        (selected ?? optionRefs.current[0])?.focus();
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [menuOpen]);

  const moveOptionFocus = (direction: number) => {
    const enabled = optionRefs.current.filter((entry): entry is HTMLButtonElement => Boolean(entry && entry.isConnected && !entry.disabled));
    if (!enabled.length) return;
    const current = enabled.indexOf(document.activeElement as HTMLButtonElement);
    enabled[(current + direction + enabled.length) % enabled.length]?.focus();
  };

  return (
    <div
      ref={rootRef}
      className={`model-power-control ${kind} ${menuOpen ? "menu-open" : ""} ${disabled ? "disabled" : ""} ${effortIndex === EFFORTS.length - 1 ? "effort-max" : ""}`}
      style={{ "--reasoning-fill": `${reasoningFill}%`, ...effortFlairStyle(effortIndex, EFFORTS.length) } as CSSProperties}
    >
      {providerControl}
      <div className="model-picker">
        <button
          type="button"
          className="model-picker-trigger"
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          aria-label={`OpenAI model: ${selectedModel?.name ?? "not selected"}`}
          disabled={disabled}
          onClick={() => setMenuOpen((open) => !open)}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              setMenuOpen(true);
            }
          }}
        >
          {/* Keyed by model so a switch replays the arrival burst. */}
          <span className={`model-orb ${selectedModelIconSrc ? "named-model-art" : "provider-model-art"}`} key={selectedModel?.id ?? kind}>
            {selectedModelIconSrc
              ? <img src={selectedModelIconSrc} alt="" aria-hidden="true" draggable={false} />
              : <ProviderLogo provider="openai" size={13} />}
          </span>
          <span className="model-picker-copy">
            <small>Model</small>
            <strong>{selectedModel?.name ?? "Choose a model"}</strong>
            <em>{selectedModel?.tagline ?? ""}</em>
          </span>
          <ChevronDown className="model-picker-chevron" size={15} />
        </button>

        <div className="model-menu" role="menu" aria-label="OpenAI model selector" onKeyDown={(event) => {
          if (event.key === "ArrowDown") { event.preventDefault(); moveOptionFocus(1); }
          if (event.key === "ArrowUp") { event.preventDefault(); moveOptionFocus(-1); }
          if (event.key === "Home") { event.preventDefault(); optionRefs.current.find((entry) => entry && !entry.disabled)?.focus(); }
          if (event.key === "End") { event.preventDefault(); [...optionRefs.current].reverse().find((entry) => entry && !entry.disabled)?.focus(); }
        }}>
          <ModelCatalogHeader provider="OpenAI" heading="Choose your model" description={runtimeModels.length ? `${options.length} from your OpenAI account` : "Built-in list — account catalog unavailable"} loading={loading} disabled={disabled} onRefresh={onRefresh} />
          {options.map((entry, index) => {
            const selected = selectedModel?.id === entry.id;
            const modelIconSrc = entry.iconSrc;
            return (
              <div className="model-row" key={entry.id} role="none">
                <button
                  type="button"
                  role="menuitemradio"
                  aria-checked={selected}
                  aria-label={`${entry.name}: ${entry.tagline}`}
                  ref={(node) => { optionRefs.current[index] = node; }}
                  className={`model-menu-option ${entry.kind} ${selected ? "selected" : ""}${starredVisible > 0 && index === starredVisible - 1 ? " favorite-group-end" : ""}`}
                  disabled={disabled}
                  onClick={() => {
                    onModel(entry.id);
                    setMenuOpen(false);
                  }}
                  title={`${entry.name}: ${entry.tagline}`}
                >
                  <span className={`menu-model-orb ${modelIconSrc ? "named-model-art" : "provider-model-art"}`}>
                    {modelIconSrc
                      ? <img src={modelIconSrc} alt="" aria-hidden="true" draggable={false} />
                      : <ProviderLogo provider="openai" size={13} />}
                  </span>
                  <span><strong>{entry.name}</strong><small>{entry.tagline}</small></span>
                  {selected && <Check size={14} />}
                </button>
                {onToggleFavorite && <ModelFavoriteStar model={entry.id} label={entry.name} favorite={favorites.includes(entry.id)} onToggle={onToggleFavorite} />}
              </div>
            );
          })}
          {error && <div className="openrouter-catalog-warning" role={menuOpen ? "status" : undefined}>{error} · {runtimeModels.length ? "Showing the last loaded catalog." : "Showing the built-in list."}</div>}
        </div>
      </div>

      <div className="reasoning-control">
        <div className="reasoning-heading"><Gauge size={13} /><span>Reasoning</span><button type="button" className={`fast-tier ${fast ? "on" : ""}`} aria-pressed={fast} aria-label="Use OpenAI fast priority service tier" onClick={() => onFast(!fast)} title="Use OpenAI priority service tier"><Zap size={9} /> Fast</button>{/* Keyed by effort so each change replays the pop-in. */}<strong key={EFFORTS[effortIndex].value}>{EFFORTS[effortIndex].label}</strong></div>
        <EffortSlider
          variant="codex"
          index={effortIndex}
          count={EFFORTS.length}
          ariaLabel="Reasoning effort"
          valueText={EFFORTS[effortIndex].label}
          disabled={disabled}
          onIndex={(next) => onEffort(EFFORTS[next].value)}
        />
        <div className="reasoning-labels">
          {EFFORTS.map((entry, index) => <span key={entry.value} className={index === effortIndex ? "active" : ""}>{entry.shortLabel}</span>)}
        </div>
      </div>
    </div>
  );
}
