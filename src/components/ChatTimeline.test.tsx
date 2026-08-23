import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { openUrl } from "@tauri-apps/plugin-opener";

vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ convertFileSrc: (path: string) => `asset://localhost/${encodeURIComponent(path)}` }));

import { ActivityRow, ChatTimeline, CommandDisclosure, CompletedWorkDisclosure, FileDisclosure, ReasoningDisclosure, compactCompletedTurns, formatCompletedDuration, orderedTimelineEntries, type WorkItemEntry } from "./ChatTimeline";
import { timelineFromTurns } from "../lib/threadTimeline";

/** Mirrors the shape of the old thread that exposed the production stall. */
function oldLongThread(): { messages: Array<{
  id: string;
  role: "user" | "assistant";
  text: string;
  timelineOrder: number;
  turnId: string;
  turnStatus: "completed";
}>; activities: Array<{
  id: string;
  kind: "command";
  title: string;
  timelineOrder: number;
  turnId: string;
  turnStatus: "completed";
}> } {
  const messages = [];
  const activities = [];
  let order = 1;
  for (let turn = 0; turn < 23; turn += 1) {
    const stamp = { turnId: `old-turn-${turn}`, turnStatus: "completed" as const };
    const messageCount = turn === 0 ? 14 : 13;
    const activityCount = turn < 18 ? 78 : 77;
    messages.push({ id: `old-user-${turn}`, role: "user" as const, text: `Request ${turn}`, timelineOrder: order++, ...stamp });
    for (let index = 0; index < messageCount - 2; index += 1) {
      messages.push({ id: `old-update-${turn}-${index}`, role: "assistant" as const, text: `Update ${turn}.${index}`, timelineOrder: order++, ...stamp });
    }
    for (let index = 0; index < activityCount; index += 1) {
      activities.push({ id: `old-activity-${turn}-${index}`, kind: "command" as const, title: `Command ${turn}.${index}`, timelineOrder: order++, ...stamp });
    }
    messages.push({ id: `old-answer-${turn}`, role: "assistant" as const, text: `Answer ${turn}`, timelineOrder: order++, ...stamp });
  }
  return { activities, messages };
}

describe("ChatTimeline", () => {
  it("shows sent image attachments as compact previews in the user message", () => {
    render(<ChatTimeline
      messages={[{
        id: "user-with-image",
        role: "user",
        text: "Use this screenshot",
        attachments: [{ path: "/tmp/pasted image.png", name: "pasted image.png", kind: "image" }],
      }]}
      activities={[]}
      running={false}
      thinkingLabel="Working"
    />);

    const preview = screen.getByRole("img", { name: "Attached image: pasted image.png" });
    expect(preview).toHaveClass("message-image-preview");
    expect(preview).toHaveAttribute("src", "asset://localhost/%2Ftmp%2Fpasted%20image.png");
    expect(screen.getByLabelText("Attached images")).toContainElement(preview);
  });

  it("renders entity-escaped sub-agent labels as plain text", () => {
    render(<ActivityRow activity={{
      id: "child-agent-1",
      kind: "agent",
      title: "Spawned Cursor sub-agent",
      detail: "cursor · grok-4.6\nStory &amp; content audit",
      status: "inProgress",
    }} />);

    expect(screen.getByText(/Story & content audit/)).toBeInTheDocument();
    expect(screen.queryByText(/&amp;/)).not.toBeInTheDocument();
  });

  it("renders a structured spawn as a live provider dispatch instead of a raw activity", () => {
    render(<ActivityRow activity={{
      id: "child-agent-2",
      kind: "agent",
      title: "Spawned Claude sub-agent",
      detail: "claude · claude-opus-5\nRust critical bug fixes",
      status: "inProgress",
      agent: {
        action: "spawn",
        provider: "claude",
        model: "claude-opus-5",
        task: "Rust critical bug fixes",
        count: 1,
      },
    }} />);

    expect(screen.getByRole("article", { name: /Claude sub-agent working: Rust critical bug fixes/i })).toBeInTheDocument();
    expect(screen.getByText("Claude sub-agent")).toBeInTheDocument();
    expect(screen.getByText("claude-opus-5")).toBeInTheDocument();
    expect(screen.getByText("Rust critical bug fixes")).toBeInTheDocument();
    expect(screen.getByText("Working")).toBeInTheDocument();
    expect(screen.queryByText("inProgress")).not.toBeInTheDocument();
  });

  it("renders a restored native Codex child through the provider Relay", () => {
    const snapshot = timelineFromTurns([{ id: "turn-1", items: [{
      id: "native-spawn",
      type: "subAgentActivity",
      kind: "started",
      agentThreadId: "child",
      agentPath: "/root/audio_regression_audit",
    }] }]);

    render(<ActivityRow activity={snapshot.activities[0]} />);

    expect(screen.getByRole("article", {
      name: /OpenAI sub-agent working: \/root\/audio_regression_audit/i,
    })).toBeInTheDocument();
    expect(screen.getByText("OpenAI sub-agent")).toBeInTheDocument();
    expect(screen.getByText("/root/audio_regression_audit")).toBeInTheDocument();
    expect(screen.getByText("Working")).toBeInTheDocument();
    expect(screen.queryByText("Sub-agent started")).not.toBeInTheDocument();
  });

  it("groups consecutive same-turn spawns into one coordinated wave", () => {
    const spawn = (id: string, order: number, turnId: string) => ({
      id,
      kind: "agent" as const,
      title: `Spawned ${id}`,
      timelineOrder: order,
      turnId,
      agent: { action: "spawn" as const, provider: "openai" as const, task: id },
    });
    const entries = orderedTimelineEntries([], [
      spawn("one", 1, "turn-a"),
      spawn("two", 2, "turn-a"),
      spawn("three", 3, "turn-b"),
    ]);

    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ kind: "spawns", value: [{ id: "one" }, { id: "two" }] });
    expect(entries[1]).toMatchObject({ kind: "activity", value: { id: "three" } });
  });

  it("announces a parallel wave once while keeping each relay navigable", () => {
    const activities = ["Parser audit", "UI audit"].map((task, index) => ({
      id: `spawn-${index}`,
      kind: "agent" as const,
      title: `Spawned worker ${index}`,
      status: index ? "completed" : "inProgress",
      timelineOrder: index + 1,
      turnId: "turn-a",
      agent: { action: "spawn" as const, provider: "openai" as const, task },
    }));
    render(<ChatTimeline messages={[]} activities={activities} running thinkingLabel="Working" />);

    expect(screen.getAllByRole("status")).toHaveLength(1);
    expect(screen.getByRole("status")).toHaveTextContent("Sub-agents: 1 working · 1 done");
    expect(screen.getByLabelText("Sub-agent wave: 1 working · 1 done")).toBeInTheDocument();
    expect(screen.getByRole("article", { name: /Parser audit/ })).toBeInTheDocument();
    expect(screen.getByRole("article", { name: /UI audit/ })).toBeInTheDocument();
  });

  it("places command activity between the messages that surround it", () => {
    const entries = orderedTimelineEntries(
      [
        { id: "user", role: "user", text: "Check it", timelineOrder: 1 },
        { id: "assistant", role: "assistant", text: "Done", timelineOrder: 3 },
      ],
      [{ id: "command", kind: "command", title: "git status", detail: "clean", timelineOrder: 2 }],
    );

    expect(entries.map((entry) => entry.kind === "commands" || entry.kind === "files" || entry.kind === "spawns"
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

    expect(entries.map((entry) => entry.kind === "commands" || entry.kind === "files" || entry.kind === "spawns" ? entry.value.map((activity) => activity.id).join(",") : entry.kind))
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

  it("renders streaming output in ordinary document flow", () => {
    const { container } = render(
      <ChatTimeline
        messages={[{ id: "answer", role: "assistant", text: "Working", timelineOrder: 1, streaming: true }]}
        activities={[]}
        running
        thinkingLabel="Thinking"
      />,
    );

    expect(screen.getByTestId("timeline-scroller")).toHaveAttribute("data-flow-timeline", "true");
    expect(container.querySelectorAll(".timeline-entry")).toHaveLength(1);
    expect(container.querySelector("[style*='position: absolute']")).toBeNull();
  });

  it("compacts the old 2,089-record thread shape to a manageable flow transcript", () => {
    const { activities, messages } = oldLongThread();

    expect(messages).toHaveLength(300);
    expect(activities).toHaveLength(1789);
    render(
      <ChatTimeline messages={messages} activities={activities} running={false} thinkingLabel="Thinking" />,
    );

    expect(document.querySelectorAll(".timeline-entry")).toHaveLength(69);
    expect(screen.getByTestId("timeline-scroller")).toHaveAttribute("data-flow-timeline", "true");
  });

  it("hydrates an existing completed transcript into the same flow container", () => {
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

    expect(screen.getByTestId("timeline-scroller")).toHaveAttribute("data-flow-timeline", "true");
    expect(document.querySelectorAll(".timeline-entry")).toHaveLength(2);
  });

  it("treats search navigation as manual navigation", () => {
      const scrollIntoView = vi.fn();
      const original = HTMLElement.prototype.scrollIntoView;
      HTMLElement.prototype.scrollIntoView = scrollIntoView;
      render(
        <ChatTimeline
          messages={[
            { id: "first", role: "user", text: "Find this needle", timelineOrder: 1 },
            { id: "latest", role: "assistant", text: "Finished", timelineOrder: 2 },
          ]}
          activities={[]}
          running={false}
          thinkingLabel="Thinking"
          searchQuery="needle"
          searchActiveMatch={0}
        />,
      );
      expect(scrollIntoView).toHaveBeenCalledWith({ block: "center" });
      expect(screen.getByRole("button", { name: "Scroll to latest message" })).toBeInTheDocument();
      HTMLElement.prototype.scrollIntoView = original;
  });

  it("applies Markdown formatting while an assistant message is still streaming", async () => {
    const { rerender } = render(
      <ChatTimeline
        messages={[{ id: "answer", role: "assistant", text: "Starting…", timelineOrder: 1, streaming: true }]}
        activities={[]}
        running
        thinkingLabel="Thinking"
      />,
    );

    rerender(
      <ChatTimeline
        messages={[{ id: "answer", role: "assistant", text: "Starting… **formatted live**", timelineOrder: 1, streaming: true }]}
        activities={[]}
        running
        thinkingLabel="Thinking"
      />,
    );

    await waitFor(() => expect(screen.getByText("formatted live").tagName).toBe("STRONG"));
    expect(screen.queryByRole("button", { name: "Copy message" })).not.toBeInTheDocument();
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

  it("renders a completed Cursor answer as Markdown after collapsed tool work", () => {
    const completed = { turnId: "cursor-turn", turnStatus: "completed" as const };
    render(
      <ChatTimeline
        messages={[
          { id: "user", role: "user", text: "What next?", timelineOrder: 1, ...completed },
          { id: "progress", role: "assistant", text: "I’ll inspect it.", timelineOrder: 2, ...completed },
          { id: "final", role: "assistant", text: "Start with **talents** next.", timelineOrder: 4, streaming: false, ...completed },
        ]}
        activities={[
          { id: "find", kind: "command", title: "Find", detail: "71 files", status: "completed", timelineOrder: 3, ...completed },
        ]}
        running={false}
        thinkingLabel="Thinking"
        provider="cursor"
      />,
    );

    expect(screen.getByText("talents").tagName).toBe("STRONG");
    expect(screen.getByText("Work completed")).toBeInTheDocument();
    expect(screen.queryByText("Find")).not.toBeInTheDocument();
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

  it("compacts a completed runtime turn whose saved opening prompt is missing its turn id", () => {
    const completed = { turnId: "turn-done", turnStatus: "completed" as const };
    const entries = compactCompletedTurns(orderedTimelineEntries(
      [
        { id: "orphaned-user", role: "user", text: "Expand the NPC dialogue", timelineOrder: 1 },
        { id: "progress-one", role: "assistant", text: "Building the dialogue engine.", timelineOrder: 2, ...completed },
        { id: "progress-two", role: "assistant", text: "Adding NPC memory.", timelineOrder: 4, ...completed },
        { id: "final", role: "assistant", text: "Dialogue and memory are complete.", timelineOrder: 6, ...completed },
      ],
      [
        { id: "file", kind: "file", title: "dialogue.py", timelineOrder: 3, ...completed },
        { id: "command", kind: "command", title: "pytest", timelineOrder: 5, ...completed },
      ],
    ), false);

    expect(entries.map((entry) => entry.kind)).toEqual(["message", "work", "message"]);
    expect(entries[0]).toMatchObject({ kind: "message", value: { id: "orphaned-user" } });
    expect(entries[1]).toMatchObject({
      kind: "work",
      value: [
        { kind: "message", value: { id: "progress-one" } },
        { kind: "files", value: [{ id: "file" }] },
        { kind: "message", value: { id: "progress-two" } },
        { kind: "commands", value: [{ id: "command" }] },
      ],
    });
    expect(entries[2]).toMatchObject({ kind: "message", value: { id: "final" } });
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

  it("summarizes how long a completed run worked alongside its activity counts", () => {
    const timing = { turnId: "turn-a", turnStatus: "completed" as const, turnDurationMs: 10 * 60_000 };
    render(<CompletedWorkDisclosure entries={[
      { kind: "commands", value: [
        { id: "one", kind: "command", title: "npm test", ...timing },
        { id: "two", kind: "command", title: "npm build", ...timing },
      ] },
      { kind: "files", value: [{ id: "edit", kind: "file", title: "9 file changes", itemCount: 9, ...timing }] },
      { kind: "activity", value: { id: "reason", kind: "reasoning", title: "Check result", ...timing } },
    ]} />);

    expect(screen.getByText("Worked for 10 minutes · 2 commands · 9 file changes · 1 other step")).toBeInTheDocument();
    expect(screen.getByRole("button", {
      name: "Show completed work: Worked for 10 minutes, 2 commands, 9 file changes, 1 other step",
    })).toBeInTheDocument();
  });

  it("formats completed run durations in readable units", () => {
    expect(formatCompletedDuration(1_000)).toBe("1 second");
    expect(formatCompletedDuration(65_000)).toBe("1 minute 5 seconds");
    expect(formatCompletedDuration(2 * 60 * 60_000 + 12 * 60_000)).toBe("2 hours 12 minutes");
  });

  it("opens markdown http links externally instead of navigating the webview", () => {
    vi.mocked(openUrl).mockClear();
    render(
      <ChatTimeline
        messages={[{ id: "answer", role: "assistant", text: "See the [docs](https://example.com/docs).", timelineOrder: 1 }]}
        activities={[]}
        running={false}
        thinkingLabel="Thinking"
      />,
    );

    const link = screen.getByRole("link", { name: "docs" });
    expect(link).toHaveAttribute("title", "https://example.com/docs");
    fireEvent.click(link);
    expect(openUrl).toHaveBeenCalledWith("https://example.com/docs");
  });

  it("keeps non-http markdown links inert", () => {
    vi.mocked(openUrl).mockClear();
    render(
      <ChatTimeline
        messages={[{ id: "answer", role: "assistant", text: "Mail [us](mailto:team@example.com).", timelineOrder: 1 }]}
        activities={[]}
        running={false}
        thinkingLabel="Thinking"
      />,
    );

    fireEvent.click(screen.getByRole("link", { name: "us" }));
    expect(openUrl).not.toHaveBeenCalled();
  });

  it("only confirms a copy once the clipboard write succeeds", async () => {
    const writeText = vi.fn<(text: string) => Promise<void>>(() => Promise.reject(new Error("denied")));
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    render(
      <ChatTimeline
        messages={[{ id: "answer", role: "assistant", text: "Answer", timelineOrder: 1 }]}
        activities={[]}
        running={false}
        thinkingLabel="Thinking"
      />,
    );

    fireEvent.click(screen.getByTitle("Copy message"));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("Answer"));
    expect(screen.queryByText("Copied")).not.toBeInTheDocument();

    writeText.mockImplementation(() => Promise.resolve());
    fireEvent.click(screen.getByTitle("Copy message"));
    await waitFor(() => expect(screen.getByText("Copied")).toBeInTheDocument());
  });
});
