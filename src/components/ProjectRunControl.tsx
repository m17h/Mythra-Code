import { useEffect, useRef, useState } from "react";
import { ChevronDown, Play, Sparkles, Square } from "lucide-react";
import { usePopoverFade } from "../hooks/usePopoverFade";
import { MAX_RUN_COMMAND_LENGTH, MAX_RUN_LABEL_LENGTH, runCommandTitle } from "../lib/projectRun";
import type { ProjectRunCommand } from "../types";

/**
 * The top-bar Run button. Grey until the project has a command, lit once it
 * does, and a Stop control while that command is running in the Terminal
 * panel. The command is saved per project — never per thread — either from
 * the editor here or by a model through the bridge.
 */
export function ProjectRunControl({
  projectName,
  run,
  running,
  terminalBusy = false,
  onRun,
  onStop,
  onSave,
}: {
  projectName: string;
  run?: ProjectRunCommand;
  running: boolean;
  /** The Terminal panel is busy with something else, so Run would have to wait. */
  terminalBusy?: boolean;
  onRun: () => void;
  onStop: () => void;
  onSave: (run: { command: string; label: string } | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const { ref: panelRef, present } = usePopoverFade(open);
  const [command, setCommand] = useState(run?.command ?? "");
  const [label, setLabel] = useState(run?.label ?? "");
  const rootRef = useRef<HTMLDivElement>(null);
  const ready = Boolean(run);

  useEffect(() => {
    if (!open) return;
    setCommand(run?.command ?? "");
    setLabel(run?.label ?? "");
  }, [open, run]);

  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
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
      ? `Run ${run!.command}${terminalBusy ? " (the terminal is busy)" : ""}`
      : "No run command yet. Click to set one, or ask the assistant.";
  const draft = command.trim();

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
        title="Edit what the Run button does"
      >
        <ChevronDown size={12} />
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
              onChange={(event) => setCommand(event.target.value.slice(0, MAX_RUN_COMMAND_LENGTH))}
              aria-label={`Run command for ${projectName}`}
              placeholder="npm install && npm run dev"
              rows={3}
              spellCheck={false}
              autoFocus
            />
            <span>Label <em>(optional)</em></span>
            <input
              value={label}
              onChange={(event) => setLabel(event.target.value.slice(0, MAX_RUN_LABEL_LENGTH))}
              aria-label="Run button label"
              placeholder="Dev server"
            />
            <small>Runs from the project folder in the Terminal panel. A thread working in an isolated worktree runs it there instead.</small>
          </div>

          <div className="project-run-hint">
            <Sparkles size={13} aria-hidden="true" />
            <span>You can also ask the assistant, for example “Set the Run button to start the dev server”.</span>
          </div>

          <div className="project-prompt-actions">
            {ready && (
              <button
                type="button"
                className="secondary-button project-run-clear"
                onClick={() => {
                  onSave(null);
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
              disabled={!draft}
              onClick={() => {
                onSave({ command: draft, label: label.trim() });
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
