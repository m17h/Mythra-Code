// The Theme library: every custom theme in one window over Settings, with
// search, sort, a grid of live previews and a details pane (rename,
// animations, use, adjust with AI, undo, history and delete). Settings itself
// only shows a short row of tiles and opens this window for the rest.

import "./ThemeLibraryDialog.css";
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type RefObject } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronLeft, ChevronRight, RotateCcw, Search, Sparkles, Trash2, Undo2, X } from "lucide-react";
import { AppSelectMenu } from "./AppSelectMenu";
import { CustomThemePreview } from "./CustomThemePreview";
import { EmptyState, Switch } from "./SettingsBits";
import { SmoothDisclosure } from "./SmoothDisclosure";
import { USER, ago, authorPhrase, hasMotion, tileMeta } from "./customThemeBits";
import { useModalFocus } from "../hooks/useModalFocus";
import { THEMES } from "../lib/appConfig";
import {
  canUndo,
  commitCustomThemeRevision,
  headSpec,
  renameCustomTheme,
  revisionAuthor,
  undoCustomTheme,
  type CustomThemeRecord,
  type CustomThemeRevision,
} from "../lib/customThemes/store";
import { THEME_LIBRARY_SORTS, isThemeLibrarySort, libraryView, type ThemeLibrarySort } from "../lib/customThemes/library";
import { builtInScheme, type CustomThemeId } from "../lib/customThemes/spec";

/** Below this dialog width the grid and the details share one column. */
const NARROW_WIDTH = 760;

export interface ThemeLibraryFocus {
  id: CustomThemeId;
  /** Land on the name field (the tile menu's Rename). */
  field?: "name";
}

export function ThemeLibraryDialog({
  themes,
  selectedId,
  initialFocus,
  motionAllowed,
  host,
  returnFocus,
  onUse,
  onDesign,
  onDelete,
  onClose,
}: {
  themes: readonly CustomThemeRecord[];
  /** The custom theme chosen in Settings, if one is. */
  selectedId: CustomThemeId | null;
  initialFocus: ThemeLibraryFocus | null;
  /** Settings is showing Appearance, theme motion isn't paused and the system allows motion. */
  motionAllowed: boolean;
  /** Where the window mounts (the Settings backdrop), so it inherits the live theme and scale. */
  host: HTMLElement | null;
  returnFocus: () => HTMLElement | null | undefined;
  onUse: (id: CustomThemeId) => void;
  /** Start the one design flow: a new theme, or adjusting `target`. */
  onDesign: (target?: CustomThemeId) => void;
  /** Ask first, then delete. Resolves true when the theme was deleted. */
  onDelete: (record: CustomThemeRecord) => Promise<boolean>;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const nameInputRef = useRef<HTMLInputElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const gridId = useId();
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<ThemeLibrarySort>("recent");
  const [currentId, setCurrentId] = useState<CustomThemeId | null>(() => initialFocus?.id ?? selectedId ?? null);
  const [hovered, setHovered] = useState<CustomThemeId | null>(null);
  const [focusedCard, setFocusedCard] = useState<CustomThemeId | null>(null);
  const narrow = useNarrow(dialogRef);
  const [showDetails, setShowDetails] = useState(() => initialFocus?.field === "name");

  const view = useMemo(() => libraryView(themes, query, sort), [themes, query, sort]);
  const current = view.find((record) => record.id === currentId) ?? view[0] ?? null;
  const detailsShown = Boolean(current) && (!narrow || showDetails);
  const gridShown = !narrow || !showDetails || !current;

  useModalFocus(dialogRef, true, {
    initialFocus: () => (initialFocus?.field === "name" ? nameInputRef.current : searchRef.current),
    returnFocus,
  });
  useEffect(() => {
    if (initialFocus?.field === "name") nameInputRef.current?.select();
    // Start with the theme in view, wherever it sits in a long grid.
    if (current) document.getElementById(optionId(current.id))?.scrollIntoView?.({ block: "nearest" });
    // On open only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const optionId = (id: CustomThemeId) => `${gridId}-${id}`;
  const focusCard = (id: CustomThemeId | null | undefined) => {
    if (!id) return;
    requestAnimationFrame(() => {
      const card = document.getElementById(optionId(id));
      card?.focus({ preventScroll: true });
      card?.scrollIntoView?.({ block: "nearest" });
    });
  };
  const choose = (id: CustomThemeId, { open }: { open?: boolean } = {}) => {
    setCurrentId(id);
    if (open && narrow) setShowDetails(true);
  };
  const back = () => {
    setShowDetails(false);
    focusCard(current?.id);
  };
  const remove = async (record: CustomThemeRecord) => {
    const index = view.findIndex((entry) => entry.id === record.id);
    const deleted = await onDelete(record);
    if (!deleted) return;
    // Land on the neighbour that takes its place, never on the page.
    const rest = view.filter((entry) => entry.id !== record.id);
    const next = rest[Math.min(Math.max(index, 0), rest.length - 1)] ?? null;
    setCurrentId(next?.id ?? null);
    setShowDetails(false);
    if (next) focusCard(next.id);
    else requestAnimationFrame(() => searchRef.current?.focus({ preventScroll: true }));
  };

  const columns = () => {
    const cards = gridRef.current ? [...gridRef.current.querySelectorAll<HTMLElement>('[role="option"]')] : [];
    const top = cards[0]?.offsetTop;
    const count = cards.filter((card) => card.offsetTop === top).length;
    return Math.max(1, count);
  };
  const gridKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!current) return;
    const index = view.findIndex((record) => record.id === current.id);
    const step = (offset: number) => view[Math.min(view.length - 1, Math.max(0, index + offset))];
    let next: CustomThemeRecord | undefined;
    switch (event.key) {
      case "ArrowRight": next = step(1); break;
      case "ArrowLeft": next = step(-1); break;
      case "ArrowDown": next = step(columns()); break;
      case "ArrowUp": next = step(-columns()); break;
      case "Home": next = view[0]; break;
      case "End": next = view[view.length - 1]; break;
      case "Enter":
      case " ":
        event.preventDefault();
        if (selectedId !== current.id) onUse(current.id);
        return;
      case "Delete":
      case "Backspace":
        // Never silent: the same confirmation as the Delete… button.
        event.preventDefault();
        void remove(current);
        return;
      default:
        return;
    }
    event.preventDefault();
    if (!next) return;
    setCurrentId(next.id);
    focusCard(next.id);
  };

  const count = themes.length;
  const countLabel = query.trim() && view.length !== count
    ? `${view.length} of ${count}`
    : `${count} theme${count === 1 ? "" : "s"}`;

  const dialog = (
    <div className="ct-lib-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div
        ref={dialogRef}
        className={`ct-lib${narrow ? " narrow" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onKeyDown={(event) => {
          if (event.key !== "Escape" || event.defaultPrevented) return;
          event.preventDefault();
          event.stopPropagation();
          // One step at a time: the narrow details view goes back to the grid first.
          if (narrow && showDetails && current) back();
          else onClose();
        }}
      >
        <header className="ct-lib-head">
          <div className="ct-lib-title">
            <h3 id={titleId} tabIndex={-1}>Theme library</h3>
            <span className="ct-lib-count" aria-live="polite">{countLabel}</span>
          </div>
          <div className="ct-lib-tools">
            <label className="ct-lib-search">
              <Search size={13} aria-hidden="true" />
              <input
                ref={searchRef}
                type="text"
                value={query}
                placeholder="Search themes"
                aria-label="Search themes"
                aria-controls={gridId}
                spellCheck={false}
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Escape" && query) { event.preventDefault(); event.stopPropagation(); setQuery(""); }
                  if (event.key === "ArrowDown" && current) { event.preventDefault(); setShowDetails(false); focusCard(current.id); }
                }}
              />
              {query && <button type="button" className="ct-lib-search-clear" aria-label="Clear search" onClick={() => { setQuery(""); searchRef.current?.focus(); }}><X size={12} aria-hidden="true" /></button>}
            </label>
            <div className="ct-lib-sort">
              <AppSelectMenu
                portal
                value={sort}
                options={THEME_LIBRARY_SORTS.map((option) => ({ value: option.value, label: option.label }))}
                ariaLabel="Sort themes"
                onChange={(value) => { if (isThemeLibrarySort(value)) setSort(value); }}
              />
            </div>
            <button type="button" className="secondary-button ct-lib-design" onClick={() => onDesign()}>
              <Sparkles size={12} aria-hidden="true" /> Design a theme with AI
            </button>
          </div>
          <button type="button" className="ct-lib-close" aria-label="Close theme library" onClick={onClose}><X size={15} aria-hidden="true" /></button>
        </header>

        <div className="ct-lib-body">
          {gridShown && <div className="ct-lib-grid-pane">
            {view.length ? (
              <div
                ref={gridRef}
                id={gridId}
                className="ct-lib-grid"
                role="listbox"
                aria-label="Custom themes"
                onKeyDown={gridKeyDown}
              >
                {view.map((record) => {
                  const spec = headSpec(record);
                  const isCurrent = current?.id === record.id;
                  const inUse = selectedId === record.id;
                  const animate = motionAllowed && spec.motion?.enabled !== false && !record.disabledReason
                    && (hovered === record.id || focusedCard === record.id);
                  return (
                    <div
                      key={record.id}
                      id={optionId(record.id)}
                      role="option"
                      aria-selected={isCurrent}
                      tabIndex={isCurrent ? 0 : -1}
                      className={`ct-lib-card${isCurrent ? " current" : ""}${inUse ? " in-use" : ""}`}
                      title={spec.description || undefined}
                      onClick={() => choose(record.id, { open: true })}
                      onFocus={() => { setFocusedCard(record.id); if (!isCurrent) setCurrentId(record.id); }}
                      onBlur={() => setFocusedCard((id) => (id === record.id ? null : id))}
                      onPointerEnter={() => setHovered(record.id)}
                      onPointerLeave={() => setHovered((id) => (id === record.id ? null : id))}
                    >
                      <span className="ct-lib-card-preview" aria-hidden="true">
                        <CustomThemePreview id={record.id} spec={spec} animate={animate} />
                      </span>
                      <span className="ct-lib-card-copy">
                        <strong>{spec.name}</strong>
                        <small>{inUse ? <><Check size={11} aria-hidden="true" className="ct-lib-in-use-mark" /> In use · </> : null}{tileMeta(record)}</small>
                      </span>
                    </div>
                  );
                })}
              </div>
            ) : (
              <EmptyState
                icon={Search}
                title={`No themes match “${query.trim()}”`}
                detail="Try another name or a word from a theme's description."
                action={<button type="button" className="secondary-button" onClick={() => { setQuery(""); searchRef.current?.focus(); }}>Clear search</button>}
              />
            )}
            {narrow && current && (
              <div className="ct-lib-peek">
                <span><strong>{headSpec(current).name}</strong><small>{selectedId === current.id ? "In use" : tileMeta(current)}</small></span>
                <button type="button" className="secondary-button" onClick={() => setShowDetails(true)}>Details <ChevronRight size={13} aria-hidden="true" /></button>
              </div>
            )}
          </div>}

          {detailsShown && current && (
            <ThemeDetails
              key={current.id}
              record={current}
              nameInputRef={nameInputRef}
              inUse={selectedId === current.id}
              animate={motionAllowed}
              onBack={narrow ? back : undefined}
              onUse={() => onUse(current.id)}
              onAdjust={() => onDesign(current.id)}
              onDelete={() => void remove(current)}
            />
          )}
        </div>
      </div>
    </div>
  );
  return createPortal(dialog, host ?? document.body);
}

/** True while the dialog is narrower than NARROW_WIDTH (window size, app scale or both). */
function useNarrow(ref: RefObject<HTMLElement | null>): boolean {
  const [narrow, setNarrow] = useState(false);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const measure = () => setNarrow(element.clientWidth > 0 && element.clientWidth < NARROW_WIDTH);
    measure();
    if (typeof ResizeObserver !== "function") return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);
  return narrow;
}

/** The details pane: everything about one theme. */
function ThemeDetails({ record, nameInputRef, inUse, animate, onBack, onUse, onAdjust, onDelete }: {
  record: CustomThemeRecord;
  nameInputRef: RefObject<HTMLInputElement | null>;
  inUse: boolean;
  animate: boolean;
  /** Narrow windows: back to the grid. */
  onBack?: () => void;
  onUse: () => void;
  onAdjust: () => void;
  onDelete: () => void;
}) {
  const spec = headSpec(record);
  const [name, setName] = useState(spec.name);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const historyId = useId();
  const nameId = useId();
  const editing = useRef(false);
  useEffect(() => { if (!editing.current) setName(spec.name); }, [spec.name]);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  const commitName = () => {
    editing.current = false;
    const next = name.trim();
    if (!next) { setName(spec.name); return; }
    if (next !== spec.name) renameCustomTheme(record.id, next, USER);
  };
  // Typing autosaves after a pause, like the rest of Settings.
  useEffect(() => {
    if (!editing.current) return;
    const timer = window.setTimeout(() => {
      const next = name.trim();
      if (next && next !== headSpec(record).name) renameCustomTheme(record.id, next, USER);
    }, 450);
    return () => window.clearTimeout(timer);
  }, [name, record]);

  const undo = canUndo(record);
  const baseTheme = THEMES.find((theme) => theme.id === spec.base);
  const scheme = builtInScheme(spec.base);
  const animated = hasMotion(record);
  const revisions = [...record.revisions].reverse();
  const adjusted = record.revisions.find((revision) => revision.n === record.head)?.adjustments?.length ?? 0;
  const previewMoves = animate && spec.motion?.enabled !== false && !record.disabledReason;

  return (
    <section className="ct-lib-details" aria-label={`${spec.name} details`}>
      {onBack && <button type="button" className="ct-lib-back" onClick={onBack}><ChevronLeft size={14} aria-hidden="true" /> All themes</button>}
      <span className="ct-lib-hero" aria-hidden="true">
        <CustomThemePreview id={record.id} spec={spec} animate={previewMoves} />
      </span>

      <div className="ct-lib-identity">
        <label className="ct-lib-field-label" htmlFor={nameId}>Name</label>
        <input
          id={nameId}
          ref={nameInputRef}
          className="ct-name-input ct-lib-name"
          value={name}
          maxLength={40}
          spellCheck={false}
          onChange={(event) => { editing.current = true; setName(event.target.value); }}
          onBlur={commitName}
          onKeyDown={(event) => {
            if (event.key === "Enter") { event.preventDefault(); commitName(); event.currentTarget.blur(); }
            if (event.key === "Escape" && name !== spec.name) { event.preventDefault(); event.stopPropagation(); editing.current = false; setName(spec.name); }
          }}
        />
        {spec.description && <p className="ct-lib-description">{spec.description}</p>}
        <p className="ct-lib-meta">Based on {baseTheme?.name ?? spec.base} ({scheme}) · {authorPhrase(record)} · Edited {ago(record.updatedAt, now)}</p>
      </div>

      <div className="ct-lib-actions">
        {inUse
          ? <button type="button" className="secondary-button ct-lib-in-use" disabled><Check size={13} aria-hidden="true" /> In use</button>
          : <button type="button" className="primary-button" onClick={onUse}>Use this theme</button>}
        <button type="button" className="secondary-button" onClick={onAdjust}><Sparkles size={13} aria-hidden="true" /> Adjust with AI</button>
      </div>

      <div className="set-card ct-lib-rows">
        {animated && <div className="set-row">
          <div className="set-copy">
            <strong id={`${nameId}-motion`}>Animations</strong>
            <small>Play this theme's animations.</small>
          </div>
          <div className="set-control">
            <Switch
              checked={spec.motion?.enabled !== false}
              labelledBy={`${nameId}-motion`}
              onChange={(next) => commitCustomThemeRevision(record.id, { ...spec, motion: { ...spec.motion, enabled: next } }, { by: USER, kind: "edit", summary: next ? "Animations on" : "Animations off" })}
            />
          </div>
        </div>}
        <div className="set-row ct-history-row">
          <button type="button" className="ct-history-toggle" aria-expanded={historyOpen} aria-controls={historyId} onClick={() => setHistoryOpen((open) => !open)}>
            <span className="ct-chevron" aria-hidden="true" />
            <strong>History</strong>
            <small>{record.revisions.length} version{record.revisions.length === 1 ? "" : "s"}{adjusted ? ` · ${adjusted} colour${adjusted === 1 ? "" : "s"} adjusted for readability` : ""}</small>
          </button>
          <div className="set-control">
            <button type="button" className="secondary-button" disabled={!undo.ok} title={undo.ok ? undefined : undo.reason}
              onClick={() => undoCustomTheme(record.id, { by: USER })}>
              <Undo2 size={13} aria-hidden="true" /> Undo last change
            </button>
          </div>
        </div>
        <SmoothDisclosure open={historyOpen} id={historyId} className="ct-history-disclosure">
          <ol className="ct-history" aria-label={`${spec.name} history`}>
            {revisions.map((revision) => <HistoryRow key={revision.n} record={record} revision={revision} now={now} />)}
            {record.revisions[0]!.n > 1 && <li className="ct-history-pruned">Earlier versions were cleared to save space.</li>}
          </ol>
        </SmoothDisclosure>
      </div>

      <div className="ct-lib-danger">
        <button type="button" className="secondary-button ct-lib-delete" onClick={onDelete}><Trash2 size={13} aria-hidden="true" /> Delete…</button>
      </div>
    </section>
  );
}

function HistoryRow({ record, revision, now }: { record: CustomThemeRecord; revision: CustomThemeRevision; now: number }) {
  const current = revision.n === record.head;
  const author = revisionAuthor(revision);
  return (
    <li className={current ? "current" : undefined} aria-current={current ? "true" : undefined}>
      <span className="ct-rev">r{revision.n}</span>
      <span className="ct-rev-copy">
        <span className="ct-rev-summary">{revision.summary}</span>
        <small>{author === "you" ? "You" : author} · {ago(revision.at, now)}{revision.adjustments?.length ? ` · ${revision.adjustments.length} colour${revision.adjustments.length === 1 ? "" : "s"} adjusted for readability` : ""}</small>
      </span>
      {current
        ? <span className="ct-rev-current">Current</span>
        : <button type="button" className="secondary-button ct-rev-restore" onClick={() => undoCustomTheme(record.id, { by: USER, toRevision: revision.n })}><RotateCcw size={12} aria-hidden="true" /> Restore</button>}
    </li>
  );
}
