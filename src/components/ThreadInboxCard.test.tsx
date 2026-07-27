import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetTaskStore, useTaskStore } from "../lib/taskStore";
import { compactDirectory, formatWorkingDuration, ThreadInboxCard } from "./ThreadInboxCard";

describe("ThreadInboxCard", () => {
  beforeEach(() => {
    resetTaskStore();
    vi.useRealTimers();
  });
  afterEach(() => vi.restoreAllMocks());

  it("shows workspace, compact directory, provider identity, and live status", () => {
    vi.spyOn(Date, "now").mockReturnValue(75_000);
    useTaskStore.getState().setTaskStatus("thread-1", "running");
    useTaskStore.setState((state) => ({
      tasks: {
        ...state.tasks,
        "thread-1": { ...state.tasks["thread-1"], workingStartedAt: 10_000 },
      },
    }));

    render(
      <ThreadInboxCard
        threadId="thread-1"
        title="Remake the sidebar"
        workspaceName="OpenKiwi"
        directory="/Users/morgan/Projects/OpenKiwi"
        provider="claude"
        providerName="Claude"
        pinned={false}
        onOpen={() => {}}
      />,
    );

    expect(screen.getByText("OpenKiwi")).toBeInTheDocument();
    expect(screen.getByText("Projects/OpenKiwi")).toBeInTheDocument();
    expect(screen.getByText("Working")).toBeInTheDocument();
    expect(screen.getByText("1m")).toBeInTheDocument();
    expect(screen.getByLabelText("Claude thread")).toBeInTheDocument();
  });

  it("prioritizes a needed approval over the running label", () => {
    useTaskStore.getState().setTaskStatus("thread-1", "running");
    useTaskStore.getState().enqueueApproval({
      id: 1,
      method: "item/commandExecution/requestApproval",
      params: {},
      threadId: "thread-1",
      receivedAt: 1,
    });

    render(
      <ThreadInboxCard
        threadId="thread-1"
        title="Review a command"
        workspaceName="OpenKiwi"
        directory="/Projects/OpenKiwi"
        provider="openai"
        providerName="OpenAI"
        pinned
        onOpen={() => {}}
      />,
    );

    expect(screen.getByText("Needs approval")).toBeInTheDocument();
    expect(screen.queryByText("Working")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Pinned")).toBeInTheDocument();
  });

  it("formats compact paths and elapsed time defensively", () => {
    expect(compactDirectory("/Users/morgan/Projects/OpenKiwi")).toBe("Projects/OpenKiwi");
    expect(compactDirectory("C:\\work\\OpenKiwi")).toBe("work/OpenKiwi");
    expect(formatWorkingDuration(Number.NaN)).toBe("0s");
    expect(formatWorkingDuration(3_661_000)).toBe("1h 1m");
  });
});
