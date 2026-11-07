// Regression checks for preferences which also affect ordinary local sends.
import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_SETTINGS } from "../appConfig.ts";
import { sharedThreadPreferences, wireServiceTier, withoutHostPreference } from "./host/executionPreferences.ts";
import { turnStartParams } from "../turnConfig.ts";
import { resetTaskStore, useTaskStore } from "../taskStore.ts";
import { reconcilePendingRequests } from "./host/pendingRequests.ts";

const turnTier = (prefs) => {
  const settings = { ...DEFAULT_SETTINGS, serviceTier: null, ...sharedThreadPreferences(DEFAULT_SETTINGS, prefs) };
  return turnStartParams(settings, "local-thread", "/local-project", []).serviceTier;
};

test("a wire Fast preference uses the existing native priority tier for a local send", () => {
  assert.equal(turnTier({ serviceTier: "fast" }), "priority");
});

test("an untouched local Fast preference retains its provider bytes", () => {
  const settings = { ...DEFAULT_SETTINGS, serviceTier: "priority" };
  const shared = sharedThreadPreferences(settings, {});
  assert.equal(turnStartParams({ ...settings, ...shared }, "local-thread", "/local-project", []).serviceTier, "priority");
});

test("a saved standard choice turns local Fast off for that thread only", () => {
  const settings = { ...DEFAULT_SETTINGS, serviceTier: "priority" };
  assert.equal(sharedThreadPreferences(settings, { serviceTier: "standard" }).serviceTier, null);
  assert.equal(sharedThreadPreferences(settings, {}).serviceTier, "priority");
});

test("turning Fast off here wins over a saved remote Fast, and keeps its other choices", () => {
  const saved = { thread: { serviceTier: "fast", permission: "read-only" }, other: { serviceTier: "fast" } };
  const settings = { ...DEFAULT_SETTINGS, serviceTier: null };
  assert.equal(sharedThreadPreferences(settings, saved.thread).serviceTier, "priority");
  const next = withoutHostPreference(saved, "thread", "serviceTier");
  assert.equal(sharedThreadPreferences(settings, next.thread).serviceTier, null);
  assert.equal(next.thread.permission, "read-only");
  assert.equal(next.other.serviceTier, "fast");
});

test("the other device sees the real tier, in its own words", () => {
  assert.equal(wireServiceTier("priority"), "fast");
  assert.equal(wireServiceTier(null), "standard");
  assert.equal(wireServiceTier("flex"), "standard");
});

for (const failure of ["incomplete", "IPC error"]) {
  test(`an ${failure} remote inventory does not erase a live local approval`, async () => {
    resetTaskStore();
    const approval = { id: "local-approval", threadId: "local-thread", receivedAt: Date.now(),
      method: "item/commandExecution/requestApproval", params: { command: "echo local" } };
    useTaskStore.getState().enqueueApproval(approval);
    const ready = await reconcilePendingRequests(1, () => true, async () => {
      if (failure === "IPC error") throw new Error("transient failure");
      return { complete: false, requests: [] };
    });
    assert.equal(ready, false);
    assert.equal(useTaskStore.getState().tasks["local-thread"].approvals.length, 1);
    resetTaskStore();
  });
}
