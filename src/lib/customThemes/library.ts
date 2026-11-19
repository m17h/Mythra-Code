// Pure helpers behind the Theme library window: its search filter and its
// sort orders. No React, no storage; the components pass the store's records in.

import { headSpec, type CustomThemeRecord } from "./store";

export type ThemeLibrarySort = "recent" | "name" | "newest";

export const THEME_LIBRARY_SORTS: ReadonlyArray<{ value: ThemeLibrarySort; label: string }> = [
  { value: "recent", label: "Recently edited" },
  { value: "name", label: "Name A–Z" },
  { value: "newest", label: "Newest first" },
];

const byRecentEdit = (a: CustomThemeRecord, b: CustomThemeRecord) => b.updatedAt - a.updatedAt || b.createdAt - a.createdAt || a.id.localeCompare(b.id);

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
