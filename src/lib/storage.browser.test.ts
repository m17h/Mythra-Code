import { afterEach, expect, it } from "vitest";
import { isTauri } from "@tauri-apps/api/core";
import { flushPendingStateWrites, loadStored, removeStoredValue, resetStorageMemoryForTests, storeValue } from "./storage";

afterEach(() => {
  resetStorageMemoryForTests();
  localStorage.clear();
});

it("keeps the real browser cache usable when Tauri IPC is unavailable", async () => {
  expect(isTauri()).toBe(false);
  storeValue("kiwi.settings", { model: "browser draft" });
  await expect(flushPendingStateWrites()).resolves.toBeUndefined();
  expect(loadStored("kiwi.settings", {})).toEqual({ model: "browser draft" });
  removeStoredValue("kiwi.settings");
  await expect(flushPendingStateWrites()).resolves.toBeUndefined();
  expect(loadStored("kiwi.settings", "absent")).toBe("absent");
});
