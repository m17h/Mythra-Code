import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Activity, ChatMessage, PendingApproval } from "../types";

vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));

import { ChatTimeline, TIMELINE_MOUNT_ROWS } from "./ChatTimeline";
import { ActivityDetailsModal, ACTIVITY_STEP_WINDOW } from "./ActivityDetailsModal";
import { SubAgentControls } from "./SubAgentControls";
import { AgentQuestionDelivery } from "../lib/agentQuestionContext";
import type { SubAgentWorker } from "../lib/subAgentActivity";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** jsdom has no modal dialogs; emulate the native path's open state. */
function emulateNativeDialogs(): () => void {
  const prototype = HTMLDialogElement.prototype as Partial<Pick<HTMLDialogElement, "showModal" | "close">>;
  const original = { showModal: prototype.showModal, close: prototype.close };
  prototype.showModal = function (this: HTMLDialogElement) { this.setAttribute("open", ""); };
  prototype.close = function (this: HTMLDialogElement) { this.removeAttribute("open"); };
  return () => {
    if (original.showModal) prototype.showModal = original.showModal; else delete prototype.showModal;
    if (original.close) prototype.close = original.close; else delete prototype.close;
  };
}

/** Captures ResizeObserver callbacks so tests can deliver layout changes. */
function captureResizeObservers() {
  const callbacks: Array<() => void> = [];
  vi.stubGlobal("ResizeObserver", class {
    constructor(callback: () => void) { callbacks.push(callback); }
    observe() {}
    unobserve() {}
    disconnect() {}
  });
  return { resize: () => act(() => { for (const callback of callbacks) callback(); }) };
}

/** A scroll region whose position clamps like a real one. */
function scrollMetrics(region: HTMLElement, initialHeight = 3000) {
  let height = initialHeight;
  let top = 0;
  const clientHeight = 600;
  const scrollTo = vi.fn((options: ScrollToOptions) => { if (typeof options.top === "number") top = Math.max(0, Math.min(options.top, height - clientHeight)); });
  Object.defineProperties(region, {
    clientHeight: { configurable: true, get: () => clientHeight },
    scrollHeight: { configurable: true, get: () => height },
    scrollTop: { configurable: true, get: () => top, set: (value: number) => { top = Math.max(0, Math.min(value, height - clientHeight)); } },
    scrollTo: { configurable: true, value: scrollTo },
  });
  return {
    scrollTo,
    get top() { return top; },
    bottom: () => height - clientHeight,
    setHeight: (value: number) => { height = value; },
    /** The reader drags the scrollbar thumb (or clicks its track). */
    drag: (value: number) => {
      fireEvent.pointerDown(region);
      top = value;
      fireEvent.scroll(region);
    },
  };
}

const live = { turnId: "turn", turnStatus: "inProgress" as const };
const done = { turnId: "turn", turnStatus: "completed" as const };

function timeline(messages: ChatMessage[], activities: Activity[], running: boolean, extra: Partial<Parameters<typeof ChatTimeline>[0]> = {}) {
  return <ChatTimeline messages={messages} activities={activities} running={running} thinkingLabel="Thinking" {...extra} />;
}

function openActivity(name: RegExp = /View activity/) {
  fireEvent.click(screen.getByRole("button", { name }));
  return screen.getByRole("dialog");
}

function stepIds(dialog: HTMLElement): string[] {
  return Array.from(dialog.querySelectorAll<HTMLElement>("[data-step-id]")).map((step) => step.dataset.stepId!);
}

describe("Activity reader endpoints", () => {
  it.each(["paging", "search"])("keeps a numeric endpoint after %s navigation while new steps arrive", (mode) => {
    const entries = (count: number) => Array.from({ length: count }, (_, index) => ({ kind: "message" as const,
      value: { id: `endpoint-${index}`, role: "assistant" as const, text: index === 3 || index === 150 ? "needle" : `Step ${index}` } }));
    const modal = (count: number) => <ActivityDetailsModal run={{ state: "running", entries: entries(count) }}
      sourceRef={{ current: null }} renderMessage={(message) => <p>{message.text}</p>} renderSubAgents={() => null} onClose={() => {}}
      {...(mode === "search" ? { focusId: "endpoint-3", searchQuery: "needle" } : {})} />;
    const view = render(modal(180));
    const dialog = screen.getByRole("dialog");
    if (mode === "search") fireEvent.click(within(dialog).getByRole("button", { name: "Next match" }));
    else {
      fireEvent.click(within(dialog).getByRole("button", { name: /earlier steps/ }));
      view.rerender(modal(240));
      fireEvent.click(within(dialog).getByRole("button", { name: /later steps/ }));
    }
    const count = dialog.querySelectorAll("[data-step-id]").length;
    view.rerender(modal(1000));
    expect(dialog.querySelectorAll("[data-step-id]")).toHaveLength(count);
    expect(within(dialog).getByRole("button", { name: /later steps/ })).toBeInTheDocument();
  });
});

describe("Activity reading order", () => {
  const thought = (id: string, detail: string, status: Activity["status"] = "completed") => ({ kind: "activity" as const,
    value: { id, kind: "reasoning" as const, title: "Reasoning", detail, status } satisfies Activity });
  const operation = (id: string, title: string, detail: string, status: Activity["status"] = "completed") => ({ kind: "activity" as const,
    value: { id, kind: "command" as const, title, detail, status } satisfies Activity });
  const modal = (entries: Parameters<typeof ActivityDetailsModal>[0]["run"]["entries"], extra: { state?: "running" | "completed"; searchQuery?: string } = {}) =>
    <ActivityDetailsModal run={{ state: extra.state ?? "completed", entries }} searchQuery={extra.searchQuery}
      sourceRef={{ current: null }} renderMessage={(message) => <p>{message.text}</p>} renderSubAgents={() => null} onClose={() => {}} />;
  const longText = Array.from({ length: 30 }, (_, index) => `Line ${index} of careful reasoning.`).join("\n");

  it("opens thinking as readable prose while command output stays folded", () => {
    render(modal([
      thought("think", "I'll trace where jobs are emitted before touching the board."),
      operation("grep", 'grep -rn "JobType" src', "src/systems/state.ts:12: JobType"),
      { kind: "message", value: { id: "update", role: "assistant", text: "Still mapping the code." } },
    ]));
    const dialog = screen.getByRole("dialog");
    const thinking = within(dialog).getByRole("button", { name: "Hide thinking: Thinking" });
    expect(thinking).toHaveAttribute("aria-expanded", "true");
    expect(dialog.querySelector('[data-step-id="think"] .activity-step-thought')).toHaveTextContent("I'll trace where jobs are emitted");
    expect(dialog.querySelector(".activity-step-preview")).toBeNull();
    expect(within(dialog).getByText("Still mapping the code.")).toBeInTheDocument();

    // Commands: exact title visible, output only on request.
    const output = within(dialog).getByRole("button", { name: 'Show output: grep -rn "JobType" src' });
    expect(output).toHaveAttribute("aria-expanded", "false");
    expect(within(dialog).getByText('grep -rn "JobType" src')).toBeInTheDocument();
    expect(within(dialog).queryByText("src/systems/state.ts:12: JobType")).not.toBeInTheDocument();
    fireEvent.click(output);
    expect(within(dialog).getByText("src/systems/state.ts:12: JobType")).toBeInTheDocument();

    // Thinking still collapses, to one readable line.
    fireEvent.click(thinking);
    expect(within(dialog).getByRole("button", { name: "Show thinking: Thinking" })).toHaveAttribute("aria-expanded", "false");
    expect(dialog.querySelector('[data-step-id="think"] .activity-step-thought')).toBeNull();
    expect(dialog.querySelector('[data-step-id="think"] .activity-step-preview')).toHaveTextContent("I'll trace where jobs");
  });

  it("bounds long settled thinking behind Show all, but never live thinking or a search hit", () => {
    const view = render(modal([thought("long", longText)]));
    let dialog = screen.getByRole("dialog");
    const body = () => dialog.querySelector<HTMLElement>('[data-step-id="long"] .activity-step-thought')!;
    expect(body()).toHaveClass("is-clamped");
    // The whole text is present for copying and find-in-page, only bounded visually.
    expect(body()).toHaveTextContent("Line 29 of careful reasoning.");
    fireEvent.click(within(dialog).getByRole("button", { name: "Show all thinking" }));
    expect(body()).not.toHaveClass("is-clamped");
    fireEvent.click(within(dialog).getByRole("button", { name: "Show less thinking" }));
    expect(body()).toHaveClass("is-clamped");
    view.unmount();

    render(modal([thought("long", longText, "inProgress")], { state: "running" }));
    dialog = screen.getByRole("dialog");
    expect(body()).not.toHaveClass("is-clamped");
    expect(within(dialog).queryByRole("button", { name: "Show all thinking" })).not.toBeInTheDocument();
  });

  it("shows a search hit inside long thinking unbounded", () => {
    render(modal([thought("long", longText)], { searchQuery: "Line 29" }));
    const dialog = screen.getByRole("dialog");
    const body = dialog.querySelector<HTMLElement>('[data-step-id="long"] .activity-step-thought')!;
    expect(body).not.toHaveClass("is-clamped");
    expect(body).toHaveTextContent("Line 29 of careful reasoning.");
  });

  it("marks a failed operation on its row", () => {
    render(modal([operation("ok", "npm test", "pass"), operation("bad", "npm run build", "error TS2322", "failed")]));
    const dialog = screen.getByRole("dialog");
    expect(dialog.querySelector('[data-step-id="bad"]')).toHaveClass("is-failed");
    expect(dialog.querySelector('[data-step-id="ok"]')).not.toHaveClass("is-failed");
    expect(within(dialog.querySelector<HTMLElement>('[data-step-id="bad"]')!).getByText("Failed")).toHaveClass("tone-bad");
  });
});

describe("compact activity in the timeline", () => {
  const prompt: ChatMessage = { id: "prompt", role: "user", text: "Fix the bug", timelineOrder: 1, ...live };
  const command: Activity = { id: "command", kind: "command", title: "npm test", detail: "1 failing", status: "inProgress", timelineOrder: 2, ...live };
  const update: ChatMessage = { id: "update", role: "assistant", text: "Found the cause.", phase: "commentary", timelineOrder: 3, ...live };
  const answer: ChatMessage = { id: "answer", role: "assistant", text: "Fixed it.", phase: "final", streaming: true, timelineOrder: 4, ...live };

  it("keeps promptless provider turns separate in their historical Activity windows", () => {
    const messages: ChatMessage[] = [
      { id: "old-update", role: "assistant", text: "Old recorded update", phase: "commentary", turnId: "old", turnStatus: "completed", timelineOrder: 1 },
      { id: "old-answer", role: "assistant", text: "Old answer", turnId: "old", turnStatus: "completed", timelineOrder: 2 },
      { id: "new-update", role: "assistant", text: "New interrupted update", phase: "commentary", turnId: "new", turnStatus: "failed", timelineOrder: 4 },
    ];
    const activities: Activity[] = [
      { id: "old-tool", kind: "command", title: "Old tool", status: "completed", turnId: "old", turnStatus: "completed", timelineOrder: 0 },
      { id: "new-tool", kind: "command", title: "New tool", status: "completed", turnId: "new", turnStatus: "failed", timelineOrder: 3 },
    ];
    const view = render(timeline(messages, activities, false));
    expect(view.container).toHaveTextContent("Old answer");
    let dialog = openActivity(/^Work completed\. View activity/);
    expect(dialog).toHaveTextContent("Old recorded update");
    expect(dialog).not.toHaveTextContent("New interrupted update");
    fireEvent.click(within(dialog).getByRole("button", { name: "Close activity" }));
    dialog = openActivity(/^Run failed\. View activity/);
    expect(dialog).toHaveTextContent("New interrupted update");
    expect(dialog).not.toHaveTextContent("Old recorded update");
  });

  it.each(["command", "file"] as const)("keeps adjacent cross-turn %s work out of the historical modal", (kind) => {
    const activities: Activity[] = [
      { id: "old-tool", kind, title: "Old operation", status: "completed", turnId: "old", turnStatus: "completed", timelineOrder: 1 },
      { id: "new-tool", kind, title: "New failed operation", status: "failed", turnId: "new", turnStatus: "failed", timelineOrder: 2 },
    ];
    const view = render(timeline([], activities, false));
    if (kind === "command") expect(view.container).not.toHaveTextContent("New failed operation");
    else expect(view.container).toHaveTextContent("New failed operation");
    const dialog = openActivity(/^Work completed\. View activity/);
    expect(dialog).toHaveTextContent("Old operation");
    expect(dialog).not.toHaveTextContent("New failed operation");
    if (kind === "command") {
      fireEvent.click(within(dialog).getByRole("button", { name: "Close activity" }));
      const failedDialog = openActivity(/^Run failed\. View activity/);
      expect(failedDialog).toHaveTextContent("New failed operation");
      expect(failedDialog).not.toHaveTextContent("Old operation");
    }
  });

  it("shows one status line while running and keeps the window open through completion", () => {
    const view = render(timeline([prompt, update, answer], [command], true));
    expect(screen.getByText("Fix the bug")).toBeInTheDocument();
    expect(view.container.querySelector(".message.assistant")).toBeNull();
    expect(view.container.querySelectorAll(".activity-status")).toHaveLength(1);

    const dialog = openActivity(/^Executing commands\. View activity: 3 steps$/);
    expect(within(dialog).getByText("Found the cause.")).toBeInTheDocument();
    expect(within(dialog).getByText("Fixed it.")).toBeInTheDocument();

    view.rerender(timeline(
      [{ ...prompt, ...done }, { ...update, ...done }, { ...answer, streaming: false, ...done }],
      [{ ...command, status: "completed", ...done }],
      false,
    ));
    const settled = screen.getByRole("dialog");
    expect(within(settled).getByText("Work completed")).toBeInTheDocument();
    expect(view.container.querySelector(".message.assistant")).toHaveTextContent("Fixed it.");
    expect(view.container.querySelector(".message.assistant")).not.toHaveTextContent("Found the cause.");

    fireEvent.click(within(settled).getByRole("button", { name: "Close activity" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("closes on Escape without letting app shortcuts such as stop-turn see the key", () => {
    const appKeys = vi.fn();
    document.addEventListener("keydown", appKeys);
    try {
      render(timeline([prompt, update], [command], true));
      let dialog = openActivity();
      fireEvent.keyDown(document.body, { key: "n", metaKey: true });
      expect(appKeys).not.toHaveBeenCalled();
      expect(screen.getByRole("dialog")).toBe(dialog);

      fireEvent.keyDown(within(dialog).getByRole("region", { name: "Activity steps" }), { key: "Escape" });
      expect(appKeys).not.toHaveBeenCalled();
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

      dialog = openActivity();
      fireEvent.keyDown(document.body, { key: "Escape" });
      expect(appKeys).not.toHaveBeenCalled();
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    } finally {
      document.removeEventListener("keydown", appKeys);
    }
  });

  it("restores true chronology when hidden work crosses a visible steer", () => {
    const steer: ChatMessage = { id: "steer", role: "user", text: "Also check the docs", timelineOrder: 4, ...live };
    const second: Activity = { id: "second", kind: "command", title: "npm run docs", status: "inProgress", timelineOrder: 5, ...live };
    render(timeline([prompt, update, steer, { ...answer, timelineOrder: 6 }], [{ ...command, timelineOrder: 2, status: "completed" }, second], true));
    expect(screen.getByText("Also check the docs")).toBeInTheDocument();
    const dialog = openActivity();
    expect(stepIds(dialog)).toEqual(["prompt", "command", "update", "steer", "second", "answer"]);
  });

  it("opens the matching run when search navigation lands on folded work, but never while typing", () => {
    const messages: ChatMessage[] = [{ ...prompt, ...done }, { id: "final", role: "assistant", text: "All clear.", timelineOrder: 4, ...done }];
    const activities: Activity[] = [
      { id: "grep", kind: "command", title: "rg needle", detail: "src/a.ts: needle found", status: "completed", timelineOrder: 2, ...done },
      { id: "other", kind: "command", title: "npm test", status: "completed", timelineOrder: 3, ...done },
    ];
    const view = render(timeline(messages, activities, false, { searchQuery: "needl", searchActiveMatch: 0 }));
    view.rerender(timeline(messages, activities, false, { searchQuery: "needle", searchActiveMatch: 0 }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Work completed\. View activity: .*1 match/ })).toBeInTheDocument();

    view.rerender(timeline(messages, activities, false, { searchQuery: "needle", searchActiveMatch: 1 }));
    const dialog = screen.getByRole("dialog");
    expect(dialog.querySelector(".is-current-match")).toHaveAttribute("data-step-id", "grep");
    expect(within(dialog).getByText("src/a.ts: needle found")).toBeInTheDocument();
    expect(within(dialog).getByText("1 of 1")).toBeInTheDocument();
  });

  it("gets out of the way when an approval needs the user", () => {
    const view = render(timeline([prompt], [command], true));
    openActivity();
    const approval: PendingApproval = { id: 1, method: "execCommandApproval", params: { command: "rm -rf build" }, threadId: "thread", receivedAt: 1 };
    view.rerender(timeline([prompt], [command], true, { approval }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(view.container.querySelector(".timeline-entry-approval")).not.toBeNull();
    expect(screen.getByRole("button", { name: /^Waiting for approval\. View activity/ })).toBeInTheDocument();
  });

  it("keeps failed output in chat with an honest outcome", () => {
    const failed = { turnId: "turn", turnStatus: "failed" as const };
    const view = render(timeline(
      [{ ...prompt, ...failed }, { id: "partial", role: "assistant", text: "Partial findings so far.", phase: "commentary", timelineOrder: 3, ...failed }],
      [{ ...command, status: "completed", ...failed }],
      false,
    ));
    expect(view.container.querySelector(".message.assistant")).toHaveTextContent("Partial findings so far.");
    expect(screen.getByRole("button", { name: /^Run failed\. View activity/ })).toBeInTheDocument();
  });

  it("gives a run with no output yet one status line and an empty, live window", () => {
    const view = render(timeline([prompt], [], true));
    expect(view.container.querySelectorAll(".activity-status")).toHaveLength(1);
    const dialog = openActivity(/^Thinking\. View activity$/);
    expect(within(dialog).getByText("Steps will appear here as the agent works.")).toBeInTheDocument();
  });

  it("names a streaming final answer without exposing it in chat", () => {
    const view = render(timeline([prompt, answer], [], true));
    expect(view.container.querySelector(".message.assistant")).toBeNull();
    expect(screen.getByRole("button", { name: /^Writing response\. View activity: 1 step$/ })).toBeInTheDocument();
  });

  it("hands focus to an approval that arrives while details are open, in native and fallback modes", async () => {
    for (const native of [true, false]) {
      const restoreDialogs = native ? emulateNativeDialogs() : () => undefined;
      const appKeys = vi.fn();
      document.addEventListener("keydown", appKeys);
      const view = render(timeline([prompt, update], [command], true));
      const dialog = openActivity();
      expect(dialog.tagName).toBe(native ? "DIALOG" : "DIV");
      const approval = document.createElement("div");
      approval.setAttribute("data-approval-modal", "");
      approval.tabIndex = -1;
      approval.innerHTML = "<input aria-label='Approval answer' />";
      try {
        act(() => { document.body.append(approval); });
        await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
        expect(document.activeElement).toBe(within(approval).getByLabelText("Approval answer"));
        // The run keeps going: closing for the approval never stops it.
        expect(appKeys).not.toHaveBeenCalled();
        expect(screen.getByRole("button", { name: /^Executing commands\. View activity/ })).toBeInTheDocument();
      } finally {
        approval.remove();
        document.removeEventListener("keydown", appKeys);
        view.unmount();
        restoreDialogs();
      }
    }
  });

  it("reveals and focuses a question that sits above the mounted rows when answering from details", async () => {
    const question: ChatMessage = { id: "question", role: "assistant", text: "Which database?", questions: [{ id: "db", title: "Which database?", options: ["Postgres", "SQLite"] }], timelineOrder: 2, ...live };
    const steers: ChatMessage[] = Array.from({ length: TIMELINE_MOUNT_ROWS + 5 }, (_, index) => ({
      id: `steer-${index}`, role: "user", text: `Steer ${index}`, timelineOrder: 10 + index, ...live,
    }));
    render(<AgentQuestionDelivery.Provider value={{ threadId: "thread", send: async () => true }}>
      {timeline([prompt, question, ...steers], [{ ...command, timelineOrder: 100 }], true)}
    </AgentQuestionDelivery.Provider>);
    const rowFor = () => Array.from(document.querySelectorAll<HTMLElement>("[data-entry-key]")).find((row) => row.dataset.entryKey === "message-question");
    expect(rowFor()).toBeUndefined();

    const dialog = openActivity();
    fireEvent.click(within(dialog).getByRole("button", { name: "Answer in chat" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    const row = rowFor();
    expect(row).toBeDefined();
    // Never an unrelated control while the question form loads.
    const scroller = screen.getByTestId("timeline-scroller");
    expect(document.activeElement === scroller || document.activeElement?.closest(".agent-question-form")).toBeTruthy();
    await waitFor(() => expect(document.activeElement!.closest(".agent-question-form")).not.toBeNull());
    expect(row!.contains(document.activeElement)).toBe(true);
  });

  it("stops following when the reader drags the scrollbar up, even as streamed output grows", () => {
    const { resize } = captureResizeObservers();
    const view = render(timeline([prompt, update, answer], [command], true));
    const dialog = openActivity();
    const region = within(dialog).getByRole("region", { name: "Activity steps" });
    const metrics = scrollMetrics(region);
    resize();
    expect(metrics.top).toBe(metrics.bottom());

    // This window's own pin is not reader intent, even if layout grew before
    // its scroll event arrived.
    metrics.setHeight(3400);
    fireEvent.scroll(region);
    resize();
    expect(metrics.top).toBe(metrics.bottom());

    metrics.drag(900);
    expect(within(dialog).getByRole("button", { name: /Latest activity/ })).toBeInTheDocument();
    metrics.setHeight(5000);
    view.rerender(timeline([prompt, update, { ...answer, text: "Fixed it.\n\nMuch more streamed text." }], [command], true));
    resize();
    expect(metrics.top).toBe(900);

    // Returning to the end resumes following.
    metrics.drag(metrics.bottom());
    metrics.setHeight(5600);
    resize();
    expect(metrics.top).toBe(metrics.bottom());
  });

  it("jumps to the latest activity without smooth scrolling when motion is reduced", () => {
    for (const reduced of [false, true]) {
      vi.stubGlobal("matchMedia", (query: string) => ({ matches: reduced && query.includes("reduce"), media: query, addEventListener() {}, removeEventListener() {} }));
      const view = render(timeline([prompt, update], [command], true));
      const dialog = openActivity();
      const region = within(dialog).getByRole("region", { name: "Activity steps" });
      const metrics = scrollMetrics(region);
      metrics.drag(100);
      fireEvent.click(within(dialog).getByRole("button", { name: /Latest activity/ }));
      if (reduced) {
        expect(metrics.scrollTo).not.toHaveBeenCalledWith(expect.objectContaining({ behavior: "smooth" }));
        expect(metrics.top).toBe(metrics.bottom());
      } else expect(metrics.scrollTo).toHaveBeenCalledWith(expect.objectContaining({ behavior: "smooth" }));
      view.unmount();
      vi.unstubAllGlobals();
    }
  });

  it("bounds rendered steps for a large run while search and earlier steps still reach every one", () => {
    const total = ACTIVITY_STEP_WINDOW * 3 + 7;
    const messages: ChatMessage[] = [{ ...prompt, ...done }, { id: "final", role: "assistant", text: "Done.", timelineOrder: 10_000, ...done }];
    const activities: Activity[] = Array.from({ length: total }, (_, index) => ({
      id: `step-${index}`, kind: "command", title: `npm run task-${index}`, detail: index === 3 ? "needle in an early step" : "ok", status: "completed", timelineOrder: 2 + index, ...done,
    }));
    const view = render(timeline(messages, activities, false));
    let dialog = openActivity(/^Work completed\. View activity/);
    // The opened group reads from its start; nothing past the window mounts.
    expect(stepIds(dialog).length).toBeLessThanOrEqual(ACTIVITY_STEP_WINDOW);
    expect(within(dialog).getByRole("button", { name: /later steps/ })).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "Close activity" }));

    // Search navigation lands on an exact, far-away match.
    view.rerender(timeline(messages, activities, false, { searchQuery: "needle", searchActiveMatch: 0 }));
    view.rerender(timeline(messages, activities, false, { searchQuery: "needle", searchActiveMatch: 1 }));
    dialog = screen.getByRole("dialog");
    expect(dialog.querySelector(".is-current-match")).toHaveAttribute("data-step-id", "step-3");
    expect(stepIds(dialog).length).toBeLessThanOrEqual(ACTIVITY_STEP_WINDOW);
    fireEvent.click(within(dialog).getByRole("button", { name: "Close activity" }));
    view.rerender(timeline(messages, activities, false));

    // A live run opens at its end; older steps are one click away.
    const running = activities.map((activity) => ({ ...activity, ...live }));
    view.rerender(timeline([prompt], running, true));
    dialog = openActivity(/View activity/);
    const ids = stepIds(dialog);
    expect(ids.length).toBeLessThanOrEqual(ACTIVITY_STEP_WINDOW);
    expect(ids.at(-1)).toBe(`step-${total - 1}`);
    fireEvent.click(within(dialog).getByRole("button", { name: /earlier steps/ }));
    expect(stepIds(dialog).length).toBe(Math.min(total + 1, ACTIVITY_STEP_WINDOW * 2));
  });

  it("keeps a window opened before any output through streamed content and completion", () => {
    const view = render(timeline([], [], true));
    const dialog = openActivity(/^Thinking\. View activity$/);
    expect(within(dialog).getByText("Steps will appear here as the agent works.")).toBeInTheDocument();

    const optimistic: ChatMessage = { id: "optimistic", role: "user", text: "Fix the bug", timelineOrder: 1 };
    view.rerender(timeline([optimistic], [], true, { activeTurnId: "turn" }));
    // The provider replaces the optimistic prompt with its own identity.
    view.rerender(timeline([prompt, update], [command], true, { activeTurnId: "turn" }));
    expect(stepIds(screen.getByRole("dialog"))).toEqual(["prompt", "command", "update"]);

    view.rerender(timeline(
      [{ ...prompt, ...done }, { ...update, ...done }, { ...answer, streaming: false, ...done }],
      [{ ...command, status: "completed", ...done }],
      false,
    ));
    const settled = screen.getByRole("dialog");
    expect(within(settled).getByText("Work completed")).toBeInTheDocument();
    expect(stepIds(settled)).toEqual(["prompt", "command", "update", "answer"]);
  });

  it.each([
    { name: "without an active identity after a completed run", legacy: false, liveChild: false, activeTurnId: undefined },
    { name: "with a new identity after untagged legacy history", legacy: true, liveChild: false, activeTurnId: "next" },
    { name: "after a completed parent whose child remains live", legacy: false, liveChild: true, activeTurnId: undefined },
  ])("opens an empty new live window $name and binds only the new run", ({ legacy, liveChild, activeTurnId }) => {
    const prior = legacy ? {} : { turnId: "prior", turnStatus: "completed" as const };
    const previousPrompt: ChatMessage = { id: "prior-prompt", role: "user", text: "Previous request", timelineOrder: 1, ...prior };
    const previousAnswer: ChatMessage = { id: "prior-answer", role: "assistant", text: "Previous answer", phase: "final", timelineOrder: 3, ...prior };
    // completeTurn deliberately permits a child's spawn card to remain live
    // after its parent turn is terminal. It is still prior-run history.
    const previousCommand: Activity = { id: "prior-command", kind: liveChild ? "agent" : "command", title: "Previous command",
      status: liveChild ? "inProgress" : "completed", timelineOrder: 2, ...prior,
      ...(liveChild ? { agent: { action: "spawn" as const, threadIds: ["prior-child"] } } : {}),
    };
    const view = render(timeline([previousPrompt, previousAnswer], [previousCommand], true, { activeTurnId }));
    expect(view.container.querySelector(".message.assistant")).toHaveTextContent("Previous answer");
    const liveButton = view.container.querySelector<HTMLButtonElement>(".activity-status.live button");
    expect(liveButton).not.toBeNull();
    fireEvent.click(liveButton!);
    let dialog = screen.getByRole("dialog");
    expect(stepIds(dialog)).toEqual([]);
    expect(within(dialog).getByText("Steps will appear here as the agent works.")).toBeInTheDocument();
    expect(within(dialog).queryByText("Previous answer")).not.toBeInTheDocument();

    const optimistic: ChatMessage = { id: "next-optimistic", role: "user", text: "Next request", timelineOrder: 4 };
    view.rerender(timeline([previousPrompt, previousAnswer, optimistic], [previousCommand], true, { activeTurnId: "next" }));
    dialog = screen.getByRole("dialog");
    expect(stepIds(dialog)).toEqual(["next-optimistic"]);

    const next = { turnId: "next", turnStatus: "inProgress" as const };
    const nextPrompt: ChatMessage = { ...optimistic, id: "next-prompt", ...next };
    const nextUpdate: ChatMessage = { id: "next-update", role: "assistant", text: "New progress", phase: "commentary", timelineOrder: 6, ...next };
    const nextCommand: Activity = { id: "next-command", kind: "command", title: "New command", status: "inProgress", timelineOrder: 5, ...next };
    view.rerender(timeline([previousPrompt, previousAnswer, nextPrompt, nextUpdate], [previousCommand, nextCommand], true, { activeTurnId: "next" }));
    dialog = screen.getByRole("dialog");
    expect(stepIds(dialog)).toEqual(["next-prompt", "next-command", "next-update"]);
    expect(within(dialog).queryByText("Previous answer")).not.toBeInTheDocument();
  });

  it("keeps the window and explains a rejected sub-agent open, and closes once one opens", async () => {
    const worker: SubAgentWorker = { id: "child", kind: "cross-provider", status: "working", title: "Review", detail: "Claude", createdAt: 1000 };
    const spawn: Activity = { id: "spawn", kind: "agent", title: "Review", status: "inProgress", timelineOrder: 2, agent: { action: "spawn", threadIds: ["child"] }, ...live };
    const onOpen = vi.fn<(worker: SubAgentWorker) => Promise<void>>().mockRejectedValueOnce(new Error("Child conversation is not available yet."));
    const wrap = (node: ReactNode) => <SubAgentControls.Provider value={{ workers: [worker], onOpen, onStop: async () => undefined, now: 2000 }}>{node}</SubAgentControls.Provider>;
    render(wrap(timeline([prompt], [spawn], true)));
    const dialog = openActivity();
    fireEvent.click(within(dialog).getByRole("button", { name: "Open sub-agent" }));
    await waitFor(() => expect(within(dialog).getByRole("alert")).toHaveTextContent("Child conversation is not available yet."));
    expect(screen.getByRole("dialog")).toBe(dialog);

    onOpen.mockResolvedValueOnce(undefined);
    fireEvent.click(within(dialog).getByRole("button", { name: "Open sub-agent" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(onOpen).toHaveBeenLastCalledWith(worker);
  });

  it("shows an idle turn without terminal evidence as unconfirmed, with its answer still hidden", () => {
    const idle = [prompt, update, { ...answer, streaming: false }];
    const view = render(timeline(idle, [{ ...command, status: "completed" }], false, { activeTurnId: "turn" }));
    expect(view.container.querySelector(".message.assistant")).toBeNull();
    expect(view.container.querySelector(".activity-status-orbit")).toBeNull();
    expect(screen.queryByRole("button", { name: /Work completed/ })).not.toBeInTheDocument();
    const dialog = openActivity(/^Completion unconfirmed\. View activity/);
    expect(within(dialog).getByText("Completion unconfirmed")).toBeInTheDocument();
    expect(within(dialog).getByText("Fixed it.")).toBeInTheDocument();

    view.rerender(timeline(
      [{ ...prompt, ...done }, { ...update, ...done }, { ...answer, streaming: false, ...done }],
      [{ ...command, status: "completed", ...done }],
      false,
    ));
    expect(within(screen.getByRole("dialog")).getByText("Work completed")).toBeInTheDocument();
    expect(view.container.querySelector(".message.assistant")).toHaveTextContent("Fixed it.");
  });
});
