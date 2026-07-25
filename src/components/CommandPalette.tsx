import { useEffect, useMemo, useRef, useState } from "react";
import { Command, FileCode2, Folder, GitBranch, MessageSquare, Plus, Search, SearchCode, Settings, TerminalSquare, UsersRound, Workflow as WorkflowIcon, Wrench, X } from "lucide-react";
import type { WorkflowDefinition } from "../lib/workflows";
import type { Project, Thread } from "../types";
import type { StudioTab } from "./StudioDock";

interface PaletteAction { id: string; label: string; detail: string; group: string; icon: typeof Command; run: () => void }

export function CommandPalette({ open, projects, threads, workflows, projectActive, onClose, onProject, onThread, onWorkflow, onNewThread, onSettings, onTool }: {
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
}) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const resultsRef = useRef<HTMLDivElement>(null);
  const actions = useMemo<PaletteAction[]>(() => [
    { id: "new", label: "New thread", detail: "Start in the active workspace", group: "Commands", icon: Plus, run: onNewThread },
    { id: "settings", label: "Open settings", detail: "Models, prompts, tools, and appearance", group: "Commands", icon: Settings, run: onSettings },
    ...(projectActive ? [
      { id: "files", label: "Browse project files", detail: "Navigate, preview, search, and attach files", group: "Commands", icon: FileCode2, run: () => onTool("files") },
      { id: "review", label: "Review working changes", detail: "Inspect and approve the current diff", group: "Commands", icon: SearchCode, run: () => onTool("review") },
      { id: "terminal", label: "Open project terminal", detail: "Run commands in the active project folder", group: "Commands", icon: TerminalSquare, run: () => onTool("terminal") },
      { id: "agents", label: "Open agent control", detail: "Watch and manage delegated work", group: "Commands", icon: UsersRound, run: () => onTool("agents") },
      { id: "git", label: "Open Git workspace", detail: "Status, stage, commit, and review CI", group: "Commands", icon: GitBranch, run: () => onTool("git") },
      { id: "tools", label: "Open tools & skills", detail: "Project actions, skills, and MCP servers", group: "Commands", icon: Wrench, run: () => onTool("tools") },
    ] : []),
    ...workflows.filter((workflow) => workflow.enabled).map((workflow) => ({
      id: `workflow-${workflow.id}`,
      label: `Run workflow: ${workflow.name}`,
      detail: `${projects.find((project) => project.id === workflow.projectId)?.name ?? "Missing project"} · ${workflow.steps.length} step${workflow.steps.length === 1 ? "" : "s"}`,
      group: "Workflows",
      icon: WorkflowIcon,
      run: () => onWorkflow(workflow),
    })),
    ...projects.map((project) => ({ id: `project-${project.id}`, label: project.name, detail: project.path, group: "Projects", icon: Folder, run: () => onProject(project) })),
    ...threads.map((thread) => ({ id: `thread-${thread.id}`, label: thread.name || thread.preview || "Untitled thread", detail: thread.preview || "Open thread", group: "Threads", icon: MessageSquare, run: () => onThread(thread) })),
  ].filter((action) => `${action.label} ${action.detail}`.toLowerCase().includes(query.toLowerCase())), [onNewThread, onProject, onSettings, onThread, onTool, onWorkflow, projectActive, projects, query, threads, workflows]);

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
        <div className="palette-results" id="command-palette-results" aria-label="Matching commands" ref={resultsRef}>
          {groups.map((group) => (
            <div className="palette-group" key={group.label} role="group" aria-label={group.label}>
              <span className="palette-group-label" aria-hidden>{group.label}</span>
              {group.items.map(({ action, index }) => (
                <button
                  id={`command-${action.id}`}
                  aria-current={active === index ? "true" : undefined}
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
