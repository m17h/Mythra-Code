import { useCallback, useRef, useState, type MutableRefObject } from "react";
import { rpc } from "../lib/codex";
import { friendlyError } from "../lib/errors";
import { commandSandbox } from "../lib/turnConfig";
import type { PermissionMode } from "../types";

export interface TerminalOutputStore {
  get: () => string;
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
  const outputRef = useRef("");
  const outputListenersRef = useRef(new Set<() => void>());
  const outputStoreRef = useRef<TerminalOutputStore | null>(null);
  if (outputStoreRef.current === null) {
    outputStoreRef.current = {
      get: () => outputRef.current,
      subscribe: (listener) => {
        outputListenersRef.current.add(listener);
        return () => outputListenersRef.current.delete(listener);
      },
    };
  }

  const append = useCallback((text: string) => {
    if (!text) return;
    outputRef.current = `${outputRef.current}${text}`.slice(-optionsRef.current.scrollback);
    for (const listener of outputListenersRef.current) listener();
  }, []);

  const run = useCallback(async (cwd: string, additionalWritableRoots: string[] = []) => {
    const trimmed = stateRef.current.running ? "" : commandRef.current.trim();
    if (!trimmed) return;
    const id = crypto.randomUUID();
    setProcessId(id);
    setRunning(true);
    append(`${outputRef.current ? "\n" : ""}$ ${trimmed}\n`);
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
