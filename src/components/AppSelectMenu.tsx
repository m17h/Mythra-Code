import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Check, ChevronDown, Search } from "lucide-react";

export interface AppSelectOption {
  value: string;
  label: string;
  detail?: string;
  keywords?: string;
  icon?: ReactNode;
}

/**
 * Mythra Code-owned single-choice menu for compact forms.
 *
 * Native HTML selects hand their popup to macOS, which makes the sub-agent
 * editor look and behave differently from the model menus in the composer.
 * This component keeps the popup inside the app, supports keyboard navigation,
 * and adds search when a provider exposes a large live model catalog.
 */
export function AppSelectMenu({
  value,
  options,
  ariaLabel,
  placeholder = "Choose an option",
  searchable = false,
  menuPlacement = "bottom",
  emptyMessage = "No options available",
  onChange,
}: {
  value: string;
  options: AppSelectOption[];
  ariaLabel: string;
  placeholder?: string;
  searchable?: boolean;
  menuPlacement?: "top" | "bottom";
  emptyMessage?: string;
  onChange: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const selected = options.find((option) => option.value === value);
  const normalizedQuery = query.trim().toLowerCase();
  const filtered = useMemo(() => {
    const matches = !normalizedQuery ? options : options.filter((option) => (
      `${option.label} ${option.detail ?? ""} ${option.value} ${option.keywords ?? ""}`
        .toLowerCase()
        .includes(normalizedQuery)
    ));
    // Live routing catalogs can contain hundreds of entries. Search still
    // covers the entire catalog, while the open menu stays cheap to render.
    return matches.slice(0, 80);
  }, [normalizedQuery, options]);

  const close = () => {
    setOpen(false);
    setQuery("");
  };

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) close();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      close();
      triggerRef.current?.focus();
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
    requestAnimationFrame(() => {
      if (searchable) {
        searchRef.current?.focus();
        return;
      }
      const selectedIndex = Math.max(0, filtered.findIndex((option) => option.value === value));
      optionRefs.current[selectedIndex]?.focus();
    });
  }, [filtered, open, searchable, value]);

  const moveFocus = (current: HTMLButtonElement, direction: number) => {
    const connected = optionRefs.current.filter((item): item is HTMLButtonElement => Boolean(item?.isConnected));
    if (!connected.length) return;
    const index = connected.indexOf(current);
    connected[(index + direction + connected.length) % connected.length]?.focus();
  };

  return (
    <div className={`app-select ${open ? "open" : ""} ${menuPlacement === "top" ? "opens-up" : ""}`} ref={rootRef} data-app-select-open={open || undefined}>
      <button
        ref={triggerRef}
        type="button"
        className="app-select-trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={ariaLabel}
        onClick={() => setOpen((current) => !current)}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            setOpen(true);
          }
        }}
      >
        <span className="app-select-value">
          {selected?.icon}
          <span>
            <strong>{selected?.label ?? placeholder}</strong>
            {selected?.detail && <small>{selected.detail}</small>}
          </span>
        </span>
        <ChevronDown size={12} aria-hidden="true" />
      </button>

      {open && (
        <div className="app-select-menu">
          {searchable && (
            <label className="app-select-search">
              <Search size={12} aria-hidden="true" />
              <input
                ref={searchRef}
                aria-label={`Search ${ariaLabel}`}
                value={query}
                placeholder="Search models…"
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "ArrowDown") {
                    event.preventDefault();
                    optionRefs.current.find((item) => item?.isConnected)?.focus();
                  }
                }}
              />
            </label>
          )}
          <div className="app-select-options" role="menu" aria-label={`${ariaLabel} choices`}>
            {filtered.map((option, index) => (
              <button
                ref={(node) => { optionRefs.current[index] = node; }}
                type="button"
                role="menuitemradio"
                aria-checked={option.value === value}
                className={option.value === value ? "selected" : ""}
                key={option.value}
                onKeyDown={(event) => {
                  if (event.key === "ArrowDown") { event.preventDefault(); moveFocus(event.currentTarget, 1); }
                  if (event.key === "ArrowUp") { event.preventDefault(); moveFocus(event.currentTarget, -1); }
                }}
                onClick={() => {
                  onChange(option.value);
                  close();
                  triggerRef.current?.focus();
                }}
              >
                <span className="app-select-option-copy">
                  {option.icon}
                  <span><strong>{option.label}</strong>{option.detail && <small>{option.detail}</small>}</span>
                </span>
                {option.value === value && <Check size={12} aria-hidden="true" />}
              </button>
            ))}
            {filtered.length === 0 && <p className="app-select-empty">{emptyMessage}</p>}
          </div>
        </div>
      )}
    </div>
  );
}
