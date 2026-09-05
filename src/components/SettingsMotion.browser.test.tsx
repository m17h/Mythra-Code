import { useState } from "react";
import { act, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { commands } from "vitest/browser";
import "../styles.css";

// Settings stays mounted after its first open. Exercise its real CSS with
// the same open/closed and inert attributes without unrelated settings APIs.
function Fixture() {
  const [open, setOpen] = useState(true);
  return <>
    <button onClick={() => setOpen(true)}>Open settings</button>
    <div data-testid="backdrop" className={`modal-backdrop settings-backdrop ${open ? "open" : "closed"}`} inert={!open || undefined} aria-hidden={!open}>
      <div className="settings-modal" data-testid="modal">
        <button onClick={() => setOpen(false)}>Close settings</button>
      </div>
    </div>
  </>;
}

afterEach(async () => { await commands.setStreamTestReducedMotion(false); });

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
