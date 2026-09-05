import type { ReactNode } from "react";
import { ChevronDown, Pin } from "lucide-react";
import { useDisclosureHeight } from "../hooks/useDisclosureHeight";
import { usePersistedState } from "../hooks/usePersistedState";

/** Own the toggle locally: expanding the sidebar must not rerender the chat,
 * composer, model pickers and every unpinned workspace before its first frame. */
export function PinnedWorkspaceGroup({ count, containsActiveWorkspace, children }: {
  count: number;
  containsActiveWorkspace: boolean;
  children: ReactNode;
}) {
  const [collapsed, setCollapsed] = usePersistedState("kiwi.pinnedWorkspacesCollapsed", false);
  const disclosure = useDisclosureHeight<HTMLDivElement>(!collapsed);
  return (
    <div className={`workspace-group pinned ${collapsed ? "collapsed" : ""}`}>
      <button
        className={`workspace-group-toggle ${collapsed && !disclosure.present && containsActiveWorkspace ? "holds-active" : ""}`}
        onClick={() => setCollapsed((current) => !current)}
        aria-expanded={!collapsed}
        aria-controls={disclosure.present ? "pinned-workspaces" : undefined}
        title={collapsed ? "Show pinned workspaces" : "Hide pinned workspaces"}
      >
        <Pin size={12} />
        <span>Pinned</span>
        <span className="thread-count">{count}</span>
        <ChevronDown className={collapsed ? "" : "open"} size={12} />
      </button>
      {disclosure.present && (
        <div className="workspace-group-body" id="pinned-workspaces" ref={disclosure.ref} aria-hidden={collapsed || undefined} inert={collapsed || undefined}>
          <div className="workspace-group-content">{children}</div>
        </div>
      )}
    </div>
  );
}
