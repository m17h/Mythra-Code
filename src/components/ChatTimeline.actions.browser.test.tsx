import { render, waitFor } from "@testing-library/react";
import { expect, it } from "vitest";
import { userEvent } from "vitest/browser";
import { THEMES, themeColorScheme } from "../lib/appConfig";
import { ChatTimeline } from "./ChatTimeline";

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

it("reserves toolbar clearance during streaming, after reopening, and on keyboard focus", async () => {
  const transcript = (streaming: boolean) => <div className="app-shell" data-theme="mythra" data-color-scheme="dark" style={{ width: 900, height: 600 }}>
    <ChatTimeline messages={[
      { id: "prompt", role: "user", text: "Please review this.", timelineOrder: 1 },
      { id: "reply", role: "assistant", text: "The change looks good.", timelineOrder: 2, streaming },
    ]} activities={[]} running={streaming} thinkingLabel="Thinking" provider="claude" />
  </div>;
  const view = render(transcript(true));
  const replyTop = view.container.querySelector(".message.assistant")!.getBoundingClientRect().top;
  expect(view.container.querySelector(".message.assistant .message-actions")).toBeNull();
  view.rerender(transcript(false));
  expect(view.container.querySelector(".message.assistant")!.getBoundingClientRect().top).toBe(replyTop);
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
