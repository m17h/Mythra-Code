import { useEffect, useRef, useState } from "react";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal, type ILink } from "@xterm/xterm";
import { openUrl } from "@tauri-apps/plugin-opener";
import { ExternalLink, TriangleAlert } from "lucide-react";
import "@xterm/xterm/css/xterm.css";
import type { TerminalOutputStore } from "../hooks/useTerminal";
import { safeErrorText } from "../lib/errors";
import { linksAtBufferRow, normalizeTerminalLink } from "../lib/terminalLinks";

/**
 * The terminal's screen colour. `.terminal-screen` paints the same value
 * around the cell grid, so the two must stay equal or the grid shows as a band.
 */
export const TERMINAL_BACKGROUND = "#15171b";

/** How long a failed open stays on screen. */
const LINK_ERROR_MS = 6000;

type LinkNotice =
  | { kind: "hover"; url: string }
  | { kind: "error"; url: string; detail: string };

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
  const [notice, setNotice] = useState<LinkNotice | null>(null);

  useEffect(() => {
    if (!hostRef.current) return;
    // Links open only from a plain primary click on a URL that passed
    // validation. A click that ends a text selection is a selection, not a
    // request to navigate.
    const openLink = (event: MouseEvent, url: string | null) => {
      if (!url || event.button !== 0 || terminal.hasSelection()) return;
      // The pointer is still on the link, and xterm will not report hovering
      // it again, so only a stale failure is cleared; the hint stays.
      setNotice((current) => current?.kind === "error" ? { kind: "hover", url } : current);
      void openUrl(url).catch((reason: unknown) => {
        setNotice({ kind: "error", url, detail: safeErrorText(reason, "The browser could not be opened.") });
      });
    };
    const showHint = (url: string) => setNotice((current) => current?.kind === "error" ? current : { kind: "hover", url });
    const hideHint = (url: string) => setNotice((current) => current?.kind === "hover" && current.url === url ? null : current);
    const terminal = new Terminal({
      convertEol: true,
      cursorBlink: true,
      cursorStyle: "bar",
      scrollback: 100_000,
      fontFamily: 'ui-monospace, "SF Mono", "SFMono-Regular", "JetBrains Mono", Menlo, Consolas, monospace',
      fontSize: 11,
      lineHeight: 1.35,
      theme: {
        background: TERMINAL_BACKGROUND,
        foreground: "#cbd5df",
        cursor: "#64ddf2",
        selectionBackground: "#2a4650",
        scrollbarSliderBackground: "rgba(255, 255, 255, .1)",
        scrollbarSliderHoverBackground: "rgba(255, 255, 255, .18)",
        scrollbarSliderActiveBackground: "rgba(255, 255, 255, .26)",
      },
      // OSC 8 hyperlinks carry a target separate from the visible text, and
      // xterm's default handler would hand any http(s) target to
      // window.open. They go through the same validation as printed URLs,
      // and the hint shows the real destination before anything is clicked.
      linkHandler: {
        allowNonHttpProtocols: false,
        activate: (event, uri) => openLink(event, normalizeTerminalLink(uri)),
        hover: (_event, uri) => {
          const url = normalizeTerminalLink(uri);
          if (url) showHint(url);
        },
        leave: (_event, uri) => {
          const url = normalizeTerminalLink(uri);
          if (url) hideHint(url);
        },
      },
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(hostRef.current);
    fit.fit();
    const data = terminal.onData((value) => onInput(value));
    const links = terminal.registerLinkProvider({
      provideLinks(line, callback) {
        const found = linksAtBufferRow(terminal.buffer.active, line - 1);
        callback(found.length ? found.map((link): ILink => ({
          range: link.range,
          text: link.text,
          decorations: { pointerCursor: true, underline: true },
          activate: (event) => openLink(event, link.url),
          hover: () => showHint(link.url),
          leave: () => hideHint(link.url),
        })) : undefined);
      },
    });
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
      links.dispose();
      data.dispose();
      terminal.dispose();
      terminalRef.current = null;
    };
  }, [onInput, onResize]);

  useEffect(() => {
    if (notice?.kind !== "error") return;
    const timer = window.setTimeout(() => setNotice(null), LINK_ERROR_MS);
    return () => window.clearTimeout(timer);
  }, [notice]);

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

  // The link strip has its own fixed-height row below the screen, so a hint
  // never covers output and showing one never changes the grid size (which
  // would resize the PTY on every hover).
  return (
    <>
      <div className="terminal-screen">
        <div ref={hostRef} className="xterm-host" />
      </div>
      <div className="terminal-link-strip" data-state={notice?.kind ?? "idle"} title={notice ? notice.kind === "error" ? `${notice.url}\n${notice.detail}` : notice.url : undefined}>
        {notice?.kind === "error" ? (
          <span className="terminal-link-message" role="alert">
            <TriangleAlert size={11} aria-hidden="true" />
            <span>Couldn’t open link:</span>{" "}
            <span className="terminal-link-detail">{notice.detail}</span>{" "}
            <code>{notice.url}</code>
          </span>
        ) : notice?.kind === "hover" ? (
          <span className="terminal-link-message">
            <ExternalLink size={11} aria-hidden="true" />
            <span>Click to open</span>{" "}
            <code>{notice.url}</code>
          </span>
        ) : (
          <span className="terminal-link-message">
            <ExternalLink size={11} aria-hidden="true" />
            <span>Click a link to open it in your browser</span>
          </span>
        )}
      </div>
    </>
  );
}
