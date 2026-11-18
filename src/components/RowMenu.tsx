import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { MoreHorizontal } from "lucide-react";
import { useMenuKeyboard } from "../hooks/useMenuKeyboard";

export interface RowMenuItem {
  label: string;
  icon?: ReactNode;
  danger?: boolean;
  /** Says why it can't be used. The row stays in the menu. */
  disabledReason?: string;
  /** Formatted key hint shown at the end of the row. */
  shortcut?: string;
  /** Draws a hairline above this item to start a new group. */
  separatorBefore?: boolean;
  onSelect: () => void;
}

/**
 * Single overflow menu replacing the per-row strips of hover icons. The list
 * is rendered position:fixed so it escapes the scrollable sidebar without
 * being clipped; it closes on outside click, Escape, or when the list it
 * belongs to scrolls.
 * `scale` compensates for the app-level `zoom` (UI size setting), which skews
 * getBoundingClientRect coordinates relative to fixed-position layout.
 *
 * Keyboard (the shared contract in useMenuKeyboard): ↓/↑/Enter/Space on the
 * trigger open it with focus on the first (or last) item; ↑/↓ wrap,
 * Home/End jump, typing a letter jumps to the matching item; Escape, Tab or
 * choosing an item returns focus to the trigger, so keyboard users never land
 * on <body>. Unavailable items stay focusable and announce why.
 */
/** `items` may be a function so long lists (the thread inbox) build their
 * menus only when one is opened, not on every render. */
export function RowMenu({ label, items, scale = 1, icon, title }: { label: string; items: RowMenuItem[] | (() => RowMenuItem[]); scale?: number; /** Replaces the "…" glyph when the menu has a more specific job. */ icon?: ReactNode; title?: string }) {
  const [position, setPosition] = useState<{ top: number; left: number; focus: "first" | "last" | null } | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const open = position !== null;

  const reasonId = useId();
  const enabledItems = () => Array.from(listRef.current?.querySelectorAll<HTMLButtonElement>("[role='menuitem']") ?? []);
  const setOpen = useCallback((next: boolean) => { if (!next) setPosition(null); }, []);
  // Opening stays position-based (openAt); the hook owns Escape, Tab,
  // arrows, Home/End and type-ahead inside the list.
  const keys = useMenuKeyboard({ open, setOpen, menuRef: listRef, triggerRef, focusOnOpen: false });
  const close = keys.close;

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) setPosition(null);
    };
    // A scroll inside the menu, or of something unrelated, keeps it open; only
    // the list that holds the trigger moving it away closes the menu.
    const onScroll = (event: Event) => {
      const target = event.target;
      if (target instanceof Node && listRef.current?.contains(target)) return;
      if (target instanceof Node && !(target === document || target.contains(triggerRef.current))) return;
      setPosition(null);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("scroll", onScroll, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("scroll", onScroll, true);
    };
  }, [open]);

  useEffect(() => {
    if (!position?.focus) return;
    const options = enabledItems();
    (position.focus === "last" ? options[options.length - 1] : options[0])?.focus();
  }, [position]);

  const openAt = (focus: "first" | "last" | null) => {
    const rect = triggerRef.current?.getBoundingClientRect();
    if (!rect) return;
    setPosition({ top: (rect.bottom + 4) / scale, left: rect.right / scale, focus });
  };

  const list = open ? (typeof items === "function" ? items() : items) : [];
  return (
    <div className={`row-menu ${open ? "open" : ""}`} ref={containerRef}>
      <button
        ref={triggerRef}
        className="row-menu-trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={label}
        title={title}
        onMouseDown={(event) => event.preventDefault()}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            event.stopPropagation();
            openAt(event.key === "ArrowUp" ? "last" : "first");
          }
        }}
        onClick={(event) => {
          if (open) {
            setPosition(null);
            return;
          }
          // detail is 0 for Enter/Space: move focus into the menu for keyboards.
          openAt(event.detail === 0 ? "first" : null);
        }}
      >
        {icon ?? <MoreHorizontal size={14} />}
      </button>
      {position && (
        <div
          ref={listRef}
          className="row-menu-list"
          role="menu"
          aria-label={label}
          style={{ top: position.top, left: position.left }}
          onKeyDown={(event) => {
            // The sidebar list's own arrow-key navigation must not see these.
            if (event.key.startsWith("Arrow") || event.key === "Home" || event.key === "End") event.stopPropagation();
            keys.onMenuKeyDown(event);
          }}
        >
          {list.map((item, index) => (
            <button
              key={item.label}
              role="menuitem"
              tabIndex={-1}
              className={[item.danger ? "danger" : "", item.separatorBefore ? "separated" : ""].filter(Boolean).join(" ")}
              aria-disabled={item.disabledReason ? true : undefined}
              aria-describedby={item.disabledReason ? `${reasonId}-${index}` : undefined}
              title={item.disabledReason}
              onClick={() => {
                if (item.disabledReason) return;
                close(true);
                item.onSelect();
              }}
            >
              {item.icon}
              <span>{item.label}</span>
              {item.shortcut && <kbd>{item.shortcut}</kbd>}
              {item.disabledReason && <span id={`${reasonId}-${index}`} className="sr-only">{item.disabledReason}</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
