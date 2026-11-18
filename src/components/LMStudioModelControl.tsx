import { withShortcut } from "../lib/shortcuts";
import { useEffect, useId, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { ChevronDown, Gauge, Search } from "lucide-react";
import { EffortSlider, effortFlairStyle } from "./effortFlair";
import { EmptyState } from "./EmptyState";
import { ModelCatalogHeader } from "./ModelCatalogHeader";
import type { LMStudioModel, LMStudioReasoningEffort } from "../lib/lmStudio";
import type { ReasoningEffort } from "./ModelPowerControl";
import { LmStudioLogo } from "./BrandLogos";
import type { ModelFavoriteProps } from "./ModelFavoriteStar";
import { ModelCatalogRow } from "./ModelCatalogRow";
import { favoriteCount, sortByFavorites } from "../lib/modelFavorites";
import { closesModelMenu } from "../lib/composerMenus";
import { useMenuKeyboard } from "../hooks/useMenuKeyboard";

const EFFORTS: Array<{ value: LMStudioReasoningEffort; label: string }> = [
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
  { value: "xhigh", label: "Extra" },
  { value: "max", label: "Max" },
];

export function LMStudioModelControl({
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
  models: LMStudioModel[];
  effort: ReasoningEffort;
  loading: boolean;
  error: string;
  providerControl?: ReactNode;
  onRefresh: () => void;
  onModel: (model: string) => void;
  onEffort: (effort: ReasoningEffort) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const menuId = useId();
  const normalizedQuery = query.trim().toLowerCase();
  const filtered = useMemo(() => sortByFavorites(models.filter((entry) => (
    `${entry.id} ${entry.displayName} ${entry.publisher}`.toLowerCase().includes(normalizedQuery)
  )), favorites, (entry) => entry.id), [favorites, models, normalizedQuery]);
  const starredVisible = favoriteCount(filtered, favorites, (entry) => entry.id);
  const selectedModel = models.find((entry) => entry.id === model);
  const customModel = query.trim();
  const canUseCustom = Boolean(customModel) && !models.some((entry) => entry.id.toLowerCase() === normalizedQuery);
  const availableEfforts = selectedModel?.reasoningEfforts.length
    ? EFFORTS.filter((entry) => selectedModel.reasoningEfforts.includes(entry.value))
    : EFFORTS;
  const normalizedEffort = effort === "ultra" ? "max" : effort as LMStudioReasoningEffort;
  const effortIndex = Math.max(0, availableEfforts.findIndex((entry) => entry.value === normalizedEffort));
  const fill = availableEfforts.length > 1 ? (effortIndex / (availableEfforts.length - 1)) * 100 : 100;

  const selectModel = (entry: LMStudioModel) => {
    onModel(entry.id);
    if (entry.reasoningEfforts.length && !entry.reasoningEfforts.includes(normalizedEffort)) {
      onEffort(entry.defaultReasoningEffort ?? entry.reasoningEfforts[0]);
    }
  };

  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => {
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

  // Shared search-first menu contract (see useMenuKeyboard).
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuKeys = useMenuKeyboard({ open, setOpen, menuRef, triggerRef, searchRef, answersModelShortcut: true });

  return (
    <div className="openrouter-control lmstudio-control" ref={rootRef} style={{ "--router-fill": `${fill}%` } as CSSProperties}>
      {providerControl}
      <div className={`openrouter-picker ${open ? "open" : ""}`}>
        <button ref={triggerRef} type="button" className="openrouter-trigger" aria-haspopup="menu" aria-expanded={open} aria-controls={menuId} aria-label={`LM Studio model: ${selectedModel?.displayName || model || "not selected"}`} title={withShortcut(`Model: ${selectedModel?.displayName || model || "not selected"}`, "modelPicker")} onPointerDown={menuKeys.onTriggerPointerDown} onClick={() => setOpen((value) => !value)} onKeyDown={menuKeys.onTriggerKeyDown}>
          <span className="openrouter-logo lmstudio-logo"><LmStudioLogo size={15} /></span>
          <span className="openrouter-trigger-copy">
            <small>Model</small>
            <strong>{selectedModel?.displayName || model || "Model"}</strong>
            <em>{models.length ? `${models.length} model${models.length === 1 ? "" : "s"} from your LM Studio server` : "Start the LM Studio local server"}</em>
          </span>
          <ChevronDown size={15} />
        </button>

        <div className="openrouter-menu lmstudio-model-menu" inert={!open || undefined} onKeyDown={menuKeys.onMenuKeyDown}>
          <ModelCatalogHeader provider="LM Studio" heading={normalizedQuery ? `${filtered.length} matches` : `${models.length} available`} description={favorites.length ? "Favorites first · local server catalog" : "Local server catalog"} loading={loading} onRefresh={onRefresh} />
          <div className="openrouter-search-row">
            <Search size={14} />
            <input ref={searchRef} aria-label="Search LM Studio models" aria-controls={menuId} value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search or enter a model identifier…" />
          </div>
          <div ref={menuRef} id={menuId} className="openrouter-options" role="menu" aria-label="LM Studio model selector">
            {filtered.map((entry, entryIndex) => (
              <ModelCatalogRow
                key={entry.id}
                id={entry.id}
                name={entry.displayName}
                detail={`${entry.id} · ${entry.trainedForToolUse ? "Tool use" : "No tool-use training"}`}
                art={<span className="openrouter-provider-mark lmstudio-logo"><LmStudioLogo size={13} /></span>}
                selected={entry.id === model}
                groupEnd={starredVisible > 0 && entryIndex === starredVisible - 1}
                ariaLabel={entry.displayName && entry.displayName !== entry.id ? `${entry.displayName}, ${entry.id}` : entry.id}
                className="lmstudio-logo-row"
                favorite={onToggleFavorite ? favorites.includes(entry.id) : undefined}
                onToggleFavorite={onToggleFavorite}
                onSelect={() => menuKeys.select(() => selectModel(entry))}
              />
            ))}
            {canUseCustom && <button type="button" role="menuitemradio" aria-checked={false} tabIndex={-1} className="custom-model-option" onClick={() => menuKeys.select(() => { onModel(customModel); setQuery(""); })}><span className="openrouter-provider-mark">+</span><span><strong>Use model identifier</strong><small>{customModel}</small></span></button>}
            {!loading && !error && filtered.length === 0 && !canUseCustom && <EmptyState variant="compact" className="model-menu-empty" icon={Search} role={normalizedQuery ? "status" : undefined} title={normalizedQuery ? "No matching models" : "No models loaded"} text="Download or load a model in LM Studio, then refresh this list." />}
          </div>
          {error && <div className="openrouter-catalog-warning" role={open ? "status" : undefined}>{!models.length && <strong>LM Studio is not connected</strong>} {error} · Check your local server, then refresh.</div>}
        </div>
      </div>

      <div className={`openrouter-reasoning ${availableEfforts.length > 1 && effortIndex === availableEfforts.length - 1 ? "effort-max" : ""}`} style={effortFlairStyle(effortIndex, availableEfforts.length)}>
        <div className="openrouter-reasoning-heading"><Gauge size={13} /><span>Reasoning</span><strong key={availableEfforts[effortIndex].value}>{availableEfforts[effortIndex].label}</strong></div>
        <EffortSlider variant="router" index={effortIndex} count={availableEfforts.length} effortValues={availableEfforts.map((entry) => entry.value)} ariaLabel="LM Studio reasoning effort" valueText={availableEfforts[effortIndex].label} onIndex={(next) => onEffort(availableEfforts[next].value)} />
        <div className="openrouter-reasoning-labels" aria-hidden="true">{availableEfforts.map((entry, index) => <span key={entry.value} className={index === effortIndex ? "active" : ""}>{entry.label}</span>)}</div>
      </div>
    </div>
  );
}
