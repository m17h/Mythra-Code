import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetTaskStore, useTaskStore } from "../lib/taskStore";
import {
  compactDirectory,
  formatWorkingDuration,
  ThreadInboxCard,
  type ThreadCardPullRequest,
} from "./ThreadInboxCard";

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
        workspaceName="Mythra Code"
        directory="/Users/morgan/Projects/Mythra Code"
        provider="claude"
        providerName="Claude"
        pinned={false}
        onOpen={() => {}}
      />,
    );

    expect(screen.getByText("Mythra Code")).toBeInTheDocument();
    expect(screen.getByText("Projects/Mythra Code")).toBeInTheDocument();
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
        workspaceName="Mythra Code"
        directory="/Projects/Mythra Code"
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
    expect(compactDirectory("/Users/morgan/Projects/Mythra Code")).toBe("Projects/Mythra Code");
    expect(compactDirectory("C:\\work\\Mythra Code")).toBe("work/Mythra Code");
    expect(formatWorkingDuration(Number.NaN)).toBe("0s");
    expect(formatWorkingDuration(3_661_000)).toBe("1h 1m");
  });
});

describe("ThreadInboxCard — the attached pull request", () => {
  beforeEach(() => {
    resetTaskStore();
    vi.useRealTimers();
  });
  afterEach(() => vi.restoreAllMocks());

  function card(pullRequest: ThreadCardPullRequest | null) {
    return render(
      <ThreadInboxCard
        threadId="thread-1"
        title="Thread the pull request workflow"
        workspaceName="Mythra Code"
        directory="/Users/morgan/Projects/Mythra Code"
        provider="claude"
        providerName="Claude"
        pinned={false}
        pullRequest={pullRequest}
        onOpen={() => {}}
      />,
    );
  }

  const open = (): ThreadCardPullRequest =>
    ({ number: 123, repository: "m17h/Mythra-Code", state: "OPEN", isDraft: false });

  it("shows the saved number, and names the repository and state for anyone who cannot see the colour", () => {
    card(open());

    expect(screen.getByText("#123")).toBeInTheDocument();
    const badge = screen.getByLabelText("Pull request m17h/Mythra-Code #123 · Open");
    // The tooltip carries the same words: the pill itself only has room for
    // an icon and a number.
    expect(badge).toHaveAttribute("title", "m17h/Mythra-Code #123 · Open");
    // A labelled button hides its contents from a screen reader, so the card's
    // own name has to repeat it.
    expect(screen.getByRole("button", { name: /Open Thread the pull request workflow · Pull request #123 in m17h\/Mythra-Code, Open/ })).toBeInTheDocument();
  });

  it("reads draft, merged and closed back in their own words", () => {
    const states: [Partial<ThreadCardPullRequest>, string][] = [
      [{ isDraft: true }, "Draft"],
      [{ state: "MERGED" }, "Merged"],
      [{ state: "CLOSED" }, "Closed"],
    ];
    for (const [overrides, label] of states) {
      const { unmount } = card({ ...open(), ...overrides });
      const badge = screen.getByLabelText(`Pull request m17h/Mythra-Code #123 · ${label}`);
      expect(badge.className).toContain(label.toLowerCase());
      unmount();
    }
  });

  it("keeps the pull request in the metadata row, never in the title", () => {
    card(open());

    // The title is the card's headline and stays alone on its line; the pull
    // request is context, and sits with the directory.
    const meta = document.querySelector<HTMLElement>(".thread-card-meta")!;
    const titleLine = document.querySelector<HTMLElement>(".thread-card-title")!;
    expect(meta).toContainElement(screen.getByText("#123"));
    expect(titleLine).toHaveTextContent("Thread the pull request workflow");
    expect(titleLine).not.toContainElement(screen.getByText("#123"));
    // The number is the part that gives way when the row runs out of room.
    expect(screen.getByText("#123")).toHaveClass("thread-card-pr-number");
  });

  it("adds no second control to a card that is already one button", () => {
    card({ ...open(), number: 1234567890 });

    expect(screen.getAllByRole("button")).toHaveLength(1);
    expect(screen.getByText("#1234567890")).toBeInTheDocument();
  });

  it("shows nothing at all when no pull request is attached", () => {
    card(null);

    expect(screen.queryByText(/^#\d+$/)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/^Pull request /)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open Thread the pull request workflow" })).toBeInTheDocument();
  });
});
