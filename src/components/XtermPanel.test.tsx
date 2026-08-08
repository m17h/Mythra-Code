import { render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Dragging the dock edge changes the terminal host's box on every pointer
 * move. These tests pin the cost of that: the PTY is only told about a resize
 * when the cell grid actually changed.
 */

let terminalDimensions = { cols: 100, rows: 30 };

vi.mock("@xterm/xterm/css/xterm.css", () => ({}));

vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    cols = terminalDimensions.cols;
    rows = terminalDimensions.rows;
    loadAddon(addon: { activate: (terminal: unknown) => void }) { addon.activate(this); }
    open() {}
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
} as never;

describe("XtermPanel", () => {
  beforeEach(() => {
    observed = [];
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
});
