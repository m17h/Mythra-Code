import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { TerminalPanel, type TerminalPanelProps } from "./TerminalPanel";

vi.mock("./XtermPanel", () => ({ XtermPanel: () => null }));

function panelProps(overrides: Partial<TerminalPanelProps> = {}): TerminalPanelProps {
  return {
    outputStore: {} as never,
    scope: "/alpha",
    scopeLabel: "Alpha",
    running: false,
    runningCommand: "",
    runningElsewhere: [],
    readOnly: false,
    onRun: vi.fn(),
    onStop: vi.fn(),
    onClear: vi.fn(),
    onInput: vi.fn(),
    onResize: vi.fn(),
    ...overrides,
  };
}

describe("TerminalPanel", () => {
  it("runs a typed command from Enter or the Run button, and only when there is one", () => {
    const props = panelProps();
    render(<TerminalPanel {...props} />);
    const input = screen.getByRole("textbox", { name: "Terminal command" });
    const run = screen.getByRole("button", { name: "Run terminal command" });

    expect(run).toBeDisabled();
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.change(input, { target: { value: "   " } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(props.onRun).not.toHaveBeenCalled();

    fireEvent.change(input, { target: { value: "npm run dev" } });
    expect(run).toBeEnabled();
    fireEvent.keyDown(input, { key: "Enter" });
    expect(props.onRun).toHaveBeenCalledExactlyOnceWith("npm run dev");
    expect(input).toHaveValue("");

    fireEvent.change(input, { target: { value: "npm test" } });
    fireEvent.click(run);
    expect(props.onRun).toHaveBeenLastCalledWith("npm test");
  });

  it("does not run while an input method is still composing", () => {
    const props = panelProps();
    render(<TerminalPanel {...props} />);
    const input = screen.getByRole("textbox", { name: "Terminal command" });
    fireEvent.change(input, { target: { value: "echo こんにちは" } });
    fireEvent.keyDown(input, { key: "Enter", isComposing: true });
    expect(props.onRun).not.toHaveBeenCalled();
    expect(input).toHaveValue("echo こんにちは");
  });

  it("swaps Run for Stop while a command is running and keeps the draft", () => {
    const props = panelProps({ running: true, runningCommand: "npm run dev" });
    render(<TerminalPanel {...props} />);
    const input = screen.getByRole("textbox", { name: "Terminal command" });
    fireEvent.change(input, { target: { value: "npm test" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(props.onRun).not.toHaveBeenCalled();
    expect(input).toHaveValue("npm test");

    expect(screen.queryByRole("button", { name: "Run terminal command" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Stop terminal command" }));
    expect(props.onStop).toHaveBeenCalledOnce();
    expect(screen.getByRole("status")).toHaveTextContent("Running in Alpha · npm run dev");
  });

  it("states readiness and other projects' commands without claiming them", () => {
    render(<TerminalPanel {...panelProps({ runningElsewhere: [{ scope: "/work/beta", command: "npm run build" }] })} />);
    expect(screen.getByRole("status")).toHaveTextContent(/^Ready/);
    expect(screen.getByRole("status")).not.toHaveTextContent("npm run build");
    expect(screen.getByText(/Still running in/)).toHaveTextContent("Still running in beta · npm run build");
  });
});
