import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "./appConfig";
import { DURABLE_STORAGE_KEYS } from "./storage";
import { sanitizeThreadSubagentSettings, settingsForThreadSubagents } from "./threadSubagentSettings";

describe("thread sub-agent opt-in", () => {
  const enabled = { ...DEFAULT_SETTINGS, subagentsEnabled: true, subagentMax: 4 };

  it("starts a fresh draft off without removing its configured crew or limit", () => {
    const fresh = settingsForThreadSubagents(enabled, null, {});
    expect(fresh.subagentsEnabled).toBe(false);
    expect(fresh.subagentMax).toBe(4);
    expect(fresh.childAgents).toBe(enabled.childAgents);
    expect(settingsForThreadSubagents(enabled, null, {}, true).subagentsEnabled).toBe(true);
  });

  it("preserves legacy opt-ins and isolates saved opt-ins from future default edits", () => {
    expect(settingsForThreadSubagents(enabled, "old", {}).subagentsEnabled).toBe(true);
    expect(settingsForThreadSubagents(enabled, "fresh", { fresh: false }).subagentsEnabled).toBe(false);
    expect(settingsForThreadSubagents(DEFAULT_SETTINGS, "opted-in", { "opted-in": true }).subagentsEnabled).toBe(true);
    expect(settingsForThreadSubagents(DEFAULT_SETTINGS, "constructor", {}).subagentsEnabled).toBe(false);
    expect(settingsForThreadSubagents(DEFAULT_SETTINGS, "toString", {}).subagentsEnabled).toBe(false);
    const changedCrew = { ...enabled, subagentMax: 7 };
    expect(settingsForThreadSubagents(changedCrew, "fresh", { fresh: false }).subagentMax).toBe(7);
  });

  it("sanitizes persisted switches and includes them in native durable storage", () => {
    expect(sanitizeThreadSubagentSettings({ yes: true, no: false, invalid: "true", "": true })).toEqual({ yes: true, no: false });
    expect(sanitizeThreadSubagentSettings(null)).toEqual({});
    expect(DURABLE_STORAGE_KEYS).toContain("kiwi.threadSubagentSettings");
  });
});
