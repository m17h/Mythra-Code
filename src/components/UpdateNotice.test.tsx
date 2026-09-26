import { act, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { UPDATE_NOTICE_PREVIEW_DELAY_MS, UpdateNotice, useUpdateNoticePreview, type UpdateNoticeState } from "./UpdateNotice";
import {
  PREVIEW_AVAILABLE_HOLD_MS,
  PREVIEW_DOWNLOAD_MS,
  PREVIEW_INSTALL_MS,
  PREVIEW_TICK_MS,
  PREVIEW_TOTAL_BYTES,
} from "./updateNoticePreview";

const updater = vi.hoisted(() => ({ check: vi.fn(), relaunch: vi.fn() }));
vi.mock("@tauri-apps/plugin-updater", () => ({ check: updater.check }));
vi.mock("@tauri-apps/plugin-process", () => ({ relaunch: updater.relaunch }));

const IDLE: UpdateNoticeState = { phase: "idle", availableVersion: null, downloadedBytes: 0, totalBytes: null, error: null };

function state(overrides: Partial<UpdateNoticeState>): UpdateNoticeState {
  return { ...IDLE, availableVersion: "1.19.0", ...overrides };
}

const available = state({ phase: "available" });
const downloading = (downloadedBytes: number, totalBytes: number | null) => state({ phase: "downloading", downloadedBytes, totalBytes });

function card() {
  return document.querySelector<HTMLElement>(".app-update-notice");
}

describe("UpdateNotice", () => {
  it("keeps an empty live region mounted until an update is available", () => {
    const view = render(<UpdateNotice update={IDLE} onOpen={vi.fn()} />);
    const region = view.container.querySelector("[aria-live='polite']");
    expect(region).toBeEmptyDOMElement();
    // Never a second role="status" beside the app's transient status messages.
    expect(screen.queryByRole("status")).toBeNull();

    view.rerender(<UpdateNotice update={available} onOpen={vi.fn()} />);
    // The same region receives the content, so assistive tech announces it.
    expect(view.container.querySelector("[aria-live='polite']")).toBe(region);
    expect(region).toHaveTextContent("Mythra Code 1.19.0 is available");
  });

  it("opens the Updates settings from its action", () => {
    const onOpen = vi.fn();
    render(<UpdateNotice update={available} onOpen={onOpen} />);
    fireEvent.click(screen.getByRole("button", { name: "View update" }));
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it("keeps the same card across unrelated rerenders so the entrance does not replay", () => {
    const view = render(<UpdateNotice update={available} onOpen={vi.fn()} />);
    const first = card();
    expect(first).not.toBeNull();
    view.rerender(<UpdateNotice update={{ ...available }} onOpen={vi.fn()} />);
    view.rerender(<UpdateNotice update={{ ...available }} onOpen={vi.fn()} />);
    expect(card()).toBe(first);
  });

  it("stays dismissed for that version but returns for a newer release", () => {
    const view = render(<UpdateNotice update={available} onOpen={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Dismiss update notice" }));
    expect(screen.queryByText(/is available/)).toBeNull();

    view.rerender(<UpdateNotice update={state({ phase: "current", availableVersion: null })} onOpen={vi.fn()} />);
    view.rerender(<UpdateNotice update={available} onOpen={vi.fn()} />);
    expect(screen.queryByText(/is available/)).toBeNull();

    view.rerender(<UpdateNotice update={state({ phase: "available", availableVersion: "1.20.0" })} onOpen={vi.fn()} />);
    expect(screen.getByText("Mythra Code 1.20.0 is available")).toBeInTheDocument();
  });

  it("continues the same card into a measured download", () => {
    const view = render(<UpdateNotice update={available} onOpen={vi.fn()} />);
    const first = card();

    view.rerender(<UpdateNotice update={downloading(0, 20_000_000)} onOpen={vi.fn()} />);
    expect(card()).toBe(first);
    expect(first).toHaveAttribute("data-stage", "downloading");
    expect(screen.getByText("Downloading Mythra Code 1.19.0")).toBeInTheDocument();
    const bar = screen.getByRole("progressbar", { name: "Downloading Mythra Code 1.19.0" });
    expect(bar).toHaveAttribute("aria-valuenow", "0");

    view.rerender(<UpdateNotice update={downloading(8_400_000, 20_000_000)} onOpen={vi.fn()} />);
    expect(bar).toHaveAttribute("aria-valuenow", "42");
    expect(bar).toHaveAttribute("aria-valuetext", "42%, 8.4 of 20.0 MB");
    expect(bar).not.toHaveClass("indeterminate");
    expect(bar.firstElementChild).toHaveStyle({ width: "42%" });
    expect(screen.getByText("42%")).toBeInTheDocument();
    expect(screen.getByText("8.4 of 20.0 MB")).toBeInTheDocument();
    // Active progress cannot be dismissed, but Settings stays one click away.
    expect(screen.queryByRole("button", { name: /Dismiss/ })).toBeNull();
    expect(screen.getByRole("button", { name: "Details" })).toBeInTheDocument();
  });

  it("keeps per-chunk numbers out of the live announcements", () => {
    render(<UpdateNotice update={downloading(8_400_000, 20_000_000)} onOpen={vi.fn()} />);
    expect(document.querySelector(".app-update-notice-meter")).toHaveAttribute("aria-hidden", "true");
    // The announced copy only changes when the stage does.
    expect(screen.getByText("Restarts once installed.")).toBeInTheDocument();
  });

  it("never overstates progress when more bytes arrive than were promised", () => {
    render(<UpdateNotice update={downloading(21_000_000, 20_000_000)} onOpen={vi.fn()} />);
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "100");
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuetext", "100%, 20.0 of 20.0 MB");
    expect(document.querySelector(".app-update-notice-bytes > span:first-child")).toHaveTextContent("20.0 of 20.0 MB");
  });

  it("shows an honest indeterminate state when the download size is unknown", () => {
    const view = render(<UpdateNotice update={downloading(0, null)} onOpen={vi.fn()} />);
    const bar = screen.getByRole("progressbar");
    expect(bar).toHaveClass("indeterminate");
    expect(bar).not.toHaveAttribute("aria-valuenow");
    expect(bar).not.toHaveAttribute("aria-valuetext");
    expect(screen.getByText("Starting…")).toBeInTheDocument();

    view.rerender(<UpdateNotice update={downloading(3_250_000, null)} onOpen={vi.fn()} />);
    expect(bar).not.toHaveAttribute("aria-valuenow");
    expect(bar).toHaveAttribute("aria-valuetext", "3.3 MB downloaded");
    expect(screen.getByText("3.3 MB")).toBeInTheDocument();
    expect(screen.queryByText(/%/)).toBeNull();

    // A zero-length header is no more a size than a missing one.
    view.rerender(<UpdateNotice update={downloading(3_250_000, 0)} onOpen={vi.fn()} />);
    expect(bar).toHaveClass("indeterminate");
  });

  it("shows an install in progress even after availability was dismissed", () => {
    const view = render(<UpdateNotice update={available} onOpen={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Dismiss update notice" }));
    expect(card()).toBeNull();

    view.rerender(<UpdateNotice update={downloading(0, null)} onOpen={vi.fn()} />);
    expect(screen.getByText("Downloading Mythra Code 1.19.0")).toBeInTheDocument();
  });

  it("walks through install and restart without claiming a percentage", () => {
    const view = render(<UpdateNotice update={downloading(20_000_000, 20_000_000)} onOpen={vi.fn()} />);
    const first = card();

    view.rerender(<UpdateNotice update={state({ phase: "installing", downloadedBytes: 20_000_000, totalBytes: 20_000_000 })} onOpen={vi.fn()} />);
    expect(card()).toBe(first);
    expect(screen.getByText("Installing Mythra Code 1.19.0")).toBeInTheDocument();
    const bar = screen.getByRole("progressbar", { name: "Installing Mythra Code 1.19.0" });
    expect(bar).toHaveClass("indeterminate");
    expect(bar).not.toHaveAttribute("aria-valuenow");
    expect(document.querySelector(".app-update-notice-meter")).toBeNull();

    view.rerender(<UpdateNotice update={state({ phase: "restarting", downloadedBytes: 20_000_000, totalBytes: 20_000_000 })} onOpen={vi.fn()} />);
    expect(card()).toBe(first);
    expect(screen.getByText("Restarting Mythra Code")).toBeInTheDocument();
    expect(screen.getByText("Version 1.19.0 is installed.")).toBeInTheDocument();
    expect(screen.queryByRole("progressbar")).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("reports a failed install, links to Settings, and can be dismissed", () => {
    const onOpen = vi.fn();
    const view = render(<UpdateNotice update={downloading(5_000_000, 20_000_000)} onOpen={onOpen} />);
    view.rerender(<UpdateNotice update={state({ phase: "error", error: "The signature did not match." })} onOpen={onOpen} />);

    expect(card()).toHaveAttribute("data-stage", "failed");
    expect(screen.getByText("The update didn’t finish")).toBeInTheDocument();
    expect(screen.getByText("The signature did not match.")).toHaveAttribute("title", "The signature did not match.");
    expect(screen.queryByRole("progressbar")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "View details" }));
    expect(onOpen).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "Dismiss update error" }));
    expect(card()).toBeNull();
  });

  it("clears the failure when a retry starts and shows the update again", () => {
    const view = render(<UpdateNotice update={state({ phase: "installing" })} onOpen={vi.fn()} />);
    view.rerender(<UpdateNotice update={state({ phase: "error", error: null })} onOpen={vi.fn()} />);
    expect(screen.getByText("The update could not be completed.")).toBeInTheDocument();

    view.rerender(<UpdateNotice update={state({ phase: "checking" })} onOpen={vi.fn()} />);
    expect(card()).toBeNull();
    view.rerender(<UpdateNotice update={available} onOpen={vi.fn()} />);
    expect(screen.getByText("Mythra Code 1.19.0 is available")).toBeInTheDocument();

    // A second failure is shown afresh, even though the first was on screen.
    view.rerender(<UpdateNotice update={downloading(0, null)} onOpen={vi.fn()} />);
    view.rerender(<UpdateNotice update={state({ phase: "error", error: "Offline." })} onOpen={vi.fn()} />);
    expect(screen.getByText("Offline.")).toBeInTheDocument();
  });

  it("leaves errors from a manual check in Settings", () => {
    const view = render(<UpdateNotice update={state({ phase: "checking", availableVersion: null })} onOpen={vi.fn()} />);
    view.rerender(<UpdateNotice update={state({ phase: "error", availableVersion: null, error: "Offline." })} onOpen={vi.fn()} />);
    expect(card()).toBeNull();
  });

  it("does not report a failure it never watched happen", () => {
    render(<UpdateNotice update={state({ phase: "error", error: "Offline." })} onOpen={vi.fn()} />);
    expect(card()).toBeNull();
  });
});

describe("useUpdateNoticePreview", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  function advance(ms: number) {
    act(() => { vi.advanceTimersByTime(ms); });
  }

  it("shows nothing unless a development preview is requested", () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useUpdateNoticePreview());
    advance(UPDATE_NOTICE_PREVIEW_DELAY_MS * 2);
    expect(result.current).toBeNull();
  });

  it("reveals the environment preview after a delay so the entrance can be watched", () => {
    vi.useFakeTimers();
    vi.stubEnv("VITE_PREVIEW_UPDATE_NOTICE", "9.9.9");
    const { result } = renderHook(() => useUpdateNoticePreview());
    expect(result.current).toBeNull();
    advance(UPDATE_NOTICE_PREVIEW_DELAY_MS);
    expect(result.current).toMatchObject({ phase: "available", availableVersion: "9.9.9" });
    // The default scenario holds at "available".
    advance(PREVIEW_AVAILABLE_HOLD_MS + PREVIEW_DOWNLOAD_MS * 2);
    expect(result.current?.phase).toBe("available");
  });

  it("plays available, a measured download, install, then holds at restarting without touching the updater", () => {
    vi.useFakeTimers();
    vi.stubEnv("VITE_PREVIEW_UPDATE_NOTICE", "9.9.9");
    vi.stubEnv("VITE_PREVIEW_UPDATE_SCENARIO", "install");
    const { result } = renderHook(() => useUpdateNoticePreview());
    advance(UPDATE_NOTICE_PREVIEW_DELAY_MS);
    expect(result.current?.phase).toBe("available");

    advance(PREVIEW_AVAILABLE_HOLD_MS);
    expect(result.current).toMatchObject({ phase: "downloading", downloadedBytes: 0, totalBytes: PREVIEW_TOTAL_BYTES });
    let previous = 0;
    for (let elapsed = 0; elapsed < PREVIEW_DOWNLOAD_MS / 2; elapsed += PREVIEW_TICK_MS) {
      advance(PREVIEW_TICK_MS);
      expect(result.current!.downloadedBytes).toBeGreaterThanOrEqual(previous);
      previous = result.current!.downloadedBytes;
    }
    expect(previous).toBeGreaterThan(0);
    expect(previous).toBeLessThan(PREVIEW_TOTAL_BYTES);

    advance(PREVIEW_DOWNLOAD_MS / 2 + PREVIEW_TICK_MS);
    expect(result.current).toMatchObject({ phase: "installing", downloadedBytes: PREVIEW_TOTAL_BYTES });
    advance(PREVIEW_INSTALL_MS);
    expect(result.current?.phase).toBe("restarting");
    advance(60_000);
    expect(result.current?.phase).toBe("restarting");

    expect(updater.check).not.toHaveBeenCalled();
    expect(updater.relaunch).not.toHaveBeenCalled();
  });

  it("previews an unknown download size with no total at any point", () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useUpdateNoticePreview());
    act(() => { window.__mythraPreviewUpdateNotice?.("9.9.9", "install-unknown-size"); });
    advance(PREVIEW_AVAILABLE_HOLD_MS + PREVIEW_TICK_MS * 5);
    expect(result.current).toMatchObject({ phase: "downloading", totalBytes: null });
    expect(result.current!.downloadedBytes).toBeGreaterThan(0);
    advance(PREVIEW_DOWNLOAD_MS);
    expect(result.current?.phase).toBe("installing");
  });

  it("previews a failure partway through the download", () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useUpdateNoticePreview());
    act(() => { window.__mythraPreviewUpdateNotice?.("9.9.9", "failure"); });
    advance(PREVIEW_AVAILABLE_HOLD_MS + PREVIEW_DOWNLOAD_MS * 2);
    expect(result.current?.phase).toBe("error");
    expect(result.current?.error).toMatch(/interrupted/);
    expect(result.current!.downloadedBytes).toBeLessThan(PREVIEW_TOTAL_BYTES);
  });

  it("falls back to the available scenario for an unknown name", () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { result } = renderHook(() => useUpdateNoticePreview());
    act(() => { window.__mythraPreviewUpdateNotice?.("9.9.9", "explode" as never); });
    advance(PREVIEW_AVAILABLE_HOLD_MS * 4);
    expect(result.current?.phase).toBe("available");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("explode"));
  });

  it("stops a running scenario when hidden, replaced, or unmounted", () => {
    vi.useFakeTimers();
    const { result, unmount } = renderHook(() => useUpdateNoticePreview());
    act(() => { window.__mythraPreviewUpdateNotice?.("9.9.9", "install"); });
    advance(PREVIEW_AVAILABLE_HOLD_MS + PREVIEW_TICK_MS * 3);
    expect(result.current?.phase).toBe("downloading");

    act(() => { window.__mythraPreviewUpdateNotice?.(null); });
    expect(result.current).toBeNull();
    advance(PREVIEW_DOWNLOAD_MS * 2);
    expect(result.current).toBeNull();

    act(() => { window.__mythraPreviewUpdateNotice?.("9.9.8"); });
    act(() => { window.__mythraPreviewUpdateNotice?.("9.9.9", "install"); });
    advance(PREVIEW_AVAILABLE_HOLD_MS + PREVIEW_TICK_MS);
    expect(result.current).toMatchObject({ phase: "downloading", availableVersion: "9.9.9" });

    unmount();
    expect(window.__mythraPreviewUpdateNotice).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("is inert outside development builds", async () => {
    vi.useFakeTimers();
    vi.stubEnv("DEV", false);
    vi.stubEnv("VITE_PREVIEW_UPDATE_NOTICE", "9.9.9");
    vi.stubEnv("VITE_PREVIEW_UPDATE_SCENARIO", "install");
    vi.resetModules();
    const production = await import("./UpdateNotice");
    const { result } = renderHook(() => production.useUpdateNoticePreview());
    advance(UPDATE_NOTICE_PREVIEW_DELAY_MS + PREVIEW_AVAILABLE_HOLD_MS * 4);
    expect(result.current).toBeNull();
    expect(window.__mythraPreviewUpdateNotice).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
  });
});
