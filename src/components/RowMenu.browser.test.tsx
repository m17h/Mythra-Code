import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { RowMenu } from "./RowMenu";

afterEach(() => { document.getAnimations().forEach((animation) => animation.cancel()); });

it("keeps the thread menu anchored to its trigger throughout the row entrance", () => {
  const view = render(<div className="app-shell" data-theme="mythra" data-color-scheme="dark">
    <aside className="sidebar open" style={{ marginTop: 100 }}>
      <div className="thread-list">
        <div className="thread-row-wrap">
          <button className="thread-card">A conversation</button>
          <RowMenu label="Options for a conversation" items={[{ label: "Rename", onSelect: () => {} }]} />
        </div>
      </div>
    </aside>
  </div>);
  // Freeze the real entrance in its middle; do not wait until the transform
  // releases, which would mask a changed fixed-position containing block.
  const animations = view.container.getAnimations({ subtree: true });
  expect(animations.some((animation) => (animation as CSSAnimation).animationName === "lm-rise-sm")).toBe(true);
  animations.forEach((animation) => { animation.pause(); animation.currentTime = 160; });
  const trigger = screen.getByRole("button", { name: "Options for a conversation" });
  fireEvent.click(trigger);
  screen.getByRole("menu").getAnimations().forEach((animation) => { animation.pause(); animation.currentTime = 160; });
  const buttonBounds = trigger.getBoundingClientRect();
  const menuBounds = screen.getByRole("menu").getBoundingClientRect();
  expect(Math.abs(menuBounds.top - (buttonBounds.bottom + 4))).toBeLessThanOrEqual(1);
  expect(Math.abs(menuBounds.right - buttonBounds.right)).toBeLessThanOrEqual(1);
  const action = screen.getByRole("menuitem", { name: "Rename" });
  const actionBounds = action.getBoundingClientRect();
  expect(action.contains(document.elementFromPoint(actionBounds.left + actionBounds.width / 2, actionBounds.top + actionBounds.height / 2))).toBe(true);
});
