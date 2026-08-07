import { beforeEach, describe, expect, it, vi } from "vitest";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));

vi.mock("@tauri-apps/api/core", () => ({ invoke }));

import { DURABLE_STORAGE_KEYS, STORAGE_SCHEMA_VERSION, flushPendingStateWrites, hydrateNativeStorage, loadStored, removeStoredValue, storeValue } from "./storage";

describe("durable storage", () => {
  beforeEach(async () => {
    await flushPendingStateWrites();
    localStorage.clear();
    invoke.mockReset();
  });

  it("hydrates local state from the native database", async () => {
    invoke.mockResolvedValueOnce({ theme: "kiwi" });
    await hydrateNativeStorage(["kiwi.settings"]);
    expect(loadStored("kiwi.settings", {})).toEqual({ theme: "kiwi" });
  });

  it("keeps per-thread model choices in durable storage", () => {
    expect(DURABLE_STORAGE_KEYS).toContain("kiwi.threadModels");
  });

  it("hydrates frozen child-agent ownership state before the app mounts", () => {
    expect(DURABLE_STORAGE_KEYS).toContain("kiwi.childAgentPolicies");
    expect(DURABLE_STORAGE_KEYS).toContain("kiwi.childAgentLinks");
  });

  it("migrates legacy localStorage when SQLite is empty", async () => {
    localStorage.setItem("kiwi.projects", JSON.stringify([{ id: "one" }]));
    invoke.mockResolvedValueOnce(null).mockResolvedValueOnce(undefined);
    await hydrateNativeStorage(["kiwi.projects"]);
    // Hydration now also stamps kiwi.schemaVersion afterwards, so assert the
    // migration write happened rather than that it was last.
    expect(invoke).toHaveBeenCalledWith("state_write", {
      key: "kiwi.projects",
      value: [{ id: "one" }],
    });
  });

  it("replays a cache write that was still pending when the app closed", async () => {
    localStorage.setItem("kiwi.settings", JSON.stringify({ theme: "newer-cache" }));
    localStorage.setItem("kiwi.nativePending.kiwi.settings", "previous-session");
    invoke.mockResolvedValue(undefined);

    await hydrateNativeStorage(["kiwi.settings"]);

    expect(loadStored("kiwi.settings", {})).toEqual({ theme: "newer-cache" });
    expect(invoke).toHaveBeenCalledWith("state_write", {
      key: "kiwi.settings",
      value: { theme: "newer-cache" },
    });
    expect(localStorage.getItem("kiwi.nativePending.kiwi.settings")).toBeNull();
    expect(invoke).not.toHaveBeenCalledWith("state_read", { key: "kiwi.settings" });
  });

  it("stamps the storage schema version after hydration", async () => {
    invoke.mockResolvedValue(null);
    await hydrateNativeStorage(["kiwi.settings"]);
    expect(loadStored("kiwi.schemaVersion", 0)).toBe(STORAGE_SCHEMA_VERSION);
  });

  it("writes both the immediate cache and durable store", async () => {
    invoke.mockResolvedValue(undefined);
    storeValue("kiwi.workspaceMode", "projects");
    expect(localStorage.getItem("kiwi.workspaceMode")).toBe('"projects"');
    expect(invoke).toHaveBeenCalledWith("state_write", {
      key: "kiwi.workspaceMode",
      value: "projects",
    });
    await flushPendingStateWrites();
  });

  it("serializes native writes for the same key", async () => {
    const releases: Array<() => void> = [];
    invoke.mockImplementation(() => new Promise<void>((resolve) => releases.push(resolve)));

    storeValue("kiwi.settings", { value: 1 });
    storeValue("kiwi.settings", { value: 2 });
    expect(invoke).toHaveBeenCalledTimes(1);

    releases.shift()?.();
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledTimes(2));
    releases.shift()?.();
    await flushPendingStateWrites();
    expect(invoke.mock.calls.map(([, payload]) => payload)).toEqual([
      { key: "kiwi.settings", value: { value: 1 } },
      { key: "kiwi.settings", value: { value: 2 } },
    ]);
  });

  it("orders a durable delete after an in-flight write", async () => {
    const releases: Array<() => void> = [];
    invoke.mockImplementation(() => new Promise<void>((resolve) => releases.push(resolve)));

    storeValue("kiwi.usageLedger", [{ threadId: "one" }]);
    removeStoredValue("kiwi.usageLedger");
    expect(localStorage.getItem("kiwi.usageLedger")).toBeNull();
    expect(invoke).toHaveBeenCalledTimes(1);

    releases.shift()?.();
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledTimes(2));
    expect(invoke).toHaveBeenLastCalledWith("state_delete", { key: "kiwi.usageLedger" });
    releases.shift()?.();
    await flushPendingStateWrites();
  });
});
