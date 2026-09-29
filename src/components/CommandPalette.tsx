import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowDownToLine, Command, FileCode2, FileDiff, Folder, Gauge, GitBranch, GitCommitHorizontal, GitFork, GitPullRequest, History, MessageSquare, Paperclip, Plus, RefreshCw, Search, SearchCode, Settings, TerminalSquare, Upload, UsersRound, Workflow as WorkflowIcon, Wrench, X } from "lucide-react";
import type { WorkflowDefinition } from "../lib/workflows";
import type { Project, Thread } from "../types";
import type { StudioTab } from "../lib/studioTabs";
import type { GitRoute } from "../lib/projectGit";

interface PaletteAction { id: string; label: string; detail: string; group: string; icon: typeof Command; run: () => void; aliases?: string[] }

// Match words independently so punctuation in labels ("Git: Changes") and
// natural word order ("git branch") do not hide otherwise matching commands.
function searchWords(value: string): string[] {
  return value.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}

const TOOL_ACTIONS: Array<[StudioTab, string, string, typeof Command]> = [
  ["files", "Browse project files", "Navigate, preview, search, and attach files", FileCode2],
  ["review", "Review working changes", "Inspect and approve the current diff", SearchCode],
  ["terminal", "Open project terminal", "Run commands in the active project folder", TerminalSquare],
  ["agents", "Open agent control", "Watch and manage delegated work", UsersRound],
  ["checkpoints", "Open checkpoints", "Restore, reapply, accept, and preview saved project states", History],
  ["worktrees", "Open worktrees", "Review, apply, merge, recover, and clean up isolated branches", GitFork],
  ["context", "Open context attachments", "Files and images sent with the next message", Paperclip],
  ["usage", "Open usage & audit", "Thread tokens, context pressure, plan limits, and request fields", Gauge],
  ["git", "Open Git workspace", "Changes, commits, branches, pull requests, and history", GitBranch],
  ["tools", "Open tools & skills", "Project actions, skills, and MCP servers", Wrench],
];

/**
 * Git destinations. Each one opens a view and focuses a control; none of them
 * runs Git. "Push" lands on the Push button, which still has to be pressed.
 */
const GIT_ROUTES: Array<[string, string, string, Omit<GitRoute, "nonce">, typeof Command]> = [
  ["git-changes", "Git: Changes", "Staged, unstaged and new files · stage, unstage, diff", { view: "changes" }, FileDiff],
  ["git-commit", "Git: Commit…", "Write a commit message · nothing is committed until you press Commit", { view: "changes", focus: "commit" }, GitCommitHorizontal],
  ["git-branch", "Git: Switch or create branch…", "Checkout · new branch · branch menu", { view: "changes", focus: "branch" }, GitBranch],
  ["git-fetch", "Git: Fetch…", "Go to Fetch · downloads remote status when pressed; files unchanged", { view: "changes", focus: "fetch" }, RefreshCw],
  ["git-pull", "Git: Pull (fast-forward)…", "Go to Pull · update from the tracked branch when pressed", { view: "changes", focus: "pull" }, ArrowDownToLine],
  ["git-push", "Git: Push…", "Go to Push · upload committed work when pressed · publish", { view: "changes", focus: "push" }, Upload],
  ["git-pulls", "Git: Pull requests", "PR · browse, search, checks, reviews, merge", { view: "pulls", focus: "pullRequestSearch" }, GitPullRequest],
  ["git-history", "Git: History", "Commit log for the current branch", { view: "history" }, History],
];

export function CommandPalette({ open, projects, threads, workflows, projectActive, onClose, onProject, onThread, onWorkflow, onNewThread, onSettings, onTool, onGitRoute }: {
  open: boolean;
  projects: Project[];
  threads: Thread[];
  workflows: WorkflowDefinition[];
  projectActive: boolean;
  onClose: () => void;
  onProject: (project: Project) => void;
  onThread: (thread: Thread) => void;
  onWorkflow: (workflow: WorkflowDefinition) => void;
  onNewThread: () => void;
  onSettings: () => void;
  onTool: (tab: StudioTab) => void;
  /** Opens a Git view and focuses a control. Never runs a Git action. */
  onGitRoute?: (route: Omit<GitRoute, "nonce">) => void;
}) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const resultsRef = useRef<HTMLDivElement>(null);
  const actions = useMemo<PaletteAction[]>(() => {
    const allActions: PaletteAction[] = [
    { id: "new", label: "New thread", detail: "Start in the active workspace", group: "Commands", icon: Plus, run: onNewThread },
    { id: "settings", label: "Open settings", detail: "Models, prompts, tools, and appearance", group: "Commands", icon: Settings, run: onSettings },
    ...(projectActive ? TOOL_ACTIONS.map(([id, label, detail, icon]) => ({ id, label, detail, icon, group: "Commands", run: () => onTool(id) })) : []),
    ...(projectActive && onGitRoute ? GIT_ROUTES.map(([id, label, detail, route, icon]) => ({ id, label, detail, icon, group: "Git", aliases: [id.replaceAll("-", " "), label, ...(id === "git-pulls" ? ["git pr", "git pull requests"] : [])], run: () => onGitRoute(route) })) : []),
    ...workflows.filter((workflow) => workflow.enabled).map((workflow) => ({
      id: `workflow-${workflow.id}`,
      label: `Run workflow: ${workflow.name}`,
      detail: `${projects.find((project) => project.id === workflow.projectId)?.name ?? (workflow.projectId ? "Choose a project" : "Any project")} · ${workflow.steps.length} step${workflow.steps.length === 1 ? "" : "s"}`,
      group: "Workflows",
      icon: WorkflowIcon,
      run: () => onWorkflow(workflow),
    })),
    ...projects.map((project) => ({ id: `project-${project.id}`, label: project.name, detail: project.path, group: "Projects", icon: Folder, run: () => onProject(project) })),
    ...threads.map((thread) => ({ id: `thread-${thread.id}`, label: thread.name || thread.preview || "Untitled thread", detail: thread.preview || "Open thread", group: "Threads", icon: MessageSquare, run: () => onThread(thread) })),
    ];
    const terms = searchWords(query);
    const canonicalQuery = [...terms].sort().join(" ");
    const matchesAlias = (action: PaletteAction) => action.aliases?.some((alias) => searchWords(alias).sort().join(" ") === canonicalQuery);
    // An explicit Git destination must win over incidental words such as
    // "press" matching "PR" or the generic Open Git workspace command.
    const exactDestination = canonicalQuery && allActions.some(matchesAlias);
    return allActions.filter((action) => {
      if (exactDestination) return matchesAlias(action);
      const words = searchWords(`${action.label} ${action.detail} ${action.group}`);
      return terms.every((term) => words.some((word) => word.includes(term)));
    });
  }, [onGitRoute, onNewThread, onProject, onSettings, onThread, onTool, onWorkflow, projectActive, projects, query, threads, workflows]);

  // Results keep one flat keyboard order but render under category headings, so
  // arrowing through the list never jumps between unrelated kinds of result.
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
    requestAnimationFrame(() => inputRef.current?.focus());
  }, [open]);

  // Keyboard selection has to stay visible when the list scrolls past the fold.
  // Guarded because non-browser DOM implementations omit scrollIntoView.
  useEffect(() => {
    const selected = resultsRef.current?.querySelector<HTMLElement>("button.active");
    selected?.scrollIntoView?.({ block: "nearest" });
  }, [active]);

  if (!open) return null;
  return (
    <div className="modal-backdrop palette-backdrop" onMouseDown={onClose}>
      <div className="command-palette" role="dialog" aria-modal="true" aria-label="Command palette" onMouseDown={(event) => event.stopPropagation()}>
        <div className="palette-search">
          <Search size={16} />
          <input
            aria-label="Search commands, projects, and threads"
            aria-controls="command-palette-results"
            aria-activedescendant={actions[active] ? `command-${actions[active].id}` : undefined}
            ref={inputRef}
            value={query}
            onChange={(event) => { setQuery(event.target.value); setActive(0); }}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown") { event.preventDefault(); setActive((value) => Math.min(actions.length - 1, value + 1)); }
              if (event.key === "ArrowUp") { event.preventDefault(); setActive((value) => Math.max(0, value - 1)); }
              if (event.key === "Enter" && actions[active]) { actions[active].run(); onClose(); }
              if (event.key === "Escape") onClose();
            }}
            placeholder="Search commands, projects, and threads…"
          />
          <button onClick={onClose} aria-label="Close command palette"><X size={14} /></button>
        </div>
        <div className="palette-results" id="command-palette-results" role="listbox" aria-label="Matching commands" ref={resultsRef}>
          {groups.map((group) => (
            <div className="palette-group" key={group.label} role="group" aria-label={group.label}>
              <span className="palette-group-label" aria-hidden>{group.label}</span>
              {group.items.map(({ action, index }) => (
                <button
                  id={`command-${action.id}`}
                  role="option"
                  aria-selected={active === index}
                  key={action.id}
                  className={active === index ? "active" : ""}
                  onMouseEnter={() => setActive(index)}
                  onClick={() => { action.run(); onClose(); }}
                >
                  <span><action.icon size={14} /></span>
                  <div><strong>{action.label}</strong><small>{action.detail}</small></div>
                  <kbd>↵</kbd>
                </button>
              ))}
            </div>
          ))}
          {!actions.length && <div className="palette-empty">No matching command</div>}
        </div>
        <div className="palette-footer">
          <span><kbd>↑↓</kbd> Navigate</span>
          <span><kbd>↵</kbd> Open</span>
          <span><kbd>esc</kbd> Close</span>
        </div>
      </div>
    </div>
  );
}
