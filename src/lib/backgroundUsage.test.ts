import { beforeEach, describe, expect, it, vi } from "vitest";
// @ts-expect-error Node built-in types are unavailable to the frontend compiler.
import { readFileSync } from "node:fs";
const mocks = vi.hoisted(() => ({ listen: vi.fn(), record: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: mocks.listen }));
vi.mock("./usageLedger", () => ({ recordAuxiliaryUsage: mocks.record }));
import { BACKGROUND_USAGE_EVENT, parseBackgroundUsageEvent, recordBackgroundUsage, subscribeBackgroundUsage } from "./backgroundUsage";
const nativeExportPath = (globalThis as unknown as { process: { env: Record<string, string | undefined> } }).process.env.MYTHRA_BACKGROUND_USAGE_EXPORT;

const fixture = () => ({
  executionId: "a625906b-6a78-42a2-a9e8-ef7df98aa857", provider: "openai", model: "gpt-6-luna", modelSource: "requested",
  purpose: "thread-title", serviceTier: "priority", serviceTierSource: "requested", requestedServiceTier: "priority", outcome: "completed",
  tokenAvailability: "partial", usage: { inputTokens: 24763, cachedInputTokens: 24448, cacheWriteInputTokens: null,
    cacheWrite1hInputTokens: null, outputTokens: 122, reasoningOutputTokens: 0, totalTokens: 24885 }, reportedCost: null,
});
beforeEach(() => { mocks.listen.mockReset(); mocks.record.mockReset().mockReturnValue(true); });

describe("background helper usage metadata", () => {
  it("keeps the CLI's missing cache writes unknown and requested Fast estimated", () => {
    expect(recordBackgroundUsage(fixture())).toBe(true);
    expect(mocks.record).toHaveBeenCalledWith(expect.objectContaining({ executionId: fixture().executionId, purpose: "thread-title",
      serviceTierSource: "requested", requestedServiceTier: "priority", reportedCost: undefined,
      usage: expect.objectContaining({ inputTokens: 24763, cachedInputTokens: 24448, cacheReadReported: true, cacheWriteReported: false,
        cacheWriteInputTokens: 0, tokenAvailability: "partial" }) }));
  });
  it("counts an actual execution with unavailable tokens without inventing usage", () => {
    const value = { ...fixture(), provider: "cursor", serviceTier: null, serviceTierSource: "unknown", requestedServiceTier: null,
      tokenAvailability: "unavailable", usage: null, outcome: "failed" };
    expect(recordBackgroundUsage(value)).toBe(true);
    expect(mocks.record).toHaveBeenCalledWith(expect.objectContaining({ provider: "cursor", usage: null, tokenAvailability: "unavailable" }));
  });
  it("retains actual Claude model and reported cost even after a failed result", () => {
    recordBackgroundUsage({ ...fixture(), provider: "claude", model: "claude-opus-5-5", modelSource: "reported", outcome: "failed", reportedCost: 0.015 });
    expect(mocks.record).toHaveBeenCalledWith(expect.objectContaining({ model: "claude-opus-5-5", modelSource: "reported", reportedCost: 0.015 }));
  });
  it("does not discard reported cache-only partial counters", () => {
    const value = fixture();
    value.usage.inputTokens = null as unknown as number;
    value.usage.cachedInputTokens = 42;
    value.usage.outputTokens = null as unknown as number;
    value.usage.totalTokens = null as unknown as number;
    recordBackgroundUsage(value);
    expect(mocks.record).toHaveBeenCalledWith(expect.objectContaining({ usage: expect.objectContaining({ inputTokens: 42, cachedInputTokens: 42, tokenAvailability: "partial" }) }));
  });
  it("retains cache1h-only metrics as a lower bound, never reported total cache writes", () => {
    recordBackgroundUsage({ ...fixture(), provider: "claude", usage: { inputTokens: null, cachedInputTokens: null,
      cacheWriteInputTokens: null, cacheWrite1hInputTokens: 2, outputTokens: null, reasoningOutputTokens: null, totalTokens: null } });
    expect(mocks.record).toHaveBeenCalledWith(expect.objectContaining({ usage: expect.objectContaining({ inputTokens: 2,
      cacheWriteInputTokens: 2, cacheWrite1hInputTokens: 2, cacheReadReported: false, cacheWriteReported: false, tokenAvailability: "partial" }) }));
  });
  it("retains reasoning-only output as a partial lower bound", () => {
    recordBackgroundUsage({ ...fixture(), usage: { inputTokens: null, cachedInputTokens: null,
      cacheWriteInputTokens: null, cacheWrite1hInputTokens: null, outputTokens: null, reasoningOutputTokens: 25, totalTokens: null } });
    expect(mocks.record).toHaveBeenCalledWith(expect.objectContaining({ usage: expect.objectContaining({ outputTokens: 25,
      reasoningOutputTokens: 25, totalTokens: 25, tokenAvailability: "partial" }) }));
  });
  it.runIf(Boolean(nativeExportPath))("validates actual native serialized partial and unavailable receipts", () => {
    const values = JSON.parse(readFileSync(nativeExportPath!, "utf8")) as { label: string; event: unknown }[];
    expect(values).toHaveLength(6);
    for (const value of values) {
      expect(parseBackgroundUsageEvent(value.event), value.label).not.toBeNull();
      expect(recordBackgroundUsage(value.event), value.label).toBe(true);
    }
    expect(mocks.record.mock.calls[0][0]).toMatchObject({ tokenAvailability: "partial", reportedCost: 0.1,
      usage: { inputTokens: 400, cachedInputTokens: 300, outputTokens: 20, totalTokens: 420, tokenAvailability: "partial" } });
    expect(mocks.record.mock.calls[1][0]).toMatchObject({ tokenAvailability: "partial", usage: { outputTokens: 25, reasoningOutputTokens: 25 } });
    expect(mocks.record.mock.calls[2][0]).toMatchObject({ tokenAvailability: "partial", usage: { inputTokens: 2, cacheWriteInputTokens: 2,
      cacheWrite1hInputTokens: 2, cacheWriteReported: false } });
    expect(mocks.record.mock.calls[3][0]).toMatchObject({ tokenAvailability: "unavailable", usage: null });
    expect(mocks.record.mock.calls[4][0]).toMatchObject({ tokenAvailability: "reported", model: "claude-opus-5-5", reportedCost: 0.125 });
    expect(mocks.record.mock.calls[5][0]).toMatchObject({ tokenAvailability: "unavailable", usage: null, reportedCost: 0.1 });
  });
  it("keeps mixed-terminal partial evidence even when every merged category is present", () => {
    const value = fixture(); value.usage.cacheWriteInputTokens = 0 as unknown as null;
    expect(recordBackgroundUsage(value)).toBe(true);
    expect(mocks.record).toHaveBeenCalledWith(expect.objectContaining({ usage: expect.objectContaining({ tokenAvailability: "partial" }) }));
  });
  it.each([
    { executionId: "retry" }, { provider: "gemini" }, { model: "secret\nbody" }, { model: "x".repeat(161) },
    { purpose: "arbitrary-body" }, { tokenAvailability: "reported" }, { serviceTierSource: "unknown" },
    { outcome: "success" }, { reportedCost: Infinity }, { prompt: "private prompt must never enter ledger" },
    { stderr: "Bearer credential must not enter ledger" }, { usage: { ...fixture().usage, inputTokens: -1 } },
    { usage: { ...fixture().usage, outputTokens: Number.MAX_SAFE_INTEGER + 1 } },
    { usage: { ...fixture().usage, cachedInputTokens: 24764 } },
    { usage: { ...fixture().usage, cacheWriteInputTokens: 0, cacheWrite1hInputTokens: 2 } },
    { usage: { ...fixture().usage, outputTokens: 0, reasoningOutputTokens: 25 } },
  ])("rejects malformed or content-bearing payload %j", (patch) => {
    expect(parseBackgroundUsageEvent({ ...fixture(), ...patch })).toBeNull();
    expect(recordBackgroundUsage({ ...fixture(), ...patch })).toBe(false);
    expect(mocks.record).not.toHaveBeenCalled();
  });
  it("delegates unchanged IDs to durable dedup, while real retries get separate IDs", () => {
    const seen = new Set<string>();
    mocks.record.mockImplementation(({ executionId }: { executionId: string }) => !seen.has(executionId) && Boolean(seen.add(executionId)));
    expect(recordBackgroundUsage(fixture())).toBe(true);
    expect(recordBackgroundUsage(fixture())).toBe(false);
    expect(recordBackgroundUsage({ ...fixture(), executionId: "c9a631c6-2437-4ea0-a8c3-c5f5c4634f1a" })).toBe(true);
  });
});

describe("background usage subscription", () => {
  it("disposes a pending registration and suppresses StrictMode stale callbacks", async () => {
    let resolve!: (stop: () => void) => void;
    mocks.listen.mockReturnValue(new Promise<() => void>((done) => { resolve = done; }));
    const stop = vi.fn();
    const dispose = subscribeBackgroundUsage();
    expect(mocks.listen).toHaveBeenCalledWith(BACKGROUND_USAGE_EVENT, expect.any(Function));
    dispose(); dispose();
    mocks.listen.mock.calls[0][1]({ payload: fixture() });
    resolve(stop);
    await Promise.resolve();
    expect(stop).toHaveBeenCalledOnce();
    expect(mocks.record).not.toHaveBeenCalled();
  });
  it("records live events and cleans up once", async () => {
    const stop = vi.fn(); mocks.listen.mockResolvedValue(stop);
    const dispose = subscribeBackgroundUsage(); await Promise.resolve();
    mocks.listen.mock.calls[0][1]({ payload: fixture() });
    expect(mocks.record).toHaveBeenCalledOnce();
    dispose(); dispose(); expect(stop).toHaveBeenCalledOnce();
  });
  it("reports listener failures without exposing raw errors", async () => {
    mocks.listen.mockRejectedValue(new Error("private diagnostic"));
    const error = vi.fn(); subscribeBackgroundUsage(error);
    await Promise.resolve(); await Promise.resolve();
    expect(error).toHaveBeenCalledExactlyOnceWith();
  });
  it("contains ingestion exceptions and never forwards private diagnostic bodies", async () => {
    mocks.listen.mockResolvedValue(vi.fn()); mocks.record.mockImplementation(() => { throw new Error("private diagnostic"); });
    const error = vi.fn(); subscribeBackgroundUsage(error); await Promise.resolve();
    expect(() => mocks.listen.mock.calls[0][1]({ payload: fixture() })).not.toThrow();
    expect(error).toHaveBeenCalledExactlyOnceWith();
  });
});
