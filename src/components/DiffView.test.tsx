import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { DiffFileSections } from "./DiffView";
import type { DiffSection } from "../lib/gitDiff";

function section(path: string): DiffSection {
  return {
    path,
    displayPath: path,
    text: `diff --git a/${path} b/${path}\n+++ b/${path}\n+one line`,
    additions: 1,
    deletions: 0,
  };
}

const sections = [section("src/one.ts"), section("src/two.ts")];

describe("DiffFileSections per-file staging", () => {
  it("offers Unstage on a staged file and Stage on the rest", () => {
    const onPathAction = vi.fn();
    const onUnstage = vi.fn();
    render(
      <DiffFileSections
        sections={sections}
        readOnly={false}
        stagedPaths={["src/one.ts"]}
        onPathAction={onPathAction}
        onUnstage={onUnstage}
      />,
    );

    // Staging per file used to be a one-way door here: the only route back
    // was a terminal, which made the staged-commit workflow a dead end.
    fireEvent.click(screen.getByRole("button", { name: /Unstage/ }));
    expect(onUnstage).toHaveBeenCalledWith("src/one.ts");

    fireEvent.click(screen.getByRole("button", { name: /^Stage$/ }));
    expect(onPathAction).toHaveBeenCalledWith("stage", "src/two.ts");
  });

  it("keeps every per-file action and its reason in read-only mode", () => {
    render(
      <DiffFileSections
        sections={sections}
        readOnly
        readOnlyReason="Switch this thread from Read only first."
        stagedPaths={["src/one.ts"]}
        onPathAction={vi.fn()}
        onUnstage={vi.fn()}
      />,
    );

    const unstage = screen.getByRole("button", { name: /Unstage/ });
    expect(unstage).toBeDisabled();
    expect(unstage).toHaveAttribute("title", "Switch this thread from Read only first.");
    expect(screen.getByRole("button", { name: "Revert src/one.ts" })).toBeDisabled();
  });

  it("behaves exactly as before for callers that supply no staging information", () => {
    const onPathAction = vi.fn();
    render(<DiffFileSections sections={sections} readOnly={false} onPathAction={onPathAction} />);

    expect(screen.queryByRole("button", { name: /Unstage/ })).not.toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /^Stage$/ })).toHaveLength(2);
    expect(screen.getAllByRole("button", { name: /^Revert / })).toHaveLength(2);
  });

  it("never offers staging for a file whose name could not be decoded", () => {
    render(
      <DiffFileSections
        sections={[{ path: null, displayPath: "b/\"odd name\"", text: "diff", additions: 0, deletions: 0 }]}
        readOnly={false}
        stagedPaths={["src/one.ts"]}
        onPathAction={vi.fn()}
        onUnstage={vi.fn()}
      />,
    );

    expect(screen.getByText("Name unavailable")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Stage|Unstage/ })).not.toBeInTheDocument();
  });
});
