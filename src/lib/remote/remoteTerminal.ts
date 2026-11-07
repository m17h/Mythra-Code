import { listen } from "@tauri-apps/api/event";
import { create } from "zustand";
import { hostRead, hostWrite } from "./remoteActions";
import type { RemoteTerminalStatus, RemoteTerminalOutput, RemoteTerminalList } from "./wire";
export type { RemoteTerminalStatus, RemoteTerminalOutput, RemoteTerminalList } from "./wire";

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

export interface RemoteTerminalView { running: boolean; opening: boolean; command: string; notice: string; terminalId?: string; readOnly?: boolean; exitCode?: number | null; elapsedMs?: number }
const IDLE: RemoteTerminalView = { running: false, opening: false, command: "", notice: "" };

export const useRemoteTerminals = create<{ views: Record<string, RemoteTerminalView>; expected: Record<string, string> }>(() => ({ views: {}, expected: {} }));

class Session {
  private text = "";
  private dropped = 0;
  private output = 0;
  private listeners = new Set<() => void>();
  private decoder = new TextDecoder();
  private terminalId: string | null = null;
  private waiting: TerminalEvent[] = [];
  private lastSeq = 0;
  private attachingId: string | null = null;
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
  private mirrored = { id: "", text: "", ended: false };
  /** Run and project actions print into the host's own panel, and it reports a moving
   * tail of that output. Shows each new piece here once, in the same terminal. */
  mirror(id: string, command: string, output: string, ended: string | null, ours: boolean) {
    if (id !== this.mirrored.id) {
      // Something that ended before this view saw it is history, unless it was
      // started from here and just finished between two looks.
      if (ended && !ours) return;
      this.mirrored = { id, text: "", ended: false };
      this.append(`${this.text && !this.text.endsWith("\n") ? "\r\n" : ""}$ ${command}\r\n`);
    }
    const seen = this.mirrored.text;
    let fresh = output;
    if (output.startsWith(seen)) fresh = output.slice(seen.length);
    else {
      // The tail moved on. Find where the last thing shown now sits.
      const longest = Math.min(seen.length, output.length);
      for (let size = longest; size > 0; size -= 1) {
        if (output.startsWith(seen.slice(-size))) { fresh = output.slice(size); break; }
      }
    }
    this.mirrored.text = output;
    if (fresh) this.append(fresh.replace(/\r?\n/g, "\r\n"));
    if (ended && !this.mirrored.ended) {
      this.mirrored.ended = true;
      this.append(`${output.endsWith("\n") ? "" : "\r\n"}${ended}\r\n`);
    }
  }
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
    this.attachingId = null;
    this.input = "";
    this.lastSeq = 0;
    clearTimeout(this.ackTimer);
    this.ackTimer = undefined;
    clearTimeout(this.resizeTimer);
    this.append(this.decoder.decode());
    this.decoder = new TextDecoder();
    this.show({ running: false, opening: false, notice });
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
      // finish() clears timers. Confirm this final frame explicitly so the
      // host can release its bounded subscriber slot.
      void hostRead(this.device, "terminal.ack", { workspaceId: this.workspaceId, terminalId: this.terminalId, through: this.lastSeq }).catch(() => undefined);
      const code = typeof exitCode === "number" ? exitCode : null;
      this.show({ exitCode: code });
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
    this.show({ opening: true, command, notice: "", readOnly: false, exitCode: null, terminalId: undefined });
    const session = ++this.session;
    try { await listenOnce(); }
    catch { if (session === this.session) this.finish("Mythra Code couldn't listen to this terminal, so no command was started."); return; }
    if (session !== this.session) return;
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
    this.show({ running: true, opening: false, command, terminalId });
    const early = this.waiting;
    this.waiting = [];
    for (const event of early) this.receive(event);
  }

  /** Explicitly choose a host session, including one discovered after a viewer
   * restart. The host snapshot and stream baseline are atomic; early deltas are
   * replayed only if newer than that baseline. No shell is launched here. */
  async attach(terminalId: string): Promise<void> {
    if (!terminalId || terminalId.length > 512) throw new Error("Choose an available terminal.");
    this.finish();
    const session = ++this.session;
    this.attachingId = terminalId;
    this.show({ opening: true, terminalId, notice: "" });
    try {
      await listenOnce();
      const result = await hostRead<RemoteTerminalOutput>(this.device, "terminal.attach", { workspaceId: this.workspaceId, terminalId, limit: 65536 });
      if (session !== this.session) return;
      if (result.terminalId !== terminalId || !Number.isSafeInteger(result.seq) || result.seq < 0
        || typeof result.deltaBase64 !== "string" || result.deltaBase64.length > 87384) throw new Error("That terminal snapshot could not be read.");
      const bytes = Uint8Array.from(atob(result.deltaBase64), (char) => char.charCodeAt(0));
      this.clear();
      this.decoder = new TextDecoder();
      this.append(this.decoder.decode(bytes, { stream: result.running }));
      this.terminalId = result.running ? terminalId : null;
      this.lastSeq = result.seq;
      this.attachingId = null;
      this.show({ running: result.running, opening: false, command: result.command, terminalId,
        readOnly: !result.owned, exitCode: result.exitCode, elapsedMs: result.elapsedMs,
        notice: result.truncated ? "Showing recent output from this terminal." : "" });
      const early = this.waiting;
      this.waiting = [];
      for (const event of early) this.receive(event);
    } catch (reason) {
      if (session === this.session) this.finish("This terminal could not be reattached. Refresh the host's terminal list.");
      throw reason;
    }
  }

  stop(name: string) {
    const terminalId = this.terminalId;
    if (!terminalId || this.view().readOnly) return;
    void hostWrite(this.device, name, "terminal.close", { workspaceId: this.workspaceId, terminalId }).then((outcome) => {
      if (this.terminalId === terminalId && !outcome.ok) this.show({ notice: outcome.message });
    });
  }

  write(name: string, data: string) {
    if (!this.terminalId || this.view().readOnly) return;
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
    if (!this.terminalId || this.view().readOnly) return;
    this.resizeTimer = setTimeout(() => {
      const terminalId = this.terminalId;
      if (terminalId) void hostWrite(this.device, name, "terminal.resize", { workspaceId: this.workspaceId, terminalId, columns: this.columns, rows: this.rows });
    }, RESIZE_MS);
  }

  owns(event: TerminalEvent) {
    return event.device === this.device && (this.terminalId === event.terminalId || (this.terminalId === null && this.view().opening && (!this.attachingId || this.attachingId === event.terminalId)));
  }
}

const sessions = new Map<string, Session>();
let listening: Promise<void> | undefined;
function listenOnce(): Promise<void> {
  if (listening) return listening;
  listening = listen<TerminalEvent>("remote-terminal-output", ({ payload }) => {
    if (!payload || typeof payload.device !== "string" || typeof payload.terminalId !== "string" || typeof payload.seq !== "number") return;
    for (const session of sessions.values()) if (session.owns(payload)) { session.receive(payload); return; }
  }).then(() => undefined).catch((reason) => { listening = undefined; throw reason; });
  return listening;
}

export function remoteTerminal(device: string, workspaceId: string): Session {
  void listenOnce().catch(() => undefined);
  const key = `${device}/${workspaceId}`;
  let session = sessions.get(key);
  if (!session) { session = new Session(key, device, workspaceId); sessions.set(key, session); }
  return session;
}
export const remoteTerminalKey = (device: string, workspaceId: string) => `${device}/${workspaceId}`;
/** A lost link detaches streaming. The host keeps owned PTYs for five minutes;
 * listRemoteTerminalSessions + Session.attach recover without launching a command. */
export function endRemoteTerminals(device: string) {
  for (const [key, session] of sessions) if (key.startsWith(`${device}/`)) session.lostConnection();
}

/** A Run or project action was started from this device, so its output is wanted here. */
export function expectRemoteRun(device: string, workspaceId: string, processHandle: string) {
  useRemoteTerminals.setState((state) => ({ expected: { ...state.expected, [remoteTerminalKey(device, workspaceId)]: processHandle } }));
}


/** Scoped native inventory. No host filesystem paths or OS process ids. */
export const listRemoteTerminalSessions = (device: string, workspaceId: string) =>
  hostRead<RemoteTerminalList>(device, "terminal.list", { workspaceId, limit: 32 });
export const readRemoteTerminalStatus = (device: string, workspaceId: string, terminalId: string) =>
  hostRead<RemoteTerminalStatus>(device, "terminal.status", { workspaceId, terminalId });
export function readRemoteTerminalOutput(device: string, workspaceId: string, terminalId: string, cursor?: number, limit = 65536): Promise<RemoteTerminalOutput> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 65536 || cursor !== undefined && (!Number.isSafeInteger(cursor) || cursor < 0)) return Promise.reject(new Error("Request bounded terminal output."));
  return hostRead<RemoteTerminalOutput>(device, "terminal.read", { workspaceId, terminalId, limit, ...(cursor !== undefined ? { cursor } : {}) });
}
