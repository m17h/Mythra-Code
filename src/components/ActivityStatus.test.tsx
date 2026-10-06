import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Activity, ChatMessage } from "../types";
import type { CompactWorkEntry } from "../lib/compactActivity";
import { ACTIVITY_PHRASE_DELAY_MS, ACTIVITY_PHRASE_INTERVAL_MS, ACTIVITY_STATUS_PHRASES, ActivityStatus, describeLiveActivity } from "./ActivityStatus";

const user: CompactWorkEntry = { kind: "message", value: { id: "user", role: "user", text: "Fix it" } };
const message = (value: Partial<ChatMessage>): CompactWorkEntry => ({ kind: "message", value: { id: "reply", role: "assistant", text: "Text", ...value } });
const activity = (value: Partial<Activity>): CompactWorkEntry => ({ kind: "activity", value: { id: "step", kind: "command", title: "npm test", ...value } });

afterEach(() => {
  vi.useRealTimers();
});

describe("describeLiveActivity", () => {
  it("names concrete operations from provider work types, never prose", () => {
    expect(describeLiveActivity([user, activity({ status: "inProgress", workType: "research", title: "Read" })]))
      .toEqual({ category: "research", label: "Researching", playful: false });
    expect(describeLiveActivity([user, activity({ kind: "file", title: "src/App.tsx", status: "inProgress" })]))
      .toEqual({ category: "files", label: "Editing files", playful: false });
    expect(describeLiveActivity([user, activity({ title: "research the failures", status: "inProgress" })]))
      .toMatchObject({ category: "commands", label: "Executing commands" });
  });

  it("says Writing response only for a trusted final channel", () => {
    expect(describeLiveActivity([user, message({ streaming: true, phase: "final" })]))
      .toEqual({ category: "writing", label: "Writing response", playful: false });
    expect(describeLiveActivity([user, message({ streaming: true, phase: "commentary" })]).label).toBe("Working");
    expect(describeLiveActivity([user, message({ streaming: true })]).label).toBe("Working");
  });

  it("keeps native Cursor search research even when its legacy kind is agent", () => {
    expect(describeLiveActivity([user, activity({
      kind: "agent", workType: "research", title: "Find", status: "inProgress", turnId: "turn",
    })], { activeTurnId: "turn" }))
      .toEqual({ category: "research", label: "Researching", playful: false });
  });

  it("keeps a run with no output on one generic, playful-eligible line", () => {
    expect(describeLiveActivity([])).toEqual({ category: "thinking", label: "Thinking", playful: true });
    expect(describeLiveActivity([user])).toEqual({ category: "thinking", label: "Thinking", playful: true });
    expect(describeLiveActivity([user, activity({ status: "completed" })])).toEqual({ category: "working", label: "Working", playful: true });
  });

  it("never implies progress while the run waits on the user", () => {
    const busy = [user, activity({ status: "inProgress" })];
    expect(describeLiveActivity(busy, { awaiting: "approval" })).toEqual({ category: "approval", label: "Waiting for approval", playful: false });
    expect(describeLiveActivity(busy, { awaiting: "input" })).toEqual({ category: "approval", label: "Waiting for your answer", playful: false });
  });
});

describe("ActivityStatus", () => {
  it("shows the normal status for three seconds then rotates phrases every five seconds without normal-status gaps", () => {
    vi.useFakeTimers();
    const view = render(<ActivityStatus state="running" label="Thinking" category="thinking" playful seed="run" onOpen={vi.fn()} />);
    const shown = () => view.container.querySelector(".activity-status-label")!.textContent;
    expect(ACTIVITY_PHRASE_DELAY_MS).toBe(3_000);
    expect(ACTIVITY_PHRASE_INTERVAL_MS).toBe(5_000);
    expect(shown()).toBe("Thinking");
    expect(screen.getByRole("status")).toHaveTextContent("Thinking");
    act(() => { vi.advanceTimersByTime(2_999); });
    expect(shown()).toBe("Thinking");
    act(() => { vi.advanceTimersByTime(1); });
    const phrase = shown() as typeof ACTIVITY_STATUS_PHRASES[number];
    const firstIndex = ACTIVITY_STATUS_PHRASES.indexOf(phrase);
    expect(firstIndex).toBeGreaterThanOrEqual(0);
    expect(screen.getByRole("status")).toHaveTextContent("Thinking");
    expect(screen.getByRole("button")).toHaveAccessibleName(/^Thinking\. View activity/);
    for (let index = 1; index <= ACTIVITY_STATUS_PHRASES.length; index += 1) {
      const previous = shown();
      act(() => { vi.advanceTimersByTime(4_999); });
      expect(shown()).toBe(previous);
      act(() => { vi.advanceTimersByTime(1); });
      expect(shown()).toBe(ACTIVITY_STATUS_PHRASES[(firstIndex + index) % ACTIVITY_STATUS_PHRASES.length]);
      expect(shown()).not.toBe("Thinking");
    }
    view.unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("restarts the wait whenever real activity changes and never decorates concrete work", () => {
    vi.useFakeTimers();
    const view = render(<ActivityStatus state="running" label="Thinking" category="thinking" playful seed="run" onOpen={vi.fn()} />);
    act(() => { vi.advanceTimersByTime(ACTIVITY_PHRASE_DELAY_MS - 100); });
    view.rerender(<ActivityStatus state="running" label="Executing commands" category="commands" seed="run" onOpen={vi.fn()} />);
    act(() => { vi.advanceTimersByTime(ACTIVITY_PHRASE_DELAY_MS * 3); });
    expect(ACTIVITY_STATUS_PHRASES.some((phrase) => screen.queryByText(phrase))).toBe(false);
    // The visible label and the announced status both name the real work.
    expect(view.container.querySelector(".activity-status-label")).toHaveTextContent(/^Executing commands$/);
    expect(screen.getByRole("status")).toHaveTextContent(/^Executing commands$/);
  });

  it("immediately ends phrase rotation for specific work and gives resumed thinking a fresh three seconds", () => {
    vi.useFakeTimers();
    const view = render(<ActivityStatus state="running" label="Thinking" category="thinking" playful seed="run" onOpen={vi.fn()} />);
    act(() => { vi.advanceTimersByTime(3_000); });
    expect(ACTIVITY_STATUS_PHRASES.some((phrase) => screen.queryByText(phrase))).toBe(true);
    view.rerender(<ActivityStatus state="running" label="Editing files" category="files" seed="run" onOpen={vi.fn()} />);
    expect(view.container.querySelector(".activity-status-label")).toHaveTextContent(/^Editing files$/);
    act(() => { vi.advanceTimersByTime(15_000); });
    expect(ACTIVITY_STATUS_PHRASES.some((phrase) => screen.queryByText(phrase))).toBe(false);
    view.rerender(<ActivityStatus state="running" label="Thinking" category="thinking" playful seed="run" onOpen={vi.fn()} />);
    act(() => { vi.advanceTimersByTime(2_999); });
    expect(view.container.querySelector(".activity-status-label")).toHaveTextContent(/^Thinking$/);
    act(() => { vi.advanceTimersByTime(1); });
    expect(ACTIVITY_STATUS_PHRASES.some((phrase) => screen.queryByText(phrase))).toBe(true);
    view.rerender(<ActivityStatus state="completed" seed="run" onOpen={vi.fn()} />);
    expect(screen.getByRole("button")).toHaveAccessibleName(/^Work completed\. View activity/);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("marks an idle turn without terminal evidence as unconfirmed, never live or completed", () => {
    vi.useFakeTimers();
    const view = render(<ActivityStatus state="unknown" unconfirmed summary="3 steps" playful seed="run" onOpen={vi.fn()} />);
    expect(view.container.querySelector(".activity-status-orbit")).toBeNull();
    expect(view.container.querySelector(".activity-status.unconfirmed")).not.toBeNull();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    act(() => { vi.advanceTimersByTime(ACTIVITY_PHRASE_DELAY_MS * 2); });
    expect(ACTIVITY_STATUS_PHRASES.some((phrase) => screen.queryByText(phrase))).toBe(false);
    expect(screen.getByRole("button", { name: "Completion unconfirmed. View activity: 3 steps" })).toBeInTheDocument();
    expect(screen.queryByText("Work completed")).not.toBeInTheDocument();
  });

  it("renders settled outcomes statically and opens the details window", () => {
    vi.useFakeTimers();
    const onOpen = vi.fn();
    const view = render(<ActivityStatus state="failed" summary="2 commands" playful onOpen={onOpen} />);
    expect(view.container.querySelector(".activity-status-orbit")).toBeNull();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    act(() => { vi.advanceTimersByTime(ACTIVITY_PHRASE_DELAY_MS * 2); });
    expect(screen.getByText("Run failed")).toBeInTheDocument();
    const button = screen.getByRole("button", { name: "Run failed. View activity: 2 commands" });
    expect(button).toHaveAttribute("aria-haspopup", "dialog");
    fireEvent.click(button);
    expect(onOpen).toHaveBeenCalledWith(button);
  });
});
