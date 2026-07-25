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

    expect(onSave).toHaveBeenCalledWith("Prefer TypeScript.");
  });

  it("can clear an existing project override and inherit the app prompt", () => {
    const onSave = vi.fn();
    render(
      <ProjectPromptControl
        projectName="OpenKiwi"
        projectPrompt="Project-only instructions"
        appPrompt=""
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

    expect(onSave).toHaveBeenCalledWith(undefined);
  });

  it("accurately explains when Claude applies an edited project prompt", () => {
    render(
      <ProjectPromptControl
        projectName="OpenKiwi"
        projectPrompt="Project-only instructions"
        appPrompt=""
        provider="claude"
        threadStarted
        onSave={vi.fn()}
        onAppPromptSettings={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Project instructions: Custom" }));

    expect(screen.getByText(/Claude will use this update starting with your next message/)).toBeInTheDocument();
  });
});
