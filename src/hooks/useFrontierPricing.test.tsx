import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useFrontierPricing } from "./useFrontierPricing";
import { recordOfficialPricingResult } from "../lib/officialPricing";
import { resetStorageMemoryForTests } from "../lib/storage";
import { resetUsageLedgerCache } from "../lib/usageLedger";

beforeEach(() => {
  localStorage.clear();
  resetStorageMemoryForTests();
  resetUsageLedgerCache();
});
afterEach(() => vi.useRealTimers());

it("reads cached evidence, receives refresh events and does not fetch on settings mount", () => {
  const fetcher = vi.spyOn(globalThis, "fetch");
  const { result, unmount } = renderHook(useFrontierPricing);
  expect(result.current.entries).toEqual([]);
  act(() => recordOfficialPricingResult("openai", { ok: true, models: {
    "gpt-6.1-sol": { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5, asOf: "2026-10-09" },
  } }, Date.parse("2026-10-09T12:00:00Z")));
  expect(result.current.entries[0]).toMatchObject({ id: "gpt-6.1-sol", cacheWriteInputPerMillion: 2.5 });
  expect(fetcher).not.toHaveBeenCalled();
  unmount();
  fetcher.mockRestore();
});

it("rechecks clock trust while mounted without changing saved rates or fetching", () => {
  vi.useFakeTimers();
  const now = Date.parse("2026-10-09T12:00:00Z");
  const savedAt = now + 10 * 60_000;
  vi.setSystemTime(savedAt);
  recordOfficialPricingResult("openai", { ok: true, models: {
    "gpt-6-sol": { input: 2, output: 10, asOf: "2026-10-09" },
  } }, savedAt);
  const storedBefore = localStorage.getItem("kiwi.officialModelPricing");
  const fetcher = vi.spyOn(globalThis, "fetch");
  const { result, unmount } = renderHook(useFrontierPricing);
  const status = () => result.current.providers.find((provider) => provider.provider === "openai")!;
  expect(status().verificationTimeUncertain).toBe(false);
  act(() => { vi.setSystemTime(now); vi.advanceTimersByTime(60_000); });
  expect(status().verificationTimeUncertain).toBe(true);
  expect(result.current.entries[0]).toMatchObject({ id: "gpt-6-sol", inputPerMillion: 2 });
  act(() => { vi.setSystemTime(savedAt); vi.advanceTimersByTime(60_000); });
  expect(status().verificationTimeUncertain).toBe(false);
  expect(localStorage.getItem("kiwi.officialModelPricing")).toBe(storedBefore);
  expect(fetcher).not.toHaveBeenCalled();
  unmount();
  expect(vi.getTimerCount()).toBe(0);
});
