import { useCallback, useLayoutEffect, useRef, useState, type HTMLAttributes, type KeyboardEvent as ReactKeyboardEvent, type ReactNode, type Ref, type RefObject } from "react";
import { Folder, MessageSquare, Pin, Plus, Search } from "lucide-react";
import { RowMenu, type RowMenuItem } from "./RowMenu";
import { ScheduledCountBadge } from "./ScheduledCountBadge";
import { TransitionInput } from "./TransitionInput";

const visibleRow = (row: HTMLElement) => !row.closest("[hidden], [inert]") && row.getClientRects().length > 0;

/**
 * Source-list keyboard model, as in Finder and Mail: the list is one Tab
 * stop, ↑/↓/Home/End move between rows, → reaches a row's "…" and ← comes
 * back, Shift+F10 or the context-menu key opens it. Rows are memoized
 * elsewhere, so tab stops are kept in the DOM rather than in props.
 */
export function useRovingRows(rootRef: RefObject<HTMLElement | null>, rowSelector: string) {
  const syncTabStops = useCallback(() => {
    const root = rootRef.current;
    if (!root) return;
    const rows = Array.from(root.querySelectorAll<HTMLElement>(rowSelector));
    const visible = rows.filter(visibleRow);
    // Writes are guarded: this runs on every render of a list that can hold
    // hundreds of rows, and an unchanged attribute must not touch the DOM.
    root.querySelectorAll<HTMLElement>(".row-menu-trigger").forEach((trigger) => { if (trigger.tabIndex !== -1) trigger.tabIndex = -1; });
    const keep = visible.find((row) => row === document.activeElement)
      ?? visible.find((row) => row.getAttribute("aria-current") === "page")
      ?? visible.find((row) => row.tabIndex === 0 && row.dataset.roving === "kept")
      ?? visible[0];
    rows.forEach((row) => {
      const tabIndex = row === keep ? 0 : -1;
      if (row.tabIndex !== tabIndex) row.tabIndex = tabIndex;
      if (row === keep) { if (row.dataset.roving !== "kept") row.dataset.roving = "kept"; }
      else if (row.dataset.roving) delete row.dataset.roving;
    });
  }, [rootRef, rowSelector]);

  useLayoutEffect(syncTabStops);
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    // Group disclosures can expand their rows without re-rendering this list.
    const observer = new MutationObserver(syncTabStops);
    observer.observe(root, { subtree: true, childList: true, attributeFilter: ["inert", "hidden"] });
    return () => observer.disconnect();
  }, [rootRef, syncTabStops]);

  return useCallback((event: ReactKeyboardEvent<HTMLElement>) => {
    const root = rootRef.current;
    const target = event.target as HTMLElement;
    if (!root || event.defaultPrevented || target.closest(".row-menu-list") || target.tagName === "INPUT") return;
    const rows = Array.from(root.querySelectorAll<HTMLElement>(rowSelector)).filter(visibleRow);
    const triggerOf = (row: HTMLElement) => row.parentElement?.querySelector<HTMLElement>(":scope > .row-menu > .row-menu-trigger") ?? null;
    const onTrigger = target.classList.contains("row-menu-trigger");
    const row = onTrigger ? rows.find((candidate) => triggerOf(candidate) === target) : rows.find((candidate) => candidate === target);
    if (!row) return;
    const index = rows.indexOf(row);
    let next: HTMLElement | null | undefined;
    if (event.key === "ArrowDown") next = rows[Math.min(rows.length - 1, index + 1)];
    else if (event.key === "ArrowUp") next = rows[Math.max(0, index - 1)];
    else if (event.key === "Home") next = rows[0];
    else if (event.key === "End") next = rows[rows.length - 1];
    else if (event.key === "ArrowRight" && !onTrigger) next = triggerOf(row);
    else if (event.key === "ArrowLeft" && onTrigger) next = row;
    else if (!onTrigger && (event.key === "ContextMenu" || (event.key === "F10" && event.shiftKey))) {
      event.preventDefault();
      triggerOf(row)?.click();
      return;
    } else return;
    if (!next) return;
    event.preventDefault();
    if (next !== row && !next.classList.contains("row-menu-trigger")) {
      rows.forEach((candidate) => { candidate.tabIndex = candidate === next ? 0 : -1; });
    }
    next.focus();
    next.scrollIntoView?.({ block: "nearest" });
  }, [rootRef, rowSelector]);
}

/** The sidebar's lists, written once. Each machine fills them with its own data. */
export function WorkspacesSection({ onAdd, addTitle = "Add project", addDisabled = false, children }: {
  onAdd: () => void;
  addTitle?: string;
  addDisabled?: boolean;
  children: ReactNode;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  const onListKeyDown = useRovingRows(listRef, ".workspace-row");
  return <div className="sidebar-section workspaces-section">
    <div className="section-label-row">
      <span className="section-label">Projects</span>
      <button className="icon-button tiny" onClick={onAdd} disabled={addDisabled} title={addTitle} aria-label="Add project">
        <Plus size={14} />
      </button>
    </div>
    <div className="workspace-list" ref={listRef} onKeyDown={onListKeyDown} role="group" aria-label="Projects">{children}</div>
  </div>;
}

export function ChatsRow({ active, onOpen, label, scheduled }: {
  active: boolean;
  onOpen: () => void;
  label: string;
  scheduled?: Parameters<typeof ScheduledCountBadge>[0];
}) {
  return <button
    className={`workspace-row chat ${active ? "active" : ""}`}
    aria-current={active ? "page" : undefined}
    onClick={onOpen}
    title="Conversations without a project folder"
    aria-label={label}
  >
    <span className="workspace-icon chat">
      <MessageSquare size={14} />
    </span>
    <span className="workspace-name">Chats</span>
    <ScheduledCountBadge {...scheduled} />
  </button>;
}

/** One workspace row. Pinned and unpinned rows differ only in which group lists them. */
export function WorkspaceRow({ name, title, label, pinned = false, className = "", current, counts, scale, menu, wrapProps, onOpen }: {
  name: string;
  title: string;
  label: string;
  pinned?: boolean;
  className?: string;
  /** The project on screen. Defaults to whether `className` marks it active. */
  current?: boolean;
  counts?: ReactNode;
  scale: number;
  menu: RowMenuItem[];
  wrapProps?: HTMLAttributes<HTMLDivElement> & { [data: `data-${string}`]: string };
  onOpen: HTMLAttributes<HTMLButtonElement>["onClick"];
}) {
  return <div {...wrapProps} className={["workspace-row-wrap", className].filter(Boolean).join(" ")}>
    <button className="workspace-row" aria-label={label} aria-current={(current ?? /\bactive\b/.test(className)) ? "page" : undefined} onClick={onOpen} title={title}>
      <span className="workspace-icon">{pinned ? <Pin size={13} /> : <Folder size={14} />}</span>
      <span className="workspace-name">{name}</span>
      <span className="workspace-counts">{counts}</span>
    </button>
    {menu.length > 0 && <RowMenu label={`Options for ${name}`} scale={scale} items={menu} />}
  </div>;
}

export function ThreadsSection({ kindSwitch, menu, search, list, footer, listRef }: {
  kindSwitch?: ReactNode;
  /** Bulk actions for the listed threads ("Archive all", "Delete archived"), behind a "…". */
  menu?: ReactNode;
  /** Absent with no workspace selected. */
  search?: ReactNode;
  list: ReactNode;
  footer?: ReactNode;
  listRef?: Ref<HTMLDivElement>;
}) {
  const ownListRef = useRef<HTMLDivElement | null>(null);
  const onListKeyDown = useRovingRows(ownListRef, ".thread-card");
  const setListRef = useCallback((node: HTMLDivElement | null) => {
    ownListRef.current = node;
    if (typeof listRef === "function") listRef(node);
    else if (listRef) (listRef as { current: HTMLDivElement | null }).current = node;
  }, [listRef]);
  return <div className="sidebar-section threads-section">
    <div className="section-label-row">
      <span className="section-label">Threads</span>
      <span className="section-label-tools">
        {kindSwitch}
        {menu}
      </span>
    </div>
    {search}
    <div className="thread-list" ref={setListRef} onKeyDown={onListKeyDown} role="group" aria-label="Threads">{list}</div>
    {footer}
  </div>;
}

export function ThreadSearch({ value, onChange, placeholder, action }: {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  action?: ReactNode;
}) {
  return <div className="thread-search-actions">
    <label className="thread-search">
      <Search size={11} />
      <TransitionInput value={value} onValueChange={onChange} placeholder={placeholder} />
    </label>
    {action}
  </div>;
}

export function ThreadRenameInput({ initial, onCommit, onCancel }: { initial: string; onCommit: (name: string) => void; onCancel: () => void }) {
  const [draft, setDraft] = useState(initial);
  const cancelled = useRef(false);
  return <input
    autoFocus
    value={draft}
    onChange={(event) => setDraft(event.target.value)}
    onBlur={() => { if (!cancelled.current) onCommit(draft); }}
    onKeyDown={(event) => {
      if (event.key === "Enter") onCommit(draft);
      if (event.key === "Escape") {
        cancelled.current = true;
        onCancel();
      }
    }}
    aria-label="Thread name"
  />;
}
