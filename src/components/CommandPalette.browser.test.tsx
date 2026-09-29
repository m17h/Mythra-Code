import { useState } from "react";
import { render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { CommandPalette } from "./CommandPalette";
import "../styles.css";

afterEach(() => page.viewport(1400, 900));

function Fixture({ scale = 1, populated = false }: { scale?: number; populated?: boolean }) {
  const [open, setOpen] = useState(false);
  return <div className="app-shell" style={{ display: "block", zoom: scale }}>
    <button onClick={() => setOpen(true)}>Open palette</button>
    <button>Outside control</button>
    <CommandPalette open={open} projectActive={false} projects={populated ? Array.from({ length: 20 }, (_, index) => ({ id: `project-${index}`, name: `Project ${index}`, path: `/projects/${index}` })) : []} threads={[]} workflows={[]}
      onClose={() => setOpen(false)} onProject={vi.fn()} onThread={vi.fn()} onWorkflow={vi.fn()}
      onNewThread={vi.fn()} onSettings={vi.fn()} onTool={vi.fn()} />
  </div>;
}

it("keeps the palette and its scrollable results inside the native minimum window at enlarged scale", async () => {
  await page.viewport(980, 680);
  const view = render(<Fixture scale={1.5} populated />);
  await page.getByRole("button", { name: "Open palette" }).click();
  const dialog = view.getByRole("dialog", { name: "Command palette" });
  dialog.getAnimations().forEach((animation) => animation.finish());
  expect(dialog.getBoundingClientRect().right).toBeLessThanOrEqual(window.innerWidth - 1);
  expect(dialog.getBoundingClientRect().bottom).toBeLessThanOrEqual(window.innerHeight - 1);
  const results = view.getByRole("listbox", { name: "Matching commands" });
  expect(getComputedStyle(results).overflowY).toBe("auto");
  expect(results.scrollHeight).toBeGreaterThan(results.clientHeight);
  expect(dialog.querySelector(".palette-footer")!.getBoundingClientRect().bottom).toBeLessThanOrEqual(window.innerHeight - 1);
});

it("contains keyboard focus while open and restores the opener on Escape", async () => {
  const view = render(<Fixture />);
  const opener = view.getByRole("button", { name: "Open palette" });
  await page.getByRole("button", { name: "Open palette" }).click();
  const input = view.getByRole("textbox", { name: "Search commands, projects, and threads" });
  await expect.poll(() => document.activeElement).toBe(input);
  await userEvent.keyboard("{Shift>}{Tab}{/Shift}");
  expect(view.getByRole("dialog", { name: "Command palette" }).contains(document.activeElement)).toBe(true);
  expect(view.getByRole("option", { name: /Open settings/ })).toHaveFocus();
  await userEvent.keyboard("{Tab}");
  expect(input).toHaveFocus();
  await userEvent.keyboard("{Escape}");
  expect(view.queryByRole("dialog", { name: "Command palette" })).toBeNull();
  expect(opener).toHaveFocus();
  await page.getByRole("button", { name: "Open palette" }).click();
  await expect.poll(() => document.activeElement).toBe(view.getByRole("textbox", { name: "Search commands, projects, and threads" }));
  await userEvent.keyboard("{Shift>}{Tab}{/Shift}");
  expect(view.getByRole("option", { name: /Open settings/ })).toHaveFocus();
  await userEvent.keyboard("{Escape}");
  expect(view.queryByRole("dialog", { name: "Command palette" })).toBeNull();
  expect(opener).toHaveFocus();
});
