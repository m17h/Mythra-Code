import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { AppActionMenu } from "./AppActionMenu";
import "../styles.css";

it("opens in the requested keyboard direction in a real browser", async () => {
  render(
    <AppActionMenu
      label="More"
      items={[
        { id: "first", label: "First", disabled: true, onSelect: vi.fn() },
        { id: "middle", label: "Middle", onSelect: vi.fn() },
        { id: "last", label: "Last", onSelect: vi.fn() },
      ]}
    />,
  );
  const trigger = screen.getByRole("button", { name: "More" });

  trigger.focus();
  fireEvent.keyDown(trigger, { key: "ArrowUp" });
  await waitFor(() => expect(screen.getByRole("menuitem", { name: "Last" })).toHaveFocus());

  fireEvent.keyDown(document, { key: "Escape" });
  expect(trigger).toHaveFocus();

  fireEvent.keyDown(trigger, { key: "ArrowDown" });
  await waitFor(() => expect(screen.getByRole("menuitem", { name: "Middle" })).toHaveFocus());
});
