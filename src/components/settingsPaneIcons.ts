import {
  BadgeDollarSign,
  Boxes,
  Brain,
  CalendarClock,
  Download,
  FolderCog,
  Gauge,
  GitPullRequest,
  KeyRound,
  Mic,
  MonitorSmartphone,
  NotebookPen,
  Palette,
  Settings2,
  SlidersHorizontal,
  UsersRound,
  Workflow,
  Wrench,
} from "lucide-react";
import type { SettingsSection } from "../types";

/**
 * One icon per Settings pane, shared by the Settings rail and the command
 * palette's Settings results so a pane looks the same wherever it is listed.
 * GitHub uses the pull-request mark (lucide ships no brand logos); the fork
 * glyph it used to share belongs to Worktree.
 */
export const SETTINGS_PANE_ICONS: Record<SettingsSection | "pricing", typeof Palette> = {
  general: Settings2,
  appearance: Palette,
  voice: Mic,
  models: KeyRound,
  prompts: NotebookPen,
  memory: Brain,
  agents: UsersRound,
  skills: Boxes,
  tools: Wrench,
  projects: FolderCog,
  workflows: Workflow,
  "scheduled-tasks": CalendarClock,
  github: GitPullRequest,
  devices: MonitorSmartphone,
  usage: Gauge,
  pricing: BadgeDollarSign,
  updates: Download,
  system: SlidersHorizontal,
};
