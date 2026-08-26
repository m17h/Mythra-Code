import { Star } from "lucide-react";

/**
 * The star that pins a model to the top of every picker.
 *
 * It is a sibling of the model option rather than a child of it, because a
 * button nested inside a button is invalid and screen readers skip it. Each
 * row is a `.model-row` wrapper holding the option and this control.
 */
export function ModelFavoriteStar({
  model,
  label,
  favorite,
  onToggle,
}: {
  model: string;
  /** Human-readable model name used in the accessible label. */
  label?: string;
  favorite: boolean;
  onToggle: (model: string) => void;
}) {
  const name = label?.trim() || model;
  return (
    <button
      type="button"
      className={`model-star ${favorite ? "on" : ""}`}
      aria-pressed={favorite}
      aria-label={favorite ? `Unstar ${name}` : `Star ${name}`}
      title={favorite ? "Remove from favorites" : "Add to favorites"}
      onClick={(event) => {
        // The star lives inside an open menu; toggling it must not also pick
        // the model or close the menu.
        event.preventDefault();
        event.stopPropagation();
        onToggle(model);
      }}
      onKeyDown={(event) => {
        // Arrow keys belong to the option list, not to this control.
        if (event.key.startsWith("Arrow")) event.stopPropagation();
      }}
    >
      <Star size={13} strokeWidth={2} {...(favorite ? { fill: "currentColor" } : {})} />
    </button>
  );
}

/** Shared props every model picker accepts so stars work identically. */
export interface ModelFavoriteProps {
  /** Starred model identifiers for the provider this picker belongs to. */
  favorites?: string[];
  onToggleFavorite?: (model: string) => void;
}
