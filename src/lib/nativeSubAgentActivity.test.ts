import { describe, expect, it } from "vitest";
import { nativeSubAgentPresentation } from "./nativeSubAgentActivity";

describe("native lifecycle presentation", () => {
  it("does not call a provider agent path an assigned task", () => {
    expect(nativeSubAgentPresentation({ type: "subAgentActivity", kind: "started", agentThreadId: "child", agentPath: "0/1" }).agent?.task).toBeUndefined();
  });
  it("labels a completed native child as completed in restored history", () => {
    expect(nativeSubAgentPresentation({ type: "subAgentActivity", kind: "completed", agentThreadId: "child" }))
      .toMatchObject({ title: "Sub-agent completed", status: "completed", agent: { threadIds: ["child"] } });
  });
});
