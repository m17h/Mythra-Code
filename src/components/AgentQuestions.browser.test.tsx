import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ChatTimeline } from "./ChatTimeline";
import { AgentQuestionDelivery } from "../lib/agentQuestionContext";
import type { ChatMessage } from "../types";
import "../styles.css";

const prompt: ChatMessage = { id: "prompt", role: "user", text: "Build the app", turnId: "turn", turnStatus: "completed", timelineOrder: 1 };
const question: ChatMessage = { id: "question", role: "assistant", text: "I can keep working while you choose.", questions: [{ title: "Which layout should I use?", options: ["Compact", "Spacious"] }], turnId: "turn", timelineOrder: 2, turnStatus: "completed" };
const answer: ChatMessage = { id: "answer", role: "assistant", text: "The initial work is ready.", turnId: "turn", timelineOrder: 3, turnStatus: "completed" };
function shell(messages: ChatMessage[], send: (threadId: string, text: string) => Promise<boolean>, running: boolean) {
  return <div className="app-shell" style={{ width: 800, height: 850 }}><div className="chat-panel" style={{ width: "100%" }}>
    <AgentQuestionDelivery value={{ threadId: "browser-questions", send }}><ChatTimeline messages={messages} activities={[]} running={running} thinkingLabel="Working" provider="openai" /></AgentQuestionDelivery>
  </div></div>;
}

describe("agent question interaction", () => {
  beforeEach(() => localStorage.clear());
  it("keeps questions visible after completion, retains a typed answer through new output, and sends once", async () => {
    const send = vi.fn(async () => true);
    const mounted = render(shell([prompt, question], send, true));
    const input = await screen.findByRole("textbox");
    act(() => input.focus());
    fireEvent.change(input, { target: { value: "Use my own compact layout" } });
    const scroller = screen.getByTestId("timeline-scroller");
    const topBeforeOutput = scroller.scrollTop;
    mounted.rerender(shell([prompt, question, { ...answer, text: "More work completed.\n\n".repeat(80) }], send, false));
    await waitFor(() => expect(screen.getByRole("textbox")).toHaveValue("Use my own compact layout"));
    expect(screen.getByRole("textbox")).toHaveFocus();
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(scroller.scrollTop).toBe(topBeforeOutput);
    const form = screen.getByRole("region", { name: "Agent questions" });
    expect(form.getBoundingClientRect().height).toBeGreaterThan(100);
    expect(form.scrollWidth).toBeLessThanOrEqual(form.clientWidth + 1);
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Submit answers" })));
    expect(screen.getByText("Answers sent")).toBeInTheDocument();
    expect(send).toHaveBeenCalledTimes(1);
  });
  it("retains an unanswered draft when timeline virtualization remounts the row", async () => {
    const send = vi.fn(async () => true);
    const mounted = render(shell([prompt, question], send, true));
    fireEvent.change(await screen.findByRole("textbox"), { target: { value: "A handwritten preference" } });
    mounted.unmount();
    render(shell([prompt, question, answer], send, false));
    expect(await screen.findByRole("textbox")).toHaveValue("A handwritten preference");
    expect(send).not.toHaveBeenCalled();
  });
});
