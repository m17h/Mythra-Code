import { useEffect, useRef, useState, type ReactNode } from "react";
import { MoreHorizontal } from "lucide-react";

export interface RowMenuItem {
  label: string;
  icon?: ReactNode;
  danger?: boolean;
  onSelect: () => void;
}

/**
 * Single overflow menu replacing the per-row strips of hover icons. The list
 * is rendered position:fixed so it escapes the scrollable sidebar without
 * being clipped; it closes on outside click, Escape, or any scroll.
 * `scale` compensates for the app-level `zoom` (UI size setting), which skews
 * getBoundingClientRect coordinates relative to fixed-position layout.
 */
/** `items` may be a function so long lists (the thread inbox) build their
 * menus only when one is opened, not on every render. */
export function RowMenu({ label, items, scale = 1 }: { label: string; items: RowMenuItem[] | (() => RowMenuItem[]); scale?: number }) {
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const open = position !== null;

  useEffect(() => {
    if (!open) return;
    const close = () => setPosition(null);
    const onPointerDown = (event: PointerEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) close();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        close();
      }
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown, true);
    document.addEventListener("scroll", close, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown, true);
      document.removeEventListener("scroll", close, true);
    };
  }, [open]);

  return (
    <div className={`row-menu ${open ? "open" : ""}`} ref={containerRef}>
      <button
        className="row-menu-trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={label}
        onMouseDown={(event) => event.preventDefault()}
        onClick={(event) => {
          if (open) {
            setPosition(null);
            return;
          }
          const rect = event.currentTarget.getBoundingClientRect();
          setPosition({ top: (rect.bottom + 4) / scale, left: rect.right / scale });
        }}
      >
        <MoreHorizontal size={14} />
      </button>
      {open && (
        <div className="row-menu-list" role="menu" aria-label={label} style={{ top: position.top, left: position.left }}>
          {(typeof items === "function" ? items() : items).map((item) => (
            <button
              key={item.label}
              role="menuitem"
              className={item.danger ? "danger" : ""}
              onClick={() => {
                setPosition(null);
                item.onSelect();
              }}
            >
              {item.icon}
              <span>{item.label}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
