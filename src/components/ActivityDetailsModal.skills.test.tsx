import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { Activity } from "../types";
import { ActivityDetailsModal, type ActivityDetailsRun } from "./ActivityDetailsModal";

vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));

const skillCall = (id: string, name: string, status: "loaded" | "pending" | "failed" = "loaded"): ActivityDetailsRun["entries"][number] => ({
  kind: "activity",
  value: { id, kind: "command", title: `Skill ${name}`, status: "completed", skillUsage: [{ name, source: "claude-skill-tool", status }] } as Activity,
});
const step = (id: string): ActivityDetailsRun["entries"][number] => ({ kind: "activity", value: { id, kind: "command", title: "ls", status: "completed" } });

function renderRun(entries: ActivityDetailsRun["entries"]) {
  const onClose = vi.fn();
  const view = render(<div className="app-shell" data-theme="mythra" data-color-scheme="dark">
    <ActivityDetailsModal run={{ state: "completed", entries }} sourceRef={{ current: null }} onClose={onClose}
      renderMessage={(message) => <p>{message.text}</p>} renderSubAgents={() => null} />
  </div>);
  return { onClose, ...view };
}

describe("Activity skill usage", () => {
  it("is hidden when no skill was loaded, including pending and failed calls", () => {
    renderRun([step("a"), skillCall("b", "release-check", "pending"), skillCall("c", "frontend-design", "failed")]);
    expect(screen.queryByText(/skills? used/)).toBeNull();
  });

  it("counts unique loaded skills with singular and plural wording", () => {
    const one = renderRun([skillCall("a", "frontend-design"), skillCall("b", "frontend-design")]);
    expect(screen.getByRole("button", { name: "1 skill used" })).toBeInTheDocument();
    one.unmount();
    renderRun([skillCall("a", "frontend-design"), step("x"), skillCall("b", "webapp-testing")]);
    expect(screen.getByRole("button", { name: "2 skills used" })).toBeInTheDocument();
  });

  it("shows exact names on focus, hover and click, and Escape closes only the names first", () => {
    const longName = "a-very-long-skill-name-that-must-wrap-inside-the-panel-without-overflowing-the-window";
    const { onClose } = renderRun([skillCall("a", "frontend-design"), skillCall("b", longName)]);
    const trigger = screen.getByRole("button", { name: "2 skills used" });
    const panel = document.getElementById(trigger.getAttribute("aria-controls")!)!;
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(panel).not.toBeVisible();

    fireEvent.focus(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(trigger).toHaveAccessibleDescription(`Skills used in this run frontend-design ${longName} Skills loaded into this run or reported by the provider. Unreported automatic activations cannot be counted. Loading a skill does not prove its instructions were followed.`);
    expect(panel).toBeVisible();
    expect(screen.getByRole("tooltip")).toHaveTextContent(longName);

    fireEvent.keyDown(trigger, { key: "Escape" });
    expect(panel).not.toBeVisible();
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.blur(trigger);
    fireEvent.pointerEnter(trigger, { pointerType: "mouse" });
    expect(panel).toBeVisible();

    fireEvent.click(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    fireEvent.click(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "false");

    fireEvent.keyDown(trigger, { key: "Escape" });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("keeps a clicked list open after the pointer leaves until an outside click", async () => {
    renderRun([skillCall("a", "frontend-design")]);
    const trigger = screen.getByRole("button", { name: "1 skill used" });
    fireEvent.click(trigger);
    fireEvent.pointerLeave(trigger, { pointerType: "mouse" });
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    fireEvent.pointerDown(screen.getByRole("heading", { name: "Activity" }));
    expect(trigger).toHaveAttribute("aria-expanded", "false");
  });
});
