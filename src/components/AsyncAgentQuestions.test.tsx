import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AsyncAgentQuestions } from "./AsyncAgentQuestions";
import { AgentQuestionDelivery } from "../lib/agentQuestionContext";
import { AgentQuestionForm } from "./AgentQuestionForm";
import type { ChatMessage } from "../types";

const message: ChatMessage = { id: "question", role: "assistant", text: "", questions: [{ title: "Which layout?", options: ["Compact", "Spacious"] }] };
const view = (send: (threadId: string, text: string) => Promise<boolean>) => <AgentQuestionDelivery value={{ threadId: "thread", send }}><AsyncAgentQuestions message={message} /></AgentQuestionDelivery>;

describe("agent questions", () => {
  beforeEach(() => localStorage.clear());
  it("preselects a suggestion without sending, accepts free text, and remembers successful answers", async () => {
    const send = vi.fn(async () => true);
    const mounted = render(view(send));
    await screen.findByRole("textbox");
    expect(screen.getByRole("radio", { name: "Compact" })).toBeChecked();
    expect(send).not.toHaveBeenCalled();
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Use a custom layout" } });
    fireEvent.click(screen.getByRole("button", { name: "Submit answers" }));
    await screen.findByText("Answers sent");
    expect(send).toHaveBeenCalledExactlyOnceWith("thread", "Answers to your questions:\n\nWhich layout?\nUse a custom layout", expect.anything());
    mounted.unmount();
    render(view(send));
    expect(screen.getByText("Answers sent")).toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });
  it("prevents duplicate sends even if the question unmounts while submitting", async () => {
    let resolve!: (value: boolean) => void;
    const send = vi.fn(() => new Promise<boolean>((done) => { resolve = done; }));
    const first = render(view(send));
    await screen.findByRole("textbox");
    fireEvent.click(screen.getByRole("button", { name: "Submit answers" }));
    first.unmount();
    render(view(send));
    await screen.findByRole("textbox");
    fireEvent.click(screen.getByRole("button", { name: "Submit answers" }));
    expect(send).toHaveBeenCalledTimes(1);
    await act(async () => resolve(true));
    expect(screen.getByText("Answers sent")).toBeInTheDocument();
  });
  it("keeps answers editable after a failed send", async () => {
    const send = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    render(view(send));
    await screen.findByRole("textbox");
    fireEvent.click(screen.getByRole("button", { name: "Submit answers" }));
    await screen.findByRole("alert");
    fireEvent.click(screen.getByRole("radio", { name: "Spacious" }));
    fireEvent.click(screen.getByRole("button", { name: "Submit answers" }));
    await screen.findByText("Answers sent");
    expect(send.mock.calls[1][1]).toContain("Spacious");
  });
  it("supports multiple choices and freeform answers with no automatic submission", async () => {
    const submit = vi.fn();
    render(<AgentQuestionForm questions={[{ id: "features", title: "Features?", multiSelect: true, options: [{ label: "Search" }, { label: "Export" }] }]} onSubmit={submit} />);
    await screen.findByRole("checkbox", { name: "Search" });
    expect(screen.getByRole("button", { name: "Submit answers" })).toBeDisabled();
    fireEvent.click(screen.getByRole("checkbox", { name: "Search" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Export" }));
    expect(submit).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Submit answers" }));
    await waitFor(() => expect(submit).toHaveBeenCalledWith({ features: ["Search", "Export"] }));
  });
});
