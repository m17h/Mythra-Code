import { render, screen, waitFor } from "@testing-library/react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { commands, userEvent } from "vitest/browser";
import { themeColorScheme } from "../lib/appConfig";
import { EMPTY_REVIEW_DIFF } from "../lib/gitDiff";
import type { TerminalOutputStore } from "../hooks/useTerminal";
import type { ThemeName } from "../types";
import { StudioDock } from "./StudioDock";
import { TERMINAL_BACKGROUND } from "./XtermPanel";
// Production order (startApplication.tsx): legacy sheet, then Lumen.
import "../styles.css";
import "../styles/lumen/index.css";

// Opening a link must never reach a real browser or user profile.
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn(async () => undefined) }));

/** An output store with the same contract as useTerminal's. */
function outputStore(initial = ""): TerminalOutputStore & { append: (text: string) => void } {
  let text = initial;
  const listeners = new Set<() => void>();
  return {
    appendedLength: () => text.length,
    read: (cursor) => ({ text: text.slice(cursor), cursor: text.length }),
    generation: () => 0,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    append: (chunk) => {
      text += chunk;
      for (const listener of listeners) listener();
    },
  };
}

const noop = () => undefined;

function Dock({ theme = "mythra", width = 430, height = 760, store, readOnly = false, running = false, onInput = noop, onResize = noop }: {
  theme?: ThemeName;
  width?: number;
  height?: number;
  store: TerminalOutputStore;
  readOnly?: boolean;
  running?: boolean;
  onInput?: (value: string) => void;
  onResize?: (columns: number, rows: number) => void;
}) {
  return (
    <div className="app-shell" data-theme={theme} data-color-scheme={themeColorScheme(theme)} style={{ display: "block", height: "auto" }}>
      <div style={{ display: "flex", height, width }}>
        <StudioDock
          open tab="terminal" onTab={noop} activeThread={false} reviewDiff={EMPTY_REVIEW_DIFF} agents={[]}
          projectName="alpha" projectPath="/work/alpha"
          terminalOutput={store} terminalRunning={running} terminalRunningCommand={running ? "npm run dev" : ""}
          terminalRunningElsewhere={running ? [{ scope: "/work/beta", command: "npm run build -- --watch" }] : []}
          commandsReadOnly={readOnly} checkpoints={[]} attachments={[]} usage={null}
          accountUsage={{ label: "Fixture account", summary: "Fixture usage" }} skills={[]} mcpServers={[]}
          gitOutput="" gitCommitSuccess="" gitCommitBusy={false} gitRepositoryState="ready" gitInitializing={false}
          githubAuthenticated={false} githubRepoStatus={null} githubRepoError="" gitActionsReadOnly={false}
          defaultRepositoryName="" promptAudit={[]} projectActions={[]} workflows={[]} workflowRuns={[]}
          onClose={noop} onRefreshDiff={noop} onReview={noop} onOpenAgent={noop} onStopAgent={noop} onRunTerminal={noop}
          onStopTerminal={noop} onClearTerminal={noop} onTerminalInput={onInput} onTerminalResize={onResize} onCheckpoint={noop}
          onFork={noop} onCheckpointRestore={noop} onCheckpointAccept={noop} onCheckpointPreview={noop} onCheckpointDelete={noop}
          onRollback={noop} onWorktreeReview={noop} onWorktreeApply={noop} onWorktreeMerge={noop} onWorktreeReveal={noop}
          onWorktreeRefresh={noop} onWorktreeRemove={noop} onWorktreeRecreate={noop} onWorktreeContinueShared={noop}
          onAddAttachment={noop} onRemoveAttachment={noop} onRefreshUsage={noop} onCompact={noop} onRefreshTools={noop}
          onGitAction={noop} onInitializeGit={noop} onGitHubAttach={noop} onGitHubCreate={noop} onOpenGitHubSettings={noop}
          onGitPathAction={noop} onAttachPath={noop} onProjectAction={noop} onRunWorkflow={noop} onStopWorkflow={noop}
          onOpenWorkflowRun={noop} onToggleSkill={noop} onConnectMcp={noop}
        />
      </div>
    </div>
  );
}

function hexToRgb(hex: string) {
  const value = Number.parseInt(hex.slice(1), 16);
  return `rgb(${value >> 16}, ${(value >> 8) & 255}, ${value & 255})`;
}

function rect(container: HTMLElement, selector: string) {
  return container.querySelector<HTMLElement>(selector)!.getBoundingClientRect();
}

beforeEach(async () => {
  vi.mocked(openUrl).mockReset().mockResolvedValue(undefined);
  await commands.setStreamTestReducedMotion(true);
});

afterEach(async () => {
  await commands.setStreamTestReducedMotion(false);
});

it.each(["mythra", "light-mythra", "atari"] as const)("fills the dock height with a dark, unclipped screen in %s", async (theme) => {
  for (const [width, height, readOnly] of [[430, 760, false], [320, 560, true], [520, 900, true]] as const) {
    const sizes: Array<[number, number]> = [];
    const store = outputStore("ready\n");
    const view = render(<Dock theme={theme} width={width} height={height} store={store} readOnly={readOnly} onResize={(cols, rows) => sizes.push([cols, rows])} />);
    try {
      await waitFor(() => expect(view.container.querySelector(".xterm-host .xterm-screen")).toBeInTheDocument());
      await waitFor(() => expect(sizes.length).toBeGreaterThan(0));
      const panel = rect(view.container, ".studio-panel");
      const terminalWindow = rect(view.container, ".terminal-window");
      const host = rect(view.container, ".xterm-host");
      const grid = rect(view.container, ".xterm-screen");
      const scroller = view.container.querySelector<HTMLElement>(".studio-panel")!;

      // The window reaches the bottom of the dock (less its padding) instead
      // of being sized from the viewport, and nothing overflows the panel.
      expect(panel.bottom - terminalWindow.bottom).toBeGreaterThanOrEqual(0);
      expect(panel.bottom - terminalWindow.bottom).toBeLessThanOrEqual(24);
      expect(scroller.scrollHeight).toBeLessThanOrEqual(scroller.clientHeight + 1);
      expect(scroller.scrollWidth).toBeLessThanOrEqual(scroller.clientWidth + 1);
      expect(terminalWindow.height).toBeGreaterThan(height * 0.5);

      // Every fitted row is visible inside the host.
      expect(grid.bottom).toBeLessThanOrEqual(host.bottom + 1);
      expect(grid.right).toBeLessThanOrEqual(host.right + 1);
      const [, rows] = sizes[sizes.length - 1];
      expect(rows).toBeGreaterThan(8);

      // Screen and xterm paint the same colour, in every theme.
      const screenColor = getComputedStyle(view.container.querySelector(".terminal-screen")!).backgroundColor;
      expect(screenColor).toBe(hexToRgb(TERMINAL_BACKGROUND));
      expect(getComputedStyle(view.container.querySelector(".xterm-scrollable-element")!).backgroundColor).toBe(screenColor);
      // The viewport spans the remainder below the last whole row; it must
      // not paint its own (black) band there.
      expect(getComputedStyle(view.container.querySelector(".xterm-viewport")!).backgroundColor).toBe("rgba(0, 0, 0, 0)");

      // Controls stay inside the bar and command row at narrow widths.
      for (const selector of [".terminal-bar", ".terminal-input"]) {
        const row = view.container.querySelector<HTMLElement>(selector)!;
        expect(row.scrollWidth).toBeLessThanOrEqual(row.clientWidth + 1);
      }
      const runButton = screen.getByRole("button", { name: "Run terminal command" }).getBoundingClientRect();
      expect(runButton.right).toBeLessThanOrEqual(terminalWindow.right);
      expect(runButton.width).toBeGreaterThanOrEqual(24);
    } finally {
      view.unmount();
    }
  }
});

it("reports a larger grid when the dock grows and keeps PTY input flowing", async () => {
  const sizes: Array<[number, number]> = [];
  const onInput = vi.fn();
  const store = outputStore();
  const onResize = (cols: number, rows: number) => sizes.push([cols, rows]);
  const view = render(<Dock height={560} store={store} running onInput={onInput} onResize={onResize} />);
  await waitFor(() => expect(sizes.length).toBeGreaterThan(0));
  const before = sizes[sizes.length - 1];
  view.rerender(<Dock height={860} store={store} running onInput={onInput} onResize={onResize} />);
  await waitFor(() => expect(sizes[sizes.length - 1][1]).toBeGreaterThan(before[1]));

  expect(screen.getByRole("status")).toHaveTextContent("Running in alpha · npm run dev");
  expect(screen.getByText(/Still running in/)).toHaveTextContent("Still running in beta · npm run build -- --watch");
  expect(screen.getByRole("button", { name: "Stop terminal command" })).toBeVisible();

  // Running focuses the terminal, so keystrokes reach the process.
  await waitFor(() => expect(document.activeElement).toHaveClass("xterm-helper-textarea"));
  await userEvent.keyboard("y");
  await waitFor(() => expect(onInput).toHaveBeenCalledWith("y"));
});

/** Pointer position (relative to the grid) of a 1-based cell. */
function cellPoint(container: HTMLElement, cols: number, rows: number, x: number, y: number) {
  const grid = rect(container, ".xterm-screen");
  const cellWidth = grid.width / cols;
  const cellHeight = grid.height / rows;
  return { x: (x - 0.5) * cellWidth, y: (y - 0.5) * cellHeight };
}

it("opens printed server links on click, including ones the terminal wrapped", async () => {
  const sizes: Array<[number, number]> = [];
  const store = outputStore();
  const view = render(<Dock width={430} height={700} store={store} onResize={(cols, rows) => sizes.push([cols, rows])} />);
  await waitFor(() => expect(sizes.length).toBeGreaterThan(0));
  const [cols, rows] = sizes[sizes.length - 1];
  // Every fixture row but the last fits on one terminal row.
  expect(cols).toBeGreaterThanOrEqual(40);
  const longPath = `/${"segment/".repeat(Math.ceil(cols / 9) + 1)}end?x=1`;
  // ANSI styling around the link must not leak into it.
  store.append([
    "  \u001b[32m➜\u001b[39m  \u001b[1mLocal\u001b[22m:   \u001b[36mhttp://localhost:\u001b[1m5173\u001b[22m/\u001b[39m",
    "  Preview at 127.0.0.1:4173.",
    "  mylocalhost:1 localhost:99999",
    `  Docs: localhost:3000${longPath}`,
    "",
  ].join("\n"));
  const grid = view.container.querySelector<HTMLElement>(".xterm-screen")!;
  const at = (x: number, y: number) => ({ position: cellPoint(view.container, cols, rows, x, y) });
  const hint = () => view.container.querySelector('.terminal-link-strip[data-state="hover"]');
  await waitFor(() => expect(view.container.querySelector(".xterm-rows")).toHaveTextContent("localhost:5173"));
  // Printing links opens nothing.
  expect(openUrl).not.toHaveBeenCalled();

  // Row 1: "  ➜  Local:   http://localhost:5173/" — the URL is cells 15..36.
  await userEvent.hover(grid, at(20, 1));
  await waitFor(() => expect(hint()).toHaveTextContent("http://localhost:5173/"));
  expect(getComputedStyle(grid).cursor).toBe("pointer");
  // Either side of the link is plain text.
  for (const x of [14, 37]) {
    await userEvent.hover(grid, at(x, 1));
    await waitFor(() => expect(hint()).not.toBeInTheDocument());
    await userEvent.click(grid, at(x, 1));
  }
  expect(openUrl).not.toHaveBeenCalled();
  await userEvent.click(grid, at(15, 1));
  await waitFor(() => expect(openUrl).toHaveBeenCalledExactlyOnceWith("http://localhost:5173/"));
  await userEvent.click(grid, at(36, 1));
  await waitFor(() => expect(openUrl).toHaveBeenCalledTimes(2));

  // Row 2: bare loopback, normalized to http; the trailing period is not part
  // of it. "  Preview at 127.0.0.1:4173." — cells 14..27, period at 28.
  await userEvent.hover(grid, at(28, 2));
  await waitFor(() => expect(hint()).not.toBeInTheDocument());
  await userEvent.click(grid, at(27, 2));
  await waitFor(() => expect(openUrl).toHaveBeenLastCalledWith("http://127.0.0.1:4173/"));

  // Row 3: neither invalid candidate is clickable.
  for (const x of [5, 22]) {
    await userEvent.hover(grid, at(x, 3));
    await waitFor(() => expect(hint()).not.toBeInTheDocument());
    await userEvent.click(grid, at(x, 3));
  }
  expect(openUrl).toHaveBeenCalledTimes(3);

  // Row 4 wraps onto row 5: hovering the continuation still opens the whole URL.
  const expected = `http://localhost:3000${longPath}`;
  await userEvent.hover(grid, at(3, 5));
  await waitFor(() => expect(hint()).toHaveTextContent(expected));
  await userEvent.click(grid, at(3, 5));
  await waitFor(() => expect(openUrl).toHaveBeenLastCalledWith(expected));
  expect(openUrl).toHaveBeenCalledTimes(4);
});

it("shows an error when the browser cannot be opened", async () => {
  vi.mocked(openUrl).mockRejectedValue(new Error("No default browser"));
  const sizes: Array<[number, number]> = [];
  const store = outputStore("https://localhost:8443/\n");
  const view = render(<Dock store={store} onResize={(cols, rows) => sizes.push([cols, rows])} />);
  await waitFor(() => expect(sizes.length).toBeGreaterThan(0));
  await waitFor(() => expect(view.container.querySelector(".xterm-rows")).toHaveTextContent("localhost:8443"));
  const [cols, rows] = sizes[sizes.length - 1];
  await userEvent.click(view.container.querySelector<HTMLElement>(".xterm-screen")!, { position: cellPoint(view.container, cols, rows, 4, 1) });
  const alert = await screen.findByRole("alert");
  expect(alert).toHaveTextContent("Couldn’t open link: No default browser https://localhost:8443/");
  // The reason itself is on screen, inside the strip, not only in a tooltip.
  const detail = alert.querySelector<HTMLElement>(".terminal-link-detail")!;
  const strip = rect(view.container, ".terminal-link-strip");
  const reason = detail.getBoundingClientRect();
  expect(detail.scrollWidth).toBeLessThanOrEqual(detail.clientWidth + 1);
  expect(reason.left).toBeGreaterThanOrEqual(strip.left);
  expect(reason.right).toBeLessThanOrEqual(strip.right);
  expect(reason.top).toBeGreaterThanOrEqual(strip.top);
  expect(reason.bottom).toBeLessThanOrEqual(strip.bottom);
});

it("keeps link hints in a reserved strip that neither covers output nor resizes the grid", async () => {
  const sizes: Array<[number, number]> = [];
  const store = outputStore("http://localhost:5173/\n");
  const view = render(<Dock store={store} onResize={(cols, rows) => sizes.push([cols, rows])} />);
  await waitFor(() => expect(sizes.length).toBeGreaterThan(0));
  await waitFor(() => expect(view.container.querySelector(".xterm-rows")).toHaveTextContent("localhost:5173"));
  const [cols, rows] = sizes[sizes.length - 1];
  const reported = sizes.length;
  const host = rect(view.container, ".xterm-host");
  const strip = view.container.querySelector<HTMLElement>(".terminal-link-strip")!;
  const idle = strip.getBoundingClientRect();
  expect(strip).toHaveAttribute("data-state", "idle");
  expect(strip).toHaveTextContent("Click a link to open it in your browser");
  // Below the grid, not over it.
  expect(idle.top).toBeGreaterThanOrEqual(rect(view.container, ".terminal-screen").bottom - 0.5);
  expect(idle.top).toBeGreaterThanOrEqual(rect(view.container, ".xterm-screen").bottom);

  const grid = view.container.querySelector<HTMLElement>(".xterm-screen")!;
  for (let pass = 0; pass < 3; pass += 1) {
    await userEvent.hover(grid, { position: cellPoint(view.container, cols, rows, 4, 1) });
    await waitFor(() => expect(strip).toHaveAttribute("data-state", "hover"));
    expect(strip.getBoundingClientRect().height).toBe(idle.height);
    await userEvent.hover(grid, { position: cellPoint(view.container, cols, rows, 4, 3) });
    await waitFor(() => expect(strip).toHaveAttribute("data-state", "idle"));
  }
  // Hovering changed no geometry, so no PTY resize was reported.
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  expect(sizes).toHaveLength(reported);
  expect(rect(view.container, ".xterm-host")).toEqual(host);
  expect(strip.getBoundingClientRect()).toEqual(idle);
});

it("hits international links cell for cell around wide characters", async () => {
  const sizes: Array<[number, number]> = [];
  // 見 and る take two cells each; so do 日, 本 and 語 inside the link.
  // Cells: 見 3-4, る 5-6, link 8-35 ("localhost:5173/" 8-22, 日本語 23-28,
  // "?q=caf" 29-34, é 35), then a space at 36.
  const store = outputStore("  見る localhost:5173/日本語?q=café ok\n");
  const view = render(<Dock store={store} onResize={(cols, rows) => sizes.push([cols, rows])} />);
  await waitFor(() => expect(sizes.length).toBeGreaterThan(0));
  await waitFor(() => expect(view.container.querySelector(".xterm-rows")).toHaveTextContent("localhost:5173"));
  const [cols, rows] = sizes[sizes.length - 1];
  expect(cols).toBeGreaterThanOrEqual(40);
  const grid = view.container.querySelector<HTMLElement>(".xterm-screen")!;
  const at = (x: number) => ({ position: cellPoint(view.container, cols, rows, x, 1) });
  const strip = view.container.querySelector<HTMLElement>(".terminal-link-strip")!;
  const expected = "http://localhost:5173/%E6%97%A5%E6%9C%AC%E8%AA%9E?q=caf%C3%A9";

  for (const x of [4, 7, 36]) {
    await userEvent.hover(grid, at(x));
    await waitFor(() => expect(strip).toHaveAttribute("data-state", "idle"));
    await userEvent.click(grid, at(x));
  }
  expect(openUrl).not.toHaveBeenCalled();
  for (const x of [8, 28, 35]) {
    await userEvent.hover(grid, at(x));
    await waitFor(() => expect(strip, `cell ${x}`).toHaveTextContent(expected));
    await userEvent.click(grid, at(x));
  }
  await waitFor(() => expect(openUrl).toHaveBeenCalledTimes(3));
  for (const call of vi.mocked(openUrl).mock.calls) expect(call).toEqual([expected]);
});

/** The colour `value` (a CSS expression) resolves to inside `scope`. */
function resolvedColor(scope: Element, value: string) {
  const probe = document.createElement("span");
  probe.style.color = value;
  scope.appendChild(probe);
  const color = getComputedStyle(probe).color;
  probe.remove();
  return color;
}

function alpha(color: string) {
  const values = color.match(/[\d.]+/g)!.map(Number);
  return values.length > 3 ? values[3] : 1;
}

it.each(["mythra", "light-mythra", "kiwi", "atari"] as const)("keeps Run and Stop quiet, neutral icon controls in %s", async (theme) => {
  const store = outputStore();
  const view = render(<Dock theme={theme} store={store} />);
  const shell = view.container.querySelector(".app-shell")!;
  const accent = resolvedColor(shell, "var(--green)");
  const muted = resolvedColor(shell, "var(--muted)");
  const run = screen.getByRole("button", { name: "Run terminal command" });
  const quiet = (button: HTMLElement) => {
    const style = getComputedStyle(button);
    expect(style.borderTopWidth).toBe("0px");
    expect(style.backgroundColor).toBe("rgba(0, 0, 0, 0)");
    expect(style.boxShadow).toBe("none");
    expect(style.backgroundImage).toBe("none");
  };

  // At rest, empty or ready: no tile, outline or accent ink.
  // (The pointer may still sit where a previous case left it.)
  await userEvent.hover(screen.getByRole("textbox", { name: "Terminal command" }));
  quiet(run);
  expect(run).toBeDisabled();
  expect(Number(getComputedStyle(run).opacity)).toBeLessThan(1);
  await userEvent.fill(screen.getByRole("textbox", { name: "Terminal command" }), "npm test");
  expect(run).toBeEnabled();
  quiet(run);
  // Enabling eases the ink from the disabled tone; wait for it to settle.
  await waitFor(() => expect(getComputedStyle(run).color).toBe(muted));
  expect(getComputedStyle(run).color).not.toBe(accent);

  // Hover lays only a faint neutral surface under the glyph.
  await userEvent.hover(run);
  await waitFor(() => expect(getComputedStyle(run).backgroundColor).not.toBe("rgba(0, 0, 0, 0)"));
  expect(alpha(getComputedStyle(run).backgroundColor)).toBeLessThanOrEqual(.1);
  expect(getComputedStyle(run).borderTopWidth).toBe("0px");
  expect(getComputedStyle(run).boxShadow).toBe("none");

  // Keyboard focus is visible, and neutral rather than an accent ring.
  screen.getByRole("textbox", { name: "Terminal command" }).focus();
  // WebKit on macOS skips buttons on Tab unless keyboard navigation is on,
  // so focus follows a keyboard interaction directly, which still counts as
  // keyboard focus for :focus-visible.
  await userEvent.keyboard("{Shift}");
  run.focus();
  expect(run).toHaveFocus();
  expect(run.matches(":focus-visible")).toBe(true);
  const focus = getComputedStyle(run);
  expect(focus.outlineStyle).toBe("solid");
  expect(parseFloat(focus.outlineWidth)).toBeGreaterThanOrEqual(1);
  expect(focus.outlineColor).toBe(muted);
  expect(focus.boxShadow).toBe("none");
  view.unmount();

  // Stop is just as quiet, recognisable by its red glyph.
  const running = render(<Dock theme={theme} store={store} running />);
  const stop = screen.getByRole("button", { name: "Stop terminal command" });
  quiet(stop);
  expect(getComputedStyle(stop).color).toBe(resolvedColor(running.container.querySelector(".app-shell")!, "var(--red)"));
  running.unmount();
});
