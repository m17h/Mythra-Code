import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ProjectRunControl } from "./ProjectRunControl";

describe("ProjectRunControl", () => {
  it("is greyed out with no command and opens the editor instead of running", () => {
    const onRun = vi.fn();
    const onSave = vi.fn();
    render(<ProjectRunControl projectName="Alpha" running={false} onRun={onRun} onStop={vi.fn()} onSave={onSave} />);

    const trigger = screen.getByRole("button", { name: "Run: not set" });
    expect(trigger).not.toHaveClass("ready");
    fireEvent.click(trigger);
    expect(onRun).not.toHaveBeenCalled();

    expect(screen.getByRole("dialog", { name: "Run command for Alpha" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save run command" })).toBeDisabled();
    fireEvent.change(screen.getByRole("textbox", { name: "Run command for Alpha" }), { target: { value: "  npm run dev " } });
    fireEvent.change(screen.getByRole("textbox", { name: "Run button label" }), { target: { value: "Dev server" } });
    fireEvent.click(screen.getByRole("button", { name: "Save run command" }));

    expect(onSave).toHaveBeenCalledWith({ command: "npm run dev", label: "Dev server" });
  });

  it("lights up and runs the saved command, and can clear it from the editor", () => {
    const onRun = vi.fn();
    const onSave = vi.fn();
    render(
      <ProjectRunControl
        projectName="Alpha"
        run={{ command: "npm run dev", label: "Dev server", updatedAt: 1 }}
        running={false}
        onRun={onRun}
        onStop={vi.fn()}
        onSave={onSave}
      />,
    );

    const trigger = screen.getByRole("button", { name: "Run: ready" });
    expect(trigger).toHaveClass("ready");
    expect(trigger).toHaveTextContent("Dev server");
    fireEvent.click(trigger);
    expect(onRun).toHaveBeenCalledOnce();

    fireEvent.click(screen.getByRole("button", { name: "Edit run command" }));
    expect(screen.getByRole("textbox", { name: "Run command for Alpha" })).toHaveValue("npm run dev");
    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    expect(onSave).toHaveBeenCalledWith(null);
  });

  it("turns into a Stop control while the command is running", () => {
    const onStop = vi.fn();
    const onRun = vi.fn();
    render(
      <ProjectRunControl
        projectName="Alpha"
        run={{ command: "npm run dev", updatedAt: 1 }}
        running
        onRun={onRun}
        onStop={onStop}
        onSave={vi.fn()}
      />,
    );

    const trigger = screen.getByRole("button", { name: "Run: running" });
    expect(trigger).toHaveClass("running");
    expect(trigger).toHaveTextContent("Stop");
    fireEvent.click(trigger);
    expect(onStop).toHaveBeenCalledOnce();
    expect(onRun).not.toHaveBeenCalled();
  });
});
