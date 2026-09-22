import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AppActionMenu } from "./AppActionMenu";

function items(overrides: Array<Partial<Parameters<typeof AppActionMenu>[0]["items"][number]>> = []) {
  const base = [
    { id: "one", label: "Reveal in Finder", onSelect: vi.fn() },
    { id: "two", label: "Refresh status", onSelect: vi.fn() },
    { id: "three", label: "Remove worktree…", danger: true, onSelect: vi.fn() },
  ];
  return base.map((item, index) => ({ ...item, ...overrides[index] }));
}

describe("AppActionMenu", () => {
  it("is the app's own menu, never an OS control", () => {
    const view = render(<AppActionMenu label="More" items={items()} />);

    expect(view.container.querySelector("select")).toBeNull();
    const trigger = screen.getByRole("button", { name: "More" });
    expect(trigger).toHaveAttribute("aria-haspopup", "menu");
    expect(trigger).toHaveAttribute("aria-expanded", "false");

    fireEvent.click(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("menu", { name: "More" })).toBeInTheDocument();
    expect(screen.getAllByRole("menuitem")).toHaveLength(3);
  });

  it("runs the chosen action once and closes behind itself", () => {
    const list = items();
    render(<AppActionMenu items={list} />);

    fireEvent.click(screen.getByRole("button", { name: "More" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Refresh status" }));

    expect(list[1].onSelect).toHaveBeenCalledOnce();
    // Closed before the action runs, so a confirmation dialog never opens
    // underneath a menu that is still hanging over it.
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "More" })).toHaveFocus();
  });

  it("refuses a disabled item and says why", () => {
    const list = items([{}, { disabled: true, title: "Wait for the current operation to finish." }]);
    render(<AppActionMenu items={list} />);

    fireEvent.click(screen.getByRole("button", { name: "More" }));
    const blocked = screen.getByRole("menuitem", { name: "Refresh status" });
    expect(blocked).toBeDisabled();
    expect(blocked).toHaveAttribute("title", "Wait for the current operation to finish.");

    fireEvent.click(blocked);
    expect(list[1].onSelect).not.toHaveBeenCalled();
    expect(screen.getByRole("menu")).toBeInTheDocument();
  });

  it("moves between items with the arrow keys, skipping what cannot be run", () => {
    render(<AppActionMenu items={items([{}, { disabled: true }])} />);

    fireEvent.click(screen.getByRole("button", { name: "More" }));
    const first = screen.getByRole("menuitem", { name: "Reveal in Finder" });
    const last = screen.getByRole("menuitem", { name: "Remove worktree…" });

    fireEvent.keyDown(first, { key: "ArrowDown" });
    expect(last).toHaveFocus();
    fireEvent.keyDown(last, { key: "ArrowUp" });
    expect(first).toHaveFocus();
  });

  it("opens toward the arrow direction and skips disabled edge items", async () => {
    const list = items([
      { disabled: true },
      {},
      { disabled: true },
    ]);
    render(<AppActionMenu items={list} />);
    const trigger = screen.getByRole("button", { name: "More" });

    fireEvent.keyDown(trigger, { key: "ArrowUp" });
    await new Promise(requestAnimationFrame);
    expect(screen.getByRole("menuitem", { name: "Refresh status" })).toHaveFocus();

    fireEvent.keyDown(document, { key: "Escape" });
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    await new Promise(requestAnimationFrame);
    expect(screen.getByRole("menuitem", { name: "Refresh status" })).toHaveFocus();
  });

  it("supports Home and End and closes when focus leaves the menu", () => {
    render(<><AppActionMenu items={items()} /><button type="button">Outside</button></>);
    fireEvent.click(screen.getByRole("button", { name: "More" }));
    const first = screen.getByRole("menuitem", { name: "Reveal in Finder" });
    const last = screen.getByRole("menuitem", { name: "Remove worktree…" });
    fireEvent.keyDown(first, { key: "End" });
    expect(last).toHaveFocus();
    fireEvent.keyDown(last, { key: "Home" });
    expect(first).toHaveFocus();
    fireEvent.blur(first, { relatedTarget: screen.getByRole("button", { name: "Outside" }) });
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("closes on Escape and returns focus to the trigger", () => {
    render(<AppActionMenu items={items()} />);
    const trigger = screen.getByRole("button", { name: "More" });

    fireEvent.click(trigger);
    fireEvent.keyDown(document, { key: "Escape" });

    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it("closes when something outside it is pressed", () => {
    render(<><AppActionMenu items={items()} /><button type="button">Elsewhere</button></>);

    fireEvent.click(screen.getByRole("button", { name: "More" }));
    fireEvent.pointerDown(screen.getByRole("button", { name: "Elsewhere" }));

    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("renders nothing at all rather than an empty menu", () => {
    const view = render(<AppActionMenu items={[]} />);
    expect(view.container).toBeEmptyDOMElement();
  });
});
