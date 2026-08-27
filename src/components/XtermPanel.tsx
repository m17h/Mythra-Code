import { useEffect, useRef } from "react";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import type { TerminalOutputStore } from "../hooks/useTerminal";

export function XtermPanel({
  outputStore,
  placeholder,
  running,
  onInput,
  onResize,
}: {
  outputStore: TerminalOutputStore;
  placeholder?: string;
  running: boolean;
  onInput: (value: string) => void;
  onResize: (columns: number, rows: number) => void;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const cursorRef = useRef(0);
  const generationRef = useRef(0);

  useEffect(() => {
    if (!hostRef.current) return;
    const terminal = new Terminal({
      convertEol: true,
      cursorBlink: true,
      cursorStyle: "bar",
      scrollback: 100_000,
      fontFamily: 'ui-monospace, "SFMono-Regular", Menlo, monospace',
      fontSize: 11,
      lineHeight: 1.35,
      theme: { background: "#202327", foreground: "#c1d7dc", cursor: "#64ddf2", selectionBackground: "#2d4850" },
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(hostRef.current);
    fit.fit();
    const data = terminal.onData((value) => onInput(value));
    // Dragging the dock edge changes this host's box every frame, but the
    // grid only changes every few pixels. Reporting unchanged dimensions sent
    // one PTY resize round-trip per frame for no effect, so the callback fires
    // only when the cell grid actually moves. The sentinel start makes the
    // first observation — the initial size — always report.
    let lastCols = -1;
    let lastRows = -1;
    const resize = new ResizeObserver(() => {
      fit.fit();
      if (terminal.cols === lastCols && terminal.rows === lastRows) return;
      lastCols = terminal.cols;
      lastRows = terminal.rows;
      onResize(terminal.cols, terminal.rows);
    });
    resize.observe(hostRef.current);
    terminalRef.current = terminal;
    return () => {
      resize.disconnect();
      data.dispose();
      terminal.dispose();
      terminalRef.current = null;
    };
  }, [onInput, onResize]);

  // Output is written to xterm imperatively via the store subscription — no
  // React re-render per chunk. On mount the retained buffer is replayed by
  // reading from cursor 0, which the store clamps to the oldest retained
  // character.
  useEffect(() => {
    let placeholderShown = false;
    const sync = () => {
      const terminal = terminalRef.current;
      if (!terminal) return;
      // Clear discards the buffer the cursor was measured against, so the
      // screen is repainted from the new empty buffer rather than appended to.
      const generation = outputStore.generation();
      if (generation !== generationRef.current) {
        generationRef.current = generation;
        cursorRef.current = 0;
        terminal.reset();
        placeholderShown = false;
      }
      const { text, cursor } = outputStore.read(cursorRef.current);
      cursorRef.current = cursor;
      if (!text) return;
      if (placeholderShown) {
        terminal.reset();
        placeholderShown = false;
      }
      terminal.write(text.replace(/\n/g, "\r\n"));
    };
    cursorRef.current = 0;
    generationRef.current = outputStore.generation();
    terminalRef.current?.reset();
    if (!outputStore.appendedLength() && placeholder) {
      terminalRef.current?.write(placeholder.replace(/\n/g, "\r\n"));
      placeholderShown = true;
    }
    sync();
    return outputStore.subscribe(sync);
  }, [outputStore, placeholder]);

  useEffect(() => {
    if (running) terminalRef.current?.focus();
  }, [running]);

  return <div ref={hostRef} className="xterm-host" />;
}
