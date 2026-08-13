import { describe, expect, it } from "vitest";
import { nativeAgentLinkFromThread, nativeAgentLinksAfterThreadDeletion, sanitizeNativeAgentLinks } from "./nativeAgentLinks";

describe("native agent ownership", () => {
  it("discovers ownership from Codex thread metadata", () => {
    expect(nativeAgentLinkFromThread({
      id: "child",
      name: null,
      preview: "Audit",
      cwd: "/workspace",
      updatedAt: 10,
      modelProvider: "openai",
      parentThreadId: "root",
      threadSource: "subagent",
      agentNickname: "reviewer",
    })).toEqual(expect.objectContaining({ childThreadId: "child", rootThreadId: "root", title: "reviewer" }));
  });

  it("rejects malformed or self-owned persisted records", () => {
    expect(sanitizeNativeAgentLinks({
      child: { childThreadId: "child", rootThreadId: "child", title: "bad", createdAt: 1 },
      mismatch: { childThreadId: "other", rootThreadId: "root", title: "bad", createdAt: 1 },
    })).toEqual({});
  });

  it("removes only the deleted child and preserves children of a deleted root", () => {
    const links = sanitizeNativeAgentLinks({ child: { childThreadId: "child", rootThreadId: "root", title: "work", createdAt: 1 } });
    expect(nativeAgentLinksAfterThreadDeletion(links, "root")).toBe(links);
    expect(nativeAgentLinksAfterThreadDeletion(links, "child")).toEqual({});
  });
});
