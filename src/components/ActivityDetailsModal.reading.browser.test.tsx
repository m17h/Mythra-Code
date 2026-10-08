import { useRef } from "react";
import { render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { commands, page, userEvent } from "vitest/browser";
import { themeColorScheme } from "../lib/appConfig";
import type { Activity, ThemeName } from "../types";
import { ActivityDetailsModal, type ActivityDetailsRun } from "./ActivityDetailsModal";
// Production order (startApplication.tsx): legacy sheet, then Lumen.
import "../styles.css";
import "../styles/lumen/index.css";

/**
 * The Activity window is read for the agent's reasoning; commands are the
 * supporting record. These checks pin that hierarchy in real layout, in
 * every theme, at a small window and under UI zoom.
 */

afterEach(async () => {
  await commands.setStreamTestReducedMotion(false);
  await page.viewport(1400, 900);
});

const command = (id: string, title: string, status: Activity["status"] = "completed"): ActivityDetailsRun["entries"][number] => ({
  kind: "activity", value: { id, kind: "command", title, detail: `output of ${id}`, status },
});
const run: ActivityDetailsRun = {
  state: "completed",
  entries: [
    command("grep", 'cd "/Users/demo/Space Game 2"; grep -n "JobType" src/systems/state.ts; grep -rln "JOB_" src'),
    { kind: "activity", value: { id: "think", kind: "reasoning", title: "Reasoning", status: "completed",
      detail: "I've laid out a plan for six new place types with shops, quest-giving residents and a new foot-based job board. Now I'm studying how scripts emit events." } },
    command("sed", 'cd "/Users/demo/Space Game 2"; sed -n 870,905p src/story/scripts.ts', "failed"),
    { kind: "message", value: { id: "update", role: "assistant", text: "Still mapping the code. I'm checking whether site buildings can have enterable interiors." } },
  ],
};

function History({ theme, zoom = 1 }: { theme: ThemeName; zoom?: number }) {
  const sourceRef = useRef<HTMLDivElement>(null);
  return <div ref={sourceRef} className="app-shell" data-theme={theme} data-color-scheme={themeColorScheme(theme)} style={{ zoom, ["--ui-scale" as string]: zoom }}>
    <ActivityDetailsModal sourceRef={sourceRef} onClose={vi.fn()} run={run}
      renderMessage={(message) => <div className="message-text">{message.text}</div>} renderSubAgents={() => null} />
  </div>;
}

function luminance(color: string) {
  // color-mix() computes to color(srgb r g b) with 0–1 channels.
  const scale = color.startsWith("color(srgb") ? 1 : 255;
  const [r, g, b] = color.match(/[\d.]+/g)!.slice(0, 3).map(Number).map((value) => {
    const channel = value / scale;
    return channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4;
  });
  return r * .2126 + g * .7152 + b * .0722;
}
function contrast(first: string, second: string) {
  const [high, low] = [luminance(first), luminance(second)].sort((a, b) => b - a);
  return (high + .05) / (low + .05);
}

it.each(["mythra", "light-mythra", "kiwi", "atari"] as const)("makes thinking and updates the primary text in %s", async (theme) => {
  await commands.setStreamTestReducedMotion(true);
  for (const [width, height, zoom] of [[1400, 900, 1], [560, 640, 1], [1400, 900, 1.25]] as const) {
    await page.viewport(width, height);
    const view = render(<History theme={theme} zoom={zoom} />);
    try {
      const dialog = screen.getByRole("dialog");
      const surface = getComputedStyle(dialog).backgroundColor;
      const thought = dialog.querySelector<HTMLElement>('[data-step-id="think"] .activity-step-thought')!;
      const update = dialog.querySelector<HTMLElement>('[data-step-id="update"] .activity-step-message')!;
      const commandTitle = dialog.querySelector<HTMLElement>('[data-step-id="grep"] .activity-step-title')!;
      const prose = getComputedStyle(thought);
      const secondary = getComputedStyle(commandTitle);

      // Prose: open, larger, full contrast, unboxed, and the same voice as updates.
      expect(thought).toBeVisible();
      expect(parseFloat(prose.fontSize)).toBeGreaterThanOrEqual(13.5);
      expect(parseFloat(prose.fontSize)).toBeGreaterThanOrEqual(parseFloat(secondary.fontSize) + 2);
      expect(contrast(prose.color, surface)).toBeGreaterThanOrEqual(7);
      expect(prose.backgroundColor).toBe("rgba(0, 0, 0, 0)");
      expect(prose.borderTopWidth).toBe("0px");
      expect(getComputedStyle(update).color).toBe(prose.color);
      expect(getComputedStyle(update).fontSize).toBe(prose.fontSize);
      const region = within(dialog).getByRole("region", { name: "Activity steps" });
      // A comfortable measure: in a wide window prose stops well short of the edge.
      if (width === 1400 && zoom === 1) expect(thought.getBoundingClientRect().width).toBeLessThan(region.getBoundingClientRect().width * .8);

      // Commands: readable, but quieter than the prose around them.
      expect(contrast(secondary.color, surface)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(secondary.color, surface)).toBeLessThan(contrast(prose.color, surface));
      expect(within(dialog).queryByText("output of grep")).not.toBeInTheDocument();

      // Prose steps have more room than operation rows.
      const room = (id: string) => parseFloat(getComputedStyle(dialog.querySelector(`[data-step-id="${id}"]`)!).paddingTop);
      expect(room("think")).toBeGreaterThanOrEqual(room("grep") + 4);

      // A failure is still unmistakable on a quiet row.
      const failedNode = getComputedStyle(dialog.querySelector('[data-step-id="sed"] .activity-step-node')!);
      expect(failedNode.color).not.toBe(getComputedStyle(dialog.querySelector('[data-step-id="grep"] .activity-step-node')!).color);
      expect(within(dialog.querySelector<HTMLElement>('[data-step-id="sed"]')!).getByText("Failed")).toBeVisible();

      // Nothing spills sideways at small sizes or under zoom.
      expect(region.scrollWidth).toBeLessThanOrEqual(region.clientWidth + 1);
      expect(commandTitle.scrollWidth).toBeGreaterThanOrEqual(commandTitle.clientWidth);
    } finally {
      view.unmount();
    }
  }
});

it("keeps keyboard focus visible on the thinking and output toggles", async () => {
  const view = render(<History theme="mythra" />);
  const dialog = screen.getByRole("dialog");
  const thinking = within(dialog).getByRole("button", { name: "Hide thinking: Thinking" });
  const output = within(dialog).getByRole("button", { name: `Show output: ${(run.entries[0].value as Activity).title}` });
  // WebKit skips buttons on Tab unless keyboard navigation is on; focus
  // after a key press still counts as keyboard focus for :focus-visible.
  await userEvent.keyboard("{Shift}");
  for (const toggle of [thinking, output]) {
    toggle.focus();
    expect(toggle.matches(":focus-visible")).toBe(true);
    expect(getComputedStyle(toggle).boxShadow).not.toBe("none");
  }
  await userEvent.click(thinking);
  expect(within(dialog).getByRole("button", { name: "Show thinking: Thinking" })).toHaveAttribute("aria-expanded", "false");
  view.unmount();
});
