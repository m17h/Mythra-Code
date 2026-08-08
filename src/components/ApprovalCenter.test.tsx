import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { APPROVAL_GRACE_MS, ApprovalCenter, InlineApprovalCard, approvalResponse } from "./ApprovalCenter";
import type { PendingApproval } from "../types";

vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));

function approval(method: string, params: PendingApproval["params"]): PendingApproval {
  return { id: 1, method, params, threadId: "thread-1", receivedAt: 1 };
}

/** Modal action buttons stay disabled through the activation grace. */
function passGrace() {
  act(() => {
    vi.advanceTimersByTime(APPROVAL_GRACE_MS);
  });
}

describe("ApprovalCenter", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("uses the legacy approval vocabulary for legacy requests", () => {
    const onRespond = vi.fn();
    render(<ApprovalCenter approval={approval("execCommandApproval", { command: "npm test" })} onRespond={onRespond} />);
    passGrace();
    fireEvent.click(screen.getByRole("button", { name: "Allow for session" }));
    expect(onRespond).toHaveBeenCalledWith({ decision: "approved_for_session" });
  });

  it("returns structured answers for agent questions", () => {
    const onRespond = vi.fn();
    render(<ApprovalCenter approval={approval("item/tool/requestUserInput", { questions: [{ id: "target", header: "Target", question: "Where?", isOther: false, isSecret: false, options: [{ label: "Web", description: "Browser" }] }] })} onRespond={onRespond} />);
    passGrace();
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "Web" } });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(onRespond).toHaveBeenCalledWith({ answers: { target: { answers: ["Web"] } } });
  });

  it("includes untouched questions in the submitted answers", () => {
    const onRespond = vi.fn();
    render(<ApprovalCenter approval={approval("item/tool/requestUserInput", { questions: [
      { id: "first", header: "First", question: "Answered", isOther: false, isSecret: false, options: null },
      { id: "second", header: "Second", question: "Skipped", isOther: false, isSecret: false, options: null },
    ] })} onRespond={onRespond} />);
    passGrace();
    fireEvent.change(screen.getAllByRole("textbox")[0], { target: { value: "yes" } });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(onRespond).toHaveBeenCalledWith({ answers: { first: { answers: ["yes"] }, second: { answers: [""] } } });
  });

  it("returns the requested permission profile with session scope", () => {
    const onRespond = vi.fn();
    const permissions = { network: { enabled: true }, fileSystem: null };
    render(<ApprovalCenter approval={approval("item/permissions/requestApproval", { permissions, reason: "Network access" })} onRespond={onRespond} />);
    passGrace();
    fireEvent.click(screen.getByRole("button", { name: "Allow for session" }));
    expect(onRespond).toHaveBeenCalledWith({ permissions, scope: "session" });
  });

  it("keeps action buttons disabled during the activation grace", () => {
    const onRespond = vi.fn();
    render(<ApprovalCenter approval={approval("execCommandApproval", { command: "npm test" })} onRespond={onRespond} />);
    const allow = screen.getByRole("button", { name: "Allow once" });
    expect(allow).toBeDisabled();
    expect(screen.getByRole("button", { name: "Deny" })).toBeDisabled();
    fireEvent.click(allow);
    expect(onRespond).not.toHaveBeenCalled();
    passGrace();
    expect(allow).toBeEnabled();
  });

  it("latches after the first decision so a second activation cannot answer the next request", () => {
    const onRespond = vi.fn();
    render(<ApprovalCenter approval={approval("execCommandApproval", { command: "npm test" })} onRespond={onRespond} />);
    passGrace();
    const allow = screen.getByRole("button", { name: "Allow once" });
    fireEvent.click(allow);
    expect(allow).toBeDisabled();
    fireEvent.click(allow);
    fireEvent.click(screen.getByRole("button", { name: "Deny" }));
    expect(onRespond).toHaveBeenCalledTimes(1);
    expect(onRespond).toHaveBeenCalledWith({ decision: "approved" });
  });

  it("latches the inline approval card without an activation grace", () => {
    const onRespond = vi.fn();
    render(<InlineApprovalCard approval={approval("execCommandApproval", { command: "npm test" })} onRespond={onRespond} />);
    const allow = screen.getByRole("button", { name: "Allow once" });
    expect(allow).toBeEnabled();
    fireEvent.click(allow);
    fireEvent.click(allow);
    expect(onRespond).toHaveBeenCalledTimes(1);
  });

  it("shows a retryable response failure and unlocks the same approval", async () => {
    const onRespond = vi.fn()
      .mockRejectedValueOnce(new Error("Runtime connection dropped"))
      .mockResolvedValueOnce(undefined);
    render(<InlineApprovalCard approval={approval("execCommandApproval", { command: "npm test" })} onRespond={onRespond} />);

    const allow = screen.getByRole("button", { name: "Allow once" });
    fireEvent.click(allow);
    await act(async () => { await Promise.resolve(); });

    expect(screen.getByRole("alert")).toHaveTextContent("Runtime connection dropped");
    expect(allow).toBeEnabled();
    fireEvent.click(allow);
    expect(onRespond).toHaveBeenCalledTimes(2);
  });

  it("submits numeric MCP fields as numbers only when the input is finite", () => {
    const onRespond = vi.fn();
    render(<ApprovalCenter approval={approval("mcpServer/elicitation/request", {
      serverName: "server",
      mode: "form",
      requestedSchema: { properties: { port: { type: "number" }, note: { type: "string" } } },
    })} onRespond={onRespond} />);
    passGrace();
    fireEvent.change(screen.getByRole("spinbutton"), { target: { value: "8080" } });
    fireEvent.click(screen.getByRole("button", { name: "Submit" }));
    expect(onRespond).toHaveBeenCalledWith({ action: "accept", content: { port: 8080, note: "" }, _meta: null });
  });

  it("moves initial focus into the input request modal", () => {
    render(<ApprovalCenter approval={approval("item/tool/requestUserInput", { questions: [{ id: "target", header: "Target", question: "Where?", isOther: false, isSecret: false, options: null }] })} onRespond={vi.fn()} />);
    expect(screen.getByRole("textbox")).toHaveFocus();
  });

  it("maps Claude permission choices onto the Agent SDK response", () => {
    const request = approval("claude/can_use_tool", {
      tool_use_id: "tool-1",
      input: { command: "npm test" },
      permission_suggestions: [{ type: "addRules", rules: [{ toolName: "Bash" }] }],
    });
    expect(approvalResponse(request, "acceptForSession")).toEqual({
      behavior: "allow",
      updatedInput: { command: "npm test" },
      updatedPermissions: [{ type: "addRules", rules: [{ toolName: "Bash" }] }],
    });
    expect(approvalResponse(request, "decline")).toEqual({ behavior: "deny", message: "The user denied this action." });
    expect(approvalResponse(approval("claude/can_use_tool", {}), "accept")).toEqual({
      behavior: "allow",
      updatedPermissions: undefined,
    });
  });
});
