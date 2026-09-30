import { beforeEach, describe, expect, it, vi } from "vitest";

const { invoke, listen } = vi.hoisted(() => ({
  invoke: vi.fn(),
  listen: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen }));

import { onCodexEvent, respond, rpc } from "./codex";
import { resetUsageLedgerCache, recordCumulativeUsage, providerUsageTotals, usageForThread, reportThreadServiceTier } from "./usageLedger";

describe("Codex event subscriptions", () => {
  beforeEach(() => {
    invoke.mockReset();
    listen.mockReset();
    resetUsageLedgerCache();
    localStorage.clear();
  });

  it("carries question identity across the native response bridge", async () => {
    const expected = { method: "item/tool/requestUserInput", threadId: "thread", turnId: "turn", itemId: "item" };
    await respond(42, { answers: {} }, expected);
    expect(invoke).toHaveBeenCalledWith("codex_respond", { id: 42, result: { answers: {} }, expected });
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

  it("records requested tiers without asserting an actual served tier and clears the previous turn", async () => {
    invoke.mockResolvedValue({ thread: { id: "thread", modelProvider: "openai" } });
    await rpc("thread/start", { model: "gpt-6-sol", modelProvider: "openai" });
    await rpc("turn/start", { threadId: "thread", model: "gpt-6-sol", serviceTier: "priority" });
    expect(usageForThread("thread")).toMatchObject({ requestedServiceTier: "fast", reportedServiceTier: undefined });
    reportThreadServiceTier("thread", "fast");
    await rpc("turn/start", { threadId: "thread", model: "gpt-6-sol", serviceTier: null });
    expect(usageForThread("thread")).toMatchObject({ requestedServiceTier: "standard", reportedServiceTier: undefined });
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
