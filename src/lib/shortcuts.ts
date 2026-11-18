import { isMacPlatform } from "./platform";

/**
 * Every app-level keyboard shortcut, written once. The keyboard layer
 * (`useAppShortcuts`), the command palette, tooltips and the shortcuts sheet
 * all read this list, so a hint can never advertise a key that doesn't work.
 *
 * `keys` uses a portable notation: "Mod" is ⌘ on macOS and Ctrl elsewhere,
 * "Alt" is ⌥ / Alt, "Shift" is ⇧ / Shift, "Ctrl" is the real Control key on
 * every platform.
 */
export type ShortcutId =
  | "palette"
  | "newThread"
  | "stop"
  | "toggleSidebar"
  | "toggleWorkspace"
  | "focusComposer"
  | "modelPicker"
  | "previousThread"
  | "nextThread"
  | "searchConversation"
  | "searchNext"
  | "settings"
  | "shortcuts"
  | "workspaceTab"
  | "focusApproval";

export interface ShortcutDefinition {
  id: ShortcutId;
  keys: string[];
  label: string;
  group: "General" | "Threads" | "Conversation" | "Composer" | "Tools";
  /** Shown in the sheet when a shortcut only works in some places. */
  note?: string;
  /** A second chord that does the same thing. */
  alias?: string[];
}

export const SHORTCUTS: readonly ShortcutDefinition[] = [
  { id: "palette", keys: ["Mod", "K"], label: "Command palette", group: "General" },
  { id: "shortcuts", keys: ["Mod", "/"], label: "Keyboard shortcuts", group: "General" },
  { id: "settings", keys: ["Mod", ","], label: "Settings", group: "General" },
  { id: "toggleSidebar", keys: ["Mod", "\\"], label: "Show or hide the sidebar", group: "General" },
  { id: "newThread", keys: ["Mod", "N"], label: "New thread", group: "Threads" },
  { id: "previousThread", keys: ["Mod", "Shift", "["], label: "Previous thread", group: "Threads", note: "In this project or Chats, in sidebar order" },
  { id: "nextThread", keys: ["Mod", "Shift", "]"], label: "Next thread", group: "Threads", note: "In this project or Chats, in sidebar order" },
  { id: "searchConversation", keys: ["Mod", "F"], label: "Search in conversation", group: "Conversation", note: "With a thread open" },
  { id: "searchNext", keys: ["Mod", "G"], label: "Next search match", group: "Conversation", note: "While searching · Shift goes back" },
  { id: "focusApproval", keys: ["Mod", "Shift", "A"], label: "Go to the approval request", group: "Conversation", note: "Moves focus to the request; never answers it" },
  { id: "focusComposer", keys: ["Mod", "L"], label: "Focus the message box", group: "Composer" },
  { id: "stop", keys: ["Mod", "."], label: "Stop the running task", group: "Composer", note: "Works while typing" },
  { id: "modelPicker", keys: ["Mod", "Shift", "M"], label: "Choose model", group: "Composer" },
  { id: "toggleWorkspace", keys: ["Mod", "B"], label: "Show or hide Tools", group: "Tools", alias: ["Mod", "Alt", "B"] },
  { id: "workspaceTab", keys: ["Mod", "Alt", "1…0"], label: "Open a Tools tab", group: "Tools", note: "With a project open, in rail order:" },
];

const MAC_SYMBOLS: Record<string, string> = { Mod: "⌘", Alt: "⌥", Shift: "⇧", Ctrl: "⌃", Enter: "↩", Escape: "Esc" };
const OTHER_NAMES: Record<string, string> = { Mod: "Ctrl", Alt: "Alt", Shift: "Shift", Ctrl: "Ctrl", Enter: "Enter", Escape: "Esc" };

/**
 * macOS writes chords as one glyph run in the system order (⌃⌥⇧⌘K);
 * Windows and Linux spell them out with plus signs (Ctrl+Shift+K).
 */
export function formatKeys(keys: readonly string[], platform?: string): string {
  if (isMacPlatform(platform)) {
    const order = ["Ctrl", "Alt", "Shift", "Mod"];
    const modifiers = order.filter((key) => keys.includes(key)).map((key) => MAC_SYMBOLS[key]);
    const rest = keys.filter((key) => !order.includes(key)).map((key) => MAC_SYMBOLS[key] ?? key);
    return [...modifiers, ...rest].join("");
  }
  // Windows lists Ctrl first, then Shift, then Alt.
  const order = ["Mod", "Ctrl", "Shift", "Alt"];
  const seen = new Set<string>();
  const modifiers = order.filter((key) => keys.includes(key)).map((key) => OTHER_NAMES[key]).filter((name) => !seen.has(name) && seen.add(name));
  const rest = keys.filter((key) => !order.includes(key)).map((key) => OTHER_NAMES[key] ?? key);
  return [...modifiers, ...rest].join("+");
}

const KEY_SEARCH_NAMES: Record<string, string> = {
  Mod: "cmd command ctrl control", Alt: "alt option opt", Shift: "shift", Ctrl: "ctrl control",
  Enter: "enter return", Escape: "esc escape", "\\": "backslash", "/": "slash", ".": "period dot", ",": "comma",
  "[": "bracket", "]": "bracket", "↑↓": "up down arrows", "→": "right arrow", "@": "at mention",
};

/** Text a shortcuts-sheet filter matches against: label, note, group and key names. */
export function shortcutSearchText(row: Pick<ShortcutDefinition, "keys" | "label" | "group" | "note" | "alias">): string {
  const keys = [...row.keys, ...(row.alias ?? [])];
  return [row.label, row.note ?? "", row.group, ...keys.map((key) => `${key} ${KEY_SEARCH_NAMES[key] ?? ""}`)].join(" ");
}

/**
 * Splits whole groups into two columns of near-equal height. Groups never
 * break across columns, so CSS multi-column "balance" can leave one column
 * far longer than the other (round 4: the left column ran past the fold
 * while the right ended early). This tries every assignment (five groups,
 * 16 choices) and keeps the one whose taller column is shortest; the first
 * group always opens the first column, and each column keeps the input order.
 * On a tie the first column is the taller one, so the eye ends on the right.
 */
export function splitIntoColumns<T>(items: readonly T[], weight: (item: T) => number): [T[], T[]] {
  if (items.length < 2) return [[...items], []];
  const weights = items.map(weight);
  const total = weights.reduce((sum, value) => sum + value, 0);
  let bestMask = 1;
  let bestTaller = Infinity;
  let bestLeft = -Infinity;
  const limit = 1 << items.length;
  for (let mask = 1; mask < limit; mask += 2) {
    if (mask === limit - 1) continue;
    let left = 0;
    for (let index = 0; index < items.length; index++) if (mask & (1 << index)) left += weights[index];
    const taller = Math.max(left, total - left);
    if (taller < bestTaller - 1e-9 || (Math.abs(taller - bestTaller) <= 1e-9 && left > bestLeft)) {
      bestMask = mask;
      bestTaller = taller;
      bestLeft = left;
    }
  }
  const first: T[] = [];
  const second: T[] = [];
  items.forEach((item, index) => (bestMask & (1 << index) ? first : second).push(item));
  return [first, second];
}

export function formatShortcut(id: ShortcutId, platform?: string): string {
  const definition = SHORTCUTS.find((shortcut) => shortcut.id === id);
  return definition ? formatKeys(definition.keys, platform) : "";
}

/** "Stop (⌘.)" style tooltip text. */
export function withShortcut(label: string, id: ShortcutId, platform?: string): string {
  const keys = formatShortcut(id, platform);
  return keys ? `${label} (${keys})` : label;
}

/**
 * Events other packages can listen to. The keyboard layer only announces the
 * request; the control that owns the picker decides how to open it.
 */
/** ⌥⌘1 … ⌥⌘0 for the n-th Tools tab (1-based, 10 = 0). */
export function workspaceTabShortcut(position: number, platform?: string): string {
  if (position < 1 || position > 10) return "";
  return formatKeys(["Mod", "Alt", position === 10 ? "0" : String(position)], platform);
}

export const OPEN_MODEL_PICKER_EVENT = "mythra:open-model-picker";
export const FOCUS_COMPOSER_EVENT = "mythra:focus-composer";
/** Asks the visible approval card to take keyboard focus. Focus only: no
 * shortcut ever answers a request. */
export const FOCUS_APPROVAL_EVENT = "mythra:focus-approval";
