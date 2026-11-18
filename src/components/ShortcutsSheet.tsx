import { useEffect, useId, useRef, useState } from "react";
import { Search, X } from "lucide-react";
import { useModalFocus } from "../hooks/useModalFocus";
import { formatKeys, shortcutSearchText, SHORTCUTS, splitIntoColumns, type ShortcutDefinition } from "../lib/shortcuts";
import { matchesSearch, searchWords } from "../lib/searchMatch";
import { STUDIO_TAB_IDS, type StudioTab } from "../lib/studioTabs";

/** Rail names, kept here so the sheet does not load the Tools panel bundle. */
const TAB_NAMES: Record<StudioTab, string> = {
  changes: "Changes", git: "Git", checkpoints: "Checkpoints", worktrees: "Worktree", files: "Files",
  terminal: "Terminal", actions: "Actions", agents: "Sub-agents", usage: "Usage", skills: "Skills & MCP",
};

/** Fixed keys that belong to a surface rather than the app-level layer. */
const LOCAL_KEYS: Array<Pick<ShortcutDefinition, "keys" | "label" | "group" | "note" | "alias">> = [
  { keys: ["Enter"], label: "Send message", group: "Composer" },
  { keys: ["Shift", "Enter"], label: "New line", group: "Composer" },
  { keys: ["@"], label: "Mention a file or skill", group: "Composer" },
  { keys: ["↑↓"], label: "Move between sidebar threads", group: "Threads", note: "With a row focused · Home and End jump" },
  { keys: ["→"], label: "Move to the row's menu button", group: "Threads", note: "In the sidebar · ← goes back to the row" },
  { keys: ["Shift", "F10"], label: "Open the row's menu", group: "Threads", note: "In the sidebar · or the context-menu key" },
  { keys: ["Escape"], label: "Close what's open", group: "Tools", note: "Innermost menu or dialog first, then Tools" },
];

const GROUPS: ShortcutDefinition["group"][] = ["General", "Conversation", "Threads", "Composer", "Tools"];

type SheetRow = Pick<ShortcutDefinition, "keys" | "label" | "group" | "note" | "alias"> & { id?: ShortcutDefinition["id"] };

/** Rough rendered height of a group, in rows: a heading, one line per
 * shortcut, a second line for a note (a third when it wraps) and the tab
 * legend's lines. Only the ratio between groups matters. */
function groupWeight(rows: SheetRow[]): number {
  return rows.reduce((sum, row) => sum + 1
    + (row.note ? (row.note.length > 44 ? 1.1 : 0.55) : 0)
    + (row.id === "workspaceTab" ? 1.9 : 0), 0.9);
}

/** Read-only list of every shortcut, opened with ⌘/, the palette, the
 * "…" menu or Settings → General → Help. A filter narrows it with the same
 * word matching as the palette; whole groups are split into two columns of
 * near-equal height (`splitIntoColumns`) and the list
 * scrolls (with edge shadows) when the window is short. */
export function ShortcutsSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState("");
  const bodyId = useId();
  useModalFocus(dialogRef, open);
  useEffect(() => { if (!open) setQuery(""); }, [open]);
  if (!open) return null;
  const terms = searchWords(query);
  const rows: SheetRow[] = [...SHORTCUTS, ...LOCAL_KEYS].filter((row) => matchesSearch(shortcutSearchText(row), terms));
  const visibleGroups = GROUPS.filter((group) => rows.some((row) => row.group === group));
  // Whole groups go to whichever column keeps the two closest in height, so
  // the sheet never ends one column far below the other (O5).
  const columns = splitIntoColumns(visibleGroups, (group) => groupWeight(rows.filter((row) => row.group === group)));
  const renderGroup = (group: ShortcutDefinition["group"]) => (
    <section key={group} className="shortcuts-group" aria-labelledby={`shortcuts-${group}`}>
      <h3 id={`shortcuts-${group}`}>{group}</h3>
      <dl>
        {rows.filter((row) => row.group === group).map((row) => (
          <div className="shortcuts-row" key={row.label}>
            <dt>
              <span>{row.label}</span>
              {row.note && <small>{row.note}</small>}
              {"id" in row && row.id === "workspaceTab" && <small className="shortcuts-legend">
                {STUDIO_TAB_IDS.map((tab, index) => <span key={tab}><b>{index === 9 ? 0 : index + 1}</b> {TAB_NAMES[tab]}</span>)}
              </small>}
            </dt>
            <dd>
              <kbd>{formatKeys(row.keys)}</kbd>
              {row.alias && <><span className="shortcuts-or">or</span><kbd>{formatKeys(row.alias)}</kbd></>}
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
  return (
    <div className="modal-backdrop shortcuts-backdrop" onMouseDown={onClose}>
      <div
        ref={dialogRef}
        className="shortcuts-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby="shortcuts-sheet-title"
        onMouseDown={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key !== "Escape" || event.defaultPrevented) return;
          event.preventDefault();
          event.stopPropagation();
          // First Escape clears a filter; the next one closes.
          if (query) setQuery("");
          else onClose();
        }}
      >
        <header className="shortcuts-sheet-head">
          <h2 id="shortcuts-sheet-title">Keyboard shortcuts</h2>
          <label className="shortcuts-filter">
            <Search size={13} aria-hidden="true" />
            <input
              type="search"
              data-autofocus
              value={query}
              placeholder="Filter shortcuts"
              aria-label="Filter shortcuts"
              aria-controls={bodyId}
              spellCheck={false}
              autoComplete="off"
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
          <button className="icon-button" onClick={onClose} aria-label="Close keyboard shortcuts">
            <X size={15} />
          </button>
        </header>
        <span className="sr-only" role="status">{query ? `${rows.length} ${rows.length === 1 ? "shortcut" : "shortcuts"} match` : ""}</span>
        <div className="shortcuts-sheet-body" id={bodyId} tabIndex={0} role="region" aria-label="Shortcut list">
          {!visibleGroups.length && <p className="shortcuts-empty">No shortcuts match “{query.trim()}”.</p>}
          {columns.map((column, index) => column.length > 0 && (
            <div key={index} className="shortcuts-column">{column.map(renderGroup)}</div>
          ))}
        </div>
      </div>
    </div>
  );
}
