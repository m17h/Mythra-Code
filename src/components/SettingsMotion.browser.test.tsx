import { useState, type CSSProperties } from "react";
import { act, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { commands, page } from "vitest/browser";
import { RotateCcw } from "lucide-react";
import "../styles.css";

// Settings stays mounted after its first open. Exercise its real CSS with
// the same open/closed and inert attributes without unrelated settings APIs.
function Fixture({ scale = 1 }: { scale?: number }) {
  const [open, setOpen] = useState(true);
  const [usage, setUsage] = useState(false);
  return <div style={{ zoom: scale, "--ui-scale": scale } as CSSProperties}>
    <button onClick={() => setOpen(true)}>Open settings</button>
    <div data-testid="backdrop" className={`modal-backdrop settings-backdrop ${open ? "open" : "closed"}`} inert={!open || undefined} aria-hidden={!open}>
      <div className={`settings-modal${usage ? " settings-modal-wide" : ""}`} data-testid="modal">
        <button onClick={() => setOpen(false)}>Close settings</button>
        <button onClick={() => setUsage(true)}>Usage</button>
        <button onClick={() => setUsage(false)}>General</button>
      </div>
    </div>
  </div>;
}

afterEach(async () => {
  await commands.setStreamTestReducedMotion(false);
  await page.viewport(1400, 900);
});

function resizeAnimations(modal: HTMLElement) {
  return modal.getAnimations().filter((animation) => animation instanceof CSSTransition && ["width", "height"].includes(animation.transitionProperty));
}

it("keeps the busy GitHub refresh indicator static only when reduced motion is requested", async () => {
  // Match GitHubSettings' busy button; its component test separately verifies
  // that the disabled button publishes aria-busy and applies this spinner class.
  const view = render(<div className="settings-backdrop open">
    <div className="settings-modal">
      <button className="icon-button" disabled aria-busy="true" aria-label="Refresh GitHub status"><RotateCcw size={14} className="spin" /></button>
    </div>
  </div>);
  const refresh = view.getByRole("button", { name: "Refresh GitHub status" });
  const icon = refresh.querySelector("svg")!;
  expect(getComputedStyle(icon).animationName).toBe("spin");
  expect(getComputedStyle(icon).animationIterationCount).toBe("infinite");
  expect(icon.getAnimations()).toHaveLength(1);

  await commands.setStreamTestReducedMotion(true);
  expect(getComputedStyle(icon).animationName).toBe("none");
  expect(icon.getAnimations()).toHaveLength(0);
  expect(refresh).toBeDisabled();
  expect(refresh).toHaveAttribute("aria-busy", "true");

  await commands.setStreamTestReducedMotion(false);
  expect(getComputedStyle(icon).animationName).toBe("spin");
  expect(icon.getAnimations()).toHaveLength(1);
});

it("smoothly expands for Usage and shrinks back without moving its center", async () => {
  await page.viewport(1400, 1000);
  const view = render(<Fixture />);
  const modal = view.getByTestId("modal");
  act(() => modal.getAnimations().forEach((animation) => animation.finish()));
  const start = modal.getBoundingClientRect();
  expect(start.width).toBeCloseTo(920, 0);
  expect(start.height).toBeCloseTo(720, 0);

  for (const [tab, smaller, larger] of [["Usage", start, { width: 1200, height: 880 }], ["General", start, { width: 1200, height: 880 }]] as const) {
    // Commit the starting layout so the browser can create real CSS transitions.
    void modal.offsetWidth;
    fireEvent.click(view.getByText(tab));
    const resize = resizeAnimations(modal);
    expect(resize).toHaveLength(2);
    for (const animation of resize) {
      animation.pause();
      animation.currentTime = Number(animation.effect!.getTiming().duration) / 2;
    }
    const midway = modal.getBoundingClientRect();
    expect(midway.width).toBeGreaterThan(smaller.width + 1);
    expect(midway.width).toBeLessThan(larger.width - 1);
    expect(midway.height).toBeGreaterThan(smaller.height + 1);
    expect(midway.height).toBeLessThan(larger.height - 1);
    expect(midway.left + midway.width / 2).toBeCloseTo(start.left + start.width / 2, 0);
    expect(midway.top + midway.height / 2).toBeCloseTo(start.top + start.height / 2, 0);
    act(() => resize.forEach((animation) => animation.finish()));
    expect(modal.getBoundingClientRect().width).toBeCloseTo(tab === "Usage" ? 1200 : 920, 0);
    expect(modal.getBoundingClientRect().height).toBeCloseTo(tab === "Usage" ? 880 : 720, 0);
  }
});

it("reverses a resize from its current size without snapping", () => {
  const view = render(<Fixture />);
  const modal = view.getByTestId("modal");
  act(() => modal.getAnimations().forEach((animation) => animation.finish()));
  void modal.offsetWidth;
  fireEvent.click(view.getByText("Usage"));
  const expansion = resizeAnimations(modal);
  expect(expansion).toHaveLength(2);
  for (const animation of expansion) {
    animation.pause();
    animation.currentTime = 80;
  }
  const before = modal.getBoundingClientRect();
  fireEvent.click(view.getByText("General"));
  const contraction = resizeAnimations(modal);
  expect(contraction).toHaveLength(2);
  contraction.forEach((animation) => { animation.pause(); animation.currentTime = 0; });
  const after = modal.getBoundingClientRect();
  expect(after.width).toBeCloseTo(before.width, 0);
  expect(after.height).toBeCloseTo(before.height, 0);
  act(() => contraction.forEach((animation) => animation.finish()));
  expect(modal.getBoundingClientRect().width).toBeCloseTo(920, 0);
  expect(modal.getBoundingClientRect().height).toBeCloseTo(720, 0);
});

it("resizes immediately when reduced motion is requested", async () => {
  await commands.setStreamTestReducedMotion(true);
  const view = render(<Fixture />);
  const modal = view.getByTestId("modal");
  for (const [tab, width] of [["Usage", 1200], ["General", 920]] as const) {
    void modal.offsetWidth;
    fireEvent.click(view.getByText(tab));
    expect(modal.getAnimations()).toHaveLength(0);
    expect(modal.getBoundingClientRect().width).toBeCloseTo(width, 0);
  }
});

it("does not snap to the target size if closed during a resize", () => {
  const view = render(<Fixture />);
  const modal = view.getByTestId("modal");
  act(() => modal.getAnimations().forEach((animation) => animation.finish()));
  void modal.offsetWidth;
  fireEvent.click(view.getByText("Usage"));
  const resize = resizeAnimations(modal);
  expect(resize).toHaveLength(2);
  resize.forEach((animation) => { animation.pause(); animation.currentTime = 80; });
  const width = Number.parseFloat(getComputedStyle(modal).width);
  const height = Number.parseFloat(getComputedStyle(modal).height);
  fireEvent.click(view.getByText("Close settings"));
  expect(Number.parseFloat(getComputedStyle(modal).width)).toBeCloseTo(width, 0);
  expect(Number.parseFloat(getComputedStyle(modal).height)).toBeCloseTo(height, 0);
  expect(resizeAnimations(modal)).toHaveLength(2);
  fireEvent.click(view.getByText("Open settings"));
  expect(Number.parseFloat(getComputedStyle(modal).width)).toBeCloseTo(width, 0);
  act(() => modal.getAnimations().forEach((animation) => animation.finish()));
  expect(modal.getBoundingClientRect().width).toBeCloseTo(1200, 0);
});

it.each([[360, 400, 1], [640, 600, 1], [700, 1000, 1], [1024, 768, 1], [1400, 900, .9], [1024, 768, 1.25], [1024, 768, 1.5]])(
  "keeps both sizes inside a %ix%i viewport at scale %s",
  async (width, height, scale) => {
    await page.viewport(width, height);
    const view = render(<Fixture scale={scale} />);
    const modal = view.getByTestId("modal");
    act(() => modal.getAnimations().forEach((animation) => animation.finish()));
    for (const tab of ["Usage", "General"]) {
      void modal.offsetWidth;
      fireEvent.click(view.getByText(tab));
      const animations = resizeAnimations(modal);
      for (const animation of animations) {
        animation.pause();
        animation.currentTime = Number(animation.effect!.getTiming().duration) / 2;
      }
      for (const finished of [false, true]) {
        if (finished) act(() => animations.forEach((animation) => animation.finish()));
        const rect = modal.getBoundingClientRect();
        expect(rect.left).toBeGreaterThanOrEqual(0);
        expect(rect.top).toBeGreaterThanOrEqual(0);
        expect(rect.right).toBeLessThanOrEqual(width + 1);
        expect(rect.bottom).toBeLessThanOrEqual(height + 1);
        expect(rect.left + rect.width / 2).toBeCloseTo(width / 2, 0);
        expect(rect.top + rect.height / 2).toBeCloseTo(height / 2, 0);
      }
    }
  },
);

it("fades and shrinks on close before becoming hidden", async () => {
  const view = render(<Fixture />);
  const backdrop = view.getByTestId("backdrop");
  const modal = view.getByTestId("modal");
  act(() => backdrop.getAnimations({ subtree: true }).forEach((animation) => animation.finish()));
  expect(getComputedStyle(backdrop).opacity).toBe("1");
  fireEvent.click(view.getByText("Close settings"));
  const exit = backdrop.getAnimations()[0];
  expect(exit).toBeDefined();
  const animations = backdrop.getAnimations({ subtree: true });
  animations.forEach((animation) => {
    animation.pause();
    animation.currentTime = 90;
  });
  expect(backdrop.inert).toBe(true);
  expect(getComputedStyle(backdrop).visibility).toBe("visible");
  expect(Number(getComputedStyle(backdrop).opacity)).toBeGreaterThan(0);
  expect(Number(getComputedStyle(backdrop).opacity)).toBeLessThan(1);
  expect(Number(getComputedStyle(modal).opacity)).toBeGreaterThan(0);
  expect(Number(getComputedStyle(modal).opacity)).toBeLessThan(1);
  expect(new DOMMatrix(getComputedStyle(modal).transform).a).toBeLessThan(1);
  act(() => animations.forEach((animation) => animation.finish()));
  await waitFor(() => expect(getComputedStyle(backdrop).visibility).toBe("hidden"));
  expect(getComputedStyle(backdrop).opacity).toBe("0");
});

it("can reopen during closing and closes immediately with reduced motion", async () => {
  const view = render(<Fixture />);
  const backdrop = view.getByTestId("backdrop");
  backdrop.getAnimations({ subtree: true }).forEach((animation) => animation.finish());
  fireEvent.click(view.getByText("Close settings"));
  backdrop.getAnimations({ subtree: true }).forEach((animation) => {
    animation.pause();
    animation.currentTime = 70;
  });
  fireEvent.click(view.getByText("Open settings"));
  backdrop.getAnimations({ subtree: true }).forEach((animation) => animation.finish());
  expect(getComputedStyle(backdrop).visibility).toBe("visible");
  expect(getComputedStyle(backdrop).opacity).toBe("1");
  expect(backdrop.inert).toBe(false);
  await commands.setStreamTestReducedMotion(true);
  fireEvent.click(view.getByText("Close settings"));
  await waitFor(() => expect(getComputedStyle(backdrop).visibility).toBe("hidden"));
  expect(backdrop.getAnimations({ subtree: true })).toHaveLength(0);
});
