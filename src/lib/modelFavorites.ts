import type { Provider } from "../types";

/**
 * Per-provider starred models. A favorite is only ever a model identifier, so
 * a catalog that drops or renames a model leaves a harmless orphan entry
 * rather than a broken selection.
 */
export type ModelFavorites = Partial<Record<Provider, string[]>>;

export const MODEL_FAVORITES_KEY = "kiwi.modelFavorites";

export const EMPTY_MODEL_FAVORITES: ModelFavorites = {};

const PROVIDERS: Provider[] = ["openai", "openrouter", "lmstudio", "claude", "cursor"];

/** Stored favorites come from disk and can be any shape after a downgrade. */
export function sanitizeModelFavorites(value: unknown): ModelFavorites {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const record = value as Record<string, unknown>;
  const favorites: ModelFavorites = {};
  for (const provider of PROVIDERS) {
    const entries = record[provider];
    if (!Array.isArray(entries)) continue;
    const models: string[] = [];
    for (const entry of entries) {
      if (typeof entry !== "string") continue;
      const model = entry.trim();
      if (model && !models.includes(model)) models.push(model);
    }
    if (models.length) favorites[provider] = models;
  }
  return favorites;
}

export function favoriteModels(favorites: ModelFavorites, provider: Provider): string[] {
  return favorites[provider] ?? [];
}

export function isFavoriteModel(favorites: ModelFavorites, provider: Provider, model: string): boolean {
  return favoriteModels(favorites, provider).includes(model.trim());
}

/**
 * Star or unstar one model. Returns the same object when nothing changes so a
 * persisted-state setter can skip an identical write.
 */
export function toggleFavoriteModel(
  favorites: ModelFavorites,
  provider: Provider,
  model: string,
): ModelFavorites {
  const id = model.trim();
  if (!id) return favorites;
  const current = favoriteModels(favorites, provider);
  const next = current.includes(id) ? current.filter((entry) => entry !== id) : [...current, id];
  const updated = { ...favorites };
  if (next.length) updated[provider] = next;
  else delete updated[provider];
  return updated;
}

/**
 * Stable favorites-first ordering: starred entries keep their catalog order
 * relative to each other, and so does everything else. Sorting by star order
 * instead would reshuffle a long catalog every time a star is toggled.
 */
export function sortByFavorites<T>(items: T[], favorites: string[], key: (item: T) => string): T[] {
  if (!favorites.length) return items;
  const starred = new Set(favorites);
  const first: T[] = [];
  const rest: T[] = [];
  for (const item of items) (starred.has(key(item)) ? first : rest).push(item);
  return first.length ? [...first, ...rest] : items;
}

/** Index of the first non-favorite, used to render a divider in the menus. */
export function favoriteCount<T>(items: T[], favorites: string[], key: (item: T) => string): number {
  if (!favorites.length) return 0;
  const starred = new Set(favorites);
  let count = 0;
  for (const item of items) {
    if (!starred.has(key(item))) break;
    count += 1;
  }
  return count;
}
