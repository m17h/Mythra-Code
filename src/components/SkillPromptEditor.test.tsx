import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SkillPromptEditor } from "./SkillPromptEditor";
import { skillDependencyFixture } from "../test/skillDependencyFixtures";
import type { SkillDependencyReport } from "../types";

afterEach(() => vi.useRealTimers());

describe("skill dependency preview lifecycle", () => {
  it("debounces edits and ignores superseded results without changing native input", async () => {
    vi.useFakeTimers();
    let finishOld!: (report: SkillDependencyReport) => void;
    const analyze = vi.fn((text: string) => text === "@review"
      ? new Promise<SkillDependencyReport>((resolve) => { finishOld = resolve; })
      : Promise.resolve(skillDependencyFixture()));
    const props = { skills: [{ name: "review", path: "/skills/review/SKILL.md" }], "aria-label": "Instructions", onAnalyze: analyze };
    const view = render(<SkillPromptEditor {...props} value="@review" />);
    await act(() => vi.advanceTimersByTimeAsync(299));
    expect(analyze).not.toHaveBeenCalled();
    await act(() => vi.advanceTimersByTimeAsync(1));
    expect(analyze).toHaveBeenCalledExactlyOnceWith("@review");
    view.rerender(<SkillPromptEditor {...props} value="@review updated" />);
    await act(() => vi.advanceTimersByTimeAsync(300));
    await act(async () => finishOld(skillDependencyFixture(true)));
    expect(screen.queryByText("Turn blocked by skill dependencies")).toBeNull();
    expect(screen.getByRole("textbox")).toHaveValue("@review updated");
    expect(view.container.querySelector(".skill-prompt-token.is-blocked")).toBeNull();
  });

  it("cancels a scheduled check on unmount and exposes failures from nested document links", async () => {
    vi.useFakeTimers();
    const analyze = vi.fn(async () => skillDependencyFixture(true));
    const view = render(<SkillPromptEditor value="@review" skills={[{ name: "review" }]} onAnalyze={analyze} />);
    view.unmount();
    await act(() => vi.advanceTimersByTimeAsync(300));
    expect(analyze).not.toHaveBeenCalled();
    const next = render(<SkillPromptEditor value="@review" skills={[{ name: "review" }]} onAnalyze={analyze} />);
    await act(() => vi.advanceTimersByTimeAsync(300));
    expect(next.container.querySelector(".skill-prompt-token.is-blocked")).toHaveTextContent("@review");
    expect(screen.getByRole("alert")).toHaveTextContent("Reference document was not found.");
    fireEvent.select(screen.getByRole("textbox"));
    expect(screen.getByRole("alert")).toHaveTextContent("@review to @tests to references/checklist.md");
  });
});
