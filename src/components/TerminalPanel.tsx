import { memo, useState } from "react";
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
  running: boolean;
  runningCommand: string;
  runningElsewhere: RunningTerminalCommand[];
  readOnly: boolean;
  onRun: (command: string) => void;
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
function TerminalPanelInner(props: TerminalPanelProps) {
  const [command, setCommand] = useState("");
  const canRun = !props.running && Boolean(command.trim());
  const run = () => {
    if (!canRun) return;
    props.onRun(command);
    setCommand("");
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
              <span className="terminal-status-text">Ready <span className="terminal-shell">{shellLabel()}</span></span>
            )}
          </div>
          <button type="button" className="terminal-tool" onClick={props.onClear} aria-label="Clear terminal" title="Clear output">
            <Eraser size={13} />
          </button>
        </div>
        {props.runningElsewhere.map((entry) => (
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
          placeholder={`MYTHRA CODE terminal ready — ${props.scopeLabel} (${shellLabel()})\n`}
          running={props.running}
          onInput={props.onInput}
          onResize={props.onResize}
        />
        <div className="terminal-input">
          <ChevronRight size={14} aria-hidden="true" />
          <input
            aria-label="Terminal command"
            value={command}
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
            placeholder={props.running ? "Type into the terminal above" : "Run a command"}
          />
          {props.running ? (
            <button type="button" className="terminal-run stop" onClick={props.onStop} aria-label="Stop terminal command" title="Stop">
              <Square size={11} fill="currentColor" />
            </button>
          ) : (
            <button type="button" className="terminal-run" onClick={run} disabled={!canRun} aria-label="Run terminal command" title="Run (Enter)">
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
