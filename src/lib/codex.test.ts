import { beforeEach, describe, expect, it, vi } from "vitest";

const { invoke, listen } = vi.hoisted(() => ({
  invoke: vi.fn(),
  listen: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen }));

import { onCodexEvent, rpc } from "./codex";
import { resetUsageLedgerCache, recordCumulativeUsage, providerUsageTotals, usageForThread } from "./usageLedger";

describe("Codex event subscriptions", () => {
  beforeEach(() => {
    invoke.mockReset();
    listen.mockReset();
    resetUsageLedgerCache();
    localStorage.clear();
  });

  it("records background provider metadata before its first usage event", async () => {
    invoke.mockResolvedValueOnce({ thread: { id: "background", modelProvider: "openrouter" } });
    await rpc("thread/start", { modelProvider: "openrouter", model: "vendor/model", cwd: "/project" });
    recordCumulativeUsage("background", { totalTokens: 120, inputTokens: 100, outputTokens: 20, cachedInputTokens: 0, reasoningOutputTokens: 0, contextWindow: null });
    expect(providerUsageTotals()[0]).toMatchObject({ provider: "openrouter", totalTokens: 120 });
    invoke.mockResolvedValueOnce({});
    await rpc("turn/start", { threadId: "background", model: "vendor/new-model" });
    expect(usageForThread("background")?.model).toBe("vendor/new-model");
  });

  it("does not block a provider start when browser storage is unavailable", async () => {
    const getItem = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("Storage unavailable"); });
    invoke.mockResolvedValue({ thread: { id: "background", modelProvider: "openrouter" } });
    try {
      await expect(rpc("thread/start", { modelProvider: "openrouter", model: "vendor/model" })).resolves.toMatchObject({ thread: { id: "background" } });
    } finally { getItem.mockRestore(); }
  });

  it("cleans up the first listener when the batched listener cannot subscribe", async () => {
    const stopSingle = vi.fn();
    listen
      .mockResolvedValueOnce(stopSingle)
      .mockRejectedValueOnce(new Error("batched listener unavailable"));

    await expect(onCodexEvent(vi.fn())).rejects.toThrow("batched listener unavailable");
    expect(stopSingle).toHaveBeenCalledOnce();
  });

  it("cleans up both listeners after a successful subscription", async () => {
    const stopSingle = vi.fn();
    const stopBatched = vi.fn();
    listen.mockResolvedValueOnce(stopSingle).mockResolvedValueOnce(stopBatched);

    const stop = await onCodexEvent(vi.fn());
    stop();

    expect(stopSingle).toHaveBeenCalledOnce();
    expect(stopBatched).toHaveBeenCalledOnce();
  });
});
