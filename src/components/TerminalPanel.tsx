import { memo, useState, type ReactNode } from "react";
import { ChevronRight, Eraser, Play, ShieldCheck, Square } from "lucide-react";
import { XtermPanel } from "./XtermPanel";
import type { RunningTerminalCommand, TerminalOutputStore } from "../hooks/useTerminal";
import { basename } from "../lib/paths";
import { shellLabel } from "../lib/shellCommand";

export interface TerminalPanelProps {
  outputStore: TerminalOutputStore;
  /** Execution path this panel is showing; also the command draft's identity. */
  scope: string;
  scopeLabel: string;
  /** Names the shell on another machine. This device's is the default. */
  shell?: string;
  running: boolean;
  runningCommand: string;
  runningElsewhere: RunningTerminalCommand[];
  readOnly: boolean;
  /** Returning a promise keeps the typed command until the run is accepted. */
  onRun: (command: string) => void | Promise<boolean>;
  /** Another device's view: whether this person may start, type into or stop a command here. Local leaves these on. */
  canRun?: boolean;
  canControl?: boolean;
  /** Why controls are off, shown on the disabled controls. */
  controlReason?: string;
  /** Replaces the "still running elsewhere" rows with a fuller, interactive list. */
  sessionList?: ReactNode;
  onStop: () => void;
  onClear: () => void;
  onInput: (value: string) => void;
  onResize: (columns: number, rows: number) => void;
}

/**
 * The command line lives here rather than in the app shell: every keystroke in
 * a top-level state field re-rendered the whole application, including the
 * conversation timeline.
 */
const ignoreInput = () => undefined;

function TerminalPanelInner(props: TerminalPanelProps) {
  const [command, setCommand] = useState("");
  const [starting, setStarting] = useState(false);
  const allowedToRun = props.canRun !== false;
  const allowedToControl = props.canControl !== false;
  const canRun = allowedToRun && !starting && !props.running && Boolean(command.trim());
  const run = () => {
    if (!canRun) return;
    const accepted = props.onRun(command);
    if (!accepted) { setCommand(""); return; }
    // Kept until the other side accepts it, so a refusal never loses what was typed.
    const typed = command;
    setStarting(true);
    void accepted.then((ok) => { if (ok) setCommand((current) => current === typed ? "" : current); }).finally(() => setStarting(false));
  };
  return (
    <div className="terminal-panel">
      {props.readOnly && (
        <div className="history-warning terminal-notice">
          <ShieldCheck size={13} /> Read only: commands run without permission to write inside {props.scopeLabel}.
          Switch this thread to Ask or Full access before running anything that edits files.
        </div>
      )}
      <section className={`terminal-window${props.running ? " running" : ""}`} aria-label={`Terminal for ${props.scopeLabel}`}>
        <div className="terminal-bar">
          <div className="terminal-status" role="status">
            <span className="terminal-status-dot" aria-hidden="true" />
            {props.running ? (
              <span className="terminal-status-text">
                Running in <strong>{props.scopeLabel}</strong>
                {props.runningCommand ? <> · <code title={props.runningCommand}>{props.runningCommand}</code></> : null}
              </span>
            ) : (
              <span className="terminal-status-text">Ready <span className="terminal-shell">{props.shell ?? shellLabel()}</span></span>
            )}
          </div>
          <button type="button" className="terminal-tool" onClick={props.onClear} aria-label="Clear terminal" title="Clear output">
            <Eraser size={13} />
          </button>
        </div>
        {props.sessionList ?? props.runningElsewhere.map((entry) => (
          <div className="terminal-elsewhere" key={entry.scope}>
            <span className="terminal-status-dot" aria-hidden="true" />
            <span className="terminal-status-text">
              Still running in <strong>{basename(entry.scope) || entry.scope}</strong>
              {entry.command ? <> · <code title={entry.command}>{entry.command}</code></> : null}
            </span>
          </div>
        ))}
        <XtermPanel
          outputStore={props.outputStore}
          placeholder={`MYTHRA CODE terminal ready — ${props.scopeLabel} (${props.shell ?? shellLabel()})\n`}
          running={props.running}
          onInput={allowedToControl ? props.onInput : ignoreInput}
          onResize={props.onResize}
        />
        <div className="terminal-input">
          <ChevronRight size={14} aria-hidden="true" />
          <input
            aria-label="Terminal command"
            value={command}
            disabled={props.running ? !allowedToControl : !allowedToRun}
            title={(props.running ? !allowedToControl : !allowedToRun) ? props.controlReason : undefined}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            autoComplete="off"
            onChange={(event) => setCommand(event.target.value)}
            onKeyDown={(event) => {
              // Enter that confirms an IME composition is not a request to run.
              if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
              event.preventDefault();
              run();
            }}
            placeholder={props.running ? allowedToControl ? "Type into the terminal above" : "Watching this command" : "Run a command"}
          />
          {props.running ? (
            <button type="button" className="terminal-run stop" onClick={props.onStop} disabled={!allowedToControl} aria-label="Stop terminal command" title={allowedToControl ? "Stop" : props.controlReason ?? "Only the device that started this command can stop it"}>
              <Square size={11} fill="currentColor" />
            </button>
          ) : (
            <button type="button" className="terminal-run" onClick={run} disabled={!canRun} aria-busy={starting || undefined} aria-label="Run terminal command" title={allowedToRun ? "Run (Enter)" : props.controlReason ?? "Run (Enter)"}>
              <Play size={12} fill="currentColor" />
            </button>
          )}
        </div>
      </section>
    </div>
  );
}

/**
 * Remounted per execution path, so a half-typed command belongs to the project
 * it was written for and never follows the user into another one.
 */
export const TerminalPanel = memo(TerminalPanelInner);
