import { Boxes, FileDiff, FolderTree, Gauge, GitBranch, GitFork, History, Play, TerminalSquare, UsersRound } from "lucide-react";
import type { StudioTab } from "../lib/studioTabs";

/**
 * One name and one icon per Tools tab: the rail label is also the panel
 * title, and the command palette's "Tools" results use the same entry, so a
 * tab looks the same wherever it is listed (Opus R6 D2). Kept out of
 * StudioDock so the palette doesn't load the lazily split dock bundle.
 */
export const STUDIO_TAB_META: Record<StudioTab, { label: string; icon: typeof FileDiff }> = {
  changes: { label: "Changes", icon: FileDiff },
  git: { label: "Git", icon: GitBranch },
  checkpoints: { label: "Checkpoints", icon: History },
  worktrees: { label: "Worktree", icon: GitFork },
  files: { label: "Files", icon: FolderTree },
  terminal: { label: "Terminal", icon: TerminalSquare },
  actions: { label: "Actions", icon: Play },
  // The persisted tab id stays "agents"; the name matches the composer's Sub-agents control.
  agents: { label: "Sub-agents", icon: UsersRound },
  usage: { label: "Usage", icon: Gauge },
  skills: { label: "Skills & MCP", icon: Boxes },
};
