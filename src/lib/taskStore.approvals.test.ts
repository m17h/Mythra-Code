import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PendingApproval } from "../types";
import { resetTaskStore, selectInlineApproval, selectPendingApproval, selectPendingApprovalCount, useTaskStore } from "./taskStore";

function approval(threadId: string, id: number, method = "item/commandExecution/requestApproval", receivedAt = id, params: PendingApproval["params"] = {}): PendingApproval {
  return { threadId, id, method, receivedAt, params };
}

describe("approval queries", () => {
  beforeEach(resetTaskStore);

  it("preserves task-order ties, per-thread request order, inline routing, and nonblocking exclusions", () => {
    const store = useTaskStore.getState();
    store.ensureTask("first");
    store.ensureTask("second");
    store.enqueueApproval(approval("second", 2, undefined, 10));
    store.enqueueApproval(approval("first", 1, "item/tool/requestUserInput", 1, { isBlocking: false }));
    store.enqueueApproval(approval("first", 3, undefined, 10));
    store.enqueueApproval(approval("first", 4, "cursor/ask_question", 2));
    expect(selectPendingApprovalCount(useTaskStore.getState())).toBe(3);
    expect(selectPendingApproval(useTaskStore.getState())?.id).toBe(3);
    store.setActiveThread("first");
    expect(selectInlineApproval(useTaskStore.getState())?.id).toBe(3);
    expect(selectPendingApproval(useTaskStore.getState())?.id).toBe(2);
    store.resolveApproval("first", 3);
    expect(selectInlineApproval(useTaskStore.getState())).toBeNull();
    expect(selectPendingApproval(useTaskStore.getState())?.id).toBe(4);
    store.clearApprovals("first");
    expect(selectPendingApprovalCount(useTaskStore.getState())).toBe(1);
    store.removeTask("second");
    expect(selectPendingApproval(useTaskStore.getState())).toBeNull();
    expect(selectPendingApprovalCount(useTaskStore.getState())).toBe(0);
  });

  it.each([
    ["claude/can_use_tool", { tool_name: "AskUserQuestion" }],
    ["item/tool/requestUserInput", {}],
    ["cursor/ask_question", {}],
    ["mcpServer/elicitation/request", {}],
  ] as const)("keeps active-thread complex request %s in the modal", (method, params) => {
    const store = useTaskStore.getState();
    store.enqueueApproval(approval("active", 1, method, 1, params));
    store.setActiveThread("active");
    expect(selectInlineApproval(useTaskStore.getState())).toBeNull();
    expect(selectPendingApproval(useTaskStore.getState())?.id).toBe(1);
    expect(selectPendingApprovalCount(useTaskStore.getState())).toBe(1);
  });

  it("invalidates replaced questions and turn completion while retaining local proposals", () => {
    const store = useTaskStore.getState();
    store.setActiveTurn("thread", "old");
    store.enqueueApproval(approval("thread", 1, "item/tool/requestUserInput", 1, { turnId: "old", itemId: "old-item" }));
    store.enqueueApproval(approval("thread", 2, "openkiwi/settingsProposal", 2));
    const first = selectPendingApproval(useTaskStore.getState());
    store.enqueueApproval(approval("thread", 1, "item/tool/requestUserInput", 3, { turnId: "new", itemId: "new-item" }));
    expect(selectPendingApproval(useTaskStore.getState())).not.toBe(first);
    expect(selectPendingApproval(useTaskStore.getState())?.params.itemId).toBe("new-item");
    store.setActiveTurn("thread", "new");
    store.completeTurn("thread", "old", "completed");
    expect(selectPendingApprovalCount(useTaskStore.getState())).toBe(2);
    store.completeTurn("thread", "new", "completed");
    expect(selectPendingApprovalCount(useTaskStore.getState())).toBe(1);
    expect(selectPendingApproval(useTaskStore.getState())?.id).toBe(2);
  });

  it("does not rescan retained tasks during text-only publications", () => {
    const store = useTaskStore.getState();
    for (let index = 0; index < 500; index += 1) store.ensureTask(`cold-${index}`);
    store.enqueueApproval(approval("pending", 1));
    expect(selectPendingApprovalCount(useTaskStore.getState())).toBe(1);
    const pending = selectPendingApproval(useTaskStore.getState());
    const token = useTaskStore.getState().approvalQueryToken;
    const queriedTasks = new Set<object>();
    const values = vi.spyOn(Object, "values");
    try {
      for (let index = 0; index < 20; index += 1) {
        store.queueAssistantDelta("streaming", "message", "text");
        store.flushDeltas();
        const state = useTaskStore.getState();
        queriedTasks.add(state.tasks);
        expect(state.approvalQueryToken).toBe(token);
        expect(selectPendingApprovalCount(state)).toBe(1);
        expect(selectPendingApproval(state)).toBe(pending);
      }
      expect(values.mock.calls.filter(([input]) => queriedTasks.has(input))).toHaveLength(0);
    } finally {
      values.mockRestore();
    }
  });
});
