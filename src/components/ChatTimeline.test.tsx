import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ActivityRow, CommandDisclosure, FileDisclosure, ReasoningDisclosure, followTimelineOutput, orderedTimelineEntries } from "./ChatTimeline";

describe("ChatTimeline", () => {
  it("places command activity between the messages that surround it", () => {
    const entries = orderedTimelineEntries(
      [
        { id: "user", role: "user", text: "Check it", timelineOrder: 1 },
        { id: "assistant", role: "assistant", text: "Done", timelineOrder: 3 },
      ],
      [{ id: "command", kind: "command", title: "git status", detail: "clean", timelineOrder: 2 }],
    );

    expect(entries.map((entry) => entry.kind === "thinking"
      ? "thinking"
      : entry.kind === "commands" || entry.kind === "files"
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
});
