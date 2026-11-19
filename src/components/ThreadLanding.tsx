// The chat side's two landings, written once: the welcome screen (no project
// or Chats open) and the new-thread landing (a project or Chats with no
// thread yet). App.tsx fills them with live state; the hidden theme preview
// (src/themePreview) fills them with sample state, so a theme preview of a
// new thread or chat draws this exact markup and behaviour. `data-ct-control`
// opts a button in to bounded theme hover/focus motion (previewScenes.ts).

import type { ReactNode } from "react";
import { Code2, Folder, FolderOpen, GitBranch, LoaderCircle, MessageSquare } from "lucide-react";
import { AnimatedMythraLogo } from "./AnimatedMythraLogo";
import { STUDIO_TAB_META } from "./studioTabMeta";
import type { StudioTab } from "../lib/studioTabs";
import type { WorkspaceGitInfo } from "../lib/worktrees";

export function WelcomeLanding({ banner, onOpenProject, onOpenChats }: { banner?: ReactNode; onOpenProject: () => void; onOpenChats: () => void }) {
  return <section className="welcome-screen">
    {banner}
    <div className="welcome-orbit">
      <Code2 size={34} />
    </div>
    <h1>Choose how to work</h1>
    <p>Open a project folder for coding, or chat without one.</p>
    <div className="welcome-actions">
      <button className="primary-button large" data-ct-control="primary" onClick={onOpenProject}>
        <FolderOpen size={17} /> Open project
      </button>
      <button
        className="secondary-button"
        data-ct-control="secondary"
        onClick={onOpenChats}
      >
        <MessageSquare size={16} /> Open Chats
      </button>
    </div>
  </section>;
}

/** Where a new project thread works: shared checkout or an isolated worktree. */
export interface ThreadIsolationChoice {
  isolated: boolean;
  onChange: (isolated: boolean) => void;
  /** null while the project's Git status is being read. */
  git: WorkspaceGitInfo | null;
  initializing: boolean;
  onInitializeGit: () => void;
}

export function ThreadLanding({ isChat, project, unavailable, notice, banner, isolation, onOpenTool, logoMotionSnapshot }: {
  isChat: boolean;
  /** The open project (unused for Chats). */
  project?: { name: string; path: string };
  /** A thread failed to open: the landing is labelled as a separate new thread. */
  unavailable?: boolean;
  /** Shown first, e.g. the unavailable-thread recovery panel. */
  notice?: ReactNode;
  /** Shown above the logo, e.g. a provider handoff draft. */
  banner?: ReactNode;
  /** Only for a project with no thread yet. */
  isolation?: ThreadIsolationChoice;
  /** Absent for Chats. */
  onOpenTool?: (tab: StudioTab) => void;
  /** An assembled pose used by the hidden theme capture. */
  logoMotionSnapshot?: "idle" | "still";
}) {
  const workspaceName = isChat ? "Chats" : project?.name;
  const git = isolation?.git ?? null;
  return <div className={`thread-empty-state${unavailable ? " after-unavailable" : ""}`}>
    {notice}
    {banner}
    <AnimatedMythraLogo motionSnapshot={logoMotionSnapshot} />
    <h1>{unavailable ? "Or start a separate thread" : isChat ? "What should we talk about?" : "What should we build?"}</h1>
    <p>{unavailable
      ? <>A new thread in <span className="thread-empty-project" title={isChat ? undefined : project?.path}>{workspaceName}</span>; the one above stays in the sidebar.</>
      : isChat ? "A chat with no project folder attached." : <>Start a new thread in <span className="thread-empty-project" title={project?.path}>{project?.name}</span>.</>}</p>
    {!isChat && isolation && (
      <div className="isolation-choice" role="group" aria-label="Where this thread works">
        <button className={!isolation.isolated ? "active" : ""} data-ct-control="isolation-choice" aria-pressed={!isolation.isolated} onClick={() => isolation.onChange(false)} title={`Work directly in ${project?.name}`}>
          <Folder size={14} />
          <span><strong>Shared project</strong></span>
        </button>
        {git && !git.error && (
          (!git.isRepo || (git.isRoot && !git.hasCommit)) ? (
            <button
              className="git-initialize-choice"
              onClick={isolation.onInitializeGit}
              disabled={isolation.initializing}
              aria-busy={isolation.initializing}
              title="Create a local Git repository and initial snapshot. Nothing is pushed."
            >
              {isolation.initializing ? <LoaderCircle className="spin" size={14} /> : <GitBranch size={14} />}
              <span>
                <strong>{isolation.initializing ? "Preparing Git…" : git.isRepo ? "Create initial Git snapshot" : "Initialize Git"}</strong>
              </span>
            </button>
          ) : (
            <button
              className={isolation.isolated ? "active" : ""}
              data-ct-control="isolation-choice"
              aria-pressed={isolation.isolated}
              onClick={() => isolation.onChange(true)}
              disabled={!git.isRoot || !git.hasCommit}
              title={!git.isRoot ? "Open the Git repository root to use an isolated worktree" : !git.hasCommit ? "Requires at least one Git commit" : "A private branch and worktree; apply or merge when ready"}
            >
              <GitBranch size={14} />
              <span>
                <strong className="isolated-worktree-title">Isolated worktree</strong>
              </span>
            </button>
          )
        )}
        {!git && (
          <button disabled title="Checking this project's Git status">
            <LoaderCircle className="spin" size={14} />
            <span>
              <strong>Checking Git…</strong>
            </span>
          </button>
        )}
        {git?.error && (
          <button disabled title={`${git.error}. Check that the project folder still exists.`}>
            <GitBranch size={14} />
            <span>
              <strong>Git unavailable</strong>
            </span>
          </button>
        )}
      </div>
    )}
    {!isChat && isolation && git?.isRepo && git.isRoot && git.hasCommit && (
      <small className="isolation-caption" aria-live="polite">{isolation.isolated ? "On a private branch; apply or merge when ready." : `Edits go straight into ${project?.name}.`}</small>
    )}
    {!isChat && onOpenTool && (
      // Opus R6 D11: each link is named and drawn like the Tools
      // tab it opens, so it teaches where it goes.
      <div className="empty-state-actions" role="group" aria-label="Open in Tools">
        {(["files", "terminal", "changes"] as const).map((tab) => {
          const { label, icon: TabIcon } = STUDIO_TAB_META[tab];
          return <button key={tab} data-ct-control="landing-action" onClick={() => onOpenTool(tab)} title={`Open ${label} in Tools`}>
            <TabIcon size={14} /> {label}
          </button>;
        })}
      </div>
    )}
  </div>;
}
