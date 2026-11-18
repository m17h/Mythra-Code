/**
 * Word matching shared by the command palette and the shortcuts sheet.
 * Words are matched independently so punctuation ("Git: Changes") and word
 * order ("git branch") don't hide otherwise matching entries.
 */
export function searchWords(value: string): string[] {
  return value.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}

/** True when every typed term is a substring of some word in `text`. */
export function matchesSearch(text: string, terms: readonly string[]): boolean {
  if (!terms.length) return true;
  const words = searchWords(text);
  return terms.every((term) => words.some((word) => word.includes(term)));
}

/**
 * How closely a result's own name answers the query: 0 = the name is the
 * query, 1 = the name starts with it, 2 = every term is in the name,
 * 3 = matched only through detail or keywords.
 */
export function labelMatchRank(label: string, terms: readonly string[]): number {
  const words = searchWords(label);
  const typed = terms.join(" ");
  if (!typed) return 3;
  if (words.join(" ") === typed || [...words].sort().join(" ") === [...terms].sort().join(" ")) return 0;
  if (words.join(" ").startsWith(typed)) return 1;
  if (terms.every((term) => words.some((word) => word.includes(term)))) return 2;
  return 3;
}

export type RankedResult<T> = { item: T; rank: number; kind: "pane" | "row" };

/**
 * Settings search order (M10): a setting whose own name answers the query
 * comes before the pane that merely contains it; within a rank, panes lead,
 * then rows in index order. A row that just repeats its pane's name is
 * dropped when that pane is already listed.
 */
export function orderSettingsResults<P extends { label: string }, R extends { label: string; paneLabel: string }>(
  panes: readonly P[],
  rows: readonly R[],
  terms: readonly string[],
): Array<RankedResult<P> | RankedResult<R>> {
  const paneLabels = new Set(panes.map((pane) => pane.label.toLowerCase()));
  const ranked: Array<RankedResult<P> | RankedResult<R>> = [
    ...panes.map((item) => ({ item, rank: labelMatchRank(item.label, terms), kind: "pane" as const })),
    ...rows
      .filter((row) => !(row.label.toLowerCase() === row.paneLabel.toLowerCase() && paneLabels.has(row.paneLabel.toLowerCase())))
      .map((item) => ({ item, rank: labelMatchRank(item.label, terms), kind: "row" as const })),
  ];
  return ranked
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => a.entry.rank - b.entry.rank || (a.entry.kind === b.entry.kind ? 0 : a.entry.kind === "pane" ? -1 : 1) || a.index - b.index)
    .map(({ entry }) => entry);
}
