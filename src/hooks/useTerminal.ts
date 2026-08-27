import { useCallback, useReducer, useRef, type MutableRefObject } from "react";
import { rpc } from "../lib/codex";
import { friendlyError } from "../lib/errors";
import { shellCommand } from "../lib/shellCommand";
import { commandSandbox } from "../lib/turnConfig";
import type { PermissionMode } from "../types";

/**
 * Upper bound on a single retained chunk. Keeps the chunk list short (a few
 * dozen entries even at the largest scrollback) so trimming its head stays
 * cheap, without ever copying a large buffer.
 */
const MAX_CHUNK_LENGTH = 8192;

/**
 * How many idle execution paths keep their scrollback. Every project the user
 * visits would otherwise hold a full scrollback buffer for the life of the
 * session. Sessions that are still running are never evicted.
 */
const MAX_IDLE_SESSIONS = 6;

/**
 * Completed processes can emit a final buffered delta after their RPC settles.
 * Keep a small routing history so that late output still lands in the project
 * that launched it rather than whichever project is selected at that moment.
 */
const MAX_PROCESS_ROUTES = 32;

export interface TerminalOutputStore {
  /**
   * Total characters ever appended. Monotonic, so it doubles as the cursor
   * consumers hand back to `read` and as an "is there any output yet?" check.
   */
  appendedLength: () => number;
  /**
   * Everything appended after `cursor`, plus the cursor to pass in next time.
   * A cursor older than the retained window resumes at the oldest retained
   * character rather than silently returning nothing.
   */
  read: (cursor: number) => { text: string; cursor: number };
  /**
   * Increments whenever the buffer is discarded (Clear). Consumers that hold a
   * cursor reset it and repaint from scratch instead of appending to stale
   * output they can no longer reconcile.
   */
  generation: () => number;
  subscribe: (listener: () => void) => () => void;
}

/** A command running in some project, used to label it wherever it is shown. */
export interface RunningTerminalCommand {
  /** Execution path that owns the run. */
  scope: string;
  command: string;
}

export interface TerminalController {
  outputStore: TerminalOutputStore;
  /** True only for the currently selected execution path. */
  running: boolean;
  /** The command running in the selected path, for header labelling. */
  runningCommand: string;
  /** Commands running under any *other* execution path. */
  runningElsewhere: RunningTerminalCommand[];
  /**
   * Appends to `scope`'s buffer, defaulting to the selected one. Callers with
   * a long-running command pass the path it started in so its output cannot
   * land under whichever project the user has since switched to.
   */
  append: (text: string, scope?: string) => void;
  /** Routes streamed runtime output by the process id that produced it. */
  appendProcess: (text: string, processId?: string) => void;
  /** Characters appended so far under `scope`, defaulting to the selected one. */
  appendedLength: (scope?: string) => number;
  /** Runs `command` in the selected execution path. */
  run: (command: string, additionalWritableRoots?: string[]) => Promise<void>;
  stop: () => Promise<void>;
  clear: () => void;
  write: (value: string) => void;
  resize: (columns: number, rows: number) => void;
  sizeRef: MutableRefObject<{ cols: number; rows: number }>;
}

interface TerminalSession {
  scope: string;
  running: boolean;
  runningCommand: string;
  processId: string | null;
  chunks: string[];
  retained: number;
  appended: number;
  generation: number;
  listeners: Set<() => void>;
  store: TerminalOutputStore;
  /** Ordering key for idle eviction. */
  touchedAt: number;
}

function createSession(scope: string, touchedAt: number): TerminalSession {
  const session: TerminalSession = {
    scope,
    running: false,
    runningCommand: "",
    processId: null,
    chunks: [],
    retained: 0,
    appended: 0,
    generation: 0,
    listeners: new Set(),
    store: {
      appendedLength: () => session.appended,
      read: (cursor) => {
        let needed = session.appended - Math.max(cursor, session.appended - session.retained);
        if (needed <= 0) return { text: "", cursor: session.appended };
        // Walk back from the newest chunk so the work is proportional to the
        // delta, not to the retained buffer.
        const parts: string[] = [];
        for (let index = session.chunks.length - 1; index >= 0 && needed > 0; index -= 1) {
          const chunk = session.chunks[index];
          if (chunk.length <= needed) {
            parts.push(chunk);
            needed -= chunk.length;
          } else {
            parts.push(chunk.slice(chunk.length - needed));
            needed = 0;
          }
        }
        parts.reverse();
        return { text: parts.join(""), cursor: session.appended };
      },
      generation: () => session.generation,
      subscribe: (listener) => {
        session.listeners.add(listener);
        return () => session.listeners.delete(listener);
      },
    },
    touchedAt,
  };
  return session;
}

/**
 * The Workspace terminal, scoped to one execution path at a time.
 *
 * Output, running state, and the PTY process all belong to the execution path
 * that produced them. A single shared buffer meant a command started in one
 * project kept streaming — and kept reporting "running" — under the next
 * project's Terminal header after a switch.
 */
export function useTerminal(options: {
  scrollback: number;
  permission: PermissionMode;
  /** Execution path the Terminal panel is currently showing. */
  scope: string;
  onError: (message: string) => void;
}): TerminalController {
  const [, bumpRender] = useReducer((value: number) => value + 1, 0);
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const sizeRef = useRef({ cols: 100, rows: 30 });
  const sessionsRef = useRef(new Map<string, TerminalSession>());
  const processScopesRef = useRef(new Map<string, string>());
  const clockRef = useRef(0);

  // Output lives outside React state: streamed command output can arrive many
  // times per frame, and routing it through setState re-rendered the entire
  // app per chunk. Consumers (xterm) subscribe and read the buffer directly.
  //
  // The buffer is a list of arriving chunks rather than one accumulated string.
  // Appending to a string and re-slicing it to the scrollback limit copied the
  // whole retained buffer twice per chunk — up to 500k characters each, which
  // dominated CPU and allocation for any command with substantial output. It
  // also silently broke display: once the accumulated string saturated the
  // limit its length stopped changing, so the delta the panel computed from
  // that length was always empty and no further output ever reached xterm.
  const sessionFor = useCallback((scope: string): TerminalSession => {
    const sessions = sessionsRef.current;
    const existing = sessions.get(scope);
    clockRef.current += 1;
    if (existing) {
      existing.touchedAt = clockRef.current;
      return existing;
    }
    const created = createSession(scope, clockRef.current);
    sessions.set(scope, created);
    // Drop the least recently shown idle sessions. A running one still owns a
    // live PTY and its output, so it is never discarded.
    const idle = [...sessions.values()]
      .filter((session) => !session.running && session.scope !== scope)
      .sort((left, right) => left.touchedAt - right.touchedAt);
    for (let index = 0; idle.length - index > MAX_IDLE_SESSIONS; index += 1) {
      sessions.delete(idle[index].scope);
    }
    return created;
  }, []);

  const active = sessionFor(options.scope);

  const appendTo = useCallback((session: TerminalSession, text: string) => {
    if (!text) return;
    // Small arrivals extend the newest chunk instead of adding an entry. A PTY
    // can emit a character at a time (progress spinners, raw-mode programs),
    // and one array entry per character made both the retained-window trim and
    // the per-string overhead scale with the character count rather than the
    // byte count.
    const chunks = session.chunks;
    const newest = chunks.length ? chunks[chunks.length - 1] : undefined;
    if (newest !== undefined && newest.length + text.length <= MAX_CHUNK_LENGTH) {
      chunks[chunks.length - 1] = `${newest}${text}`;
    } else {
      chunks.push(text);
    }
    session.retained += text.length;
    session.appended += text.length;
    const limit = Math.max(1, optionsRef.current.scrollback);
    while (session.retained > limit) {
      const oldest = session.chunks[0];
      const excess = session.retained - limit;
      if (oldest.length <= excess) {
        session.chunks.shift();
        session.retained -= oldest.length;
      } else {
        session.chunks[0] = oldest.slice(excess);
        session.retained = limit;
      }
    }
    for (const listener of session.listeners) listener();
  }, []);

  const append = useCallback((text: string, scope?: string) => {
    appendTo(sessionFor(scope ?? optionsRef.current.scope), text);
  }, [appendTo, sessionFor]);

  const appendProcess = useCallback((text: string, processId?: string) => {
    const scope = processId ? processScopesRef.current.get(processId) : undefined;
    appendTo(sessionFor(scope ?? optionsRef.current.scope), text);
  }, [appendTo, sessionFor]);

  const appendedLength = useCallback(
    (scope?: string) => sessionsRef.current.get(scope ?? optionsRef.current.scope)?.appended ?? 0,
    [],
  );

  const run = useCallback(async (command: string, additionalWritableRoots: string[] = []) => {
    const cwd = optionsRef.current.scope;
    if (!cwd) return;
    const session = sessionFor(cwd);
    const trimmed = session.running ? "" : command.trim();
    if (!trimmed) return;
    const id = crypto.randomUUID();
    const processScopes = processScopesRef.current;
    processScopes.set(id, cwd);
    while (processScopes.size > MAX_PROCESS_ROUTES) {
      const oldest = processScopes.keys().next().value;
      if (oldest === undefined) break;
      processScopes.delete(oldest);
    }
    session.processId = id;
    session.running = true;
    session.runningCommand = trimmed;
    bumpRender();
    appendTo(session, `${session.appended ? "\n" : ""}$ ${trimmed}\n`);
    try {
      const result = await rpc<{ exitCode: number; stdout: string; stderr: string }>("command/exec", {
        command: shellCommand(trimmed),
        processId: id,
        tty: true,
        streamStdoutStderr: true,
        streamStdin: true,
        size: sizeRef.current,
        cwd,
        timeoutMs: 300000,
        sandboxPolicy: commandSandbox(optionsRef.current.permission, cwd, additionalWritableRoots),
      });
      appendTo(session, `${result.stdout}${result.stderr}\n[exit ${result.exitCode}]\n`);
    } catch (reason) {
      appendTo(session, `\n${friendlyError(reason)}\n`);
    } finally {
      session.running = false;
      session.runningCommand = "";
      session.processId = null;
      bumpRender();
    }
  }, [appendTo, sessionFor]);

  const stop = useCallback(async () => {
    const session = sessionsRef.current.get(optionsRef.current.scope);
    if (!session?.processId) return;
    try {
      await rpc("command/exec/terminate", { processId: session.processId });
    } catch (reason) {
      optionsRef.current.onError(friendlyError(reason));
    }
  }, []);

  const clear = useCallback(() => {
    const session = sessionFor(optionsRef.current.scope);
    if (!session.appended && !session.chunks.length) return;
    session.chunks = [];
    session.retained = 0;
    session.appended = 0;
    session.generation += 1;
    for (const listener of session.listeners) listener();
    bumpRender();
  }, [sessionFor]);

  const write = useCallback((value: string) => {
    const session = sessionsRef.current.get(optionsRef.current.scope);
    if (!session?.processId || !session.running) return;
    const bytes = new TextEncoder().encode(value);
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    void rpc("command/exec/write", { processId: session.processId, deltaBase64: btoa(binary) })
      .catch((reason) => optionsRef.current.onError(friendlyError(reason)));
  }, []);

  const resize = useCallback((columns: number, rows: number) => {
    sizeRef.current = { cols: columns, rows };
    const session = sessionsRef.current.get(optionsRef.current.scope);
    if (!session?.processId || !session.running) return;
    void rpc("command/exec/resize", { processId: session.processId, size: { cols: columns, rows } }).catch(() => {});
  }, []);

  const runningElsewhere: RunningTerminalCommand[] = [];
  for (const session of sessionsRef.current.values()) {
    if (session.running && session.scope !== options.scope) {
      runningElsewhere.push({ scope: session.scope, command: session.runningCommand });
    }
  }

  return {
    outputStore: active.store,
    running: active.running,
    runningCommand: active.runningCommand,
    runningElsewhere,
    append,
    appendProcess,
    appendedLength,
    run,
    stop,
    clear,
    write,
    resize,
    sizeRef,
  };
}
