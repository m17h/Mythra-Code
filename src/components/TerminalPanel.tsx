import { memo, useState } from "react";
import { CircleStop, Eraser, Play, ShieldCheck } from "lucide-react";
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
  return (
    <>
      {props.readOnly && (
        <div className="history-warning">
          <ShieldCheck size={13} /> Read only: commands run without permission to write inside {props.scopeLabel}.
          Switch this thread to Ask or Full access before running anything that edits files.
        </div>
      )}
      {props.running && (
        <div className="terminal-origin" role="status">
          Running in <strong>{props.scopeLabel}</strong>
          {props.runningCommand ? <> · <code>{props.runningCommand}</code></> : null}
        </div>
      )}
      {props.runningElsewhere.map((entry) => (
        <div className="terminal-origin other" key={entry.scope}>
          Still running in <strong>{basename(entry.scope) || entry.scope}</strong>
          {entry.command ? <> · <code>{entry.command}</code></> : null}
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
        <span>$</span>
        <input
          aria-label="Terminal command"
          value={command}
          onChange={(event) => setCommand(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== "Enter" || props.running) return;
            props.onRun(command);
            setCommand("");
          }}
          placeholder="npm test"
        />
        <button
          aria-label={props.running ? "Stop terminal command" : "Run terminal command"}
          onClick={() => {
            if (props.running) {
              props.onStop();
              return;
            }
            props.onRun(command);
            setCommand("");
          }}
        >
          {props.running ? <CircleStop size={14} /> : <Play size={14} />}
        </button>
      </div>
      <div className="studio-actions">
        <button onClick={props.onClear}><Eraser size={13} /> Clear</button>
      </div>
    </>
  );
}

/**
 * Remounted per execution path, so a half-typed command belongs to the project
 * it was written for and never follows the user into another one.
 */
export const TerminalPanel = memo(TerminalPanelInner);
