import { lazy, Suspense, useEffect, useId, useRef, useState } from "react";
import { CircleAlert, ChevronDown, ChevronRight, LoaderCircle, Play, Square } from "lucide-react";
import { usePopoverFade } from "../hooks/usePopoverFade";
import { MAX_RUN_COMMAND_LENGTH, MAX_RUN_LABEL_LENGTH, runCommandTitle } from "../lib/projectRun";
import { useRunCommandDiscovery } from "../hooks/useRunCommandDiscovery";
import type { RunDiscoveryCatalogs } from "../lib/runDiscovery";
import type { ProjectRunCommand } from "../types";
import "./RunSetup.css";

const RunCommandDiscovery = lazy(() => import("./RunCommandDiscovery"));

/**
 * The top-bar Run button. Grey until the project has a command, lit once it
 * does, and a Stop control while that command is running in the Terminal
 * panel. The command is saved per project — never per thread — either from
 * the editor here or by a model through the bridge.
 */
export function ProjectRunControl({
  projectName,
  projectPath,
  discoveryCatalogs,
  lmStudioBaseUrl,
  onDiscoveryAccounts,
  run,
  running,
  terminalBusy = false,
  onRun,
  onStop,
  onSave,
  onDiscovered,
}: {
  projectName: string;
  projectPath?: string;
  discoveryCatalogs?: RunDiscoveryCatalogs;
  lmStudioBaseUrl?: string;
  onDiscoveryAccounts?: () => void;
  run?: ProjectRunCommand;
  running: boolean;
  /** The Terminal panel is busy with something else, so Run would have to wait. */
  terminalBusy?: boolean;
  onRun: () => void;
  onStop: () => void;
  /** A missing `setupCommand` means the project has no setup step. */
  onSave: (run: { command: string; label: string; setupCommand?: string } | null) => void;
  /** Captured when discovery starts, so its result can be checked against the originating project. */
  onDiscovered?: (run: { command: string; label: string; setupCommand?: string }) => void;
}) {
  const discovery = useRunCommandDiscovery(projectPath, lmStudioBaseUrl);
  const [open, setOpen] = useState(false);
  const { ref: panelRef, present } = usePopoverFade(open);
  const [command, setCommand] = useState(run?.command ?? "");
  const [label, setLabel] = useState(run?.label ?? "");
  const [setup, setSetup] = useState(run?.setupCommand ?? "");
  const [setupOpen, setSetupOpen] = useState(Boolean(run?.setupCommand));
  const setupRef = useRef<HTMLTextAreaElement>(null);
  const setupId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const ready = Boolean(run);

  useEffect(() => {
    if (!open) return;
    setCommand(run?.command ?? "");
    setLabel(run?.label ?? "");
    setSetup(run?.setupCommand ?? "");
    setSetupOpen(Boolean(run?.setupCommand));
  }, [open, run]);

  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        if (rootRef.current?.querySelector('[role="menu"]')) return;
        // Escape closes only this popover — never the app-level stop-turn handler.
        event.stopPropagation();
        setOpen(false);
      }
    };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", escape, true);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", escape, true);
    };
  }, [open]);

  const state = running ? "running" : ready ? "ready" : "not set";
  const title = running
    ? `Stop ${runCommandTitle(run)}`
    : ready
      ? `Run ${run!.setupCommand ? `${run!.setupCommand}, then ` : ""}${run!.command}${terminalBusy ? " (the terminal is busy)" : ""}`
      : "No run command yet. Click to set one, or ask the assistant.";
  const draft = command.trim();
  const setupDraft = setup.trim();

  return (
    <div className={`project-run-control ${ready ? "ready" : ""} ${running ? "running" : ""}`} ref={rootRef}>
      <button
        type="button"
        className={`project-run-trigger ${ready ? "ready" : ""} ${running ? "running" : ""}`}
        onClick={() => {
          if (running) onStop();
          else if (ready) onRun();
          else setOpen(true);
        }}
        aria-label={`Run: ${state}`}
        title={title}
      >
        {running ? <Square size={12} /> : <Play size={13} />}
        <span>{running ? "Stop" : "Run"}</span>
        <small>{running ? "Running" : ready ? runCommandTitle(run) : "Not set"}</small>
      </button>
      <button
        type="button"
        className="project-run-edit"
        onClick={() => setOpen((value) => !value)}
        aria-label="Edit run command"
        aria-haspopup="dialog"
        aria-expanded={open}
        title={discovery.pending ? "Finding dev command…" : discovery.error ? "Discovery failed — open for details" : "Edit run command"}
      >
        {discovery.pending ? <LoaderCircle size={12} className="spin" /> : discovery.error ? <CircleAlert size={12} /> : <ChevronDown size={12} />}
      </button>

      {present && (
        <div ref={panelRef} className="project-prompt-popover project-run-popover" style={{ opacity: 0 }} aria-hidden={!open || undefined} inert={!open || undefined} role="dialog" aria-label={`Run command for ${projectName}`}>
          <div className="project-prompt-heading">
            <span className="project-prompt-icon"><Play size={15} /></span>
            <div>
              <strong>Run button</strong>
              <small>Saved for {projectName}. Every thread in this project shares it.</small>
            </div>
          </div>

          <div className="project-prompt-editor">
            <span>Command</span>
            <textarea
              value={command}
              disabled={discovery.pending}
              onChange={(event) => setCommand(event.target.value.slice(0, MAX_RUN_COMMAND_LENGTH))}
              aria-label={`Run command for ${projectName}`}
              placeholder="npm run dev"
              rows={3}
              spellCheck={false}
              autoFocus
            />
            <span>Label <em>(optional)</em></span>
            <input
              value={label}
              disabled={discovery.pending}
              onChange={(event) => setLabel(event.target.value.slice(0, MAX_RUN_LABEL_LENGTH))}
              aria-label="Run button label"
              placeholder="Dev server"
            />
            <button
              type="button"
              className={`run-setup-toggle ${setupOpen ? "open" : ""}`}
              aria-expanded={setupOpen}
              aria-controls={setupId}
              disabled={discovery.pending}
              onClick={() => {
                const next = !setupOpen;
                setSetupOpen(next);
                if (next) requestAnimationFrame(() => setupRef.current?.focus({ preventScroll: true }));
              }}
            >
              <ChevronRight size={12} aria-hidden="true" />
              Before each run <em>(optional)</em>
              {!setupOpen && setupDraft && <code>{setupDraft}</code>}
            </button>
            <div className="run-setup-reveal" id={setupId} data-open={setupOpen || undefined} inert={!setupOpen || undefined}>
              <div className="run-setup-clip">
                <textarea
                  ref={setupRef}
                  value={setup}
                  disabled={discovery.pending}
                  onChange={(event) => setSetup(event.target.value.slice(0, MAX_RUN_COMMAND_LENGTH))}
                  aria-label={`Setup command for ${projectName}`}
                  placeholder="npm install"
                  rows={2}
                  spellCheck={false}
                />
                <small>Runs first, in the same shell, every time. Keep it quick and safe to repeat.</small>
              </div>
            </div>
            <small>Runs from the project folder in the Terminal panel. A thread working in an isolated worktree runs it there instead.</small>
          </div>

          {projectPath && <Suspense fallback={<small>Loading discovery…</small>}>
            <RunCommandDiscovery discovery={discovery} catalogs={discoveryCatalogs} onAccounts={onDiscoveryAccounts} onFound={onDiscovered ?? onSave} />
          </Suspense>}

          <div className="project-prompt-actions">
            {ready && (
              <button
                type="button"
                className="secondary-button project-run-clear"
                disabled={discovery.pending}
                onClick={() => {
                  onSave(null);
                  discovery.clearSuggestion();
                  setOpen(false);
                }}
              >
                Clear
              </button>
            )}
            <button type="button" className="secondary-button" onClick={() => setOpen(false)}>Cancel</button>
            <button
              type="button"
              className="primary-button"
              disabled={!draft || discovery.pending}
              onClick={() => {
                onSave({ command: draft, label: label.trim(), ...(setupDraft ? { setupCommand: setupDraft } : {}) });
                discovery.clearSuggestion();
                setOpen(false);
              }}
            >
              Save run command
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
