import { EmptyState } from "./EmptyState";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ArrowDownToLine, Command, Folder, GitBranch, GitCommitHorizontal, GitPullRequest, History, MessageSquare, Plus, RefreshCw, Search, Settings, Upload, Workflow as WorkflowIcon, X } from "lucide-react";
import type { WorkflowDefinition } from "../lib/workflows";
import type { Project, SettingsSection, Thread } from "../types";
import { STUDIO_TAB_IDS, type StudioTab } from "../lib/studioTabs";
import type { GitRoute } from "../lib/projectGit";
import { formatKeys, workspaceTabShortcut } from "../lib/shortcuts";
import { useModalFocus } from "../hooks/useModalFocus";
import { searchWords } from "../lib/searchMatch";
import { SETTINGS_PANE_ICONS } from "./settingsPaneIcons";
import { STUDIO_TAB_META } from "./studioTabMeta";

/** A command the app adds to the palette (thread actions, toggles, stop). */
export interface PaletteCommand {
  id: string;
  label: string;
  /** Shown only on the highlighted row. */
  detail?: string;
  /** Heading the command is listed under; defaults to "Commands". */
  group?: string;
  icon?: typeof Command;
  /** Already formatted for this platform (see `formatShortcut`). */
  shortcut?: string;
  /** Extra words that should find this command. */
  keywords?: string;
  /** Says why it can't run; the row stays listed but can't be chosen. */
  disabledReason?: string;
  run: () => void;
}

interface PaletteAction extends PaletteCommand { group: string; icon: typeof Command; aliases?: string[]; order: number }

// Word matching is shared with the shortcuts sheet (src/lib/searchMatch.ts).

/**
 * What each Tools tab is for. The name and icon come from the rail's own
 * metadata (STUDIO_TAB_META) so the two can't drift apart; only this
 * description is the palette's.
 */
export const TOOL_DESCRIPTIONS: Record<StudioTab, string> = {
  changes: "Stage, commit, diff, AI review and checks",
  git: "Branch, fetch, pull, push, pull requests and history",
  checkpoints: "Restore, reapply, accept and preview saved project states",
  worktrees: "Review, apply, merge and clean up the isolated branch",
  files: "Browse, preview, search and attach project files",
  terminal: "Run commands in the project folder",
  actions: "Run command, checks, quick actions and workflows",
  agents: "Watch and manage delegated work",
  usage: "Cost, tokens and context for this thread",
  skills: "Skills and MCP servers",
};

/** The palette's Tools entries, in rail order. */
export const TOOL_ACTIONS: Array<[StudioTab, string, string, typeof Command]> = STUDIO_TAB_IDS.map((id) =>
  [id, STUDIO_TAB_META[id].label, TOOL_DESCRIPTIONS[id], STUDIO_TAB_META[id].icon]);

/**
 * Git destinations. Each one opens a view and focuses a control; none of them
 * runs Git. "Push" lands on the Push button, which still has to be pressed.
 * Labels match the Git panel's buttons; an ellipsis only where the next step
 * asks for more input (a commit message, a branch name), as in menus.
 */
const GIT_ROUTES: Array<[string, string, string, Omit<GitRoute, "nonce">, typeof Command]> = [
  ["git-commit", "Commit…", "Write a message; nothing is committed until you press Commit", { view: "changes", focus: "commit" }, GitCommitHorizontal],
  ["git-branch", "Switch or create branch…", "Checkout or start a new branch", { view: "changes", focus: "branch" }, GitBranch],
  ["git-fetch", "Fetch", "Goes to Fetch; nothing downloads until you press it", { view: "changes", focus: "fetch" }, RefreshCw],
  ["git-pull", "Pull", "Goes to Pull (fast-forward); nothing changes until you press it", { view: "changes", focus: "pull" }, ArrowDownToLine],
  ["git-push", "Push", "Goes to Push; nothing uploads until you press it", { view: "changes", focus: "push" }, Upload],
  ["git-pulls", "Pull requests", "Browse, search, checks, reviews and merge", { view: "pulls", focus: "pullRequestSearch" }, GitPullRequest],
  ["git-history", "Commit history", "Commit log for the current branch", { view: "history" }, History],
];

/** Settings panes, by the names the Settings rail uses. */
const SETTINGS_PANES: Array<[SettingsSection, string, string]> = [
  ["general", "General", "behavior notifications menu bar"],
  ["appearance", "Appearance", "theme font size dark light"],
  ["models", "Models & accounts", "provider sign in api key account"],
  ["voice", "Voice input", "dictation microphone transcription"],
  ["prompts", "Instructions", "system prompt agents.md claude.md"],
  ["memory", "Memory", "learning preferences"],
  ["agents", "Sub-agents", "delegate crew presets"],
  ["skills", "Skills", "markdown skills"],
  ["tools", "MCP & language servers", "mcp servers language tools lsp"],
  ["workflows", "Workflows", "recipes quick actions"],
  ["scheduled-tasks", "Scheduled tasks", "schedule timer recurring"],
  ["projects", "Projects", "project folders overrides"],
  ["github", "GitHub", "clone repository"],
  ["devices", "Devices", "remote pair network"],
  ["usage", "Usage", "quota cost pricing"],
  ["updates", "Updates", "version upgrade"],
  ["system", "Advanced", "terminal diagnostics privacy"],
];

const GROUP_ORDER = ["Best match", "Suggested", "Recent threads", "Commands", "Thread", "Project", "Tools", "Git", "Settings", "Workflows", "Projects", "Threads"];

/** Keeps a long thread list from burying every command when nothing is typed. */
const EMPTY_QUERY_THREAD_LIMIT = 5;
/** With nothing typed, what the moment calls for leads: stop a run, answer an
 * approval, or start something new. */
const SUGGESTED_IDS = ["focus-approval", "stop", "new"];

/** 0 = the label is the query, 1 = the label starts with it, 2 = every word
 * is in the label, 3 = found only in detail or keywords. */
function matchRank(action: { label: string }, terms: string[], canonical: string): number {
  const words = searchWords(action.label);
  if (words.join(" ") === canonical || [...words].sort().join(" ") === [...terms].sort().join(" ")) return 0;
  if (words.join(" ").startsWith(canonical)) return 1;
  if (terms.every((term) => words.some((word) => word.includes(term)))) return 2;
  return 3;
}

function highlight(text: string, terms: string[]): ReactNode {
  if (!terms.length) return text;
  const lower = text.toLowerCase();
  const ranges: Array<[number, number]> = [];
  for (const term of terms) {
    let from = 0;
    while (term && (from = lower.indexOf(term, from)) !== -1) {
      ranges.push([from, from + term.length]);
      from += term.length;
    }
  }
  if (!ranges.length) return text;
  ranges.sort((a, b) => a[0] - b[0]);
  const merged: Array<[number, number]> = [];
  for (const range of ranges) {
    const last = merged[merged.length - 1];
    if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1]);
    else merged.push([...range] as [number, number]);
  }
  const parts: ReactNode[] = [];
  let cursor = 0;
  merged.forEach(([start, end], index) => {
    if (start > cursor) parts.push(text.slice(cursor, start));
    parts.push(<mark key={index}>{text.slice(start, end)}</mark>);
    cursor = end;
  });
  if (cursor < text.length) parts.push(text.slice(cursor));
  return parts;
}

export function CommandPalette({ open, projects, threads, workflows, projectActive, commands = [], onClose, onProject, onThread, onWorkflow, onNewThread, onSettings, onTool, onGitRoute }: {
  open: boolean;
  projects: Project[];
  threads: Thread[];
  workflows: WorkflowDefinition[];
  projectActive: boolean;
  /** Everyday actions the app owns: stop, toggles, thread "…" menu actions. */
  commands?: PaletteCommand[];
  onClose: () => void;
  onProject: (project: Project) => void;
  onThread: (thread: Thread) => void;
  onWorkflow: (workflow: WorkflowDefinition) => void;
  onNewThread: () => void;
  onSettings: (section?: SettingsSection) => void;
  onTool: (tab: StudioTab) => void;
  /** Opens a Git view and focuses a control. Never runs a Git action. */
  onGitRoute?: (route: Omit<GitRoute, "nonce">) => void;
}) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const resultsRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const pointerRef = useRef<{ x: number; y: number } | null>(null);
  useModalFocus(dialogRef, open);
  const terms = useMemo(() => searchWords(query), [query]);
  const actions = useMemo<PaletteAction[]>(() => {
    let order = 0;
    const next = () => order++;
    const allActions: PaletteAction[] = [
      { id: "new", label: "New thread", detail: "Start in the active project or Chats", group: "Commands", icon: Plus, shortcut: formatKeys(["Mod", "N"]), run: onNewThread, order: next() },
      ...commands.map((command) => ({ ...command, group: command.group ?? "Commands", icon: command.icon ?? Command, order: next() })),
      ...(projectActive ? TOOL_ACTIONS.map(([id, label, detail, icon]) => ({
        id: `tool-${id}`, label, detail, icon, group: "Tools", keywords: `open tools panel workspace ${id}${id === "changes" ? " git diff stage" : ""}`,
        ...(id === "changes" ? { aliases: ["git changes"] } : {}),
        shortcut: workspaceTabShortcut(STUDIO_TAB_IDS.indexOf(id) + 1), run: () => onTool(id), order: next(),
      })) : []),
      ...(projectActive && onGitRoute ? GIT_ROUTES.map(([id, label, detail, route, icon]) => ({
        id, label, detail, icon, group: "Git", keywords: "git",
        aliases: [id.replaceAll("-", " "), `git ${label}`, ...(id === "git-pulls" ? ["git pr", "git pull requests"] : [])],
        run: () => onGitRoute(route), order: next(),
      })) : []),
      { id: "settings", label: "Open Settings", detail: "All settings", group: "Settings", icon: Settings, shortcut: formatKeys(["Mod", ","]), run: () => onSettings(), order: next() },
      ...SETTINGS_PANES.map(([section, label, keywords]) => ({
        id: `settings-${section}`, label, detail: `Settings · ${label}`, group: "Settings", icon: SETTINGS_PANE_ICONS[section], keywords: `settings ${keywords}`,
        run: () => onSettings(section), order: next(),
      })),
      ...workflows.filter((workflow) => workflow.enabled).map((workflow) => ({
        id: `workflow-${workflow.id}`,
        label: workflow.name,
        // A workflow on another device names that device; its steps aren't listed here.
        detail: (workflow as WorkflowDefinition & { paletteDetail?: string }).paletteDetail ?? `${projects.find((project) => project.id === workflow.projectId)?.name ?? (workflow.projectId ? "Choose a project" : "Any project")} · ${workflow.steps.length} step${workflow.steps.length === 1 ? "" : "s"}`,
        group: "Workflows",
        icon: WorkflowIcon,
        keywords: "run workflow",
        run: () => onWorkflow(workflow),
        order: next(),
      })),
      ...projects.map((project) => ({ id: `project-${project.id}`, label: project.name, detail: project.path, group: "Projects", icon: Folder, run: () => onProject(project), order: next() })),
      ...threads.map((thread) => ({ id: `thread-${thread.id}`, label: thread.name || thread.preview || "Untitled thread", detail: thread.name && thread.preview ? thread.preview : undefined, group: "Threads", icon: MessageSquare, run: () => onThread(thread), order: next() })),
    ];
    const canonicalQuery = [...terms].sort().join(" ");
    const matchesAlias = (action: PaletteAction) => action.aliases?.some((alias) => searchWords(alias).sort().join(" ") === canonicalQuery);
    // An explicit Git destination must win over incidental words such as
    // "press" matching "PR" or the generic Open Git workspace command.
    const exactDestination = canonicalQuery && allActions.some(matchesAlias);
    let threadCount = 0;
    const typed = terms.join(" ");
    const filtered = allActions.filter((action) => {
      if (exactDestination) return matchesAlias(action);
      if (!terms.length) {
        // Settings panes and Git destinations are found by typing; the empty
        // palette leads with everyday commands and recent threads.
        if (action.group === "Settings" && action.id !== "settings") return false;
        if (action.group === "Git") return false;
        if (action.group === "Threads") return threadCount++ < EMPTY_QUERY_THREAD_LIMIT;
        return true;
      }
      const words = searchWords(`${action.label} ${action.detail ?? ""} ${action.group} ${action.keywords ?? ""}`);
      return terms.every((term) => words.some((word) => word.includes(term)));
    });
    const placed = filtered.map((action) => {
      if (!terms.length) {
        if (SUGGESTED_IDS.includes(action.id)) return { ...action, group: "Suggested", rank: SUGGESTED_IDS.indexOf(action.id) };
        if (action.group === "Threads") return { ...action, group: "Recent threads", rank: 0 };
        return { ...action, rank: 0 };
      }
      const rank = matchRank(action, terms, typed);
      // A command whose name is exactly what was typed comes first, ahead of
      // every incidental match, and is not listed a second time below.
      return rank === 0 ? { ...action, group: "Best match", rank } : { ...action, rank };
    });
    // Group order is fixed so arrowing never jumps between kinds of result;
    // inside a group, closer name matches come first.
    return placed.sort((a, b) => {
      const groupA = GROUP_ORDER.indexOf(a.group);
      const groupB = GROUP_ORDER.indexOf(b.group);
      return (groupA === -1 ? 99 : groupA) - (groupB === -1 ? 99 : groupB) || a.rank - b.rank || a.order - b.order;
    });
  }, [commands, onGitRoute, onNewThread, onProject, onSettings, onThread, onTool, onWorkflow, projectActive, projects, terms, threads, workflows]);

  const groups = useMemo(() => {
    const order: string[] = [];
    const buckets = new Map<string, Array<{ action: PaletteAction; index: number }>>();
    actions.forEach((action, index) => {
      if (!buckets.has(action.group)) {
        buckets.set(action.group, []);
        order.push(action.group);
      }
      buckets.get(action.group)!.push({ action, index });
    });
    return order.map((label) => ({ label, items: buckets.get(label)! }));
  }, [actions]);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setActive(0);
    pointerRef.current = null;
    // useModalFocus already focuses the input during this commit. A later
    // queued focus would steal focus back after the user's first Tab.
  }, [open]);

  // Keyboard selection has to stay visible when the list scrolls past the fold.
  // Guarded because non-browser DOM implementations omit scrollIntoView.
  useEffect(() => {
    const selected = resultsRef.current?.querySelector<HTMLElement>("[role='option'].active");
    selected?.scrollIntoView?.({ block: "nearest" });
  }, [active]);

  if (!open) return null;
  const choose = (action: PaletteAction | undefined) => {
    if (!action || action.disabledReason) return;
    onClose();
    action.run();
  };
  const move = (delta: number) => setActive((value) => {
    if (!actions.length) return 0;
    return (value + delta + actions.length) % actions.length;
  });
  const activeAction = actions[active];
  return (
    <div className="modal-backdrop palette-backdrop" onMouseDown={onClose}>
      <div ref={dialogRef} className="command-palette" role="dialog" aria-modal="true" aria-label="Command palette" onMouseDown={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key !== "Escape" || event.defaultPrevented) return;
          event.preventDefault();
          event.stopPropagation();
          onClose();
        }}>
        <div className="palette-search">
          <Search size={16} aria-hidden="true" />
          <input
            role="combobox"
            aria-expanded="true"
            aria-haspopup="listbox"
            aria-autocomplete="list"
            aria-label="Search commands, projects and threads"
            aria-controls="command-palette-results"
            aria-activedescendant={activeAction ? `command-${activeAction.id}` : undefined}
            ref={inputRef}
            value={query}
            onChange={(event) => { setQuery(event.target.value); setActive(0); }}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown") { event.preventDefault(); move(1); }
              else if (event.key === "ArrowUp") { event.preventDefault(); move(-1); }
              else if (event.key === "PageDown") { event.preventDefault(); setActive((value) => Math.min(actions.length - 1, value + 8)); }
              else if (event.key === "PageUp") { event.preventDefault(); setActive((value) => Math.max(0, value - 8)); }
              else if (event.key === "Enter") { event.preventDefault(); choose(activeAction); }
            }}
            placeholder="Search commands, projects and threads…"
          />
          <button onClick={onClose} aria-label="Close command palette" tabIndex={-1}><X size={14} /></button>
        </div>
        <div className="palette-results" id="command-palette-results" role="listbox" aria-label="Results" ref={resultsRef}>
          {groups.map((group) => (
            <div className="palette-group" key={group.label} role="group" aria-label={group.label}>
              <span className="palette-group-label" aria-hidden>{group.label}</span>
              {group.items.map(({ action, index }) => {
                const isActive = active === index;
                return (
                  <div
                    id={`command-${action.id}`}
                    role="option"
                    aria-selected={isActive}
                    aria-disabled={action.disabledReason ? true : undefined}
                    key={action.id}
                    className={`palette-row ${isActive ? "active" : ""} ${action.disabledReason ? "disabled" : ""}`}
                    title={action.disabledReason}
                    // Only real pointer movement moves the selection, so a list
                    // scrolling under a still pointer never steals it.
                    onPointerMove={(event) => {
                      const last = pointerRef.current;
                      pointerRef.current = { x: event.clientX, y: event.clientY };
                      if (!last || (last.x === event.clientX && last.y === event.clientY)) return;
                      if (!isActive) setActive(index);
                    }}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => choose(action)}
                  >
                    <span className="palette-row-icon" aria-hidden="true"><action.icon size={14} /></span>
                    <span className="palette-row-text">
                      <span className="palette-row-label">{highlight(action.label, terms)}</span>
                      {isActive && (action.disabledReason || action.detail) && <span className="palette-row-detail">{action.disabledReason ?? action.detail}</span>}
                    </span>
                    {action.shortcut && <kbd className="palette-row-keys" aria-label={`Shortcut ${action.shortcut}`}>{action.shortcut}</kbd>}
                  </div>
                );
              })}
            </div>
          ))}
          {!actions.length && <EmptyState variant="compact" className="palette-empty" icon={Search} role="status" title="No results" text={<>Nothing matches “{query.trim()}”. Try a command, project or thread name.</>} />}
        </div>
        <div className="palette-footer" aria-hidden="true">
          <span><kbd>↑↓</kbd> Navigate</span>
          <span><kbd>↩</kbd> Open</span>
          <span><kbd>Esc</kbd> Close</span>
        </div>
      </div>
    </div>
  );
}
