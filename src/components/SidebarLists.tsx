import { useRef, useState, type HTMLAttributes, type ReactNode, type Ref } from "react";
import { Folder, MessageSquare, Pin, Plus, Search } from "lucide-react";
import { RowMenu, type RowMenuItem } from "./RowMenu";
import { ScheduledCountBadge } from "./ScheduledCountBadge";
import { TransitionInput } from "./TransitionInput";

/** The sidebar's lists, written once. Each machine fills them with its own data. */
export function WorkspacesSection({ onAdd, addTitle = "Add project", addDisabled = false, children }: {
  onAdd: () => void;
  addTitle?: string;
  addDisabled?: boolean;
  children: ReactNode;
}) {
  return <div className="sidebar-section workspaces-section">
    <div className="section-label-row">
      <span className="section-label">Workspaces</span>
      <button className="icon-button tiny" onClick={onAdd} disabled={addDisabled} title={addTitle} aria-label="Add project">
        <Plus size={14} />
      </button>
    </div>
    <div className="workspace-list">{children}</div>
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
export function WorkspaceRow({ name, title, label, pinned = false, className = "", counts, scale, menu, wrapProps, onOpen }: {
  name: string;
  title: string;
  label: string;
  pinned?: boolean;
  className?: string;
  counts?: ReactNode;
  scale: number;
  menu: RowMenuItem[];
  wrapProps?: HTMLAttributes<HTMLDivElement> & { [data: `data-${string}`]: string };
  onOpen: HTMLAttributes<HTMLButtonElement>["onClick"];
}) {
  return <div {...wrapProps} className={["workspace-row-wrap", className].filter(Boolean).join(" ")}>
    <button className="workspace-row" aria-label={label} onClick={onOpen} title={title}>
      <span className="workspace-icon">{pinned ? <Pin size={13} /> : <Folder size={14} />}</span>
      <span className="workspace-name">{name}</span>
      <span className="workspace-counts">{counts}</span>
    </button>
    {menu.length > 0 && <RowMenu label={`Options for ${name}`} scale={scale} items={menu} />}
  </div>;
}

export function ThreadsSection({ kindSwitch, search, list, footer, listRef }: {
  kindSwitch?: ReactNode;
  /** Absent with no workspace selected. */
  search?: ReactNode;
  list: ReactNode;
  footer?: ReactNode;
  listRef?: Ref<HTMLDivElement>;
}) {
  return <div className="sidebar-section threads-section">
    <div className="section-label-row">
      <span className="section-label">Threads</span>
      {kindSwitch}
    </div>
    {search}
    <div className="thread-list" ref={listRef}>{list}</div>
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
