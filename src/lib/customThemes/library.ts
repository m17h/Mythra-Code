// Pure helpers behind the Custom themes row in Settings and the Theme library
// window: which tiles Settings shows, the library's search filter and its sort
// orders. No React, no storage; the components pass the store's records in.

import { headSpec, type CustomThemeRecord } from "./store";
import type { CustomThemeId } from "./spec";

/** Settings shows at most this many tiles (one row of its 3-column grid); the rest live in the library. */
export const SETTINGS_TILE_LIMIT = 3;

export type ThemeLibrarySort = "recent" | "name" | "newest";

export const THEME_LIBRARY_SORTS: ReadonlyArray<{ value: ThemeLibrarySort; label: string }> = [
  { value: "recent", label: "Recently edited" },
  { value: "name", label: "Name A–Z" },
  { value: "newest", label: "Newest first" },
];

const byRecentEdit = (a: CustomThemeRecord, b: CustomThemeRecord) => b.updatedAt - a.updatedAt || b.createdAt - a.createdAt || a.id.localeCompare(b.id);

/**
 * The tiles Settings shows: the chosen custom theme first (when there is one),
 * then the most recently edited others, up to `limit`.
 */
export function settingsTiles(
  themes: readonly CustomThemeRecord[],
  selectedId: CustomThemeId | null | undefined,
  limit = SETTINGS_TILE_LIMIT,
): CustomThemeRecord[] {
  const max = Math.max(0, Math.floor(limit));
  if (!max) return [];
  const selected = selectedId ? themes.find((record) => record.id === selectedId) ?? null : null;
  const others = themes.filter((record) => record !== selected).sort(byRecentEdit);
  return (selected ? [selected, ...others] : others).slice(0, max);
}

/** Case-insensitive match on name and description; blank queries match everything. */
export function filterThemes(themes: readonly CustomThemeRecord[], query: string): CustomThemeRecord[] {
  const words = query.toLocaleLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [...themes];
  return themes.filter((record) => {
    const spec = headSpec(record);
    const haystack = `${spec.name} ${spec.description ?? ""}`.toLocaleLowerCase();
    return words.every((word) => haystack.includes(word));
  });
}

const collator = typeof Intl !== "undefined" ? new Intl.Collator(undefined, { sensitivity: "base", numeric: true }) : null;
const compareNames = (a: string, b: string) => (collator ? collator.compare(a, b) : a.localeCompare(b));

export function sortThemes(themes: readonly CustomThemeRecord[], sort: ThemeLibrarySort): CustomThemeRecord[] {
  const list = [...themes];
  if (sort === "name") return list.sort((a, b) => compareNames(headSpec(a).name, headSpec(b).name) || byRecentEdit(a, b));
  if (sort === "newest") return list.sort((a, b) => b.createdAt - a.createdAt || byRecentEdit(a, b));
  return list.sort(byRecentEdit);
}

/** What the library grid shows for a search and a sort. */
export function libraryView(themes: readonly CustomThemeRecord[], query: string, sort: ThemeLibrarySort): CustomThemeRecord[] {
  return sortThemes(filterThemes(themes, query), sort);
}

export function isThemeLibrarySort(value: unknown): value is ThemeLibrarySort {
  return value === "recent" || value === "name" || value === "newest";
}
