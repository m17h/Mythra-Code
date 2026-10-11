import { describe, expect, it } from "vitest";
import { createWorkspaceDraftKey, isWorkspaceDraftKey, retainSavedWorkspaceDraftKeys, sanitizeSavedWorkspaceDraftKeys, sanitizeWorkspaceDraftKeys } from "./newThreadDraftKeys";

const uuid = "d010ca21-0d86-4a36-9976-2f00a498007c";
describe("new thread draft key ownership", () => {
  it("never treats a suffix-like workspace's default draft as its parent's generated draft", () => {
    const workspace = `/projects/alpha:draft:${uuid}`;
    const key = `new:${workspace}`;
    expect(isWorkspaceDraftKey(key, workspace)).toBe(true);
    expect(isWorkspaceDraftKey(key, "/projects/alpha")).toBe(false);
  });
  it("accepts only the exact workspace draft or a structured generated identity", () => {
    expect(isWorkspaceDraftKey("new:/projects/alpha", "/projects/alpha")).toBe(true);
    expect(isWorkspaceDraftKey(createWorkspaceDraftKey("/projects/alpha", uuid), "/projects/alpha")).toBe(true);
    expect(isWorkspaceDraftKey("new:/projects/alphabeta", "/projects/alpha")).toBe(false);
    expect(isWorkspaceDraftKey("new:/projects/alpha:draft:invalid", "/projects/alpha")).toBe(false);
    expect(isWorkspaceDraftKey(uuid, "/projects/alpha")).toBe(false);
    expect(isWorkspaceDraftKey("new:C:\\projects\\alpha", "C:/projects/alpha")).toBe(true);
    expect(isWorkspaceDraftKey(createWorkspaceDraftKey("C:\\projects\\alpha\\", uuid), "C:/projects/alpha")).toBe(true);
  });

  it("keeps generated path and ID fields separate and rejects malformed identities", () => {
    const workspace = `/projects/alpha:draft:${uuid}`;
    const generated = createWorkspaceDraftKey("/projects/alpha", uuid);
    expect(generated).not.toBe(`new:${workspace}`);
    expect(isWorkspaceDraftKey(generated, workspace)).toBe(false);
    expect(isWorkspaceDraftKey(createWorkspaceDraftKey(workspace, uuid), workspace)).toBe(true);
    for (const identity of [null, {}, ["/projects/alpha"], ["/projects/alpha", "invalid"], ["relative", uuid], ["/projects/alpha", uuid, "extra"]]) {
      expect(isWorkspaceDraftKey(`new-draft:${JSON.stringify(identity)}`, "/projects/alpha")).toBe(false);
    }
    expect(isWorkspaceDraftKey("new-draft:invalid-json", "/projects/alpha")).toBe(false);
  });

  it("sanitizes malformed persisted maps, cross-workspace keys and duplicates", () => {
    expect(sanitizeWorkspaceDraftKeys(null)).toEqual({});
    expect(sanitizeWorkspaceDraftKeys([])).toEqual({});
    expect(sanitizeWorkspaceDraftKeys({ "/projects/alpha": "new:/projects/alphabeta", "/projects/beta": {} })).toEqual({});
    expect(sanitizeSavedWorkspaceDraftKeys({ "/projects/alpha": ["new:/projects/alpha", "new:/projects/alpha", "provider-id", "new:/projects/alphabeta"], "/projects/beta": "bad" }))
      .toEqual({ "/projects/alpha": ["new:/projects/alpha"] });
  });

  it("retains more than ten nonempty recovered drafts and every active send, pruning only settled empty keys", () => {
    const nonempty = Array.from({ length: 12 }, (_, index) => createWorkspaceDraftKey("/projects/alpha", `${index.toString(16).padStart(8, "0")}-0d86-4a36-9976-2f00a498007c`));
    const active = "new:/projects/alpha";
    const stale = createWorkspaceDraftKey("/projects/alpha", uuid);
    const retained = retainSavedWorkspaceDraftKeys({ "/projects/alpha": [...nonempty, active, stale] }, (key) => nonempty.includes(key), new Set([active]));
    expect(retained["/projects/alpha"]).toEqual([...nonempty, active]);
    expect(retainSavedWorkspaceDraftKeys(retained, () => false, new Set())).toEqual({});
  });
});
