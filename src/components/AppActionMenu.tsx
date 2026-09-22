import "./git-workflow.css";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { ChevronDown, Ellipsis } from "lucide-react";

export interface AppActionMenuItem {
  id: string;
  label: string;
  /** One short line under the label, for actions whose effect is not obvious. */
  description?: string;
  icon?: ReactNode;
  danger?: boolean;
  disabled?: boolean;
  /** Hover/focus explanation — the reason, when the item is disabled. */
  title?: string;
  onSelect: () => void;
}

/**
 * A Mythra Code-owned menu of *actions*.
 *
 * `AppSelectMenu` next door chooses one value out of a list and reports it
 * back; this one runs something. They are deliberately separate components:
 * a radio group and a command list have different roles, different keyboard
 * contracts, and conflating them produced menus that announced a "selected"
 * action that was merely the last one used.
 *
 * Native `<select>` and OS context menus are not an option anywhere in this
 * app — they hand the popup to macOS and break the shell's palettes, motion
 * and container-query sizing.
 */
export function AppActionMenu({
  label = "More",
  ariaLabel,
  items,
  disabled = false,
  compact = false,
  align = "end",
}: {
  label?: string;
  ariaLabel?: string;
  items: AppActionMenuItem[];
  disabled?: boolean;
  /** Icon-only trigger, for rows that are already dense. */
  compact?: boolean;
  align?: "start" | "end";
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);

  const close = (returnFocus: boolean) => {
    setOpen(false);
    if (returnFocus) triggerRef.current?.focus();
  };

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      close(true);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown, true);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    // The first item that can actually be run takes focus, so a keyboard user
    // never lands on a disabled row and has to guess why nothing happens.
    const frame = requestAnimationFrame(() => {
      itemRefs.current.find((item) => item?.isConnected && !item.disabled)?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [open]);

  const moveFocus = (current: HTMLButtonElement, direction: number) => {
    const connected = itemRefs.current.filter(
      (item): item is HTMLButtonElement => Boolean(item?.isConnected && !item.disabled),
    );
    if (!connected.length) return;
    const index = connected.indexOf(current);
    connected[(index + direction + connected.length) % connected.length]?.focus();
  };

  if (!items.length) return null;

  return (
    <div className={`app-action-menu ${open ? "open" : ""} ${align === "start" ? "align-start" : ""}`} ref={rootRef} onBlur={(event) => { if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget as Node)) setOpen(false); }}>
      <button
        ref={triggerRef}
        type="button"
        className={`app-action-trigger ${compact ? "compact" : ""}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={ariaLabel ?? label}
        disabled={disabled}
        onClick={() => setOpen((current) => !current)}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            setOpen(true);
          }
        }}
      >
        {compact ? <Ellipsis size={13} aria-hidden="true" /> : <>{label}<ChevronDown size={12} aria-hidden="true" /></>}
      </button>

      {open && (
        <div className="app-action-list" role="menu" aria-label={ariaLabel ?? label}>
          {items.map((item, index) => (
            <button
              key={item.id}
              ref={(node) => { itemRefs.current[index] = node; }}
              type="button"
              role="menuitem"
              className={item.danger ? "danger-action" : ""}
              disabled={item.disabled}
              title={item.title}
              onKeyDown={(event) => {
                if (event.key === "ArrowDown") { event.preventDefault(); moveFocus(event.currentTarget, 1); }
                if (event.key === "ArrowUp") { event.preventDefault(); moveFocus(event.currentTarget, -1); }
                if (event.key === "Home" || event.key === "End") {
                  event.preventDefault();
                  const enabledItems = itemRefs.current.filter((node) => node?.isConnected && !node.disabled);
                  (event.key === "Home" ? enabledItems[0] : enabledItems.at(-1))?.focus();
                }
              }}
              onClick={() => {
                if (item.disabled) return;
                // Closed before the action runs: several of these open a
                // confirmation dialog, and a menu still hanging over it is
                // both ugly and a way to double-fire the same command.
                close(true);
                item.onSelect();
              }}
            >
              {item.icon}
              <span>
                <strong>{item.label}</strong>
                {item.description && <small>{item.description}</small>}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
