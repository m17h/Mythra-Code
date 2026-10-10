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
  it("tracks own compaction while delegation is off, including reset to provider default", () => {
    const small = subagentCapabilitySignature({ subagentsEnabled: false, subagentMax: 4, autoCompactTokens: 100_000 });
    const large = subagentCapabilitySignature({ subagentsEnabled: false, subagentMax: 4, autoCompactTokens: 1_000_000 });
    expect(new Set([OFF, small, large]).size).toBe(3);
    expect(subagentCapabilitySignature({ subagentsEnabled: false, subagentMax: 4, autoCompactTokens: undefined })).toBe(OFF);
  });
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

  it("records the engine and its own native concurrency independently of the Mythra budget", () => {
    const native = subagentCapabilitySignature({ subagentsEnabled: true, subagentMax: 4, subagentEngine: "native", nativeSubagentMax: 6 });
    expect(native).not.toBe(ON);
    expect(subagentCapabilitySignature({ subagentsEnabled: true, subagentMax: 24, subagentEngine: "native", nativeSubagentMax: 6 })).toBe(native);
    expect(subagentCapabilitySignature({ subagentsEnabled: true, subagentMax: 4, subagentEngine: "native", nativeSubagentMax: 7 })).not.toBe(native);
    expect(subagentCapabilitySignature({ subagentsEnabled: false, subagentMax: 24, subagentEngine: "native", nativeSubagentMax: 7 })).toBe(OFF);
  });

  it("tracks Codex child defaults and compaction only when native delegation is active", () => {
    const base = { subagentsEnabled: true, subagentMax: 4, subagentEngine: "native" as const, nativeSubagentMax: 6 };
    const empty = subagentCapabilitySignature(base);
    const preferred = subagentCapabilitySignature({ ...base, nativeSubagentOptions: { codex: { model: "gpt-6-luna", reasoningEffort: "high", autoCompactTokens: 100_000 } } });
    expect(preferred).not.toBe(empty);
    expect(subagentCapabilitySignature({ ...base, nativeSubagentOptions: { claude: { model: "opus" } } })).toBe(empty);
    for (const codex of [{ model: "gpt-6-luna" }, { reasoningEffort: "high" as const }, { autoCompactTokens: 100_000 }]) {
      expect(subagentCapabilitySignature({ ...base, nativeSubagentOptions: { codex } })).not.toBe(empty);
    }
    expect(subagentCapabilitySignature({ ...base, subagentsEnabled: false, nativeSubagentOptions: { codex: { autoCompactTokens: 100_000 } } })).toBe(OFF);
  });
});

describe("planSubagentCapabilities", () => {
  beforeEach(() => forgetSubagentCapabilities());

  it("refreshes an unknown loaded thread before claiming native delegation is disabled", () => {
    expect(planSubagentCapabilities("thread-1", RUNTIME, OFF)).toEqual(REFRESH);
    expect(planSubagentCapabilities("thread-1", RUNTIME, OFF, false)).toEqual(RESUME_ONLY);
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

  it("refreshes a loaded thread when its delegation engine changes", () => {
    recordSubagentCapabilities("thread-1", RUNTIME, ON);
    const native = subagentCapabilitySignature({ subagentsEnabled: true, subagentMax: 4, subagentEngine: "native", nativeSubagentMax: 6 });
    expect(planSubagentCapabilities("thread-1", RUNTIME, native)).toEqual(REFRESH);
    expect(planSubagentCapabilities("thread-1", RESTARTED, native, false)).toEqual(RESUME_ONLY);
  });

  it("refreshes when startup-only native preferences are set and cleared", () => {
    const base = { subagentsEnabled: true, subagentMax: 4, subagentEngine: "native" as const, nativeSubagentMax: 6 };
    const cleared = subagentCapabilitySignature(base);
    const preferred = subagentCapabilitySignature({ ...base, nativeSubagentOptions: { codex: { model: "gpt-6-luna", autoCompactTokens: 100_000 } } });
    recordSubagentCapabilities("thread-options", RUNTIME, cleared);
    expect(planSubagentCapabilities("thread-options", RUNTIME, preferred)).toEqual(REFRESH);
    recordSubagentCapabilities("thread-options", RUNTIME, preferred);
    expect(planSubagentCapabilities("thread-options", RUNTIME, cleared)).toEqual(REFRESH);
    expect(planSubagentCapabilities("thread-options", RESTARTED, cleared, false)).toEqual(RESUME_ONLY);
  });

  it("only resumes when the app-server that held the thread has since been replaced", () => {
    // A restarted runtime has nothing loaded, so config applies on resume and
    // interrupting it again would cost the user a turn for no reason.
    recordSubagentCapabilities("thread-1", RUNTIME, ON);
    expect(planSubagentCapabilities("thread-1", RESTARTED, BRIDGED, false)).toEqual(RESUME_ONLY);
  });

  it("resumes a neutral thread after a restart so the replacement runtime loads it", () => {
    recordSubagentCapabilities("thread-1", RUNTIME, BRIDGED);
    expect(planSubagentCapabilities("thread-1", RESTARTED, OFF, false)).toEqual(RESUME_ONLY);
  });

  it("resumes an unknown thread without restarting a runtime that has not loaded it", () => {
    expect(planSubagentCapabilities("thread-1", RUNTIME, BRIDGED, false)).toEqual(RESUME_ONLY);
  });

  it("refreshes a replacement runtime that already loaded the thread through another path", () => {
    recordSubagentCapabilities("thread-1", RUNTIME, ON);
    expect(planSubagentCapabilities("thread-1", RESTARTED, BRIDGED, true)).toEqual(REFRESH);
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
