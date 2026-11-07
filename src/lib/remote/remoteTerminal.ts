import { listen } from "@tauri-apps/api/event";
import { create } from "zustand";
import { hostRead, hostWrite } from "./remoteActions";

/** One terminal per project on each paired device, kept for as long as the app
 * runs so a command outlives the panel, as it does on this device. */
const MAX_TERMINAL_CHARS = 512 * 1024;
const MAX_WAITING_FRAMES = 128;
const MAX_WAITING_INPUT = 64 * 1024;
/** 16 KiB is the host's limit, and a character is at most four bytes. */
const INPUT_CHUNK_CHARS = 4096;
const ACK_MS = 60;
const RESIZE_MS = 150;

type TerminalFrame = { deltaBase64?: unknown; finished?: unknown; exitCode?: unknown; failed?: unknown };
interface TerminalEvent { device: string; terminalId: string; seq: number; data: TerminalFrame }

export interface RemoteTerminalView { running: boolean; opening: boolean; command: string; notice: string }
const IDLE: RemoteTerminalView = { running: false, opening: false, command: "", notice: "" };

export const useRemoteTerminals = create<{ views: Record<string, RemoteTerminalView> }>(() => ({ views: {} }));

class Session {
  private text = "";
  private dropped = 0;
  private output = 0;
  private listeners = new Set<() => void>();
  private decoder = new TextDecoder();
  private terminalId: string | null = null;
  private waiting: TerminalEvent[] = [];
  private lastSeq = 0;
  private ackTimer: ReturnType<typeof setTimeout> | undefined;
  private input = "";
  private sendingInput = false;
  private columns = 80;
  private rows = 24;
  private resizeTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly key: string, private readonly device: string, private readonly workspaceId: string) {}

  /** Moves on whenever a run ends, so a late reply can't claim the view it left. */
  private session = 0;
  private view(): RemoteTerminalView { return useRemoteTerminals.getState().views[this.key] ?? IDLE; }
  private show(change: Partial<RemoteTerminalView>) {
    useRemoteTerminals.setState((state) => ({ views: { ...state.views, [this.key]: { ...this.view(), ...change } } }));
  }
  private notify() { for (const listener of this.listeners) listener(); }

  readonly store = {
    appendedLength: () => this.dropped + this.text.length,
    read: (cursor: number) => ({ text: this.text.slice(Math.max(0, cursor - this.dropped)), cursor: this.dropped + this.text.length }),
    generation: () => this.output,
    subscribe: (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; },
  };
  clear() { this.text = ""; this.dropped = 0; this.output += 1; this.notify(); }
  private append(next: string) {
    if (!next) return;
    this.text += next;
    if (this.text.length > MAX_TERMINAL_CHARS) { this.dropped += this.text.length - MAX_TERMINAL_CHARS; this.text = this.text.slice(-MAX_TERMINAL_CHARS); }
    this.notify();
  }

  private finish(notice = "") {
    this.session += 1;
    this.terminalId = null;
    this.waiting = [];
    this.input = "";
    this.lastSeq = 0;
    clearTimeout(this.ackTimer);
    this.ackTimer = undefined;
    clearTimeout(this.resizeTimer);
    this.append(this.decoder.decode());
    this.decoder = new TextDecoder();
    this.show({ running: false, opening: false, command: "", notice });
  }

  /** Output can arrive before the host's reply names the terminal. */
  receive(event: TerminalEvent) {
    if (this.terminalId === null) {
      if (this.view().opening && this.waiting.length < MAX_WAITING_FRAMES) this.waiting.push(event);
      return;
    }
    if (event.terminalId !== this.terminalId || event.seq <= this.lastSeq) return;
    this.lastSeq = event.seq;
    const { deltaBase64, finished, exitCode, failed } = event.data ?? {};
    if (typeof deltaBase64 === "string") {
      try {
        this.append(this.decoder.decode(Uint8Array.from(atob(deltaBase64), (char) => char.charCodeAt(0)), { stream: true }));
      } catch { this.finish("That terminal sent something Mythra Code couldn't read."); return; }
    }
    this.acknowledge();
    if (finished === true) {
      const code = typeof exitCode === "number" ? exitCode : null;
      this.finish(failed === true ? "That command couldn't finish." : code ? `That command stopped with code ${code}.` : "");
    }
  }

  /** The host pauses output until it hears this, so a fast command can't flood this app. */
  private acknowledge() {
    if (this.ackTimer !== undefined) return;
    this.ackTimer = setTimeout(() => {
      this.ackTimer = undefined;
      const terminalId = this.terminalId;
      if (!terminalId) return;
      hostRead(this.device, "terminal.ack", { workspaceId: this.workspaceId, terminalId, through: this.lastSeq })
        .catch(() => { if (this.terminalId === terminalId) this.lost(); });
    }, ACK_MS);
  }
  private lost() { this.finish("The connection to this terminal was lost. The command may still be running on the other device."); }

  lostConnection() { if (this.terminalId !== null || this.view().opening) this.lost(); }

  async run(name: string, threadId: string | undefined, command: string) {
    const current = this.view();
    if (current.running || current.opening) return;
    this.show({ opening: true, command, notice: "" });
    const session = ++this.session;
    const outcome = await hostWrite<{ terminalId?: string }>(this.device, name, "terminal.open", {
      workspaceId: this.workspaceId, ...(threadId ? { threadId } : {}), command, columns: this.columns, rows: this.rows });
    const terminalId = outcome.result?.terminalId;
    // The link dropped while this was opening, and whatever followed owns this view now.
    if (session !== this.session) {
      if (terminalId) void hostWrite(this.device, name, "terminal.close", { workspaceId: this.workspaceId, terminalId });
      return;
    }
    if (!outcome.ok || !terminalId) { this.finish(outcome.message || `${name} didn't start that command.`); return; }
    this.terminalId = terminalId;
    this.show({ running: true, opening: false, command });
    const early = this.waiting;
    this.waiting = [];
    for (const event of early) this.receive(event);
  }

  stop(name: string) {
    const terminalId = this.terminalId;
    if (!terminalId) return;
    void hostWrite(this.device, name, "terminal.close", { workspaceId: this.workspaceId, terminalId }).then((outcome) => {
      if (this.terminalId === terminalId && !outcome.ok) this.show({ notice: outcome.message });
    });
  }

  write(name: string, data: string) {
    if (!this.terminalId) return;
    if (this.input.length + data.length > MAX_WAITING_INPUT) { this.show({ notice: `${name} isn't keeping up, so some typing was left out.` }); return; }
    this.input += data;
    if (!this.sendingInput) void this.drainInput(name);
  }
  /** One at a time, so what's typed arrives in order. */
  private async drainInput(name: string) {
    this.sendingInput = true;
    try {
      while (this.input && this.terminalId) {
        const last = this.input.charCodeAt(INPUT_CHUNK_CHARS - 1);
        const take = last >= 0xd800 && last <= 0xdbff ? INPUT_CHUNK_CHARS - 1 : INPUT_CHUNK_CHARS;
        const data = this.input.slice(0, take);
        this.input = this.input.slice(data.length);
        const outcome = await hostWrite(this.device, name, "terminal.write", { workspaceId: this.workspaceId, terminalId: this.terminalId, data });
        if (!outcome.ok) { this.input = ""; this.show({ notice: outcome.message }); }
      }
    } finally { this.sendingInput = false; }
  }

  resize(name: string, columns: number, rows: number) {
    if (columns < 1 || rows < 1 || columns > 1000 || rows > 1000) return;
    this.columns = Math.round(columns);
    this.rows = Math.round(rows);
    clearTimeout(this.resizeTimer);
    if (!this.terminalId) return;
    this.resizeTimer = setTimeout(() => {
      const terminalId = this.terminalId;
      if (terminalId) void hostWrite(this.device, name, "terminal.resize", { workspaceId: this.workspaceId, terminalId, columns: this.columns, rows: this.rows });
    }, RESIZE_MS);
  }

  owns(event: TerminalEvent) {
    return event.device === this.device && (this.terminalId === event.terminalId || (this.terminalId === null && this.view().opening));
  }
}

const sessions = new Map<string, Session>();
let listening = false;
function listenOnce() {
  if (listening) return;
  listening = true;
  listen<TerminalEvent>("remote-terminal-output", ({ payload }) => {
    if (!payload || typeof payload.device !== "string" || typeof payload.terminalId !== "string" || typeof payload.seq !== "number") return;
    for (const session of sessions.values()) if (session.owns(payload)) { session.receive(payload); return; }
  }).catch(() => { listening = false; });
}

export function remoteTerminal(device: string, workspaceId: string): Session {
  listenOnce();
  const key = `${device}/${workspaceId}`;
  let session = sessions.get(key);
  if (!session) { session = new Session(key, device, workspaceId); sessions.set(key, session); }
  return session;
}
export const remoteTerminalKey = (device: string, workspaceId: string) => `${device}/${workspaceId}`;
/** A lost link ends the terminal's route on the host, so no more output will come. */
export function endRemoteTerminals(device: string) {
  for (const [key, session] of sessions) if (key.startsWith(`${device}/`)) session.lostConnection();
}
