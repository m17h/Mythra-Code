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

  it("saves a named snapshot with its layering mode in the existing save transaction", () => {
    const onSave = vi.fn();
    render(<ProjectPromptControl projectName="Mythra" projectPrompt="Use @review" promptMode="append" appPrompt="Global"
      provider="openai" threadStarted={false} profiles={[]} onSave={onSave} onAppPromptSettings={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /Project instructions:/ }));
    fireEvent.click(screen.getByText("Saved project profiles"));
    fireEvent.change(screen.getByRole("textbox", { name: "Project profile name" }), { target: { value: "Review" } });
    fireEvent.click(screen.getByRole("button", { name: "Save as profile" }));
    expect(onSave).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Save project prompt" }));
    expect(onSave).toHaveBeenCalledWith("Use @review", "append", {
      profiles: [{ id: expect.any(String), name: "Review", prompt: "Use @review", mode: "append" }], selectedProfileId: expect.any(String),
    });
  });

  it("selects, updates, renames and deletes snapshots without clearing current instructions", () => {
    const onSave = vi.fn();
    const profiles = [{ id: "review", name: "Review", prompt: "Use @review", mode: "append" as const }];
    render(<ProjectPromptControl projectName="Mythra" projectPrompt="Current" promptMode="replace" appPrompt="Global"
      provider="openai" threadStarted onSave={onSave} onAppPromptSettings={vi.fn()} profiles={profiles} />);
    fireEvent.click(screen.getByRole("button", { name: /Project instructions:/ }));
    fireEvent.change(screen.getByRole("combobox", { name: "Saved project profile" }), { target: { value: "review" } });
    const editor = screen.getByRole("textbox", { name: "Prompt for Mythra" });
    expect(editor).toHaveValue("Use @review");
    expect(screen.getByRole("switch")).toHaveAttribute("aria-checked", "true");
    fireEvent.change(editor, { target: { value: "New instructions" } });
    fireEvent.click(screen.getByRole("button", { name: "Update profile" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Project profile name" }), { target: { value: "Renamed" } });
    fireEvent.click(screen.getByRole("button", { name: "Rename profile" }));
    expect(screen.getByRole("option", { name: "Renamed" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Delete profile" }));
    expect(editor).toHaveValue("New instructions");
    expect(screen.getByRole("switch")).toHaveAttribute("aria-checked", "true");
    fireEvent.click(screen.getByRole("button", { name: "Save project prompt" }));
    expect(onSave).toHaveBeenCalledWith("New instructions", "append", { profiles: [], selectedProfileId: undefined });
  });

  it("Cancel discards profile switches and deletion, and legacy instructions reopen intact", () => {
    const onSave = vi.fn();
    render(<ProjectPromptControl projectName="Mythra" projectPrompt="Legacy instructions" promptMode="replace" appPrompt="Global"
      provider="openai" threadStarted onSave={onSave} onAppPromptSettings={vi.fn()}
      profiles={[{ id: "review", name: "Review", prompt: "Other instructions", mode: "append" }]} />);
    const trigger = screen.getByRole("button", { name: /Project instructions:/ });
    fireEvent.click(trigger);
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "review" } });
    fireEvent.click(screen.getByRole("button", { name: "Delete profile" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onSave).not.toHaveBeenCalled();
    fireEvent.click(trigger);
    expect(screen.getByRole("textbox", { name: "Prompt for Mythra" })).toHaveValue("Legacy instructions");
    expect(screen.getByRole("option", { name: "Review" })).toBeInTheDocument();
  });

  it("preserves existing large instructions while bounding new saved snapshots", () => {
    const onSave = vi.fn();
    const prompt = "p".repeat(120001);
    render(<ProjectPromptControl projectName="Mythra" projectPrompt={prompt} promptMode="replace" appPrompt=""
      provider="openai" threadStarted={false} profiles={[]} onSave={onSave} onAppPromptSettings={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /Project instructions:/ }));
    fireEvent.click(screen.getByText("Saved project profiles"));
    fireEvent.change(screen.getByRole("textbox", { name: "Project profile name" }), { target: { value: "Large" } });
    expect(screen.getByRole("button", { name: "Save as profile" })).toBeDisabled();
    expect(screen.getByRole("textbox", { name: "Prompt for Mythra" })).not.toHaveAttribute("maxlength");
    fireEvent.click(screen.getByRole("button", { name: "Save project prompt" }));
    expect(onSave).toHaveBeenCalledWith(prompt, "replace", { profiles: [], selectedProfileId: undefined });
  });
});
