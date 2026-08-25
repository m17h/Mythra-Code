import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  forgetSubagentCapabilities,
  planSubagentCapabilities,
  recordSubagentCapabilities,
  seedSubagentCapabilities,
  subagentCapabilitySignature,
} from "./threadCapabilities";

const OFF = subagentCapabilitySignature({ subagentsEnabled: false, subagentMax: 1 });
const ON = subagentCapabilitySignature({ subagentsEnabled: true, subagentMax: 4 });
const BRIDGED = subagentCapabilitySignature({ subagentsEnabled: true, subagentMax: 4, bridgeInstanceId: "/bridge/one/mcp.json" });

/** The app-server process a record belongs to. */
const RUNTIME = "runtime-1";
const RESTARTED = "runtime-2";

const NOTHING = { restartRuntime: false, resume: false };
const RESUME_ONLY = { restartRuntime: false, resume: true };
const REFRESH = { restartRuntime: true, resume: true };

describe("subagentCapabilitySignature", () => {
  it("separates the three things a runtime thread has to be told", () => {
    expect(new Set([OFF, ON, BRIDGED]).size).toBe(3);
  });

  it("treats a nonsense limit as one rather than producing a new signature each turn", () => {
    expect(subagentCapabilitySignature({ subagentsEnabled: true, subagentMax: Number.NaN }))
      .toBe(subagentCapabilitySignature({ subagentsEnabled: true, subagentMax: 1 }));
    expect(subagentCapabilitySignature({ subagentsEnabled: true, subagentMax: 0 }))
      .toBe(subagentCapabilitySignature({ subagentsEnabled: true, subagentMax: 1 }));
  });

  it("ignores a parallel limit that cannot matter because sub-agents are off", () => {
    expect(subagentCapabilitySignature({ subagentsEnabled: false, subagentMax: 12 })).toBe(OFF);
  });
});

describe("planSubagentCapabilities", () => {
  beforeEach(() => forgetSubagentCapabilities());

  it("leaves an unknown pre-feature thread alone while it wants nothing special", () => {
    expect(planSubagentCapabilities("thread-1", RUNTIME, OFF)).toEqual(NOTHING);
  });

  it("refreshes an unknown loaded thread before granting sub-agent powers", () => {
    expect(planSubagentCapabilities("thread-1", RUNTIME, ON)).toEqual(REFRESH);
    expect(planSubagentCapabilities("thread-1", RUNTIME, BRIDGED)).toEqual(REFRESH);
  });

  it("stops asking once this runtime has been told", () => {
    recordSubagentCapabilities("thread-1", RUNTIME, ON);
    expect(planSubagentCapabilities("thread-1", RUNTIME, ON)).toEqual(NOTHING);
  });

  it("refreshes the runtime that is holding this thread with other capabilities", () => {
    recordSubagentCapabilities("thread-1", RUNTIME, ON);
    expect(planSubagentCapabilities("thread-1", RUNTIME, BRIDGED)).toEqual(REFRESH);
    expect(planSubagentCapabilities("thread-1", RUNTIME, OFF)).toEqual(REFRESH);
  });

  it("refreshes a thread recorded before the managed routing-policy revision", () => {
    recordSubagentCapabilities("thread-1", RUNTIME, "on:4:/bridge/one/mcp.json");
    expect(planSubagentCapabilities("thread-1", RUNTIME, BRIDGED)).toEqual(REFRESH);
  });

  it("only resumes when the app-server that held the thread has since been replaced", () => {
    // A restarted runtime has nothing loaded, so config applies on resume and
    // interrupting it again would cost the user a turn for no reason.
    recordSubagentCapabilities("thread-1", RUNTIME, ON);
    expect(planSubagentCapabilities("thread-1", RESTARTED, BRIDGED)).toEqual(RESUME_ONLY);
  });

  it("resumes a neutral thread after a restart so the replacement runtime loads it", () => {
    recordSubagentCapabilities("thread-1", RUNTIME, BRIDGED);
    expect(planSubagentCapabilities("thread-1", RESTARTED, OFF)).toEqual(RESUME_ONLY);
  });

  it("distinguishes a newly registered token file for the same policy", () => {
    recordSubagentCapabilities("thread-1", RUNTIME, BRIDGED);
    const replacement = subagentCapabilitySignature({
      subagentsEnabled: true,
      subagentMax: 4,
      bridgeInstanceId: "/bridge/two/mcp.json",
    });
    expect(planSubagentCapabilities("thread-1", RUNTIME, replacement)).toEqual(REFRESH);
  });

  it("tracks each thread separately", () => {
    recordSubagentCapabilities("thread-1", RUNTIME, ON);
    expect(planSubagentCapabilities("thread-2", RUNTIME, ON)).toEqual(REFRESH);
  });

  it("re-evaluates a thread whose runtime state was discarded", () => {
    recordSubagentCapabilities("thread-1", RUNTIME, ON);
    forgetSubagentCapabilities("thread-1");
    expect(planSubagentCapabilities("thread-1", RUNTIME, ON)).toEqual(REFRESH);
  });
});

describe("seedSubagentCapabilities", () => {
  beforeEach(() => forgetSubagentCapabilities());

  it("does not overwrite what the same runtime was already told", () => {
    // Opening a loaded thread resumes it, but that runtime ignores the config,
    // so the record it already holds is still the truthful one.
    recordSubagentCapabilities("thread-1", RUNTIME, BRIDGED);
    seedSubagentCapabilities("thread-1", RUNTIME, OFF);
    expect(planSubagentCapabilities("thread-1", RUNTIME, BRIDGED)).toEqual(NOTHING);
  });

  it("replaces a record left behind by an app-server that has since restarted", () => {
    // Opening the thread loaded it into the new runtime with exactly this
    // config, and the bridge the old record described is not registered there.
    recordSubagentCapabilities("thread-1", RUNTIME, BRIDGED);
    seedSubagentCapabilities("thread-1", RESTARTED, ON);
    expect(planSubagentCapabilities("thread-1", RESTARTED, ON)).toEqual(NOTHING);
    expect(planSubagentCapabilities("thread-1", RESTARTED, BRIDGED)).toEqual(REFRESH);
  });

  it("records a thread this runtime has never heard of", () => {
    seedSubagentCapabilities("thread-1", RUNTIME, ON);
    expect(planSubagentCapabilities("thread-1", RUNTIME, ON)).toEqual(NOTHING);
  });
});

/** A renderer reload re-evaluates the module against whatever it persisted. */
async function reloadModule(): Promise<typeof import("./threadCapabilities")> {
  vi.resetModules();
  return import("./threadCapabilities");
}

describe("durable capability records", () => {
  beforeEach(() => forgetSubagentCapabilities());

  it("survives a renderer reload that never replaced the app-server", async () => {
    recordSubagentCapabilities("thread-1", RUNTIME, BRIDGED);
    const reloaded = await reloadModule();
    expect(reloaded.planSubagentCapabilities("thread-1", RUNTIME, BRIDGED)).toEqual(NOTHING);
    // Losing this across a reload would let the switch look live while the
    // loaded runtime thread kept the capabilities it already had.
    expect(reloaded.planSubagentCapabilities("thread-1", RUNTIME, ON)).toEqual(REFRESH);
  });

  it("ignores stored records that are not shaped like one", async () => {
    localStorage.setItem("kiwi.threadSubagentCapabilities", JSON.stringify({
      "thread-1": "managed-v2:on:4:",
      "thread-2": { instance: RUNTIME },
      "thread-3": { instance: "", signature: ON },
      "thread-4": { instance: RUNTIME, signature: ON },
    }));
    const reloaded = await reloadModule();
    expect(reloaded.planSubagentCapabilities("thread-1", RUNTIME, ON)).toEqual(REFRESH);
    expect(reloaded.planSubagentCapabilities("thread-2", RUNTIME, ON)).toEqual(REFRESH);
    expect(reloaded.planSubagentCapabilities("thread-3", RUNTIME, ON)).toEqual(REFRESH);
    expect(reloaded.planSubagentCapabilities("thread-4", RUNTIME, ON)).toEqual(NOTHING);
  });
});
