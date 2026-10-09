import { afterEach, beforeEach, expect, it, vi } from "vitest";

const native = vi.hoisted(() => ({ invoke: vi.fn(), isTauri: vi.fn(() => true) }));
vi.mock("@tauri-apps/api/core", () => native);
import { flushPendingStateWrites, hydrateNativeStorage, loadStored, removeStoredValue, resetStorageMemoryForTests, storeValue } from "./storage";
import { flushBeforeClose } from "../hooks/useFlushOnClose";

beforeEach(() => {
  resetStorageMemoryForTests(); localStorage.clear();
  native.invoke.mockReset().mockResolvedValue(undefined); native.isTauri.mockReturnValue(true);
});
afterEach(async () => {
  native.invoke.mockResolvedValue(undefined);
  await flushPendingStateWrites(); resetStorageMemoryForTests();
});

it("rejects a close flush after a completed native failure and retries on the next close", async () => {
  native.invoke.mockRejectedValue(new Error("disk full"));
  storeValue("kiwi.settings", { model: "latest" });
  await Promise.resolve(); await Promise.resolve();
  await expect(flushBeforeClose([flushPendingStateWrites])).rejects.toThrow("kiwi.settings");
  expect(loadStored("kiwi.settings", {})).toEqual({ model: "latest" });
  const attempts = native.invoke.mock.calls.length;
  native.invoke.mockResolvedValue(undefined);
  await expect(flushBeforeClose([flushPendingStateWrites])).resolves.toBeUndefined();
  expect(native.invoke.mock.calls.length).toBe(attempts + 1);
  expect(localStorage.getItem("kiwi.nativePending.kiwi.settings")).toBeNull();
});

it("retains the newest immutable value when both caches cannot save", async () => {
  vi.spyOn(localStorage, "setItem").mockImplementation(() => { throw new Error("quota full"); });
  native.invoke.mockRejectedValue(new Error("disk full"));
  const value = { name: "first" };
  storeValue("kiwi.projects", [value]); value.name = "mutated";
  storeValue("kiwi.projects", [{ name: "newest" }]);
  await expect(flushPendingStateWrites()).rejects.toThrow("kiwi.projects");
  expect(loadStored("kiwi.projects", [])).toEqual([{ name: "newest" }]);
  native.invoke.mockResolvedValue(undefined);
  await flushPendingStateWrites();
  expect(native.invoke).toHaveBeenLastCalledWith("state_write", { key: "kiwi.projects", value: [{ name: "newest" }] });
});

it("retries a deletion without replaying an older failed write", async () => {
  native.invoke.mockRejectedValue(new Error("database unavailable"));
  storeValue("kiwi.settings", { secret: "old" });
  removeStoredValue("kiwi.settings");
  await expect(flushPendingStateWrites()).rejects.toThrow("kiwi.settings");
  expect(loadStored("kiwi.settings", "missing")).toBe("missing");
  const attempts = native.invoke.mock.calls.length;
  native.invoke.mockResolvedValue(undefined);
  await flushPendingStateWrites();
  expect(native.invoke.mock.calls.slice(attempts)).toEqual([["state_delete", { key: "kiwi.settings" }]]);
});

it("settles independent keys even when one remains unsaved", async () => {
  native.invoke.mockImplementation(async (_command, args) => {
    if (args.key === "kiwi.settings") throw new Error("private database path");
  });
  storeValue("kiwi.settings", { model: "unsaved" }); storeValue("kiwi.projects", []);
  await expect(flushPendingStateWrites()).rejects.toThrow("kiwi.settings");
  expect(localStorage.getItem("kiwi.nativePending.kiwi.projects")).toBeNull();
  await expect(flushPendingStateWrites()).rejects.not.toThrow("private database path");
});

it("retains failed startup recovery for the existing close guard", async () => {
  localStorage.setItem("kiwi.settings", '{"model":"recover me"}');
  localStorage.setItem("kiwi.nativePending.kiwi.settings", "previous-session");
  native.invoke.mockImplementation(async (command) => {
    if (command === "state_write") throw new Error("disk full");
    return null;
  });
  await hydrateNativeStorage(["kiwi.settings"]);
  await expect(flushPendingStateWrites()).rejects.toThrow("kiwi.settings");
  native.invoke.mockResolvedValue(undefined); await flushPendingStateWrites();
  expect(localStorage.getItem("kiwi.nativePending.kiwi.settings")).toBeNull();
});

it("keeps browser-only development usable without a native store", async () => {
  native.isTauri.mockReturnValue(false);
  native.invoke.mockRejectedValue(new Error("no native IPC"));
  storeValue("kiwi.settings", { model: "web" });
  await expect(flushPendingStateWrites()).resolves.toBeUndefined();
  expect(loadStored("kiwi.settings", {})).toEqual({ model: "web" });
});

it("does not let an outstanding hydration read replace a newer saved revision", async () => {
  localStorage.setItem("kiwi.schemaVersion", "29");
  let release!: (value: string) => void;
  const oldRead = new Promise<string>((resolve) => { release = resolve; });
  native.invoke.mockImplementation(async (command) => command === "state_read_raw" ? oldRead : undefined);
  const hydration = hydrateNativeStorage(["kiwi.settings"]);
  storeValue("kiwi.settings", { model: "newest" });
  await flushPendingStateWrites();
  release('{"model":"old native"}');
  await hydration;
  expect(loadStored("kiwi.settings", {})).toEqual({ model: "newest" });
});

it("does not replay old recovery data collected before another hydration read completes", async () => {
  localStorage.setItem("kiwi.schemaVersion", "29");
  localStorage.setItem("kiwi.settings", '{"model":"old cache"}');
  localStorage.setItem("kiwi.nativePending.kiwi.settings", "previous-session");
  let release!: (value: unknown) => void;
  const slowRead = new Promise<unknown>((resolve) => { release = resolve; });
  native.invoke.mockImplementation(async (command) => command === "state_read" ? slowRead : undefined);
  const hydration = hydrateNativeStorage(["kiwi.settings", "kiwi.drafts"]);
  storeValue("kiwi.settings", { model: "newest" });
  await flushPendingStateWrites();
  release(null);
  await hydration;
  const writes = native.invoke.mock.calls.filter(([command, args]) => command === "state_write" && args.key === "kiwi.settings");
  expect(writes).toEqual([["state_write", { key: "kiwi.settings", value: { model: "newest" } }]]);
});

it("shares concurrent flushes while including writes added during a retry", async () => {
  let release!: () => void;
  const retry = new Promise<void>((resolve) => { release = resolve; });
  native.invoke.mockRejectedValueOnce(new Error("disk full")).mockImplementation(() => retry);
  storeValue("kiwi.settings", { model: "old" });
  await Promise.resolve(); await Promise.resolve();
  const first = flushPendingStateWrites();
  const second = flushPendingStateWrites();
  for (let index = 0; index < 12; index += 1) await Promise.resolve();
  expect(native.invoke.mock.calls.filter(([command, args]) => command === "state_write" && args.value.model === "old")).toHaveLength(2);
  storeValue("kiwi.settings", { model: "newest" });
  storeValue("kiwi.projects", []);
  native.invoke.mockResolvedValue(undefined);
  release();
  await Promise.all([first, second]);
  expect(native.invoke.mock.calls.filter(([command, args]) => command === "state_write" && args.key === "kiwi.settings").at(-1))
    .toEqual(["state_write", { key: "kiwi.settings", value: { model: "newest" } }]);
  expect(localStorage.getItem("kiwi.nativePending.kiwi.settings")).toBeNull();
  expect(localStorage.getItem("kiwi.nativePending.kiwi.projects")).toBeNull();
});

it("retries the immutable captured payload even when its caller mutates it", async () => {
  native.invoke.mockRejectedValue(new Error("disk full"));
  const value = { model: "captured" };
  storeValue("kiwi.settings", value);
  value.model = "later caller mutation";
  await expect(flushPendingStateWrites()).rejects.toThrow("kiwi.settings");
  native.invoke.mockResolvedValue(undefined);
  await flushPendingStateWrites();
  expect(native.invoke).toHaveBeenLastCalledWith("state_write", { key: "kiwi.settings", value: { model: "captured" } });
});

it("migrates the newest startup state when a write arrives during recovery persistence", async () => {
  localStorage.setItem("kiwi.schemaVersion", "13");
  localStorage.setItem("kiwi.settings", '{"promptProfileId":"concise","systemPrompt":"old prompt"}');
  localStorage.setItem("kiwi.nativePending.kiwi.settings", "previous-session");
  let release!: () => void;
  const replay = new Promise<void>((resolve) => { release = resolve; });
  native.invoke.mockReturnValueOnce(replay).mockResolvedValue(undefined);
  const hydration = hydrateNativeStorage(["kiwi.settings"]);
  for (let index = 0; index < 12; index += 1) await Promise.resolve();
  storeValue("kiwi.settings", { promptProfileId: "mine", systemPrompt: "new prompt" });
  release();
  await hydration;
  await flushPendingStateWrites();
  expect(loadStored("kiwi.settings", {})).toEqual({ promptProfileId: "mine", systemPrompt: "new prompt" });
});
