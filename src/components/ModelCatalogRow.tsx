import type { CSSProperties, ReactNode } from "react";
import { Check } from "lucide-react";
import { ModelFavoriteStar } from "./ModelFavoriteStar";

/**
 * One catalog row for every model menu (composer pickers; reusable by any
 * list of models): small art, the model's full display name, one muted detail
 * line, optional trailing meta, the selected check, and the favourite star
 * (with a "→ Favorite" hint while the row has keyboard focus).
 * Keyboard behaviour comes from useMenuKeyboard; this only owns presentation.
 */
export function ModelCatalogRow({
  id, name, detail, art, meta, selected, groupEnd = false, ariaLabel, title, role = "menuitemradio",
  disabled, ariaDisabled, className = "", style, favorite, onToggleFavorite, onSelect,
}: {
  id: string;
  name: string;
  detail?: ReactNode;
  art: ReactNode;
  meta?: ReactNode;
  selected: boolean;
  /** The last starred row: a hairline separates favourites from the rest. */
  groupEnd?: boolean;
  ariaLabel?: string;
  title?: string;
  role?: "menuitemradio" | "menuitem";
  disabled?: boolean;
  ariaDisabled?: boolean;
  className?: string;
  style?: CSSProperties;
  /** Undefined hides the star (for rows that cannot be favourited). */
  favorite?: boolean;
  onToggleFavorite?: (model: string) => void;
  onSelect: () => void;
}) {
  const starrable = favorite !== undefined && Boolean(onToggleFavorite);
  return (
    <div className="model-row catalog-row" role="none">
      <button
        type="button"
        role={role}
        aria-checked={role === "menuitemradio" ? selected : undefined}
        aria-current={role === "menuitem" && selected ? "true" : undefined}
        aria-label={ariaLabel ?? name}
        aria-disabled={ariaDisabled || undefined}
        className={`catalog-row-option ${selected ? "selected " : ""}${groupEnd ? "favorite-group-end " : ""}${className}`.trim()}
        style={style}
        disabled={disabled}
        tabIndex={-1}
        title={title}
        onClick={onSelect}
      >
        <span className="catalog-row-art" aria-hidden="true">{art}</span>
        <span className="catalog-row-copy">
          <strong>{name}</strong>
          {detail && <small>{detail}</small>}
        </span>
        {/* The trailing column is part of the row's own layout: meta and the
            check on top, and (only while the row has keyboard focus) the
            "→ Favorite" hint under them. Nothing is positioned on top of the
            row, so the hint can never cover its text (O1). */}
        {(meta || selected || starrable) && (
          <span className="catalog-row-trail">
            {(meta || selected) && (
              <span className="catalog-row-trail-main">
                {meta && <span className="catalog-row-meta">{meta}</span>}
                {selected && <Check className="catalog-row-check" size={13} aria-hidden="true" />}
              </span>
            )}
            {starrable && <span className="catalog-row-star-hint" aria-hidden="true"><kbd>→</kbd>{favorite ? "Unfavorite" : "Favorite"}</span>}
          </span>
        )}
      </button>
      {starrable && onToggleFavorite && <ModelFavoriteStar model={id} label={name} favorite={Boolean(favorite)} onToggle={onToggleFavorite} keyHint="→" />}
    </div>
  );
}
