import { render, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { expect, it } from "vitest";
import { userEvent } from "vitest/browser";
import { THEMES, themeColorScheme } from "../lib/appConfig";
import { ChatTimeline, MessageRow } from "./ChatTimeline";
import { FeedbackProvider } from "./FeedbackProvider";

const cases = THEMES.flatMap(({ id, name }) => [false, true].map((image) => ({ id, name, image })));

it.each(cases)("leaves space above the reply hover toolbar in $name (image prompt: $image)", async ({ id, image }) => {
  const view = render(<div className="app-shell" data-theme={id} data-color-scheme={themeColorScheme(id)} style={{ width: 900, height: 600 }}>
    <ChatTimeline messages={[
      { id: "prompt", role: "user", text: "Could you review this change?", timelineOrder: 1, ...(image ? { attachments: [{
        path: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='80' height='60'%3E%3Crect width='80' height='60' fill='%238fd6ff'/%3E%3C/svg%3E",
        name: "example.svg", kind: "image" as const,
      }] } : {}) },
      { id: "reply", role: "assistant", text: "The change looks good.\nThe hover toolbar now has room to breathe.", timelineOrder: 2 },
    ]} activities={[]} running={false} thinkingLabel="Thinking" provider="claude" />
  </div>);
  const prompt = view.container.querySelector<HTMLElement>(".message.user")!;
  const reply = view.container.querySelector<HTMLElement>(".message.assistant")!;
  const toolbar = reply.querySelector<HTMLElement>(".message-actions")!;
  await userEvent.hover(reply);
  await waitFor(() => {
    expect(getComputedStyle(toolbar).opacity).toBe("1");
    expect(prompt.getAnimations().every((animation) => animation.playState !== "running")).toBe(true);
  });
  expect(toolbar.getBoundingClientRect().top - prompt.getBoundingClientRect().bottom).toBeGreaterThanOrEqual(7.5);
  expect(Math.abs(toolbar.getBoundingClientRect().left - reply.querySelector(".message-body")!.getBoundingClientRect().left)).toBeLessThanOrEqual(0.5);
  expect(getComputedStyle(toolbar).pointerEvents).toBe("auto");
  expect(reply.querySelector('button[title="Copy message"]')).not.toBeNull();
  // Opening a workspace dock can narrow the chat column and wrap the prompt.
  view.container.querySelector<HTMLElement>(".app-shell")!.style.width = "450px";
  await userEvent.hover(reply);
  await waitFor(() => expect(getComputedStyle(toolbar).opacity).toBe("1"));
  expect(toolbar.getBoundingClientRect().top - prompt.getBoundingClientRect().bottom).toBeGreaterThanOrEqual(7.5);
  expect(Math.abs(toolbar.getBoundingClientRect().left - reply.querySelector(".message-body")!.getBoundingClientRect().left)).toBeLessThanOrEqual(0.5);
});

it("reserves toolbar clearance at the streaming renderer boundary without moving the reply at completion", async () => {
  // ChatTimeline no longer mounts routine live replies. Exercise the exported
  // production row with its real timeline wrappers, rather than declaring a
  // live task idle just to expose the old streaming DOM.
  const transcript = (streaming: boolean) => <StrictMode><div className="app-shell" data-theme="mythra" data-color-scheme="dark" style={{ width: 900, height: 600 }}>
    <div className="timeline-shell"><div className="timeline flow-timeline"><div className="flow-timeline-list">
    <div data-entry-kind="message"><div className="timeline-entry timeline-entry-message">
      <MessageRow message={{ id: "prompt", role: "user", text: "Please review this." }} provider="claude" />
    </div></div>
    <div data-entry-kind="message"><div className="timeline-entry timeline-entry-message">
      <MessageRow message={{ id: "reply", role: "assistant", text: "The change looks good.", streaming }} provider="claude" />
    </div></div>
    </div></div></div>
  </div></StrictMode>;
  const view = render(transcript(true));
  const replyTop = view.container.querySelector(".message.assistant")!.getBoundingClientRect().top;
  expect(view.container.querySelector(".message.assistant .message-actions")).toBeNull();
  view.rerender(transcript(false));
  const reply = view.container.querySelector<HTMLElement>(".message.assistant")!;
  expect(reply.getBoundingClientRect().top).toBe(replyTop);
  await userEvent.hover(reply);
  const toolbar = reply.querySelector<HTMLElement>(".message-actions")!;
  await waitFor(() => expect(getComputedStyle(toolbar).opacity).toBe("1"));
  expect(toolbar.getBoundingClientRect().top - view.container.querySelector(".message.user")!.getBoundingClientRect().bottom).toBeGreaterThanOrEqual(7.5);
});

it("shows only a live work status, then preserves completed/reopened toolbar clearance and keyboard focus", async () => {
  const transcript = (streaming: boolean) => <div className="app-shell" data-theme="mythra" data-color-scheme="dark" style={{ width: 900, height: 600 }}>
    <ChatTimeline messages={[
      { id: "prompt", role: "user", text: "Please review this.", timelineOrder: 1, turnId: "turn" },
      { id: "reply", role: "assistant", text: "The change looks good.", timelineOrder: 2, streaming, phase: "final", turnId: "turn", turnStatus: streaming ? "inProgress" : "completed" },
    ]} activities={[]} running={streaming} thinkingLabel="Thinking" provider="claude" />
  </div>;
  const view = render(transcript(true));
  expect(view.container.querySelector(".message.assistant")).toBeNull();
  expect(view.container.querySelectorAll(".activity-status.live")).toHaveLength(1);
  expect(view.container.querySelector(".activity-status-pill")?.textContent).toContain("Writing response");
  expect(view.container.querySelector(".message.assistant .message-actions")).toBeNull();
  view.rerender(transcript(false));
  expect(view.container.querySelectorAll(".message.assistant")).toHaveLength(1);
  const copy = view.container.querySelector<HTMLButtonElement>('.message.assistant button[title="Copy message"]')!;
  copy.focus();
  await userEvent.hover(view.container.querySelector(".message.user")!);
  const toolbar = view.container.querySelector<HTMLElement>(".message.assistant .message-actions")!;
  await waitFor(() => expect(getComputedStyle(toolbar).opacity).toBe("1"));
  const gap = () => toolbar.getBoundingClientRect().top - view.container.querySelector(".message.user")!.getBoundingClientRect().bottom;
  await waitFor(() => expect(gap()).toBeGreaterThanOrEqual(7.5));
  view.unmount();
  const reopened = render(transcript(false));
  await userEvent.hover(reopened.container.querySelector(".message.assistant")!);
  await waitFor(() => {
    const actions = reopened.container.querySelector<HTMLElement>(".message.assistant .message-actions")!;
    expect(getComputedStyle(actions).opacity).toBe("1");
    expect(actions.getBoundingClientRect().top - reopened.container.querySelector(".message.user")!.getBoundingClientRect().bottom).toBeGreaterThanOrEqual(7.5);
  });
});

it.each(THEMES)("keeps reply actions clear of completed work in $name", async ({ id }) => {
  const view = render(<div className="app-shell" data-theme={id} data-color-scheme={themeColorScheme(id)} style={{ width: 900, height: 600 }}>
    <FeedbackProvider enabled onAdd={() => true}>
      <ChatTimeline messages={[
        { id: "prompt", role: "user", text: "Please review this change and check that the response actions remain accessible when the conversation column becomes narrow.", timelineOrder: 1, turnId: "turn", turnStatus: "completed" },
        { id: "reply", role: "assistant", text: "The change looks good.", timelineOrder: 3, turnId: "turn", turnStatus: "completed" },
      ]} activities={[{ id: "command", kind: "command", title: "npm test", status: "completed", timelineOrder: 2, turnId: "turn", turnStatus: "completed" }]} running={false} thinkingLabel="Thinking" provider="claude" />
    </FeedbackProvider>
  </div>);
  const reply = view.container.querySelector<HTMLElement>(".message.assistant")!;
  const toolbar = reply.querySelector<HTMLElement>(".message-actions")!;
  const work = view.container.querySelector<HTMLButtonElement>(".activity-status.settled .activity-status-pill")!;
  expect(toolbar.querySelectorAll("button")).toHaveLength(2);
  for (const width of [900, 450, 280]) {
    view.container.querySelector<HTMLElement>(".app-shell")!.style.width = `${width}px`;
    await userEvent.hover(reply);
    await waitFor(() => expect(getComputedStyle(toolbar).opacity).toBe("1"));
    const actionsRect = toolbar.getBoundingClientRect();
    const workRect = work.getBoundingClientRect();
    expect(actionsRect.top - workRect.bottom).toBeGreaterThanOrEqual(7.5);
    expect(actionsRect.right).toBeLessThanOrEqual(view.container.querySelector(".flow-timeline")!.getBoundingClientRect().right + 0.5);
    expect(document.elementFromPoint(workRect.left + workRect.width / 2, workRect.bottom - 2)?.closest(".activity-status-pill")).toBe(work);
    for (const button of toolbar.querySelectorAll("button")) {
      const rect = button.getBoundingClientRect();
      expect(document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)?.closest("button")).toBe(button);
    }
  }
  await userEvent.click(work);
  const dialog = view.container.querySelector<HTMLDialogElement>(".activity-details-dialog")!;
  await waitFor(() => expect(dialog.open).toBe(true));
  expect(dialog.querySelector('[data-step-id="command"]')).not.toBeNull();
  expect(view.container.querySelectorAll(".flow-timeline .activity-status.settled")).toHaveLength(1);
  expect(view.container.querySelector(".flow-timeline .command-disclosure")).toBeNull();
  await userEvent.click(dialog.querySelector<HTMLButtonElement>('button[aria-label="Close activity"]')!);
  await waitFor(() => expect(view.container.querySelector(".activity-details-dialog")).toBeNull());
  await userEvent.hover(reply);
  await waitFor(() => {
    expect(getComputedStyle(toolbar).opacity).toBe("1");
    expect(toolbar.getBoundingClientRect().top - work.getBoundingClientRect().bottom).toBeGreaterThanOrEqual(7.5);
  });
});

const workCases = (["command", "file", "warning"] as const).flatMap((kind) =>
  (["completed", "interrupted"] as const).map((status) => ({ kind, status })));

it.each(workCases)("reserves actions after a $kind row across $status and reopening", async ({ kind, status }) => {
  const transcript = (streaming: boolean) => <div className="app-shell" data-theme="mythra" data-color-scheme="dark" style={{ width: 450, height: 600 }}>
    <FeedbackProvider enabled onAdd={() => true}>
      <ChatTimeline messages={[
        { id: "prompt", role: "user", text: "Please review this change.", timelineOrder: 1, turnId: "active-turn", turnStatus: streaming ? "inProgress" : status },
        { id: "reply", role: "assistant", text: "Here is the result.", timelineOrder: 3, streaming, turnId: "active-turn", turnStatus: streaming ? "inProgress" : status },
      ]} activities={[{ id: "work", kind, title: "Review step", status: "completed", timelineOrder: 2, turnId: "active-turn", turnStatus: streaming ? "inProgress" : status }]} running={streaming} thinkingLabel="Thinking" provider="claude" />
    </FeedbackProvider>
  </div>;
  const view = render(transcript(true));
  expect(view.container.querySelector(".message.assistant")).toBeNull();
  expect(view.container.querySelectorAll(".activity-status.live")).toHaveLength(1);
  expect(view.container.querySelector(".message.assistant .message-actions")).toBeNull();
  view.rerender(transcript(false));
  expect(view.container.querySelectorAll(".message.assistant")).toHaveLength(1);
  const verify = async (container: HTMLElement) => {
    const reply = container.querySelector<HTMLElement>(".message.assistant")!;
    const toolbar = reply.querySelector<HTMLElement>(".message-actions")!;
    const rows = [...container.querySelectorAll<HTMLElement>(".flow-timeline .timeline-entry")];
    const preceding = rows[rows.indexOf(reply.closest<HTMLElement>(".timeline-entry")!) - 1];
    expect(preceding).toBeDefined();
    expect(toolbar.querySelectorAll("button")).toHaveLength(2);
    await userEvent.hover(reply);
    await waitFor(() => expect(getComputedStyle(toolbar).opacity).toBe("1"));
    // Measure the predecessor's content edge, excluding its reserved padding.
    const bottom = preceding.getBoundingClientRect().bottom - parseFloat(getComputedStyle(preceding).paddingBottom);
    expect(toolbar.getBoundingClientRect().top - bottom).toBeGreaterThanOrEqual(7.5);
    for (const button of toolbar.querySelectorAll("button")) {
      const rect = button.getBoundingClientRect();
      expect(document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)?.closest("button")).toBe(button);
    }
  };
  await verify(view.container);
  view.unmount();
  await verify(render(transcript(false)).container);
});
