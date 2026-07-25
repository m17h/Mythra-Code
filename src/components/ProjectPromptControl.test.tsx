import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ProjectPromptControl } from "./ProjectPromptControl";

describe("ProjectPromptControl", () => {
  it("makes inherited app instructions explicit and saves a project override", () => {
    const onSave = vi.fn();
    render(
      <ProjectPromptControl
        projectName="OpenKiwi"
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
    fireEvent.change(screen.getByRole("textbox", { name: "Prompt for OpenKiwi" }), { target: { value: "Prefer TypeScript." } });
    fireEvent.click(screen.getByRole("button", { name: "Save project prompt" }));

    expect(onSave).toHaveBeenCalledWith("Prefer TypeScript.", "replace");
  });

  it("can clear an existing project override and inherit the app prompt", () => {
    const onSave = vi.fn();
    render(
      <ProjectPromptControl
        projectName="OpenKiwi"
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
    expect(screen.getByText(/current conversation is unchanged/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("radio", { name: /Inherit app prompt/ }));
    fireEvent.click(screen.getByRole("button", { name: "Use app prompt" }));

    expect(onSave).toHaveBeenCalledWith(undefined, "replace");
  });

  it("accurately explains when Claude applies an edited project prompt", () => {
    render(
      <ProjectPromptControl
        projectName="OpenKiwi"
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

    expect(screen.getByText(/Claude will use this update starting with your next message/)).toBeInTheDocument();
  });

  it("can layer the app-wide prompt before the project prompt", () => {
    const onSave = vi.fn();
    render(
      <ProjectPromptControl
        projectName="OpenKiwi"
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
        projectName="OpenKiwi"
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
