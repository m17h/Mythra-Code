import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { Check, ChevronDown, Search } from "lucide-react";
import { ModelFavoriteStar } from "./ModelFavoriteStar";
import { favoriteCount, sortByFavorites } from "../lib/modelFavorites";

/** Options rendered before the menu offers to reveal the rest of a long list. */
const BROWSE_LIMIT = 80;
const POPOVER_VIEWPORT_MARGIN = 8;
const POPOVER_GAP = 4;
const POPOVER_WIDTH = 320;

export interface AppSelectOption {
  value: string;
  label: string;
  detail?: string;
  keywords?: string;
  icon?: ReactNode;
  /** Visible but unavailable choices, such as models that need a CLI update. */
  disabled?: boolean;
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
  selectedDisplay,
  ariaLabel,
  placeholder = "Choose an option",
  searchable = false,
  menuPlacement = "bottom",
  portal = false,
  emptyMessage = "No options available",
  favorites = [],
  onToggleFavorite,
  onSearch,
  onChange,
}: {
  value: string;
  options: AppSelectOption[];
  /** Closed-trigger copy for a saved value intentionally omitted from the menu. */
  selectedDisplay?: Omit<AppSelectOption, "value">;
  ariaLabel: string;
  placeholder?: string;
  searchable?: boolean;
  menuPlacement?: "top" | "bottom";
  /** Render above clipping/scroll containers and track the trigger in viewport space. */
  portal?: boolean;
  emptyMessage?: string;
  /** Starred option values, floated to the top of the list. */
  favorites?: string[];
  /** Renders a star beside each option when supplied. */
  onToggleFavorite?: (value: string) => void;
  /**
   * Lets the owner resolve a provider-specific identifier typed into search.
   * The normal option search remains exhaustive and local.
   */
  onSearch?: (query: string) => void;
  onChange: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [showAll, setShowAll] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const menuRef = useRef<HTMLDivElement>(null);
  const [popoverStyle, setPopoverStyle] = useState<CSSProperties>({});
  const selected = options.find((option) => option.value === value)
    ?? (value && selectedDisplay ? { value, ...selectedDisplay } : undefined);
  const normalizedQuery = query.trim().toLowerCase();
  const ordered = useMemo(
    () => sortByFavorites(options, favorites, (option) => option.value),
    [favorites, options],
  );
  // A search is never truncated: a cut-off result list is indistinguishable
  // from an option the catalog does not have. Token matching lets a query like
  // "anthropic sonnet" reach `anthropic/claude-sonnet-5`.
  const filtered = useMemo(() => {
    if (!normalizedQuery) return ordered;
    const tokens = normalizedQuery.split(/\s+/).filter(Boolean);
    return ordered.filter((option) => {
      const haystack = `${option.label} ${option.detail ?? ""} ${option.value} ${option.keywords ?? ""}`.toLowerCase();
      return tokens.every((token) => haystack.includes(token));
    });
  }, [normalizedQuery, ordered]);
  // Idle browsing of a several-hundred-entry routing catalog is capped for
  // render cost only; the row below discloses and reveals the remainder.
  const visible = normalizedQuery || showAll ? filtered : filtered.slice(0, BROWSE_LIMIT);
  const hidden = filtered.length - visible.length;
  const starredVisible = favoriteCount(visible, favorites, (option) => option.value);
  const topLayer = portal && !!HTMLElement.prototype.showPopover;

  const close = () => {
    setOpen(false);
    setQuery("");
    setShowAll(false);
    setPopoverStyle({});
  };

  const positionPopover = useCallback(() => {
    if (!open || !topLayer) return;
    const trigger = triggerRef.current;
    const menu = menuRef.current;
    if (!trigger || !menu) return;

    const triggerRect = trigger.getBoundingClientRect();
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    const maxWidth = Math.max(1, viewportWidth - POPOVER_VIEWPORT_MARGIN * 2);
    const width = Math.min(POPOVER_WIDTH, maxWidth);
    const height = menu.offsetHeight;
    const above = triggerRect.top - POPOVER_GAP - height;
    const below = triggerRect.bottom + POPOVER_GAP;
    const openAbove = menuPlacement === "top"
      ? above >= POPOVER_VIEWPORT_MARGIN || below + height > viewportHeight - POPOVER_VIEWPORT_MARGIN
      : below + height > viewportHeight - POPOVER_VIEWPORT_MARGIN && above >= POPOVER_VIEWPORT_MARGIN;
    const preferredTop = openAbove ? above : below;
    const maxTop = Math.max(POPOVER_VIEWPORT_MARGIN, viewportHeight - height - POPOVER_VIEWPORT_MARGIN);
    const top = Math.min(Math.max(preferredTop, POPOVER_VIEWPORT_MARGIN), maxTop);
    const left = Math.max(
      POPOVER_VIEWPORT_MARGIN,
      Math.min(triggerRect.left, viewportWidth - width - POPOVER_VIEWPORT_MARGIN),
    );
    setPopoverStyle({ top, left, width, visibility: "visible" });
  }, [open, topLayer, menuPlacement]);

  const setMenuRef = useCallback((node: HTMLDivElement | null) => {
    menuRef.current = node;
    if (node && topLayer) node.showPopover?.();
  }, [topLayer]);

  useEffect(() => {
    if (!open || !topLayer) return;
    positionPopover();
    const onViewportChange = () => positionPopover();
    window.addEventListener("resize", onViewportChange);
    window.addEventListener("scroll", onViewportChange, true);
    const resizeObserver = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(positionPopover);
    const menu = menuRef.current;
    if (menu) resizeObserver?.observe(menu);
    return () => {
      window.removeEventListener("resize", onViewportChange);
      window.removeEventListener("scroll", onViewportChange, true);
      resizeObserver?.disconnect();
    };
  }, [open, topLayer, menuPlacement, normalizedQuery, searchable, value, visible.length, positionPopover]);

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
      const selectedIndex = visible.findIndex((option) => option.value === value && !option.disabled);
      const selectedButton = selectedIndex >= 0 ? optionRefs.current[selectedIndex] : null;
      const firstEnabled = optionRefs.current.find((item) => item?.isConnected && !item.disabled);
      (selectedButton?.isConnected && !selectedButton.disabled ? selectedButton : firstEnabled)?.focus();
    });
  }, [open, searchable, value, visible]);

  useEffect(() => {
    if (!open || !onSearch || !normalizedQuery) return;
    const timer = window.setTimeout(() => onSearch(query.trim()), 320);
    return () => window.clearTimeout(timer);
  }, [normalizedQuery, onSearch, open, query]);

  const moveFocus = (current: HTMLButtonElement, direction: number) => {
    const connected = optionRefs.current.filter((item): item is HTMLButtonElement => Boolean(item?.isConnected && !item.disabled));
    if (!connected.length) return;
    const index = connected.indexOf(current);
    connected[(index + direction + connected.length) % connected.length]?.focus();
  };

  const menu = open ? (
    <div
      ref={setMenuRef}
      className="app-select-menu"
      popover={topLayer ? "manual" : undefined}
      style={topLayer ? {
        position: "fixed",
        inset: "auto",
        width: `min(${POPOVER_WIDTH}px, calc(100vw - ${POPOVER_VIEWPORT_MARGIN * 2}px))`,
        right: "auto",
        bottom: "auto",
        margin: 0,
        visibility: "hidden",
        ...popoverStyle,
      } : undefined}
    >
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
                optionRefs.current.find((item) => item?.isConnected && !item.disabled)?.focus();
              }
            }}
          />
        </label>
      )}
      <div className="app-select-options" role="menu" aria-label={`${ariaLabel} choices`}>
        {visible.map((option, index) => (
          <Fragment key={option.value}>
            {starredVisible > 0 && index === 0 && <p className="model-group-label">Favorites</p>}
            {starredVisible > 0 && index === starredVisible && <p className="model-group-label">All models</p>}
            <div className="model-row" role="none">
              <button
                ref={(node) => { optionRefs.current[index] = node; }}
                type="button"
                role="menuitemradio"
                aria-checked={option.value === value}
                className={option.value === value ? "selected" : ""}
                disabled={option.disabled}
                onKeyDown={(event) => {
                  if (event.key === "ArrowDown") { event.preventDefault(); moveFocus(event.currentTarget, 1); }
                  if (event.key === "ArrowUp") { event.preventDefault(); moveFocus(event.currentTarget, -1); }
                }}
                onClick={() => {
                  if (option.disabled) return;
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
              {onToggleFavorite && <ModelFavoriteStar model={option.value} label={option.label} favorite={favorites.includes(option.value)} onToggle={onToggleFavorite} />}
            </div>
          </Fragment>
        ))}
        {hidden > 0 && (
          <button type="button" className="model-show-all" onClick={() => setShowAll(true)}>
            Show all {filtered.length} options ({hidden} more)
          </button>
        )}
        {visible.length === 0 && <p className="app-select-empty">{emptyMessage}</p>}
      </div>
    </div>
  ) : null;

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

      {menu}
    </div>
  );
}
