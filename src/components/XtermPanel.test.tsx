import { act, render, screen } from "@testing-library/react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ILink, ILinkHandler, ILinkProvider } from "@xterm/xterm";

/**
 * Dragging the dock edge changes the terminal host's box on every pointer
 * move. These tests pin the cost of that: the PTY is only told about a resize
 * when the cell grid actually changed.
 */

let terminalDimensions = { cols: 100, rows: 30 };

vi.mock("@xterm/xterm/css/xterm.css", () => ({}));

vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn(async () => undefined) }));

/** Rows the mocked terminal's buffer holds, for link detection. */
let bufferRows: string[] = [];
let selection = false;
let linkProvider: ILinkProvider | null = null;
let linkHandler: ILinkHandler | null = null;

vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    cols = terminalDimensions.cols;
    rows = terminalDimensions.rows;
    buffer = {
      active: {
        getLine: (y: number) => {
          const row = bufferRows[y];
          if (row === undefined) return undefined;
          return { isWrapped: false, length: 80, getCell: (x: number) => ({ getChars: () => row[x] ?? "", getWidth: () => 1 }) };
        },
      },
    };
    constructor(options: { linkHandler?: ILinkHandler }) { linkHandler = options.linkHandler ?? null; }
    loadAddon(addon: { activate: (terminal: unknown) => void }) { addon.activate(this); }
    open() {}
    hasSelection() { return selection; }
    registerLinkProvider(provider: ILinkProvider) {
      linkProvider = provider;
      return { dispose: () => { linkProvider = null; } };
    }
    onData() { return { dispose: () => {} }; }
    write() {}
    reset() {}
    focus() {}
    dispose() {}
  },
}));

vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class {
    private terminal: { cols: number; rows: number } | null = null;
    activate(terminal: { cols: number; rows: number }) { this.terminal = terminal; }
    fit() {
      if (!this.terminal) return;
      this.terminal.cols = terminalDimensions.cols;
      this.terminal.rows = terminalDimensions.rows;
    }
  },
}));

import { XtermPanel } from "./XtermPanel";

let observed: Array<() => void> = [];

class ObservableResizeObserver {
  constructor(private callback: () => void) { observed.push(() => this.callback()); }
  observe() {}
  unobserve() {}
  disconnect() {}
}

const outputStore = {
  read: () => ({ text: "", cursor: 0 }),
  subscribe: () => () => {},
  appendedLength: () => 0,
  generation: () => 0,
} as never;

describe("XtermPanel", () => {
  beforeEach(() => {
    observed = [];
    bufferRows = [];
    selection = false;
    vi.mocked(openUrl).mockReset().mockResolvedValue(undefined);
    terminalDimensions = { cols: 100, rows: 30 };
    Object.defineProperty(globalThis, "ResizeObserver", {
      configurable: true,
      value: ObservableResizeObserver,
    });
  });

  it("reports a resize only when the cell grid changes", () => {
    const onResize = vi.fn();
    render(<XtermPanel outputStore={outputStore} running={false} onInput={vi.fn()} onResize={onResize} />);
    const notifyResize = () => observed.forEach((fire) => fire());

    // The first observation is the initial size and always reports.
    notifyResize();
    expect(onResize).toHaveBeenCalledExactlyOnceWith(100, 30);

    // Sub-cell width changes during a drag reach the observer but change no
    // dimension, so they must not cost a PTY round trip.
    notifyResize();
    notifyResize();
    expect(onResize).toHaveBeenCalledTimes(1);

    terminalDimensions = { cols: 96, rows: 30 };
    notifyResize();
    expect(onResize).toHaveBeenCalledTimes(2);
    expect(onResize).toHaveBeenLastCalledWith(96, 30);

    terminalDimensions = { cols: 96, rows: 28 };
    notifyResize();
    expect(onResize).toHaveBeenCalledTimes(3);
    expect(onResize).toHaveBeenLastCalledWith(96, 28);
  });

  const linksOn = (row: number) => new Promise<ILink[]>((resolve) => {
    linkProvider!.provideLinks(row, (links) => resolve(links ?? []));
  });
  const click = (button = 0) => new MouseEvent("mouseup", { button });

  it("offers validated links and opens them only on a plain primary click", async () => {
    bufferRows = ["  ➜  Local:   localhost:5173/  mylocalhost:1", "nothing here"];
    render(<XtermPanel outputStore={outputStore} running={false} onInput={vi.fn()} onResize={vi.fn()} />);

    // Nothing opens just because a link was printed or detected.
    const [link, ...rest] = await linksOn(1);
    expect(rest).toEqual([]);
    expect(link.text).toBe("localhost:5173/");
    expect(link.range).toEqual({ start: { x: 15, y: 1 }, end: { x: 29, y: 1 } });
    expect(link.decorations).toEqual({ pointerCursor: true, underline: true });
    expect(await linksOn(2)).toEqual([]);
    expect(openUrl).not.toHaveBeenCalled();

    // The strip is always present; hovering only changes its message.
    const strip = document.querySelector(".terminal-link-strip")!;
    expect(strip).toHaveAttribute("data-state", "idle");
    expect(strip).toHaveTextContent("Click a link to open it in your browser");
    act(() => link.hover?.(click(), link.text));
    expect(document.querySelector(".terminal-link-strip")).toBe(strip);
    expect(strip).toHaveAttribute("data-state", "hover");
    expect(strip).toHaveTextContent("Click to open http://localhost:5173/");
    act(() => link.leave?.(click(), link.text));
    expect(strip).toHaveAttribute("data-state", "idle");

    link.activate(click(2), link.text);
    selection = true;
    link.activate(click(), link.text);
    expect(openUrl).not.toHaveBeenCalled();

    selection = false;
    link.activate(click(), link.text);
    expect(openUrl).toHaveBeenCalledExactlyOnceWith("http://localhost:5173/");
  });

  it("validates OSC 8 hyperlink targets instead of trusting the escape sequence", () => {
    render(<XtermPanel outputStore={outputStore} running={false} onInput={vi.fn()} onResize={vi.fn()} />);
    const range = { start: { x: 1, y: 1 }, end: { x: 4, y: 1 } };
    expect(linkHandler?.allowNonHttpProtocols).toBe(false);
    for (const uri of ["javascript:alert(1)", "file:///etc/passwd", "http://localhost:3000@example.com/", "https://exa mple.com"]) {
      linkHandler!.activate(click(), uri, range);
    }
    expect(openUrl).not.toHaveBeenCalled();
    linkHandler!.activate(click(), "localhost:3000/docs", range);
    expect(openUrl).toHaveBeenCalledExactlyOnceWith("http://localhost:3000/docs");
  });

  it("says so when the browser cannot be opened", async () => {
    vi.mocked(openUrl).mockRejectedValueOnce(new Error("Not allowed to open url"));
    bufferRows = ["https://localhost:8443/"];
    render(<XtermPanel outputStore={outputStore} running={false} onInput={vi.fn()} onResize={vi.fn()} />);
    const [link] = await linksOn(1);
    await act(async () => link.activate(click(), link.text));
    const alert = await screen.findByRole("alert");
    // The reason is shown, not only offered in a tooltip.
    expect(alert).toHaveTextContent("Couldn’t open link: Not allowed to open url https://localhost:8443/");
    expect(alert).toBeVisible();
    expect(document.querySelector(".terminal-link-strip")).toHaveAttribute("title", "https://localhost:8443/\nNot allowed to open url");
  });
});
