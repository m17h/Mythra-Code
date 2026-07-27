import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const { scrollToBottom } = vi.hoisted(() => ({ scrollToBottom: vi.fn() }));

vi.mock("react-virtuoso", async () => {
  const React = await import("react");
  return {
    Virtuoso: React.forwardRef(function MockVirtuoso(
      props: {
        data?: unknown[];
        itemContent?: (index: number, entry: unknown) => React.ReactNode;
      },
      ref: React.ForwardedRef<{ scrollTo: typeof scrollToBottom }>,
    ) {
      React.useImperativeHandle(ref, () => ({ scrollTo: scrollToBottom }));
      return <div>{props.data?.map((entry, index) => <div key={index}>{props.itemContent?.(index, entry)}</div>)}</div>;
    }),
  };
});

import { ActivityRow, ChatTimeline, CommandDisclosure, CompletedWorkDisclosure, FileDisclosure, INITIAL_TIMELINE_POSITION, ReasoningDisclosure, compactCompletedTurns, followTimelineOutput, orderedTimelineEntries, type WorkItemEntry } from "./ChatTimeline";

describe("ChatTimeline", () => {
  it("places command activity between the messages that surround it", () => {
    const entries = orderedTimelineEntries(
      [
        { id: "user", role: "user", text: "Check it", timelineOrder: 1 },
        { id: "assistant", role: "assistant", text: "Done", timelineOrder: 3 },
      ],
      [{ id: "command", kind: "command", title: "git status", detail: "clean", timelineOrder: 2 }],
    );

    expect(entries.map((entry) => entry.kind === "commands" || entry.kind === "files"
        ? entry.value.map((activity) => activity.id).join(",")
        : entry.value.id))
      .toEqual(["user", "command", "assistant"]);
  });

  it("groups consecutive commands and file changes while preserving timeline order", () => {
    const entries = orderedTimelineEntries(
      [{ id: "user", role: "user", text: "Check it", timelineOrder: 1 }],
      [
        { id: "one", kind: "command", title: "git status", timelineOrder: 2 },
        { id: "two", kind: "command", title: "npm test", timelineOrder: 3 },
        { id: "file", kind: "file", title: "Changed app.ts", timelineOrder: 4 },
        { id: "file-two", kind: "file", title: "Changed styles.css", timelineOrder: 5 },
        { id: "three", kind: "command", title: "npm build", timelineOrder: 6 },
      ],
    );

    expect(entries.map((entry) => entry.kind === "commands" || entry.kind === "files" ? entry.value.map((activity) => activity.id).join(",") : entry.kind))
      .toEqual(["message", "one,two", "file,file-two", "three"]);
  });

  it("keeps grouped commands collapsed until the user opens them", () => {
    render(<CommandDisclosure commands={[
      { id: "status", kind: "command", title: "git status", detail: "working tree clean", status: "completed" },
      { id: "tests", kind: "command", title: "npm test", detail: "all tests passed", status: "completed" },
    ]} />);

    const toggle = screen.getByRole("button", { name: "Show 2 executed commands" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByText("Executed 2 commands")).toBeInTheDocument();
    expect(screen.queryByText("working tree clean")).not.toBeInTheDocument();

    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("button", { name: "Hide 2 executed commands" })).toBeInTheDocument();
    expect(screen.getByText("working tree clean").closest(".command-panel")).toHaveAttribute("aria-hidden", "false");
    expect(screen.getByText("all tests passed")).toBeInTheDocument();
  });

  it("keeps file tool results in a compact disclosure", () => {
    render(<FileDisclosure files={[
      { id: "edit-one", kind: "file", title: "/project/src/App.tsx", detail: "The file has been updated successfully.", status: "completed" },
      { id: "edit-two", kind: "file", title: "/project/src/styles.css", detail: "The stylesheet has been updated successfully.", status: "completed" },
    ]} />);

    const toggle = screen.getByRole("button", { name: "Show 2 file changes" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByText("Made 2 file changes")).toBeInTheDocument();
    expect(screen.queryByText("The file has been updated successfully.")).not.toBeInTheDocument();

    fireEvent.click(toggle);
    expect(screen.getByRole("button", { name: "Hide 2 file changes" })).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("The file has been updated successfully.")).toBeInTheDocument();
    expect(screen.getByText("The stylesheet has been updated successfully.")).toBeInTheDocument();
  });

  it("uses singular command copy", () => {
    render(<CommandDisclosure commands={[
      { id: "status", kind: "command", title: "git status", status: "completed" },
    ]} />);
    expect(screen.getByText("Executed 1 command")).toBeInTheDocument();
  });

  it("keeps model thinking collapsed by default and reveals it on request", () => {
    const { container } = render(<ActivityRow activity={{ id: "reasoning", kind: "reasoning", title: "Model thinking", detail: "Considering the available approaches", status: "completed" }} />);

    const toggle = screen.getByRole("button", { name: "Show thinking" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(container.querySelector(".reasoning-panel")).toHaveAttribute("aria-hidden", "true");

    fireEvent.click(toggle);
    expect(screen.getByRole("button", { name: "Hide thinking" })).toHaveAttribute("aria-expanded", "true");
    expect(container.querySelector(".reasoning-panel")).toHaveAttribute("aria-hidden", "false");
    expect(screen.getByText("Considering the available approaches")).toBeInTheDocument();
  });

  it("streams new thinking into an open disclosure without collapsing it", () => {
    const { rerender } = render(<ReasoningDisclosure detail="Checking the project" inProgress />);
    fireEvent.click(screen.getByRole("button", { name: "Show thinking" }));

    rerender(<ReasoningDisclosure detail={"Checking the project\nReading the relevant files"} inProgress />);

    expect(screen.getByRole("button", { name: "Hide thinking" })).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText(/Reading the relevant files/)).toBeInTheDocument();
  });

  it("follows appended output without stacking smooth scroll animations", () => {
    expect(followTimelineOutput(true)).toBe("auto");
    expect(followTimelineOutput(false)).toBe(false);
  });

  it("opens a newly mounted conversation at its latest entry", () => {
    expect(INITIAL_TIMELINE_POSITION).toEqual({ index: "LAST", align: "end" });
  });

  it("moves to the latest entry when an asynchronously resumed transcript first arrives", () => {
    scrollToBottom.mockClear();
    const { rerender } = render(
      <ChatTimeline messages={[]} activities={[]} running={false} thinkingLabel="Thinking" />,
    );

    rerender(
      <ChatTimeline
        messages={[
          { id: "first", role: "user", text: "Start", timelineOrder: 1 },
          { id: "latest", role: "assistant", text: "Finished", timelineOrder: 2 },
        ]}
        activities={[]}
        running={false}
        thinkingLabel="Thinking"
      />,
    );

    expect(scrollToBottom).toHaveBeenCalledWith({ top: Number.MAX_SAFE_INTEGER, behavior: "auto" });
  });

  it("reinforces the latest-entry position when a populated transcript mounts", () => {
    scrollToBottom.mockClear();
    render(
      <ChatTimeline
        messages={[
          { id: "first", role: "user", text: "Start", timelineOrder: 1 },
          { id: "latest", role: "assistant", text: "Finished", timelineOrder: 2 },
        ]}
        activities={[]}
        running={false}
        thinkingLabel="Thinking"
      />,
    );

    expect(scrollToBottom).toHaveBeenCalledWith({ top: Number.MAX_SAFE_INTEGER, behavior: "auto" });
  });

  it("compacts a completed turn to its request, work disclosure, and final answer", () => {
    const entries = compactCompletedTurns(orderedTimelineEntries(
      [
        { id: "user", role: "user", text: "Fix it", timelineOrder: 1 },
        { id: "progress", role: "assistant", text: "I found the cause.", timelineOrder: 3 },
        { id: "final", role: "assistant", text: "Fixed and verified.", timelineOrder: 6 },
      ],
      [
        { id: "command", kind: "command", title: "npm test", timelineOrder: 2 },
        { id: "file", kind: "file", title: "src/App.tsx", timelineOrder: 4 },
        { id: "reasoning", kind: "reasoning", title: "Checking behavior", timelineOrder: 5 },
      ],
    ), false);

    expect(entries.map((entry) => entry.kind)).toEqual(["message", "work", "message"]);
    expect(entries[0]).toMatchObject({ kind: "message", value: { id: "user" } });
    expect(entries[2]).toMatchObject({ kind: "message", value: { id: "final" } });
    expect(entries[1]).toMatchObject({
      kind: "work",
      value: [
        { kind: "commands", value: [{ id: "command" }] },
        { kind: "message", value: { id: "progress" } },
        { kind: "files", value: [{ id: "file" }] },
        { kind: "activity", value: { id: "reasoning" } },
      ],
    });
  });

  it("leaves the active turn fully visible while it is running", () => {
    const entries = compactCompletedTurns(orderedTimelineEntries(
      [
        { id: "user", role: "user", text: "Fix it", timelineOrder: 1 },
        { id: "progress", role: "assistant", text: "Working on it.", timelineOrder: 3, streaming: true },
      ],
      [{ id: "command", kind: "command", title: "npm test", timelineOrder: 2 }],
    ), true);

    expect(entries.map((entry) => entry.kind)).toEqual(["message", "commands", "message"]);
  });

  it("compacts older completed turns while keeping the current turn live", () => {
    const entries = compactCompletedTurns(orderedTimelineEntries(
      [
        { id: "user-one", role: "user", text: "First task", timelineOrder: 1 },
        { id: "final-one", role: "assistant", text: "First task done.", timelineOrder: 3 },
        { id: "user-two", role: "user", text: "Second task", timelineOrder: 4 },
      ],
      [
        { id: "command-one", kind: "command", title: "npm test", timelineOrder: 2 },
        { id: "command-two", kind: "command", title: "npm build", timelineOrder: 5 },
      ],
    ), true);

    expect(entries.map((entry) => entry.kind)).toEqual(["message", "work", "message", "message", "commands"]);
  });

  it("keeps a steered runtime turn fully visible until that exact turn completes", () => {
    const entries = compactCompletedTurns(orderedTimelineEntries(
      [
        { id: "user-one", role: "user", text: "Fix it", timelineOrder: 1, turnId: "turn-live" },
        { id: "progress", role: "assistant", text: "I found the cause.", timelineOrder: 3, turnId: "turn-live" },
        { id: "steer", role: "user", text: "Also cover the edge case.", timelineOrder: 4, turnId: "turn-live" },
        { id: "stream", role: "assistant", text: "Updating", timelineOrder: 6, streaming: true, turnId: "turn-live" },
      ],
      [
        { id: "command-one", kind: "command", title: "npm test", timelineOrder: 2, turnId: "turn-live" },
        { id: "command-two", kind: "command", title: "npm build", timelineOrder: 5, turnId: "turn-live" },
      ],
    ), true);

    expect(entries.map((entry) => entry.kind)).toEqual(["message", "commands", "message", "message", "commands", "message"]);
  });

  it("keeps steering visible and compacts the work around it after completion", () => {
    const turn = { turnId: "turn-done", turnStatus: "completed" as const };
    const entries = compactCompletedTurns(orderedTimelineEntries(
      [
        { id: "user-one", role: "user", text: "Fix it", timelineOrder: 1, ...turn },
        { id: "progress", role: "assistant", text: "I found the cause.", timelineOrder: 3, ...turn },
        { id: "steer", role: "user", text: "Also cover the edge case.", timelineOrder: 4, ...turn },
        { id: "final", role: "assistant", text: "Fixed and verified.", timelineOrder: 6, ...turn },
      ],
      [
        { id: "command-one", kind: "command", title: "npm test", timelineOrder: 2, ...turn },
        { id: "command-two", kind: "command", title: "npm build", timelineOrder: 5, ...turn },
      ],
    ), false);

    expect(entries.map((entry) => entry.kind)).toEqual(["message", "work", "message", "work", "message"]);
    expect(entries.filter((entry) => entry.kind === "message").map((entry) => entry.value.id))
      .toEqual(["user-one", "steer", "final"]);
  });

  it("does not hide an interrupted turn without a final answer", () => {
    const entries = compactCompletedTurns(orderedTimelineEntries(
      [{ id: "user", role: "user", text: "Fix it", timelineOrder: 1 }],
      [{ id: "command", kind: "command", title: "npm test", timelineOrder: 2 }],
    ), false);

    expect(entries.map((entry) => entry.kind)).toEqual(["message", "commands"]);
  });

  it("does not present a rehydrated interrupted answer as a successful final response", () => {
    const interrupted = { turnId: "turn-stopped", turnStatus: "interrupted" as const };
    const entries = compactCompletedTurns(orderedTimelineEntries(
      [
        { id: "user", role: "user", text: "Fix it", timelineOrder: 1, ...interrupted },
        { id: "partial", role: "assistant", text: "I started changing", timelineOrder: 3, ...interrupted },
      ],
      [{ id: "command", kind: "command", title: "npm test", timelineOrder: 2, ...interrupted }],
    ), false);

    expect(entries.map((entry) => entry.kind)).toEqual(["message", "commands", "message"]);
  });

  it("lets a clean follow-up compact after an answer-less interrupted legacy turn", () => {
    const entries = compactCompletedTurns(orderedTimelineEntries(
      [
        { id: "user-one", role: "user", text: "First task", timelineOrder: 1 },
        { id: "user-two", role: "user", text: "Try a different task", timelineOrder: 3 },
        { id: "final-two", role: "assistant", text: "Second task done.", timelineOrder: 5 },
      ],
      [
        { id: "command-one", kind: "command", title: "stopped command", timelineOrder: 2 },
        { id: "command-two", kind: "command", title: "successful command", timelineOrder: 4 },
      ],
    ), false);

    expect(entries.map((entry) => entry.kind)).toEqual(["message", "commands", "message", "work", "message"]);
  });

  it("keeps completed work collapsed until the user opens the audit trail", () => {
    const work: WorkItemEntry[] = [
      { kind: "commands", value: [{ id: "test", kind: "command", title: "npm test", detail: "Tests passed", status: "completed" }] },
      { kind: "message", value: { id: "update", role: "assistant", text: "I found the **cause**." } },
      { kind: "files", value: [{ id: "edit", kind: "file", title: "src/App.tsx", detail: "Updated", status: "completed" }] },
    ];
    const { rerender } = render(<CompletedWorkDisclosure entries={work} />);

    const toggle = screen.getByRole("button", { name: "Show completed work: 1 command, 1 file change, 1 other step" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("Tests passed")).not.toBeInTheDocument();
    expect(screen.queryByText(/I found the/)).not.toBeInTheDocument();

    rerender(<CompletedWorkDisclosure entries={work} reveal />);
    expect(screen.getByRole("button", { name: "Hide completed work: 1 command, 1 file change, 1 other step" })).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("npm test")).toBeInTheDocument();
    expect(screen.getByText("cause").tagName).toBe("STRONG");
    expect(screen.getByText("Updated")).toBeInTheDocument();
  });
});
