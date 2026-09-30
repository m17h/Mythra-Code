import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ProjectPromptControl } from "./ProjectPromptControl";
import { emptySkillDependencyReport } from "../lib/skillDependencies";

describe("ProjectPromptControl", () => {
  it.each(["append", "replace"] as const)("previews the effective project skill graph in %s mode", async (promptMode) => {
    const analyze = vi.fn(async () => emptySkillDependencyReport());
    render(<ProjectPromptControl projectName="Mythra Code" projectPrompt="Project @review instructions" appPrompt="Global @security instructions"
      promptMode={promptMode} provider="openai" threadStarted={false} skills={[{ name: "review" }, { name: "security" }]}
      onAnalyzeSkillDependencies={analyze} onSave={vi.fn()} onAppPromptSettings={vi.fn()} />);
    expect(analyze).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: /Project instructions:/ }));
    await waitFor(() => expect(analyze).toHaveBeenCalledWith("", promptMode === "append" ? "Global @security instructions\n\nProject @review instructions" : "Project @review instructions"));
  });

  it("highlights only exact available skills in a project prompt", () => {
    const view = render(<ProjectPromptControl projectName="Mythra Code" projectPrompt="Use @review. Ignore @review.md and @unknown."
      appPrompt="" promptMode="replace" provider="openai" threadStarted={false}
      skills={[{ name: "review" }]} onSave={vi.fn()} onAppPromptSettings={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Project instructions: Custom" }));
    expect(view.container.querySelectorAll(".skill-prompt-token")).toHaveLength(1);
    expect(view.container.querySelector(".skill-prompt-token")).toHaveTextContent("@review");
  });

  it("uses the first Escape to dismiss skills and the second to close the prompt popover", () => {
    render(<ProjectPromptControl projectName="Mythra Code" projectPrompt="Use @review"
      appPrompt="" promptMode="replace" provider="openai" threadStarted={false}
      skills={[{ name: "review" }]} onSave={vi.fn()} onAppPromptSettings={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Project instructions: Custom" }));
    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "@rev" } });
    expect(screen.getByRole("listbox")).toBeInTheDocument();
    fireEvent.keyDown(input, { key: "Escape" });
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    fireEvent.keyDown(input, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("makes inherited app instructions explicit and saves a project override", () => {
    const onSave = vi.fn();
    render(
      <ProjectPromptControl
        projectName="Mythra Code"
        appPrompt="Keep answers concise."
        promptMode="replace"
        provider="openai"
        threadStarted={false}
        onSave={onSave}
        onAppPromptSettings={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Project instructions: Inherited" }));
    expect(screen.getByText("Uses the 21-character app-wide prompt")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("radio", { name: /Use a project prompt/ }));
    fireEvent.change(screen.getByRole("textbox", { name: "Prompt for Mythra Code" }), { target: { value: "Prefer TypeScript." } });
    fireEvent.click(screen.getByRole("button", { name: "Save project prompt" }));

    expect(onSave).toHaveBeenCalledWith("Prefer TypeScript.", "replace");
  });

  it("can clear an existing project override and inherit the app prompt", () => {
    const onSave = vi.fn();
    render(
      <ProjectPromptControl
        projectName="Mythra Code"
        projectPrompt="Project-only instructions"
        appPrompt=""
        promptMode="replace"
        provider="openai"
        threadStarted
        onSave={onSave}
        onAppPromptSettings={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Project instructions: Custom" }));
    expect(screen.getByText(/applies starting with your next message in this thread/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("radio", { name: /Inherit app prompt/ }));
    fireEvent.click(screen.getByRole("button", { name: "Use app prompt" }));

    expect(onSave).toHaveBeenCalledWith(undefined, "replace");
  });

  it("accurately explains when Claude applies an edited project prompt", () => {
    render(
      <ProjectPromptControl
        projectName="Mythra Code"
        projectPrompt="Project-only instructions"
        appPrompt=""
        promptMode="replace"
        provider="claude"
        threadStarted
        onSave={vi.fn()}
        onAppPromptSettings={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Project instructions: Custom" }));

    expect(screen.getByText(/applies starting with your next message/)).toBeInTheDocument();
  });

  it("can layer the app-wide prompt before the project prompt", () => {
    const onSave = vi.fn();
    render(
      <ProjectPromptControl
        projectName="Mythra Code"
        projectPrompt="Project-only instructions"
        promptMode="replace"
        appPrompt="App-wide instructions"
        provider="openai"
        threadStarted={false}
        onSave={onSave}
        onAppPromptSettings={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Project instructions: Custom" }));
    const toggle = screen.getByRole("switch", { name: /Run the app-wide prompt first/ });
    expect(toggle).toHaveAttribute("aria-checked", "false");
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-checked", "true");
    fireEvent.click(screen.getByRole("button", { name: "Save project prompt" }));

    expect(onSave).toHaveBeenCalledWith("Project-only instructions", "append");
  });

  it("does not claim prompts are layered while the app-wide prompt is empty", () => {
    render(
      <ProjectPromptControl
        projectName="Mythra Code"
        projectPrompt="Project-only instructions"
        promptMode="append"
        appPrompt="  "
        provider="openai"
        threadStarted={false}
        onSave={vi.fn()}
        onAppPromptSettings={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Project instructions: Custom" }));
    expect(screen.getByRole("switch", { name: "Run the app-wide prompt first" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByText("No app-wide prompt is set, so only this project prompt runs.")).toBeInTheDocument();
  });
});
