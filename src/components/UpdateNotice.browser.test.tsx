import { render, screen } from "@testing-library/react";
import { commands } from "vitest/browser";
import { afterEach, expect, it, vi } from "vitest";
import { UpdateNotice, type UpdateNoticeState } from "./UpdateNotice";
import "../styles.css";

afterEach(async () => { await commands.setStreamTestReducedMotion(false); });

const IDLE: UpdateNoticeState = { phase: "idle", availableVersion: null, downloadedBytes: 0, totalBytes: null, error: null };

function stateFor(version: string | null, overrides: Partial<UpdateNoticeState> = {}): UpdateNoticeState {
  return version ? { ...IDLE, phase: "available", availableVersion: version, ...overrides } : IDLE;
}

const downloading = (downloadedBytes: number, totalBytes: number | null) =>
  stateFor("1.19.0", { phase: "downloading", downloadedBytes, totalBytes });

function Shell({ version, update, width }: { version?: string | null; update?: UpdateNoticeState; width?: number }) {
  return (
    <div className="app-shell" data-color-scheme="dark" style={{ display: "flex", height: 600, width }}>
      <main className="main-panel">
        <header className="topbar">Top bar</header>
        <UpdateNotice update={update ?? stateFor(version ?? null)} onOpen={() => undefined} />
        <section data-testid="content" style={{ flex: 1 }}>Thread</section>
      </main>
    </div>
  );
}

function card() {
  const element = document.querySelector<HTMLElement>(".app-update-notice");
  expect(element).not.toBeNull();
  return element!;
}

it("floats under the top bar without moving the thread or catching clicks beside it", () => {
  const view = render(<Shell version={null} />);
  const contentTop = screen.getByTestId("content").getBoundingClientRect().top;

  view.rerender(<Shell version="1.19.0" />);
  expect(screen.getByTestId("content").getBoundingClientRect().top).toBe(contentTop);

  const topbar = document.querySelector(".topbar")!.getBoundingClientRect();
  const bounds = card().getBoundingClientRect();
  expect(bounds.top).toBeGreaterThan(topbar.bottom);
  expect(bounds.height).toBeLessThan(48);
  // Compact, centred, and nowhere near the full width of the panel.
  expect(bounds.width).toBeLessThanOrEqual(600);
  const panel = document.querySelector(".main-panel")!.getBoundingClientRect();
  expect(Math.abs((bounds.left + bounds.right) / 2 - (panel.left + panel.right) / 2)).toBeLessThan(2);

  const beside = document.elementFromPoint(panel.left + 8, bounds.top + bounds.height / 2);
  expect(beside).toBe(screen.getByTestId("content"));
  expect(document.elementFromPoint(bounds.left + bounds.width / 2, bounds.top + bounds.height / 2)?.closest(".app-update-notice")).toBe(card());
});

it("plays the entrance once and does not restart it on rerender", () => {
  const view = render(<Shell version="1.19.0" />);
  const [animation] = card().getAnimations();
  expect((animation as CSSAnimation).animationName).toBe("update-notice-arrive");
  animation.pause();
  animation.currentTime = 200;

  view.rerender(<Shell version="1.19.0" />);
  const after = card().getAnimations();
  expect(after).toHaveLength(1);
  expect(after[0]).toBe(animation);
  expect(after[0].currentTime).toBe(200);
});

it("settles fully opaque in its resting position", async () => {
  render(<Shell version="1.19.0" />);
  await vi.waitFor(() => expect(card().getAnimations()).toHaveLength(0), { timeout: 2_000 });
  const style = getComputedStyle(card());
  expect(style.opacity).toBe("1");
  expect(style.transform).toBe("none");
});

it("falls back to a plain fade when reduced motion is requested", async () => {
  await commands.setStreamTestReducedMotion(true);
  render(<Shell version="1.19.0" />);
  const [animation] = card().getAnimations();
  expect((animation as CSSAnimation).animationName).toBe("update-notice-fade");
});

it("carries progress in the same footprint as the available notice", () => {
  const view = render(<Shell version="1.19.0" />);
  const before = card().getBoundingClientRect();

  view.rerender(<Shell update={downloading(7_728_000, 18_400_000)} />);
  const after = card().getBoundingClientRect();
  expect(after.top).toBe(before.top);
  expect(after.height).toBe(before.height);
  // Continuing into progress does not replay the entrance.
  expect(card().getAnimations().map((animation) => (animation as CSSAnimation).animationName)).not.toContain("update-sweep");

  const track = document.querySelector<HTMLElement>(".app-update-notice-progress")!.getBoundingClientRect();
  const fill = document.querySelector<HTMLElement>(".app-update-notice-progress > span")!.getBoundingClientRect();
  // The hairline sits inside the card's bottom edge, clear of the rounded corners.
  expect(track.left).toBeGreaterThan(after.left + 4);
  expect(track.right).toBeLessThan(after.right - 4);
  expect(track.bottom).toBeLessThanOrEqual(after.bottom);
  expect(track.height).toBeLessThanOrEqual(3);
  expect(fill.width / track.width).toBeCloseTo(0.42, 1);
});

it("does not shuffle sideways as the byte counter rolls over", () => {
  const view = render(<Shell update={downloading(900_000, 18_400_000)} />);
  const first = card().getBoundingClientRect();
  for (const bytes of [9_900_000, 10_000_000, 18_400_000]) {
    view.rerender(<Shell update={downloading(bytes, 18_400_000)} />);
    const next = card().getBoundingClientRect();
    expect(Math.abs(next.left - first.left)).toBeLessThan(1);
    expect(Math.abs(next.width - first.width)).toBeLessThan(1);
  }
});

it("keeps only the percentage on a narrow panel, but keeps bytes when size is unknown", () => {
  // Measured rather than toBeVisible(): the entrance fade starts at opacity 0.
  const shown = (selector: string) => document.querySelector<HTMLElement>(selector)!.getBoundingClientRect().width > 0;
  const view = render(<Shell width={560} update={downloading(7_728_000, 18_400_000)} />);
  expect(shown(".app-update-notice-bytes")).toBe(false);
  expect(shown(".app-update-notice-percent")).toBe(true);

  view.rerender(<Shell width={560} update={downloading(7_728_000, null)} />);
  expect(shown(".app-update-notice-bytes")).toBe(true);
});

it("sweeps an unknown-size download, and holds still under reduced motion", async () => {
  render(<Shell update={downloading(3_000_000, null)} />);
  const fill = document.querySelector<HTMLElement>(".app-update-notice-progress.indeterminate > span")!;
  expect(fill.getAnimations().map((animation) => (animation as CSSAnimation).animationName)).toContain("update-sweep");

  await commands.setStreamTestReducedMotion(true);
  expect(fill.getAnimations()).toHaveLength(0);
  // A steady, dimmed full track: working, amount unknown.
  expect(fill.getBoundingClientRect().width).toBeCloseTo(fill.parentElement!.getBoundingClientRect().width, 0);
  expect(Number(getComputedStyle(fill).opacity)).toBeLessThan(1);
});

it("stops the install spinner under reduced motion", async () => {
  await commands.setStreamTestReducedMotion(true);
  render(<Shell update={stateFor("1.19.0", { phase: "installing" })} />);
  const spinner = document.querySelector<SVGElement>(".app-update-notice-icon .spin")!;
  expect(spinner.getAnimations()).toHaveLength(0);
});

it("lets clicks through beside the progress card", () => {
  render(<Shell update={downloading(3_000_000, null)} />);
  const bounds = card().getBoundingClientRect();
  const panel = document.querySelector(".main-panel")!.getBoundingClientRect();
  expect(document.elementFromPoint(panel.left + 8, bounds.top + bounds.height / 2)).toBe(screen.getByTestId("content"));
});
