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
      theme: { background: "#202327", foreground: "#b7d6af", cursor: "#a7e26f", selectionBackground: "#34432c" },
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(hostRef.current);
    fit.fit();
    const data = terminal.onData((value) => onInput(value));
    const resize = new ResizeObserver(() => {
      fit.fit();
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
