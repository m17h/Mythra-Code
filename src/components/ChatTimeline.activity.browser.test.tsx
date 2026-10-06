import { StrictMode } from "react";
import { configure, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { commands, userEvent } from "vitest/browser";
import { ChatTimeline } from "./ChatTimeline";
import { ActivityDetailsModal, ACTIVITY_STEP_WINDOW } from "./ActivityDetailsModal";
import { ActivityStatus, ACTIVITY_STATUS_PHRASES } from "./ActivityStatus";
import { ApprovalCenter } from "./ApprovalCenter";
import { useAppShortcuts } from "../hooks/useAppShortcuts";
import { AgentQuestionDelivery } from "../lib/agentQuestionContext";
import type { Activity, ChatMessage, PendingApproval } from "../types";
// Match main.tsx; native top-layer behavior needs the shipped cascade.
import "../styles.css";
import "../styles/lumen/index.css";

// A native dialog disappearing would otherwise dump the whole transcript
// twice for each failure; retain the query error and its exact test location.
configure({ getElementError: (message) => new Error(message ?? "Activity browser query failed") });

declare module "vitest/internal/browser" {
  interface BrowserCommands {
    setStreamTestReducedMotion(reduced: boolean): Promise<void>;
  }
}

const prompt: ChatMessage = { id: "prompt", role: "user", text: "Inspect the project", timelineOrder: 1, turnId: "turn", turnStatus: "inProgress" };
const progress: ChatMessage = { id: "progress", role: "assistant", text: "Routine progress belongs in details", phase: "commentary", timelineOrder: 3, turnId: "turn", turnStatus: "inProgress" };
const final: ChatMessage = { id: "answer", role: "assistant", text: "The complete final answer", phase: "final", streaming: true, timelineOrder: 4, turnId: "turn", turnStatus: "inProgress" };
const tool: Activity = { id: "tool", kind: "command", title: "npm run check", detail: "Checks passed", status: "completed", timelineOrder: 2, turnId: "turn", turnStatus: "inProgress" };
const questionApproval: PendingApproval = {
  id: "approval", threadId: "thread", receivedAt: 1,
  method: "item/tool/requestUserInput",
  params: { questions: [{ id: "choice", header: "Direction", question: "Which direction?", options: [{ label: "First", description: "First direction" }, { label: "Second", description: "Second direction" }] }] },
};
const settleFrames = () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));

function Shell({ messages = [prompt, progress, final], activities = [tool], running = true, activeTurnId, searchQuery, approval, overlay, stopTurn = () => {}, shortcut = () => {} }: {
  messages?: ChatMessage[];
  activities?: Activity[];
  running?: boolean;
  activeTurnId?: string;
  searchQuery?: string;
  approval?: PendingApproval;
  overlay?: PendingApproval;
  stopTurn?: () => void;
  shortcut?: () => void;
}) {
  useAppShortcuts({ modalOpen: Boolean(overlay), commandPaletteOpen: false, threadOpen: true, running,
    workspaceOpen: false, workspaceAvailable: true, toggleCommandPalette: shortcut, openConversationSearch: shortcut,
    newThread: shortcut, openSettings: shortcut, toggleWorkspace: shortcut, closeWorkspace: shortcut, stopTurn });
  return <div className="app-shell" data-theme="mythra" data-color-scheme="dark" style={{ width: 1000, height: 760 }}>
    <AgentQuestionDelivery value={{ threadId: "activity-browser", send: async () => true }}>
      <ChatTimeline messages={messages} activities={activities} running={running} activeTurnId={activeTurnId} searchQuery={searchQuery} thinkingLabel="Working" approval={approval} provider="openai" />
    </AgentQuestionDelivery>
    {overlay && <ApprovalCenter approval={overlay} onRespond={vi.fn()} />}
  </div>;
}

const strictShell = (props: Parameters<typeof Shell>[0] = {}) => <StrictMode><Shell {...props} /></StrictMode>;

async function openDetails(button = screen.getByRole("button", { name: /View activity/ })) {
  await waitFor(() => {
    const bounds = button.getBoundingClientRect();
    expect(document.elementFromPoint(bounds.left + bounds.width / 2, bounds.top + bounds.height / 2)?.closest("button")).toBe(button);
  });
  await userEvent.click(button);
  const dialog = await screen.findByRole("dialog", { name: "Activity" });
  expect(dialog).toBeInstanceOf(HTMLDialogElement);
  expect((dialog as HTMLDialogElement).open).toBe(true);
  await settleFrames();
  // StrictMode's setup/cleanup/setup queues a close event from cleanup.
  // That old event must not dismiss the reopened native dialog.
  expect(dialog.isConnected).toBe(true);
  expect((dialog as HTMLDialogElement).open).toBe(true);
  return dialog as HTMLDialogElement;
}

afterEach(async () => { await commands.setStreamTestReducedMotion(false); });

describe("compact activity in the real browser", () => {
  it("rotates thinking phrases every five seconds and immediately yields to concrete work", async () => {
    const status = (researching = false) => <StrictMode>
      <ActivityStatus state="running" label={researching ? "Researching" : "Thinking"}
        category={researching ? "research" : "thinking"} playful={!researching} seed="browser-rotation" onOpen={() => {}} />
    </StrictMode>;
    const view = render(status());
    const label = () => view.container.querySelector(".activity-status-label")!.textContent;
    const started = performance.now();
    expect(label()).toBe("Thinking");
    await waitFor(() => expect(label()).not.toBe("Thinking"), { timeout: 6_500 });
    expect(performance.now() - started).toBeGreaterThanOrEqual(2_900);
    const first = label();
    expect(ACTIVITY_STATUS_PHRASES).toContain(first);
    const firstIndex = ACTIVITY_STATUS_PHRASES.findIndex((phrase) => phrase === first);
    await waitFor(() => expect(label()).toBe(ACTIVITY_STATUS_PHRASES[(firstIndex + 1) % ACTIVITY_STATUS_PHRASES.length]), { timeout: 6_500 });
    expect(performance.now() - started).toBeGreaterThanOrEqual(7_900);
    expect(screen.getByRole("status").textContent).toBe("Thinking");
    view.rerender(status(true));
    expect(label()).toBe("Researching");
    expect(screen.getByRole("status").textContent).toBe("Researching");
    view.unmount();
  }, 15_000);

  it("keeps the native dialog open through StrictMode cleanup, while a genuine native close dismisses it", async () => {
    render(strictShell());
    const dialog = await openDetails();
    await settleFrames();
    expect(screen.getByRole("dialog", { name: "Activity" })).toBe(dialog);
    dialog.close();
    // close() synchronously hides the element; the real queued close event
    // must also reach React and clear selection, rather than leaving it mounted.
    await waitFor(() => expect(dialog.isConnected).toBe(false));
    expect(screen.getByRole("button", { name: /View activity/ })).toHaveAttribute("aria-expanded", "false");
  });

  it("contains Escape and app shortcuts, returns focus, and never stops the active task", async () => {
    const stop = vi.fn();
    const shortcut = vi.fn();
    render(strictShell({ stopTurn: stop, shortcut }));
    const opener = screen.getByRole("button", { name: /View activity/ });
    const dialog = await openDetails();
    within(dialog).getByRole("region", { name: "Activity steps" }).focus();
    await userEvent.keyboard("{Meta>}k{/Meta}");
    expect(shortcut).not.toHaveBeenCalled();
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Activity" })).toBeNull());
    expect(stop).not.toHaveBeenCalled();
    await waitFor(() => expect(opener).toHaveFocus());
    // The same actual global shortcut works once the reader has closed.
    await userEvent.keyboard("{Escape}");
    expect(stop).toHaveBeenCalledOnce();
  });

  it("hides every live assistant stream in chat, then keeps details open when completion reveals the answer", async () => {
    const view = render(strictShell());
    const main = () => view.container.querySelector(".flow-timeline")!;
    expect(main().textContent).not.toContain(progress.text);
    expect(main().textContent).not.toContain(final.text);
    expect(main().querySelectorAll(".activity-status.live")).toHaveLength(1);
    const dialog = await openDetails();
    await waitFor(() => expect(dialog.textContent).toContain(final.text));
    // An item finishing is not the whole turn finishing.
    view.rerender(strictShell({ messages: [prompt, progress, { ...final, streaming: false }] }));
    expect(main().textContent).not.toContain(final.text);
    view.rerender(strictShell({ running: false, messages: [prompt, progress, { ...final, streaming: false }].map((message) => ({ ...message, turnStatus: "completed" })), activities: [{ ...tool, turnStatus: "completed" }] }));
    await waitFor(() => expect(main().textContent).toContain(final.text));
    expect(main().textContent).not.toContain(progress.text);
    expect(screen.getByRole("dialog", { name: "Activity" })).toBe(dialog);
    expect(dialog.open).toBe(true);
    await waitFor(() => expect(within(dialog).getByText("Work completed")).toBeVisible());
    expect(main().querySelectorAll(".activity-status.live")).toHaveLength(0);
  });

  it("preempts native details for an arriving approval overlay and focuses its real question controls", async () => {
    const view = render(strictShell());
    await openDetails();
    view.rerender(strictShell({ overlay: questionApproval }));
    const approval = await screen.findByRole("alertdialog");
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Activity" })).toBeNull());
    await waitFor(() => expect(approval.contains(document.activeElement)).toBe(true));
    const radio = await within(approval).findByRole("radio", { name: "First First direction" });
    await waitFor(() => {
      const bounds = radio.getBoundingClientRect();
      expect(approval.contains(document.elementFromPoint(bounds.left + bounds.width / 2, bounds.top + bounds.height / 2))).toBe(true);
    });
    await userEvent.click(radio);
    expect(radio).toBeChecked();
  });

  it("preempts details for an inline command approval", async () => {
    const approval: PendingApproval = { id: "command-approval", threadId: "thread", receivedAt: 1, method: "item/commandExecution/requestApproval", params: { command: "npm run check", cwd: "/project" } };
    const view = render(strictShell());
    await openDetails();
    view.rerender(strictShell({ approval }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Activity" })).toBeNull());
    expect(view.container.querySelector(".timeline-entry-approval")).toBeVisible();
  });

  it("bounds a long live history and keeps earlier Markdown reachable in chronology", async () => {
    const updates: ChatMessage[] = Array.from({ length: ACTIVITY_STEP_WINDOW * 4 }, (_, index) => ({ ...progress, id: `update-${index}`, text: `History step ${index}: **recorded operation**`, timelineOrder: index + 2 }));
    const view = render(strictShell({ messages: [prompt, ...updates], activities: [] }));
    const dialog = await openDetails();
    const steps = () => dialog.querySelectorAll("[data-step-id]");
    expect(steps().length).toBeLessThanOrEqual(ACTIVITY_STEP_WINDOW);
    expect(dialog.textContent).toContain("History step 239");
    expect(dialog.textContent).not.toContain("History step 0:");
    const more: ChatMessage[] = Array.from({ length: ACTIVITY_STEP_WINDOW * 3 }, (_, index) => ({ ...progress, id: `new-${index}`, text: `New step ${index}`, timelineOrder: index + updates.length + 2 }));
    view.rerender(strictShell({ messages: [prompt, ...updates, ...more], activities: [] }));
    await waitFor(() => expect(dialog.textContent).toContain("New step 179"));
    expect(steps().length).toBeLessThanOrEqual(ACTIVITY_STEP_WINDOW * 2);
    const region = within(dialog).getByRole("region", { name: "Activity steps" });
    region.scrollTop = 0;
    await userEvent.click(within(dialog).getByRole("button", { name: /earlier steps/ }));
    expect(dialog.textContent).toContain("New step 60");
    const orders = Array.from(steps(), (element) => element.getAttribute("data-step-id")!);
    expect(orders.indexOf("new-60")).toBeLessThan(orders.indexOf("new-179"));
    expect(view.container.querySelector(".flow-timeline")!.textContent).not.toContain("recorded operation");
  });

  it.each(["paging", "search"])("freezes the live endpoint after reader %s navigation", async (mode) => {
    const updates = (count: number): ChatMessage[] => Array.from({ length: count }, (_, index) => ({
      ...progress, id: `bounded-${index}`, timelineOrder: index + 2,
      text: `Step ${index}: ${index === 3 || index === 150 ? "needle" : "recorded work"}\n\n${"Full retained output. ".repeat(12)}`,
    }));
    const modal = (count: number) => <ActivityDetailsModal run={{ state: "running", entries: updates(count).map((value) => ({ kind: "message", value })) }}
      sourceRef={{ current: null }} renderMessage={(message) => <p>{message.text}</p>} renderSubAgents={() => null} onClose={() => {}}
      {...(mode === "search" ? { focusId: "bounded-3", searchQuery: "needle" } : {})} />;
    const view = render(modal(180));
    const dialog = await screen.findByRole("dialog", { name: "Activity" });
    const region = within(dialog).getByRole("region", { name: "Activity steps" });
    if (mode === "search") {
      fireEvent.click(within(dialog).getByRole("button", { name: "Next match" }));
      expect(dialog.querySelector(".is-current-match")).toHaveAttribute("data-step-id", "bounded-150");
    } else {
      fireEvent.click(within(dialog).getByRole("button", { name: /earlier steps/ }));
      view.rerender(modal(240));
      fireEvent.click(within(dialog).getByRole("button", { name: /later steps/ }));
    }
    // Output may arrive before the browser dispatches navigation scroll events.
    const before = region.scrollTop;
    const mountedBefore = dialog.querySelectorAll("[data-step-id]").length;
    view.rerender(modal(500));
    await settleFrames();
    expect(dialog.querySelectorAll("[data-step-id]")).toHaveLength(mountedBefore);
    expect(Math.abs(region.scrollTop - before)).toBeLessThanOrEqual(2);
    await waitFor(() => expect(within(dialog).getByRole("button", { name: /later steps/ })).toBeVisible());
  });

  it("resumes a live endpoint when Latest is followed immediately by new output", async () => {
    await commands.setStreamTestReducedMotion(true);
    const modal = (count: number) => <ActivityDetailsModal run={{ state: "running", entries: Array.from({ length: count }, (_, index) => ({ kind: "message",
      value: { ...progress, id: `latest-${index}`, text: `Step ${index}: ${"Recorded output. ".repeat(30)}` } })) }}
      sourceRef={{ current: null }} renderMessage={(message) => <p>{message.text}</p>} renderSubAgents={() => null} onClose={() => {}} />;
    const view = render(modal(180));
    const dialog = await screen.findByRole("dialog", { name: "Activity" });
    const region = within(dialog).getByRole("region", { name: "Activity steps" });
    fireEvent.click(within(dialog).getByRole("button", { name: /earlier steps/ }));
    fireEvent.pointerDown(region, { button: 0 });
    region.scrollTop = 100;
    fireEvent.scroll(region);
    fireEvent.click(within(dialog).getByRole("button", { name: "Latest activity" }));
    view.rerender(modal(181));
    await waitFor(() => expect(dialog.querySelector('[data-step-id="latest-180"]')).not.toBeNull());
    await waitFor(() => expect(region.scrollHeight - region.scrollTop - region.clientHeight).toBeLessThanOrEqual(2));
  });

  it("keeps a reader's scrollbar position when live output grows, and respects reduced-motion Latest navigation", async () => {
    await commands.setStreamTestReducedMotion(true);
    const updates: ChatMessage[] = Array.from({ length: 40 }, (_, index) => ({ ...progress, id: `scroll-${index}`, text: `Step ${index}\n\n${"Long recorded operation. ".repeat(12)}`, timelineOrder: index + 2 }));
    const view = render(strictShell({ messages: [prompt, ...updates], activities: [] }));
    const dialog = await openDetails();
    const region = within(dialog).getByRole("region", { name: "Activity steps" });
    await waitFor(() => expect(region.scrollHeight).toBeGreaterThan(region.clientHeight + 100));
    // A native scroll-position change has no wheel/key signal, as with a
    // scrollbar drag; use actual layout and its real scroll event.
    fireEvent.pointerDown(region, { button: 0 });
    region.scrollTop = 100;
    await waitFor(() => expect(region.scrollTop).toBeLessThan(150));
    await settleFrames();
    const before = region.scrollTop;
    view.rerender(strictShell({ messages: [prompt, ...updates, { ...progress, id: "appended", text: "New output grew below the reader", timelineOrder: 100 }], activities: [] }));
    await settleFrames();
    expect(Math.abs(region.scrollTop - before)).toBeLessThanOrEqual(2);
    const latest = within(dialog).getByRole("button", { name: "Latest activity" });
    await userEvent.click(latest);
    await waitFor(() => expect(region.scrollHeight - region.scrollTop - region.clientHeight).toBeLessThanOrEqual(2));
    expect(getComputedStyle(dialog).animationName).toBe("none");
  });

  it("opens a newly active turn as empty work instead of relabeling the previous completed history", async () => {
    const oldPrompt: ChatMessage = { ...prompt, id: "old-prompt", text: "Previous request", turnId: "old", turnStatus: "completed" };
    const oldAnswer: ChatMessage = { ...final, id: "old-answer", text: "Previous completed answer", streaming: false, turnId: "old", turnStatus: "completed" };
    const view = render(strictShell({ messages: [oldPrompt, oldAnswer], activities: [], running: true, activeTurnId: "new" }));
    const main = view.container.querySelector(".flow-timeline")!;
    expect(main.textContent).toContain(oldAnswer.text);
    const liveButton = main.querySelector<HTMLButtonElement>(".activity-status.live button")!;
    expect(liveButton).not.toBeNull();
    const dialog = await openDetails(liveButton);
    expect(dialog.textContent).not.toContain(oldPrompt.text);
    expect(dialog.textContent).not.toContain(oldAnswer.text);
    expect(dialog.querySelectorAll("[data-step-id]")).toHaveLength(0);
    expect(dialog.textContent).toContain("Steps will appear here as the agent works.");
    const newPrompt: ChatMessage = { ...prompt, id: "new-prompt", text: "Current request", turnId: "new", timelineOrder: 10 };
    view.rerender(strictShell({ messages: [oldPrompt, oldAnswer, newPrompt], activities: [], activeTurnId: "new" }));
    await waitFor(() => expect(dialog.textContent).toContain(newPrompt.text));
    expect(dialog.textContent).not.toContain(oldAnswer.text);
  });

  it("keeps initially optimistic work selected as the runtime assigns its turn and prompt identity", async () => {
    const optimistic: ChatMessage = { ...prompt, id: "optimistic", turnId: undefined, turnStatus: undefined };
    const view = render(strictShell({ messages: [optimistic], activities: [], running: true }));
    const dialog = await openDetails();
    const bound: ChatMessage = { ...optimistic, turnId: "assigned", turnStatus: "inProgress" };
    view.rerender(strictShell({ messages: [bound], activities: [], running: true, activeTurnId: "assigned" }));
    expect(screen.getByRole("dialog", { name: "Activity" })).toBe(dialog);
    const accepted: ChatMessage = { ...bound, id: "runtime-prompt", turnStatus: "completed" };
    const answer: ChatMessage = { ...final, id: "runtime-answer", streaming: false, turnId: "assigned", turnStatus: "completed" };
    view.rerender(strictShell({ messages: [accepted, answer], activities: [], running: false }));
    await waitFor(() => expect(dialog.textContent).toContain(answer.text));
    expect(dialog.isConnected).toBe(true);
    expect(dialog.open).toBe(true);
  });

  it("contains background focus and hands an arriving approval priority in the legacy fallback", async () => {
    // Only feature detection is changed. Portal layout, focus, keyboard events,
    // question controls and hit testing still execute in the actual browser.
    const descriptor = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, "showModal")!;
    Object.defineProperty(HTMLDialogElement.prototype, "showModal", { ...descriptor, value: undefined });
    const stop = vi.fn();
    const view = render(strictShell({ stopTurn: stop }));
    try {
      const opener = screen.getByRole("button", { name: /View activity/ });
      await userEvent.click(opener);
      const dialog = await screen.findByRole("dialog", { name: "Activity" });
      expect(dialog).not.toBeInstanceOf(HTMLDialogElement);
      const region = within(dialog).getByRole("region", { name: "Activity steps" });
      opener.focus();
      await waitFor(() => expect(region).toHaveFocus());
      const bounds = dialog.getBoundingClientRect();
      expect(bounds.top).toBeGreaterThanOrEqual(0);
      expect(bounds.bottom).toBeLessThanOrEqual(window.innerHeight);
      expect(dialog.contains(document.elementFromPoint(bounds.left + bounds.width / 2, bounds.top + 40))).toBe(true);
      view.rerender(strictShell({ overlay: questionApproval, stopTurn: stop }));
      const approval = await screen.findByRole("alertdialog");
      await waitFor(() => expect(screen.queryByRole("dialog", { name: "Activity" })).toBeNull());
      await waitFor(() => expect(approval.contains(document.activeElement)).toBe(true));
      const radio = await within(approval).findByRole("radio", { name: "First First direction" });
      await userEvent.click(radio);
      expect(radio).toBeChecked();
      expect(stop).not.toHaveBeenCalled();
    } finally {
      view.unmount();
      Object.defineProperty(HTMLDialogElement.prototype, "showModal", descriptor);
    }
  });

  it("returns to an older question beyond the mounted chat suffix without duplicating its actionable form", async () => {
    const question: ChatMessage = { ...progress, id: "old-question", text: "Your direction is needed", timelineOrder: 2, questions: [{ id: "direction", title: "Choose direction", options: ["First", "Second"] }] };
    const warnings: Activity[] = Array.from({ length: 65 }, (_, index) => ({ ...tool, id: `warning-${index}`, kind: "warning", title: `Recorded warning ${index}`, timelineOrder: index + 3 }));
    const view = render(strictShell({ messages: [prompt, question], activities: warnings }));
    expect(view.container.querySelector(".agent-question-form")).toBeNull();
    const dialog = await openDetails();
    expect(dialog.querySelector(".agent-question-form")).toBeNull();
    const region = within(dialog).getByRole("region", { name: "Activity steps" });
    region.scrollTop = 0;
    await userEvent.click(within(dialog).getByRole("button", { name: /earlier steps/ }));
    const answer = within(dialog).getByRole("button", { name: "Answer in chat" });
    answer.scrollIntoView({ block: "center" });
    await userEvent.click(answer);
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Activity" })).toBeNull());
    const first = await screen.findByRole("radio", { name: "First" });
    expect(view.container.querySelectorAll(".agent-question-form")).toHaveLength(1);
    await waitFor(() => expect(first).toHaveFocus());
    const scroller = view.container.querySelector<HTMLElement>(".flow-timeline")!;
    await waitFor(() => {
      const bounds = first.getBoundingClientRect();
      const visible = scroller.getBoundingClientRect();
      expect(bounds.top).toBeGreaterThanOrEqual(visible.top);
      expect(bounds.bottom).toBeLessThanOrEqual(visible.bottom);
    });
  });

  it("keeps a bounded reading window when many live steps arrive while the reader is scrolled back", async () => {
    await commands.setStreamTestReducedMotion(true);
    const updates: ChatMessage[] = Array.from({ length: ACTIVITY_STEP_WINDOW * 4 }, (_, index) => ({ ...progress, id: `reading-${index}`, text: `Recorded step ${index}\n\n${"Recorded operation. ".repeat(12)}`, timelineOrder: index + 2 }));
    const view = render(strictShell({ messages: [prompt, ...updates], activities: [] }));
    const dialog = await openDetails();
    const region = within(dialog).getByRole("region", { name: "Activity steps" });
    await waitFor(() => expect(region.scrollHeight).toBeGreaterThan(region.clientHeight + 100));
    fireEvent.pointerDown(region, { button: 0 });
    region.scrollTop = 100;
    await settleFrames();
    const before = region.scrollTop;
    const first = dialog.querySelector("[data-step-id]")!.getAttribute("data-step-id");
    const more: ChatMessage[] = Array.from({ length: ACTIVITY_STEP_WINDOW * 3 + 1 }, (_, index) => ({ ...progress, id: `reading-new-${index}`, text: `Streaming append ${index}`, timelineOrder: updates.length + index + 2 }));
    view.rerender(strictShell({ messages: [prompt, ...updates, ...more], activities: [] }));
    await settleFrames();
    expect(dialog.querySelectorAll("[data-step-id]").length).toBeLessThanOrEqual(ACTIVITY_STEP_WINDOW * 2);
    expect(dialog.querySelector("[data-step-id]")!.getAttribute("data-step-id")).toBe(first);
    expect(Math.abs(region.scrollTop - before)).toBeLessThanOrEqual(2);
    await userEvent.click(within(dialog).getByRole("button", { name: "Latest activity" }));
    await waitFor(() => expect(dialog.textContent).toContain(`Streaming append ${more.length - 1}`));
    expect(dialog.querySelectorAll("[data-step-id]").length).toBeLessThanOrEqual(ACTIVITY_STEP_WINDOW * 2);
  });

  it("renders a reported search match at the beginning of long tool output and keeps that output readable", async () => {
    const prefix = "Distinct searchable prefix before the long output";
    const detail = `${prefix}\n${Array.from({ length: 180 }, (_, index) => `Output line ${index}: the recorded command continued normally.`).join("\n")}\nComplete output tail`;
    expect(detail.length).toBeGreaterThan(4000);
    render(strictShell({ running: false, messages: [prompt, { ...final, streaming: false }].map((message) => ({ ...message, turnStatus: "completed" })),
      activities: [{ ...tool, detail, turnStatus: "completed" }], searchQuery: prefix }));
    const button = screen.getByRole("button", { name: /View activity/ });
    expect(button).toHaveAccessibleName(/1 match/);
    const dialog = await openDetails(button);
    expect(within(dialog).getByText("1 of 1")).toBeVisible();
    const output = dialog.querySelector<HTMLElement>(".activity-step-output")!;
    expect(output).not.toBeNull();
    expect(output.textContent).toBe(detail);
    expect(output.textContent).toContain(prefix);
    expect(output.textContent).toContain("Complete output tail");
    output.scrollIntoView({ block: "center" });
    output.scrollTop = 0;
    await waitFor(() => {
      expect(output.getBoundingClientRect().height).toBeGreaterThan(0);
      expect(output.scrollHeight).toBeGreaterThan(output.clientHeight);
      expect(output.scrollTop).toBe(0);
      const bounds = output.getBoundingClientRect();
      expect(output.contains(document.elementFromPoint(bounds.left + 12, bounds.top + 12))).toBe(true);
    });
    await userEvent.wheel(output, { delta: { y: 10000 } });
    await waitFor(() => expect(output.scrollHeight - output.scrollTop - output.clientHeight).toBeLessThanOrEqual(2));
  });
});
