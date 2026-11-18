/**
 * Shedding ladder for the top bar (B06). Each level hides one more piece of
 * secondary chrome; stage.css keys off `.topbar[data-shed~="N"]` (the
 * attribute lists every level reached, so the selectors are cumulative).
 * Status words are never hidden. The last level only swaps long status words
 * for their short form ("Setup needed" → "Set up").
 */
export const TOPBAR_SHED = [
  "full",
  "key hints",
  "usage window name",
  "empty Pull requests chip (moves to the … menu)",
  "Search label",
  // M03 (round 6): the quota chip never drops its "left"/"used" word; once
  // its window name is gone, the next step moves the whole chip (figure and
  // meaning together) into the … menu.
  "idle usage chip (moves to the … menu)",
  "unset Run label",
  "Tools label",
  "Run label",
  "PR prefix, short status words, sign-in usage chip (moves to the … menu)",
] as const;
export const TOPBAR_SHED_MAX = TOPBAR_SHED.length - 1;
/** Level at which the empty Pull requests chip leaves the bar. */
export const TOPBAR_SHED_PULL_REQUESTS = 3;
/** Level at which the idle usage chip leaves the bar. */
export const TOPBAR_SHED_USAGE = 5;
/** Level at which status words take their short form. */
export const TOPBAR_SHED_SHORT_STATUS = 9;

/** The thread title gets this much room before chrome is allowed to stay. */
export const TOPBAR_TITLE_ROOM = 200;

export type TopbarMeasure = {
  barClient: number;
  barScroll: number;
  headingClient: number;
  /** Untruncated width of the widest heading line (project name or thread title). */
  headingNatural: number;
};

/** True when the bar fits at the current level. */
export function topbarShedTarget(m: TopbarMeasure): boolean {
  if (m.barScroll > m.barClient + 1) return false;
  const want = Math.min(m.headingNatural, TOPBAR_TITLE_ROOM);
  return m.headingClient + 1 >= want;
}

export type TopbarStatusKind = "ready" | "working" | "approval" | "setup" | "unknown" | "other";

/** Visible status word: never empty, short form only at the last shed level. */
export function topbarStatusLabel(kind: TopbarStatusKind, word: string, short: boolean): string {
  if (!short) return word;
  if (kind === "setup") return "Set up";
  if (kind === "unknown") return "Unknown";
  return word;
}
