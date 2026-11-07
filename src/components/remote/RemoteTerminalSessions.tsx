import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { TerminalOutputStore } from "../../hooks/useTerminal";
import {
  listRemoteTerminalSessions, readRemoteTerminalOutput, remoteTerminal, remoteTerminalKey, useRemoteTerminals,
  type RemoteTerminalStatus,
} from "../../lib/remote/remoteTerminal";

const LIST_MS = 4_000;
const OUTPUT_MS = 2_000;
const MOST_BYTES = 65_536;
const MOST_PAGES = 16;
const MOST_TEXT = 512 * 1024;

/** Every session on the host this device may see, kept fresh while the panel is open. */
export function useHostTerminalSessions(device: string, workspaceId: string, enabled: boolean) {
  const [state, setState] = useState<{ list: RemoteTerminalStatus[]; error: string; loaded: boolean }>({ list: [], error: "", loaded: false });
  const inFlight = useRef(false);
  const generation = useRef(0);
  const reload = useCallback(() => {
    if (!enabled || inFlight.current) return;
    inFlight.current = true;
    const mine = generation.current;
    listRemoteTerminalSessions(device, workspaceId).then((result) => {
      if (mine === generation.current) setState({ list: Array.isArray(result?.terminals) ? result.terminals : [], error: "", loaded: true });
    }, () => {
      if (mine === generation.current) setState((current) => ({ ...current, error: "This list may be out of date. Mythra Code couldn't refresh it.", loaded: true }));
    }).finally(() => { if (mine === generation.current) inFlight.current = false; });
  }, [device, enabled, workspaceId]);
  useEffect(() => {
    generation.current += 1;
    inFlight.current = false;
    setState({ list: [], error: "", loaded: false });
    if (!enabled) return;
    reload();
    const timer = setInterval(reload, LIST_MS);
    return () => { clearInterval(timer); generation.current += 1; inFlight.current = false; };
  }, [enabled, reload]);
  return { ...state, reload };
}

/**
 * A command this device started survives on the host while this window was away.
 * It is reattached once per connection to that project, latched only when that
 * worked; a failure says so and can be retried. Nothing is ever started here.
 */
export function useReattachOwnSession(device: string, workspaceId: string, enabled: boolean, connection: string) {
  const scope = `${device}/${workspaceId}/${connection}`;
  const done = useRef<string | null>(null);
  const token = useRef(0);
  const [failure, setFailure] = useState("");
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    // Read, not subscribed: the attach itself marks the panel busy, and that must not cancel it.
    const view = useRemoteTerminals.getState().views[remoteTerminalKey(device, workspaceId)];
    if (!enabled || view?.running || view?.opening || done.current === scope) return;
    const mine = ++token.current;
    setFailure("");
    void (async () => {
      // A fresh read, never a remembered list, so a finished command isn't chosen.
      const fresh = await listRemoteTerminalSessions(device, workspaceId);
      if (mine !== token.current) return;
      const own = fresh.terminals.find((entry) => entry.owned && entry.running && entry.attachable);
      const view = useRemoteTerminals.getState().views[remoteTerminalKey(device, workspaceId)];
      if (own && !view?.running && !view?.opening) await remoteTerminal(device, workspaceId).attach(own.terminalId);
      if (mine === token.current) done.current = scope;
    })().catch(() => { if (mine === token.current) setFailure("A command you started there couldn't be reconnected."); });
    return () => { token.current += 1; };
  }, [attempt, device, enabled, scope, workspaceId]);
  const retry = useCallback(() => { done.current = null; setAttempt((value) => value + 1); }, []);
  return { failure, retry };
}

/** A read-only copy of a session that can't be attached, read by byte cursor. */
export function useHostTerminalViewer(device: string, workspaceId: string, terminalId: string | null) {
  const [status, setStatus] = useState<{ running: boolean; exitCode: number | null; elapsedMs: number; command: string; notice: string } | null>(null);
  const store = useMemo(() => {
    let text = "", dropped = 0, generation = 0;
    const listeners = new Set<() => void>();
    return {
      append(chunk: string) {
        if (!chunk) return;
        text += chunk;
        if (text.length > MOST_TEXT) { dropped += text.length - MOST_TEXT; text = text.slice(-MOST_TEXT); }
        for (const listener of listeners) listener();
      },
      view: {
        appendedLength: () => dropped + text.length,
        read: (cursor: number) => ({ text: text.slice(Math.max(0, cursor - dropped)), cursor: dropped + text.length }),
        generation: () => generation,
        subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
      } as TerminalOutputStore,
    };
  }, [terminalId]);
  useEffect(() => {
    setStatus(null);
    if (!terminalId) return;
    let current = true, cursor: number | undefined, timer: ReturnType<typeof setTimeout> | undefined;
    const decoder = new TextDecoder();
    let running = true;
    const read = async () => {
      let truncated = false;
      for (let page = 0; page < MOST_PAGES && current; page += 1) {
        const result = await readRemoteTerminalOutput(device, workspaceId, terminalId, cursor, MOST_BYTES);
        if (!current) return;
        if (!Number.isSafeInteger(result.cursor) || result.cursor < 0 || typeof result.deltaBase64 !== "string") throw new Error("invalid");
        const bytes = Uint8Array.from(atob(result.deltaBase64), (char) => char.charCodeAt(0));
        store.append(decoder.decode(bytes, { stream: result.running }));
        cursor = result.cursor;
        running = result.running;
        truncated ||= result.truncated;
        setStatus({ running: result.running, exitCode: result.exitCode, elapsedMs: result.elapsedMs, command: result.command,
          notice: truncated ? "Showing the most recent output. Earlier output wasn't kept." : "" });
        if (!result.hasMore) break;
      }
    };
    // One read at a time; the next starts only after this one ends, and only while it runs.
    const loop = () => {
      read().then(() => { if (current && running) timer = setTimeout(loop, OUTPUT_MS); },
        () => { if (current) setStatus((value) => ({ running: false, exitCode: value?.exitCode ?? null, elapsedMs: value?.elapsedMs ?? 0, command: value?.command ?? "",
          notice: "Mythra Code couldn't read this terminal's output. It may have ended." })); });
    };
    loop();
    return () => { current = false; if (timer) clearTimeout(timer); };
  }, [device, store, terminalId, workspaceId]);
  return { store: store.view, status };
}

export function elapsedLabel(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  return minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/** The sessions as rows in the local "still running" strip, each one selectable. */
export function HostTerminalSessionList({ sessions, name, selected, ownId, error, onSelect }: {
  sessions: RemoteTerminalStatus[];
  name: string;
  selected: string | null;
  ownId: string | undefined;
  error: string;
  onSelect: (session: RemoteTerminalStatus) => void;
}) {
  const others = sessions.filter((entry) => entry.terminalId !== ownId);
  if (!others.length && !error) return null;
  return <>
    {others.map((entry) => {
      const state = entry.running ? `Running on ${name}` : `Exited${entry.exitCode === null ? "" : ` · exit ${entry.exitCode}`}`;
      return <button type="button" key={entry.terminalId} className={`terminal-elsewhere terminal-session-row${selected === entry.terminalId ? " selected" : ""}${entry.running ? "" : " exited"}`}
        aria-pressed={selected === entry.terminalId} title={entry.attachable ? "Reconnect to this command" : "View this command's output"} onClick={() => onSelect(entry)}>
        <span className="terminal-status-dot" aria-hidden="true" />
        <span className="terminal-status-text">
          {entry.running ? <>{state}</> : <strong>{state}</strong>} · <code title={entry.command}>{entry.command || "Command"}</code>
          {" · "}{elapsedLabel(entry.elapsedMs)}{entry.owned ? " · started here" : ""}
        </span>
      </button>;
    })}
    {error && <div className="terminal-elsewhere" role="status"><span className="terminal-status-text">{error}</span></div>}
  </>;
}
