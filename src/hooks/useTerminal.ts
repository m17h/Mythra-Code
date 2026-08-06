import { useCallback, useRef, useState, type MutableRefObject } from "react";
import { rpc } from "../lib/codex";
import { friendlyError } from "../lib/errors";
import { commandSandbox } from "../lib/turnConfig";
import type { PermissionMode } from "../types";

/**
 * Upper bound on a single retained chunk. Keeps the chunk list short (a few
 * dozen entries even at the largest scrollback) so trimming its head stays
 * cheap, without ever copying a large buffer.
 */
const MAX_CHUNK_LENGTH = 8192;

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
  subscribe: (listener: () => void) => () => void;
}

export interface TerminalController {
  command: string;
  outputStore: TerminalOutputStore;
  running: boolean;
  setCommand: (value: string) => void;
  append: (text: string) => void;
  run: (cwd: string, additionalWritableRoots?: string[]) => Promise<void>;
  stop: () => Promise<void>;
  write: (value: string) => void;
  resize: (columns: number, rows: number) => void;
  sizeRef: MutableRefObject<{ cols: number; rows: number }>;
}

export function useTerminal(options: { scrollback: number; permission: PermissionMode; onError: (message: string) => void }): TerminalController {
  const [command, setCommand] = useState("");
  const [running, setRunning] = useState(false);
  const [processId, setProcessId] = useState<string | null>(null);
  const sizeRef = useRef({ cols: 100, rows: 30 });
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const stateRef = useRef({ processId, running });
  stateRef.current = { processId, running };
  const commandRef = useRef(command);
  commandRef.current = command;

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
  const chunksRef = useRef<string[]>([]);
  const retainedRef = useRef(0);
  const appendedRef = useRef(0);
  const outputListenersRef = useRef(new Set<() => void>());
  const outputStoreRef = useRef<TerminalOutputStore | null>(null);
  if (outputStoreRef.current === null) {
    outputStoreRef.current = {
      appendedLength: () => appendedRef.current,
      read: (cursor) => {
        const appended = appendedRef.current;
        let needed = appended - Math.max(cursor, appended - retainedRef.current);
        if (needed <= 0) return { text: "", cursor: appended };
        // Walk back from the newest chunk so the work is proportional to the
        // delta, not to the retained buffer.
        const parts: string[] = [];
        for (let index = chunksRef.current.length - 1; index >= 0 && needed > 0; index -= 1) {
          const chunk = chunksRef.current[index];
          if (chunk.length <= needed) {
            parts.push(chunk);
            needed -= chunk.length;
          } else {
            parts.push(chunk.slice(chunk.length - needed));
            needed = 0;
          }
        }
        parts.reverse();
        return { text: parts.join(""), cursor: appended };
      },
      subscribe: (listener) => {
        outputListenersRef.current.add(listener);
        return () => outputListenersRef.current.delete(listener);
      },
    };
  }

  const append = useCallback((text: string) => {
    if (!text) return;
    // Small arrivals extend the newest chunk instead of adding an entry. A PTY
    // can emit a character at a time (progress spinners, raw-mode programs),
    // and one array entry per character made both the retained-window trim and
    // the per-string overhead scale with the character count rather than the
    // byte count.
    const chunks = chunksRef.current;
    const newest = chunks.length ? chunks[chunks.length - 1] : undefined;
    if (newest !== undefined && newest.length + text.length <= MAX_CHUNK_LENGTH) {
      chunks[chunks.length - 1] = `${newest}${text}`;
    } else {
      chunks.push(text);
    }
    retainedRef.current += text.length;
    appendedRef.current += text.length;
    const limit = Math.max(1, optionsRef.current.scrollback);
    while (retainedRef.current > limit) {
      const oldest = chunksRef.current[0];
      const excess = retainedRef.current - limit;
      if (oldest.length <= excess) {
        chunksRef.current.shift();
        retainedRef.current -= oldest.length;
      } else {
        chunksRef.current[0] = oldest.slice(excess);
        retainedRef.current = limit;
      }
    }
    for (const listener of outputListenersRef.current) listener();
  }, []);

  const run = useCallback(async (cwd: string, additionalWritableRoots: string[] = []) => {
    const trimmed = stateRef.current.running ? "" : commandRef.current.trim();
    if (!trimmed) return;
    const id = crypto.randomUUID();
    setProcessId(id);
    setRunning(true);
    append(`${appendedRef.current ? "\n" : ""}$ ${trimmed}\n`);
    setCommand("");
    try {
      const result = await rpc<{ exitCode: number; stdout: string; stderr: string }>("command/exec", {
        command: ["/bin/zsh", "-lc", trimmed],
        processId: id,
        tty: true,
        streamStdoutStderr: true,
        streamStdin: true,
        size: sizeRef.current,
        cwd,
        timeoutMs: 300000,
        sandboxPolicy: commandSandbox(optionsRef.current.permission, cwd, additionalWritableRoots),
      });
      append(`${result.stdout}${result.stderr}\n[exit ${result.exitCode}]\n`);
    } catch (reason) {
      append(`\n${friendlyError(reason)}\n`);
    } finally {
      setRunning(false);
      setProcessId(null);
    }
  }, [append]);

  const stop = useCallback(async () => {
    if (!stateRef.current.processId) return;
    try {
      await rpc("command/exec/terminate", { processId: stateRef.current.processId });
    } catch (reason) {
      optionsRef.current.onError(friendlyError(reason));
    }
  }, []);

  const write = useCallback((value: string) => {
    const { processId: id, running: active } = stateRef.current;
    if (!id || !active) return;
    const bytes = new TextEncoder().encode(value);
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    void rpc("command/exec/write", { processId: id, deltaBase64: btoa(binary) })
      .catch((reason) => optionsRef.current.onError(friendlyError(reason)));
  }, []);

  const resize = useCallback((columns: number, rows: number) => {
    sizeRef.current = { cols: columns, rows };
    const { processId: id, running: active } = stateRef.current;
    if (!id || !active) return;
    void rpc("command/exec/resize", { processId: id, size: { cols: columns, rows } }).catch(() => {});
  }, []);

  return { command, outputStore: outputStoreRef.current, running, setCommand, append, run, stop, write, resize, sizeRef };
}
