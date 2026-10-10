import { describe, expect, it } from "vitest";
import { canOwnThread, canOwnNativeThread, nativeDescendantIds, nativeAgentLinkFromThread, nativeAgentLinksAfterThreadDeletion, ownershipRootIds, ownsChildren, sanitizeNativeAgentLinks } from "./nativeAgentLinks";

describe("native agent ownership", () => {
  it("restores bounded readout evidence without promoting requested models to observed models", () => {
    const restored = sanitizeNativeAgentLinks({ child: { childThreadId: "child", rootThreadId: "root", createdAt: 1, title: "Task", task: "a".repeat(13000), progress: "b".repeat(9000) + "latest", result: "Reported result", requestedModel: "requested", modelSource: "invented", activationId: "operation" } }).child;
    expect(restored.task?.length).toBe(12001);
    expect(restored.progress?.length).toBe(8001);
    expect(restored.progress).toMatch(/latest$/);
    expect(restored).toMatchObject({ result: "Reported result", requestedModel: "requested", activationId: "operation" });
    expect(restored.model).toBeUndefined();
    expect(restored.modelSource).toBeUndefined();
  });

  it("retains explicit cleared model evidence for a new activation across reload", () => {
    const restored = sanitizeNativeAgentLinks({ child: { childThreadId: "child", rootThreadId: "root", createdAt: 1, title: "Task", model: "", requestedModel: "", activationId: "fresh-operation" } }).child;
    expect(restored).toMatchObject({ model: "", requestedModel: "", activationId: "fresh-operation" });
    expect(restored.modelSource).toBeUndefined();
  });
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

describe("ownership graph guards", () => {
  const graph = { child: { rootThreadId: "root" } };

  it("knows which threads are roots", () => {
    expect(ownsChildren(graph, "root")).toBe(true);
    expect(ownsChildren(graph, "child")).toBe(false);
    expect(ownsChildren(graph, "")).toBe(false);
  });

  it("indexes a snapshot without caching a mutable discovery graph", () => {
    const links: Record<string, { rootThreadId: string }> = { child: { rootThreadId: "root" } };
    const roots = ownershipRootIds(links);
    expect(ownsChildren(links, "root", roots)).toBe(true);
    expect(ownsChildren(links, "child", roots)).toBe(false);
    delete links.child;
    links.next = { rootThreadId: "new-root" };
    expect(ownsChildren(links, "root")).toBe(false);
    expect(ownsChildren(links, "new-root")).toBe(true);
    expect([...ownershipRootIds(links)]).toEqual(["new-root"]);
  });

  it("refuses self ownership", () => {
    expect(canOwnThread({}, "root", "root")).toBe(false);
    expect(canOwnThread({}, "", "child")).toBe(false);
    expect(canOwnThread({}, "root", "")).toBe(false);
  });

  it("refuses a reversed claim that would make an established root a child", () => {
    expect(canOwnThread(graph, "child", "root")).toBe(false);
    // The forward direction is still fine for a second, unrelated child.
    expect(canOwnThread(graph, "root", "second-child")).toBe(true);
  });

  it("refuses a longer cycle back onto a root", () => {
    const chain = { b: { rootThreadId: "a" }, c: { rootThreadId: "b" } };
    expect(canOwnThread(chain, "c", "a")).toBe(false);
  });

  it("refuses to nest delegation deeper than one level", () => {
    // `child` already owns work of its own, so it is a root and can never be
    // recorded as somebody else's child.
    expect(canOwnThread({ grandchild: { rootThreadId: "child" } }, "root", "child")).toBe(false);
    // And a thread that is somebody's child can never become a root itself.
    expect(canOwnThread(graph, "child", "grandchild")).toBe(false);
  });

  it("keeps a child with its first owner instead of handing it to another root", () => {
    expect(canOwnThread(graph, "other-root", "child")).toBe(false);
    // The same owner may re-assert the record, which is how discovery refreshes it.
    expect(canOwnThread(graph, "root", "child")).toBe(true);
  });

  it("restores native descendants while Mythra delegation stays one level deep", () => {
    const restored = sanitizeNativeAgentLinks({
      child: { childThreadId: "child", rootThreadId: "root", title: "work", createdAt: 1 },
      grandchild: { childThreadId: "grandchild", rootThreadId: "child", title: "nested", createdAt: 2 },
    });
    expect(Object.keys(restored)).toEqual(["child", "grandchild"]);
    expect(canOwnThread(restored, "grandchild", "next")).toBe(false);
    expect(canOwnNativeThread(restored, "grandchild", "next")).toBe(true);
    expect(nativeDescendantIds(restored, "root")).toEqual(["child", "grandchild"]);
    expect(canOwnNativeThread(restored, "grandchild", "root")).toBe(false);
  });

  it("drops cyclic pairs from persisted storage instead of trusting file order", () => {
    const restored = sanitizeNativeAgentLinks({
      child: { childThreadId: "child", rootThreadId: "root", title: "work", createdAt: 1 },
      root: { childThreadId: "root", rootThreadId: "child", title: "reversed", createdAt: 2 },
    });
    expect(Object.keys(restored)).toEqual(["child"]);
  });

  it("fails closed on a cycle that was already written to storage", () => {
    // Both members of the cycle are recorded as children, so neither may own
    // anything further; the corrupt pair cannot grow and cannot loop here.
    const cyclic = { a: { rootThreadId: "b" }, b: { rootThreadId: "a" } };
    expect(canOwnThread(cyclic, "a", "c")).toBe(false);
    expect(canOwnThread(cyclic, "a", "b")).toBe(false);
    expect(canOwnThread(cyclic, "fresh-root", "c")).toBe(true);
  });
});
