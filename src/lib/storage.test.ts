import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));

vi.mock("@tauri-apps/api/core", () => ({ invoke }));

import { DURABLE_STORAGE_KEYS, STORAGE_SCHEMA_VERSION, resetStorageMemoryForTests, flushPendingStateWrites, hydrateNativeStorage, loadStored, migrateStorage, removeStoredValue, storeValue } from "./storage";

describe("durable storage", () => {
  afterEach(resetStorageMemoryForTests);
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
    expect(DURABLE_STORAGE_KEYS).toContain("kiwi.threadReasoning");
  });

  it("removes legacy bundled prompt profiles without deleting user profiles or active prompt text", async () => {
    localStorage.setItem("kiwi.schemaVersion", "13");
    localStorage.setItem("kiwi.promptProfiles", JSON.stringify([
      { id: "concise", name: "Concise builder", prompt: "Bundled", builtIn: true },
      { id: "mine", name: "Mine", prompt: "User prompt" },
    ]));
    localStorage.setItem("kiwi.settings", JSON.stringify({ promptProfileId: "concise", systemPrompt: "Keep this active text" }));
    invoke.mockResolvedValue(undefined);

    migrateStorage();

    expect(loadStored("kiwi.promptProfiles", [])).toEqual([{ id: "mine", name: "Mine", prompt: "User prompt" }]);
    expect(loadStored<Record<string, unknown>>("kiwi.settings", {})).toMatchObject({ promptProfileId: "", systemPrompt: "Keep this active text" });
    await flushPendingStateWrites();
  });

  it("hydrates frozen child-agent ownership state before the app mounts", () => {
    expect(DURABLE_STORAGE_KEYS).toContain("kiwi.childAgentPolicies");
    expect(DURABLE_STORAGE_KEYS).toContain("kiwi.childAgentLinks");
    expect(DURABLE_STORAGE_KEYS).toContain("kiwi.threadSubagentCapabilities");
  });

  it("clears legacy cumulative context pressure without losing usage history", async () => {
    localStorage.setItem("kiwi.schemaVersion", "15");
    localStorage.setItem("kiwi.usageLedger", JSON.stringify([{
      threadId: "thread-1",
      usage: { totalTokens: 500_000, inputTokens: 480_000, outputTokens: 20_000, contextTokens: 500_000, contextWindow: 200_000 },
      cumulativeSnapshot: { totalTokens: 500_000, inputTokens: 480_000, outputTokens: 20_000, contextTokens: 500_000, contextWindow: 200_000 },
      estimatedCost: 4.25,
      updatedAt: 1,
    }]));
    invoke.mockResolvedValue(undefined);

    migrateStorage();

    const records = loadStored<Array<Record<string, unknown>>>("kiwi.usageLedger", []);
    expect(records[0]).toMatchObject({ threadId: "thread-1", estimatedCost: 4.25 });
    expect(records[0].usage).toMatchObject({ totalTokens: 500_000, contextWindow: 200_000 });
    expect(records[0].usage).not.toHaveProperty("contextTokens");
    expect(records[0].cumulativeSnapshot).not.toHaveProperty("contextTokens");
    await flushPendingStateWrites();
  });

  it("compacts legacy sidebar metadata without touching canonical transcripts", async () => {
    const preview = "🧠".repeat(400);
    localStorage.setItem("kiwi.schemaVersion", "19");
    localStorage.setItem("kiwi.knownThreads", JSON.stringify({
      thread: { id: "thread", preview, turns: [{ id: "turn", items: [{ text: "canonical" }] }] },
    }));
    invoke.mockResolvedValue(undefined);

    migrateStorage();

    const stored = loadStored<Record<string, Record<string, unknown>>>("kiwi.knownThreads", {});
    expect(Array.from(String(stored.thread.preview))).toHaveLength(320);
    expect(stored.thread).not.toHaveProperty("turns");
    await flushPendingStateWrites();
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

function failCacheWrites() {
  const setItem = localStorage.setItem.bind(localStorage);
  vi.spyOn(localStorage, "setItem").mockImplementation((key, value) => {
    if (key === "kiwi.projects") throw new DOMException("full", "QuotaExceededError");
    setItem(key, value);
  });
}

describe("storage quota recovery", () => {
  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem("kiwi.schemaVersion", String(STORAGE_SCHEMA_VERSION));
    invoke.mockReset();
  });
  afterEach(async () => {
    await flushPendingStateWrites();
    resetStorageMemoryForTests();
  });
  it("reads native state even when hydration cannot update the cache", async () => {
    localStorage.setItem("kiwi.projects", '[{"id":"stale"}]');
    failCacheWrites();
    invoke.mockResolvedValue([{ id: "durable" }]);
    await hydrateNativeStorage(["kiwi.projects"]);
    expect(loadStored("kiwi.projects", [])).toEqual([{ id: "durable" }]);
  });
  it("does not mark a failed cache write for replay, and still reads the new value", async () => {
    localStorage.setItem("kiwi.projects", '[{"id":"stale"}]');
    localStorage.setItem("kiwi.nativePending.kiwi.projects", "older-write");
    failCacheWrites();
    invoke.mockRejectedValue(new Error("database unavailable"));
    storeValue("kiwi.projects", [{ id: "latest" }]);
    expect(loadStored("kiwi.projects", [])).toEqual([{ id: "latest" }]);
    expect(localStorage.getItem("kiwi.nativePending.kiwi.projects")).toBeNull();
    await flushPendingStateWrites();
    resetStorageMemoryForTests();
    invoke.mockReset().mockResolvedValue([{ id: "durable" }]);
    await hydrateNativeStorage(["kiwi.projects"]);
    expect(invoke).not.toHaveBeenCalledWith("state_write", expect.anything());
    expect(loadStored("kiwi.projects", [])).toEqual([{ id: "durable" }]);
  });
  it("hydrates even when cache reads are unavailable", async () => {
    vi.spyOn(localStorage, "getItem").mockImplementation(() => { throw new Error("unavailable"); });
    vi.spyOn(localStorage, "setItem").mockImplementation(() => { throw new Error("unavailable"); });
    invoke.mockImplementation(async (method, args) => method === "state_read" && args.key === "kiwi.projects" ? [{ id: "durable" }] : null);
    await hydrateNativeStorage(["kiwi.projects"]);
    expect(loadStored("kiwi.projects", [])).toEqual([{ id: "durable" }]);
  });
  it("snapshots mutable values before their native write is queued", async () => {
    let release!: () => void;
    invoke.mockImplementationOnce(() => new Promise<void>((resolve) => { release = resolve; })).mockResolvedValue(undefined);
    storeValue("kiwi.projects", []);
    const value = [{ id: "saved" }];
    storeValue("kiwi.projects", value);
    value[0].id = "later-mutation";
    release();
    await flushPendingStateWrites();
    expect(invoke).toHaveBeenLastCalledWith("state_write", { key: "kiwi.projects", value: [{ id: "saved" }] });
  });
});
