import { render, screen, within, waitFor } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { commands, userEvent } from "vitest/browser";
import { ActivityDetailsModal } from "./ActivityDetailsModal";
import { themeColorScheme } from "../lib/appConfig";
import type { ThemeName } from "../types";
import "../styles.css";
import "../styles/lumen/index.css";

const thought = "The first command failed, but the plan is still sound. I am comparing the existing behavior with the requested change before editing the implementation.";
const update = "I found the cause and am checking the smallest safe correction.";
const command = "cd C:/Projects/demo; npm run check";

afterEach(async () => { await commands.setStreamTestReducedMotion(false); });

it.each(["mythra", "light-mythra", "atari", "synthwave"] as ThemeName[])("makes thinking and updates easier to read than commands in %s", async (theme) => {
  await commands.setStreamTestReducedMotion(true);
  const source = { current: null as HTMLDivElement | null };
  const view = render(<div ref={(node) => { source.current = node; }} className="app-shell" data-theme={theme} data-color-scheme={themeColorScheme(theme)}>
    <ActivityDetailsModal sourceRef={source} onClose={() => {}} renderMessage={(message) => <p>{message.text}</p>} renderSubAgents={() => null}
      run={{ state: "running", entries: [
        { kind: "activity", value: { id: "command", kind: "command", title: command, detail: "Exit code 1: check failed", status: "failed" } },
        { kind: "activity", value: { id: "thought", kind: "reasoning", title: "Thinking", detail: thought, status: "inProgress" } },
        { kind: "message", value: { id: "update", role: "assistant", text: update, phase: "commentary" } },
      ] }} />
  </div>);
  const dialog = await screen.findByRole("dialog", { name: "Activity" });
  const thinking = within(dialog).getByText(thought);
  expect(thinking).toBeVisible();
  expect(thinking).toHaveClass("activity-step-thought");
  const commandTitle = within(dialog).getByText(command);
  const updateBody = within(dialog).getByText(update).closest(".activity-step-message")!;
  expect(parseFloat(getComputedStyle(thinking).fontSize)).toBeGreaterThan(parseFloat(getComputedStyle(commandTitle).fontSize));
  expect(parseFloat(getComputedStyle(updateBody).fontSize)).toBeGreaterThan(parseFloat(getComputedStyle(commandTitle).fontSize));
  expect(getComputedStyle(thinking).color).not.toBe(getComputedStyle(commandTitle).color);
  expect(getComputedStyle(thinking).lineHeight).not.toBe("normal");
  expect(within(dialog).queryByText("Exit code 1: check failed")).not.toBeInTheDocument();
  expect(within(dialog).getByText("Failed")).toBeVisible();
  const thinkingControl = within(dialog).getByRole("button", { name: "Hide thinking: Thinking" });
  expect(thinkingControl).toHaveAttribute("aria-expanded", "true");
  await userEvent.click(thinkingControl);
  expect(within(dialog).queryByText(thought, { selector: ".activity-step-thought" })).not.toBeInTheDocument();
  await userEvent.click(within(dialog).getByRole("button", { name: "Show thinking: Thinking" }));
  expect(within(dialog).getByText(thought)).toBeVisible();
  await userEvent.click(within(dialog).getByRole("button", { name: `Show output: ${command}` }));
  expect(within(dialog).getByText("Exit code 1: check failed")).toBeVisible();
  const body = dialog.querySelector<HTMLElement>(".activity-details-scroll")!;
  await waitFor(() => expect(body.scrollWidth).toBeLessThanOrEqual(body.clientWidth + 1));
  view.unmount();
});
