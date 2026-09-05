import { useState } from "react";
import { act, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { commands } from "vitest/browser";
import { DISCLOSURE_CLOSE_MS, DISCLOSURE_OPEN_MS, useDisclosureHeight } from "./useDisclosureHeight";

afterEach(async () => { await commands.setStreamTestReducedMotion(false); });

function Disclosure({ startOpen = true, rows = 4 }: { startOpen?: boolean; rows?: number }) {
  const [open, setOpen] = useState(startOpen);
  const { ref, present } = useDisclosureHeight<HTMLDivElement>(open);
  return (
    <div style={{ width: 240 }}>
      <button onClick={() => setOpen((current) => !current)}>Toggle</button>
      {(open || present) && (
        <div ref={ref} data-testid="panel" style={{ display: "flex", flexDirection: "column" }}>
          {Array.from({ length: rows }, (_, index) => (
            <div key={index} style={{ height: 34, flex: "0 0 34px" }}>Row {index + 1}</div>
          ))}
        </div>
      )}
    </div>
  );
}

const height = (element: HTMLElement) => element.getBoundingClientRect().height;

describe("useDisclosureHeight", () => {
  it("mounts at its natural height without animating the first paint", () => {
    const view = render(<Disclosure />);
    const panel = view.getByTestId("panel");
    expect(panel.getAnimations()).toHaveLength(0);
    expect(height(panel)).toBe(136);
  });

  it("shrinks to nothing on close, keeping the panel mounted until it lands", async () => {
    const view = render(<Disclosure />);
    const panel = view.getByTestId("panel");
    const natural = height(panel);

    fireEvent.click(view.getByRole("button", { name: "Toggle" }));
    const exit = panel.getAnimations()[0];
    expect(exit).toBeDefined();
    exit.pause();
    exit.currentTime = DISCLOSURE_CLOSE_MS / 2;
    // Mid-close it is genuinely part-way, not snapped to either end.
    expect(height(panel)).toBeGreaterThan(0);
    expect(height(panel)).toBeLessThan(natural);
    expect(Number(getComputedStyle(panel).opacity)).toBe(1);

    act(() => exit.finish());
    await waitFor(() => expect(view.queryByTestId("panel")).toBeNull());
  });

  it("grows from nothing to its measured height on open", async () => {
    const view = render(<Disclosure startOpen={false} />);
    expect(view.queryByTestId("panel")).toBeNull();

    fireEvent.click(view.getByRole("button", { name: "Toggle" }));
    const panel = view.getByTestId("panel");
    const entrance = panel.getAnimations()[0];
    entrance.pause();
    entrance.currentTime = 0;
    expect(height(panel)).toBe(0);
    entrance.currentTime = DISCLOSURE_OPEN_MS / 2;
    expect(height(panel)).toBeGreaterThan(0);
    expect(height(panel)).toBeLessThan(136);
    // Committed open from the start: an interrupted animation leaves a usable
    // panel rather than one frozen at whatever height it reached.
    expect(panel.style.height).toBe("");

    act(() => entrance.finish());
    // Back to auto once it lands, so adding a row later still fits.
    await waitFor(() => expect(panel.style.overflow).toBe(""));
    expect(panel.style.height).toBe("");
    expect(panel.getAnimations()).toHaveLength(0);
    expect(height(panel)).toBe(136);
  });

  it("holds the collapsed state itself, so finishing can never republish the open size", async () => {
    const view = render(<Disclosure />);
    const panel = view.getByTestId("panel");

    fireEvent.click(view.getByRole("button", { name: "Toggle" }));
    // The destination is committed before the transition plays. Nothing is
    // restored at the end, so there is no frame between the animation ending
    // and React unmounting where the full list can paint again.
    expect(panel.style.height).toBe("0px");
    expect(panel.style.overflow).toBe("hidden");

    const exit = panel.getAnimations()[0];
    exit.pause();
    exit.currentTime = DISCLOSURE_CLOSE_MS - 1;
    expect(panel.style.height).toBe("0px");

    exit.finish();
    await new Promise((resolve) => requestAnimationFrame(resolve));
    if (panel.isConnected) expect(height(panel)).toBe(0);
    await waitFor(() => expect(view.queryByTestId("panel")).toBeNull());
  });

  it("responds early while keeping revealed text fully legible", () => {
    const view = render(<Disclosure startOpen={false} />);
    fireEvent.click(view.getByRole("button", { name: "Toggle" }));
    const panel = view.getByTestId("panel");
    const animation = panel.getAnimations()[0];
    animation.pause();
    animation.currentTime = 40;
    expect(height(panel)).toBeGreaterThan(136 * 0.2);
    expect(height(panel)).toBeLessThan(136);
    expect(getComputedStyle(panel).opacity).toBe("1");
  });

  it("ignores stale completion after reversal and honors reduced motion", async () => {
    const view = render(<Disclosure />);
    const panel = view.getByTestId("panel");
    fireEvent.click(view.getByRole("button", { name: "Toggle" }));
    const exit = panel.getAnimations()[0];
    exit.pause();
    exit.currentTime = 60;
    const staleFinish = exit.onfinish;
    fireEvent.click(view.getByRole("button", { name: "Toggle" }));
    staleFinish?.call(exit, new Event("finish") as AnimationPlaybackEvent);
    expect(view.getByTestId("panel")).toBe(panel);
    await commands.setStreamTestReducedMotion(true);
    await waitFor(() => expect(panel.getAnimations()).toHaveLength(0));
    expect(height(panel)).toBe(136);
    expect(panel.style.overflow).toBe("");
  });

  it("reverses from the height it actually reached instead of jumping", async () => {
    const view = render(<Disclosure />);
    const panel = view.getByTestId("panel");
    fireEvent.click(view.getByRole("button", { name: "Toggle" }));
    const exit = panel.getAnimations()[0];
    exit.pause();
    exit.currentTime = DISCLOSURE_CLOSE_MS * 0.35;
    const reached = height(panel);

    fireEvent.click(view.getByRole("button", { name: "Toggle" }));
    // Same element, no unmount, and the reopen starts where the close stopped.
    expect(view.getByTestId("panel")).toBe(panel);
    const reopen = panel.getAnimations()[0];
    reopen.pause();
    reopen.currentTime = 0;
    expect(height(panel)).toBeCloseTo(reached, 0);

    act(() => reopen.finish());
    await waitFor(() => expect(height(panel)).toBe(136));
  });

  it("lands on the final state with no animation when motion is turned down", async () => {
    await commands.setStreamTestReducedMotion(true);
    const view = render(<Disclosure />);
    const panel = view.getByTestId("panel");

    fireEvent.click(view.getByRole("button", { name: "Toggle" }));
    expect(panel.getAnimations()).toHaveLength(0);
    await waitFor(() => expect(view.queryByTestId("panel")).toBeNull());

    fireEvent.click(view.getByRole("button", { name: "Toggle" }));
    const reopened = view.getByTestId("panel");
    expect(reopened.getAnimations()).toHaveLength(0);
    expect(height(reopened)).toBe(136);
  });
});
