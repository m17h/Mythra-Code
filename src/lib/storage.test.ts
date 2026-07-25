import { beforeEach, describe, expect, it, vi } from "vitest";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));

vi.mock("@tauri-apps/api/core", () => ({ invoke }));

import { DURABLE_STORAGE_KEYS, hydrateNativeStorage, loadStored, storeValue } from "./storage";

describe("durable storage", () => {
  beforeEach(() => {
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

  it("stamps the storage schema version after hydration", async () => {
    invoke.mockResolvedValue(null);
    await hydrateNativeStorage(["kiwi.settings"]);
    expect(loadStored("kiwi.schemaVersion", 0)).toBeGreaterThan(0);
  });

  it("writes both the immediate cache and durable store", () => {
    invoke.mockResolvedValue(undefined);
    storeValue("kiwi.workspaceMode", "projects");
    expect(localStorage.getItem("kiwi.workspaceMode")).toBe('"projects"');
    expect(invoke).toHaveBeenCalledWith("state_write", {
      key: "kiwi.workspaceMode",
      value: "projects",
    });
  });
});
