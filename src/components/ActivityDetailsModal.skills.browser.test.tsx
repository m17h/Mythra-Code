import { useRef } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { commands, page, userEvent } from "vitest/browser";
import { themeColorScheme } from "../lib/appConfig";
import type { Activity, ThemeName } from "../types";
import { ActivityDetailsModal, type ActivityDetailsRun } from "./ActivityDetailsModal";
// Production order (startApplication.tsx): legacy sheet, then Lumen.
import "../styles.css";
import "../styles/lumen/index.css";

afterEach(async () => {
  await commands.setStreamTestReducedMotion(false);
  await page.viewport(1400, 900);
});

const longName = "an-unusually-long-skill-invocation-name-that-has-to-wrap-cleanly-inside-the-names-panel";
const names = ["frontend-design", "webapp-testing", longName, ...Array.from({ length: 24 }, (_, index) => `checklist-${index + 1}`)];
const run = (count: number): ActivityDetailsRun => ({
  state: "completed",
  summary: "Worked for 2 minutes",
  entries: names.slice(0, count).map((name, index) => ({ kind: "activity", value: {
    id: `skill-${index}`, kind: "command", title: `Skill ${name}`, status: "completed",
    skillUsage: [{ name, source: "claude-skill-tool", status: "loaded" }],
  } as Activity })),
});

function History({ theme, zoom, count, onClose }: { theme: ThemeName; zoom: number; count: number; onClose: () => void }) {
  const sourceRef = useRef<HTMLDivElement>(null);
  return <div ref={sourceRef} className="app-shell" data-theme={theme} data-color-scheme={themeColorScheme(theme)} style={{ zoom, ["--ui-scale" as string]: zoom }}>
    <ActivityDetailsModal sourceRef={sourceRef} onClose={onClose} run={run(count)}
      renderMessage={(message) => <div>{message.text}</div>} renderSubAgents={() => null} />
  </div>;
}

function expectInsideViewport(panel: HTMLElement) {
  const box = panel.getBoundingClientRect();
  expect(box.left).toBeGreaterThanOrEqual(0);
  expect(box.top).toBeGreaterThanOrEqual(0);
  expect(box.right).toBeLessThanOrEqual(window.innerWidth + 1);
  expect(box.bottom).toBeLessThanOrEqual(window.innerHeight + 1);
  expect(panel.scrollWidth).toBeLessThanOrEqual(panel.clientWidth + 1);
  // Painted above the modal dialog, not behind or clipped by it.
  const hit = document.elementFromPoint(box.left + box.width / 2, box.top + Math.min(box.height / 2, 20));
  expect(hit && panel.contains(hit)).toBe(true);
}

it.each([
  { theme: "mythra", zoom: 1 },
  { theme: "light-mythra", zoom: 1.5 },
] as const)("opens exact skill names above the native Activity dialog on hover, focus and click ($theme, $zoom×)", async ({ theme, zoom }) => {
  await commands.setStreamTestReducedMotion(true);
  await page.viewport(560, 520);
  const onClose = vi.fn();
  render(<History theme={theme} zoom={zoom} count={names.length} onClose={onClose} />);
  const dialog = document.querySelector<HTMLDialogElement>("dialog.activity-details-dialog")!;
  expect(dialog.open).toBe(true);
  const trigger = screen.getByRole("button", { name: `${names.length} skills used` });
  const panel = document.getElementById(trigger.getAttribute("aria-controls")!)!;
  expect(dialog.contains(panel)).toBe(true);

  await userEvent.hover(trigger);
  await waitFor(() => expect(panel.matches(":popover-open")).toBe(true));
  expectInsideViewport(panel);
  // The names never cover their own trigger.
  expect(panel.getBoundingClientRect().top).toBeGreaterThanOrEqual(trigger.getBoundingClientRect().bottom);
  expect(panel).toHaveTextContent(longName);
  expect(panel).toHaveTextContent("Skills loaded into this run or reported by the provider. Unreported automatic activations cannot be counted. Loading a skill does not prove its instructions were followed.");
  // A long list is bounded and scrolls instead of leaving the window.
  expect(panel.scrollHeight).toBeGreaterThan(panel.clientHeight);
  // Moving onto the panel keeps it open so a long list can be scrolled.
  await userEvent.hover(panel);
  await new Promise((resolve) => setTimeout(resolve, 220));
  expect(panel.matches(":popover-open")).toBe(true);
  // Leaving both trigger and panel closes it. The heading sits above the
  // trigger, so the panel below never covers it.
  await userEvent.hover(screen.getByRole("heading", { name: "Activity" }));
  await waitFor(() => expect(panel.matches(":popover-open")).toBe(false));

  // Keyboard: the steps region holds initial focus; Tab reaches the count.
  trigger.focus();
  await waitFor(() => expect(panel.matches(":popover-open")).toBe(true));
  expect(trigger).toHaveAccessibleDescription(expect.stringContaining("frontend-design"));
  await userEvent.keyboard("{Escape}");
  expect(panel.matches(":popover-open")).toBe(false);
  expect(dialog.open).toBe(true);
  expect(onClose).not.toHaveBeenCalled();

  // Click pins the list; an outside click inside the dialog releases it.
  await userEvent.click(trigger);
  expect(trigger).toHaveAttribute("aria-expanded", "true");
  await userEvent.hover(screen.getByRole("heading", { name: "Activity" }));
  await new Promise((resolve) => setTimeout(resolve, 220));
  expect(panel.matches(":popover-open")).toBe(true);
  await userEvent.click(screen.getByRole("heading", { name: "Activity" }));
  await waitFor(() => expect(panel.matches(":popover-open")).toBe(false));
  expect(onClose).not.toHaveBeenCalled();

  trigger.focus();
  await waitFor(() => expect(panel.matches(":popover-open")).toBe(true));
  await page.screenshot({ path: `../../test-results/official-skills/fixture-activity-skills-${theme}-${zoom}.png` });
  await userEvent.keyboard("{Escape}");
  await userEvent.keyboard("{Escape}");
  expect(onClose).toHaveBeenCalledOnce();
});

it("shows a single quiet count and nothing when no skill was used", async () => {
  await page.viewport(900, 700);
  const first = render(<History theme="mythra" zoom={1} count={1} onClose={vi.fn()} />);
  const trigger = screen.getByRole("button", { name: "1 skill used" });
  const meta = document.querySelector<HTMLElement>(".activity-details-meta")!;
  expect(trigger.getBoundingClientRect().top).toBeLessThan(meta.getBoundingClientRect().bottom);
  expect(getComputedStyle(trigger).fontSize).toBe(getComputedStyle(meta).fontSize);
  first.unmount();
  render(<History theme="mythra" zoom={1} count={0} onClose={vi.fn()} />);
  expect(screen.queryByText(/skills? used/)).toBeNull();
});
