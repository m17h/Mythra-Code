// The hidden theme preview's scene registry and the themeable control map.
// One list feeds the job contract (previewJob.ts), the tool handler and its
// result labels (toolHandlerCore.ts), the design kit (designKit.ts), the
// customCss interaction allowance (sanitizeCss.ts) and the preview page that
// draws each scene from bundled sample data (src/themePreview). The native
// side keeps the same ids in src-tauri/src/theme_preview.rs; keep both lists
// in step when adding a scene.
//
// Adding a scene: add it here, add its id to `PREVIEW_SCENE_IDS` in
// theme_preview.rs, and render it in src/themePreview/PreviewSurface.tsx from
// the app's own components with sample data from fixtures.ts. No scene may
// read user content, live routes or arbitrary input.
//
// Pure data: no DOM, no imports beyond types.

import type { StudioTab } from "../studioTabs";

export const PREVIEW_SCENE_IDS = [
  "conversation",
  "changes",
  "new-thread",
  "new-chat",
  "welcome",
  "tools-files",
  "tools-terminal",
  "tools-worktrees",
  "tools-git",
  "tools-checkpoints",
  "tools-actions",
  "tools-agents",
  "tools-usage",
  "tools-skills",
  "settings-appearance",
  "command-palette",
] as const;
export type PreviewSceneId = (typeof PREVIEW_SCENE_IDS)[number];

export const PREVIEW_INTERACTIONS = ["rest", "hover", "focus", "press"] as const;
export type PreviewInteraction = (typeof PREVIEW_INTERACTIONS)[number];

export const CONTROL_TARGET_IDS = [
  "send", "attach", "new-thread", "sidebar-icon", "sidebar-settings", "tools-toggle",
  "tools-tab", "primary", "secondary", "landing-action", "isolation-choice",
] as const;
export type ControlTargetId = (typeof CONTROL_TARGET_IDS)[number];

/**
 * The app-owned opt-in for interaction motion. Only elements that carry it
 * (set in their production markup, never by a theme) can take the bounded
 * grow transform from customCss; every other element keeps the sanitizer's
 * no-transform rule. Approval, destructive, dialog, auth and Settings
 * buttons never carry it.
 */
export const CONTROL_ATTRIBUTE = "data-ct-control";

export interface ControlTarget {
  id: ControlTargetId;
  label: string;
  /** The production selector to style this control with. */
  selector: string;
  where: string;
  /** Where the class is shared with buttons that don't opt in to motion. */
  shared?: string;
}

/** The opt-in attribute value on a control's own element. */
export function controlAttribute(id: ControlTargetId): string {
  return `[${CONTROL_ATTRIBUTE}="${id}"]`;
}

/**
 * Common themeable buttons, by their production selectors. Each listed
 * element opts in with CONTROL_ATTRIBUTE; colours, borders and shadows can
 * be styled on every element the selector matches, movement only on the
 * opted-in ones.
 */
export const CONTROL_TARGETS: readonly ControlTarget[] = [
  { id: "send", label: "Composer Send", selector: ".send-button", where: "Right end of the composer card. Disabled until there is text." },
  { id: "attach", label: "Composer Attach", selector: ".attach-button", where: "Composer toolbar, under the text field.", shared: "Other composer toolbar buttons share .toolbar-button but don't move." },
  { id: "new-thread", label: "New thread", selector: ".new-thread-button", where: "Top of the left navigator." },
  { id: "sidebar-icon", label: "Hide sidebar", selector: ".sidebar-brand .icon-button", where: "Beside the app name in the left navigator.", shared: "Every .icon-button shares its base styles; only this one moves." },
  { id: "sidebar-settings", label: "Settings button", selector: ".sidebar-settings", where: "Foot of the left navigator." },
  { id: "tools-toggle", label: "Tools toggle", selector: ".workspace-tools-trigger", where: "Right end of the top bar in a project." },
  { id: "tools-tab", label: "Tools tab", selector: ".studio-tabs button", where: "The Tools panel's tab column (button.active is the open tab and the one that takes keyboard focus)." },
  { id: "primary", label: "Primary button (welcome screen)", selector: ".primary-button", where: "Open project on the welcome screen.", shared: "Approvals, dialogs and Settings use .primary-button too; they take its colours but never move." },
  { id: "secondary", label: "Secondary button (welcome screen)", selector: ".secondary-button", where: "Open Chats on the welcome screen.", shared: "Settings rows, dialogs and approvals use .secondary-button too; they take its colours but never move." },
  { id: "landing-action", label: "New-thread tool shortcut", selector: ".empty-state-actions button", where: "Files, Terminal and Changes shortcuts on the new-thread landing." },
  { id: "isolation-choice", label: "Shared project / Isolated worktree", selector: ".isolation-choice button", where: "The where-this-thread-works choice on the new-thread landing (button.active is chosen)." },
];

export function controlTarget(id: string): ControlTarget | undefined {
  return CONTROL_TARGETS.find((target) => target.id === id);
}

export type PreviewChrome = "project" | "chats" | "welcome";

export interface PreviewScene {
  id: PreviewSceneId;
  /** What is drawn, in a sentence. */
  shows: string;
  chrome: PreviewChrome;
  /** The main panel: the sample conversation or a landing. */
  stage: "conversation" | "new-thread" | "new-chat" | "welcome";
  /** The Tools panel's open tab, when it is open. */
  tools?: StudioTab;
  overlay?: "settings-appearance" | "command-palette";
  /** Controls present in this scene, the first one is the default for an interaction. */
  controls: readonly ControlTargetId[];
}

/** Controls in the left navigator: an explicit request for one shows the sidebar. */
export const SIDEBAR_CONTROLS: readonly ControlTargetId[] = ["new-thread", "sidebar-icon", "sidebar-settings"];

const SHELL_CONTROLS: readonly ControlTargetId[] = ["new-thread", "sidebar-icon", "sidebar-settings"];
const PROJECT_CONTROLS: readonly ControlTargetId[] = ["send", "attach", "tools-toggle", ...SHELL_CONTROLS];

export const PREVIEW_SCENES: Record<PreviewSceneId, PreviewScene> = {
  conversation: {
    id: "conversation", chrome: "project", stage: "conversation", controls: PROJECT_CONTROLS,
    shows: "a project: sidebar with sample projects and threads, top bar, a sample conversation (messages, tool activity, code) and the composer",
  },
  changes: {
    id: "changes", chrome: "project", stage: "conversation", tools: "changes", controls: [...PROJECT_CONTROLS, "tools-tab"],
    shows: "the conversation scene with the Tools panel open on Changes, showing a sample diff",
  },
  "new-thread": {
    id: "new-thread", chrome: "project", stage: "new-thread", controls: ["send", "landing-action", "isolation-choice", "attach", "tools-toggle", ...SHELL_CONTROLS],
    shows: "New thread in a sample project: the app's real new-thread landing (heading, Shared project / Isolated worktree choice, Files/Terminal/Changes shortcuts) above an empty composer",
  },
  "new-chat": {
    id: "new-chat", chrome: "chats", stage: "new-chat", controls: ["send", "attach", ...SHELL_CONTROLS],
    shows: "a new chat in Chats (no project folder): the app's real Chats landing and composer, with Chats selected in the sidebar and no Tools button",
  },
  welcome: {
    id: "welcome", chrome: "welcome", stage: "welcome", controls: ["primary", "secondary", "sidebar-icon", "sidebar-settings"],
    shows: "the welcome screen shown when no project or Chats is open (Open project and Open Chats buttons; New thread is disabled there)",
  },
  "tools-files": {
    id: "tools-files", chrome: "project", stage: "conversation", tools: "files", controls: ["tools-tab", ...PROJECT_CONTROLS],
    shows: "the conversation scene with Tools open on Files, listing a sample project folder and its files",
  },
  "tools-terminal": {
    id: "tools-terminal", chrome: "project", stage: "conversation", tools: "terminal", controls: ["tools-tab", ...PROJECT_CONTROLS],
    shows: "the conversation scene with Tools open on Terminal, displaying sample npm output",
  },
  "tools-worktrees": {
    id: "tools-worktrees", chrome: "project", stage: "conversation", tools: "worktrees", controls: ["tools-tab", ...PROJECT_CONTROLS],
    shows: "the conversation scene with Tools open on Worktree, showing the sample thread's isolated branch, status and actions",
  },
  "tools-git": {
    id: "tools-git", chrome: "project", stage: "conversation", tools: "git", controls: ["tools-tab", ...PROJECT_CONTROLS],
    shows: "the conversation scene with Tools open on Git (sample branch, no remote)",
  },
  "tools-checkpoints": {
    id: "tools-checkpoints", chrome: "project", stage: "conversation", tools: "checkpoints", controls: ["tools-tab", ...PROJECT_CONTROLS],
    shows: "the conversation scene with Tools open on Checkpoints (no saved checkpoints)",
  },
  "tools-actions": {
    id: "tools-actions", chrome: "project", stage: "conversation", tools: "actions", controls: ["tools-tab", ...PROJECT_CONTROLS],
    shows: "the conversation scene with Tools open on Actions (a sample run command and checks)",
  },
  "tools-agents": {
    id: "tools-agents", chrome: "project", stage: "conversation", tools: "agents", controls: ["tools-tab", ...PROJECT_CONTROLS],
    shows: "the conversation scene with Tools open on Sub-agents (none running)",
  },
  "tools-usage": {
    id: "tools-usage", chrome: "project", stage: "conversation", tools: "usage", controls: ["tools-tab", ...PROJECT_CONTROLS],
    shows: "the conversation scene with Tools open on Usage (no usage recorded for the sample thread)",
  },
  "tools-skills": {
    id: "tools-skills", chrome: "project", stage: "conversation", tools: "skills", controls: ["tools-tab", ...PROJECT_CONTROLS],
    shows: "the conversation scene with Tools open on Skills & MCP (sample skills and MCP servers)",
  },
  "settings-appearance": {
    id: "settings-appearance", chrome: "project", stage: "conversation", overlay: "settings-appearance", controls: ["secondary"],
    shows: "Settings open on Appearance over the conversation scene: the theme cards, Custom themes (an empty library, since saved themes are not read), size, chat font, effort slider and logos",
  },
  "command-palette": {
    id: "command-palette", chrome: "project", stage: "conversation", overlay: "command-palette", controls: [],
    shows: "the command palette (⌘K / Ctrl+K) open over the conversation scene, listing commands, Tools, sample projects and sample threads",
  },
};

export function isPreviewScene(value: unknown): value is PreviewSceneId {
  return typeof value === "string" && (PREVIEW_SCENE_IDS as readonly string[]).includes(value);
}

export function isPreviewInteraction(value: unknown): value is PreviewInteraction {
  return typeof value === "string" && (PREVIEW_INTERACTIONS as readonly string[]).includes(value);
}

export function isControlTargetId(value: unknown): value is ControlTargetId {
  return typeof value === "string" && (CONTROL_TARGET_IDS as readonly string[]).includes(value);
}

/** What the preview cannot show, said once wherever scenes are listed. */
export const PREVIEW_SCENE_LIMITS = [
  "Scenes are fixed: sample data only, never the user's projects, threads, files, accounts or current screen, and no way to navigate to anything else.",
  "Not drawn: approval and question cards, a running turn, the machine switcher, open menus and popovers, Theme library and other dialogs, toasts and onboarding.",
  "Settings shows only Appearance; its Custom themes list is empty because the preview never reads saved themes. Its buttons take theme colours but are not motion opt-in controls.",
  "The command palette lists representative sample commands, not the app's full live command set.",
  "One still moment: animations and particles are paused at 2.4s; transitions are shown at their end state.",
  "Interaction states are mirrored, not real input: the page's :hover, :active, :focus, :focus-visible and :focus-within selectors are rewritten in place to also match a preview-only marker, which is set on the chosen control (and, for hover and press, its ancestors). Focus is drawn with keyboard modality.",
  "The animated logo on the new-thread and new-chat landings is assembled, sampled 1.85s into its idle animation with the caret visible. With reduced motion it is assembled and still.",
] as const;
