import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "./appConfig";
import { DURABLE_STORAGE_KEYS } from "./storage";
import { autoCompactTokensError, DEFAULT_THREAD_SUBAGENT_SETTINGS, nativeSubagentOptionsError, nativeSubagentUnavailableReason, nativeSubagentVersionAtLeast, sanitizeNativeSubagentMax, sanitizeNativeSubagentOptions, sanitizeThreadSubagentSettings, settingsForThreadSubagents, threadSubagentSettingsFromApp } from "./threadSubagentSettings";
import type { ChildAgentReadiness } from "./childAgents";

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
    expect(sanitizeThreadSubagentSettings({ yes: true, no: false, invalid: "true", "": true })).toEqual({
      yes: { ...DEFAULT_THREAD_SUBAGENT_SETTINGS, enabled: true },
      no: { ...DEFAULT_THREAD_SUBAGENT_SETTINGS },
      invalid: { ...DEFAULT_THREAD_SUBAGENT_SETTINGS },
    });
    expect(sanitizeThreadSubagentSettings(null)).toEqual({});
    expect(DURABLE_STORAGE_KEYS).toContain("kiwi.threadSubagentSettings");
  });

  it("resolves a thread's engine and native budget without changing the retained Mythra crew", () => {
    const policies = sanitizeThreadSubagentSettings({ native: { enabled: true, engine: "native", nativeMaxConcurrent: 9 } });
    const resolved = settingsForThreadSubagents(enabled, "native", policies);
    expect(resolved).toMatchObject({ subagentsEnabled: true, subagentEngine: "native", nativeSubagentMax: 9, subagentMax: 4 });
    expect(resolved.childAgents).toBe(enabled.childAgents);
    expect(settingsForThreadSubagents({ ...enabled, subagentEngine: "native", nativeSubagentMax: 22 }, "legacy", {})).toMatchObject({ subagentEngine: "mythra", nativeSubagentMax: 6 });
    expect(settingsForThreadSubagents(enabled, null, policies)).toMatchObject({ subagentsEnabled: false, subagentEngine: "mythra", nativeSubagentMax: 6 });
  });

  it("fails closed for an unknown saved engine and bounds the separate native budget", () => {
    expect(sanitizeThreadSubagentSettings({ bad: { enabled: true, engine: "future" }, native: { enabled: false, engine: "native", nativeMaxConcurrent: 99 } })).toMatchObject({
      bad: { enabled: false, engine: "mythra" }, native: { enabled: false, engine: "native", nativeMaxConcurrent: 24 },
    });
    expect(sanitizeNativeSubagentMax(undefined)).toBe(6);
    expect(sanitizeNativeSubagentMax(Number.NaN)).toBe(6);
    expect(sanitizeNativeSubagentMax(0)).toBe(1);
    expect(sanitizeNativeSubagentMax(3.7)).toBe(3);
  });

  it("retains malformed known entries as disabled policies instead of inheriting a legacy opt-in", () => {
    const malformed = { enabled: "false", engine: "native", nativeMaxConcurrent: 1 };
    const stored = sanitizeThreadSubagentSettings({ malformed, nullEntry: null, arrayEntry: [] });
    const reloaded = sanitizeThreadSubagentSettings(JSON.parse(JSON.stringify(stored)));
    for (const id of ["malformed", "nullEntry", "arrayEntry"]) {
      expect(settingsForThreadSubagents(enabled, id, reloaded)).toMatchObject({ subagentsEnabled: false, subagentEngine: "mythra" });
    }
    expect(settingsForThreadSubagents(enabled, "malformed", { malformed } as never).subagentsEnabled).toBe(false);
    expect(settingsForThreadSubagents(enabled, "actually-legacy", reloaded).subagentsEnabled).toBe(true);
  });

  it("keeps provider preferences durable while off or using Mythra without creating draft defaults", () => {
    const nativeOptions = { claude: { model: "claude-haiku-5-5", autoCompactTokens: 200_000 }, codex: { model: "gpt-6.1-sol", reasoningEffort: "high" as const, autoCompactTokens: 150_000 } };
    const saved = sanitizeThreadSubagentSettings({ a: { enabled: false, engine: "mythra", nativeOptions } });
    expect(saved.a.nativeOptions).toEqual(nativeOptions);
    expect(saved.a.nativeOptions).not.toBe(nativeOptions);
    expect(settingsForThreadSubagents(enabled, "a", saved).nativeSubagentOptions).toEqual(nativeOptions);
    expect(settingsForThreadSubagents({ ...enabled, nativeSubagentOptions: nativeOptions }, null, {}).nativeSubagentOptions).toBeUndefined();
    expect(settingsForThreadSubagents(enabled, "a", { a: { ...saved.a, nativeOptions: undefined } }).nativeSubagentOptions).toBeUndefined();
  });

  it("sanitizes bounded native preferences without coercion or injected identifiers", () => {
    expect(sanitizeNativeSubagentOptions({ claude: { model: " claude-opus-5 ", autoCompactTokens: 1_000_000 }, codex: { model: "gpt-6.1-sol", reasoningEffort: "max", autoCompactTokens: 100_000 } })).toEqual({ claude: { model: "claude-opus-5", autoCompactTokens: 1_000_000 }, codex: { model: "gpt-6.1-sol", reasoningEffort: "max", autoCompactTokens: 100_000 } });
    for (const autoCompactTokens of [99_999, 1_000_001, 100_000.5, NaN, Infinity, "200000"]) {
      expect(sanitizeNativeSubagentOptions({ codex: { autoCompactTokens } })).toBeUndefined();
      expect(nativeSubagentOptionsError("openai", { codex: { autoCompactTokens } })).toContain("whole number");
    }
    for (const model of ["", "  ", "bad\nmodel", "model;run", "default", "inherit", "a".repeat(201)]) expect(sanitizeNativeSubagentOptions({ claude: { model } })).toBeUndefined();
    expect(sanitizeNativeSubagentOptions({ codex: { reasoningEffort: "bogus" }, claude: { reasoningEffort: "high" } })).toBeUndefined();
    expect(nativeSubagentOptionsError("claude", { codex: { autoCompactTokens: "invalid" }, claude: {} })).toBeNull();
  });

  it("disables malformed active native persisted policies instead of silently reverting to provider defaults", () => {
    const nativeOptions = { codex: { autoCompactTokens: 99_999 }, claude: { model: "claude-opus-5" } };
    const cleaned = sanitizeThreadSubagentSettings({ native: { enabled: true, engine: "native", nativeOptions }, mythra: { enabled: true, engine: "mythra", nativeOptions } });
    expect(cleaned.native).toMatchObject({ enabled: false, engine: "native", nativeOptions: { claude: { model: "claude-opus-5" } } });
    expect(cleaned.mythra.enabled).toBe(true);
  });

  it("retains Claude's bounded context suffix without accepting it for Codex or injected model syntax", () => {
    for (const model of ["opus[1m]", "claude-fable-5-1[1m]", "claude-opus-5-5[1M]"]) {
      expect(nativeSubagentOptionsError("claude", { claude: { model } })).toBeNull();
      expect(sanitizeNativeSubagentOptions({ claude: { model } })).toEqual({ claude: { model } });
      expect(nativeSubagentOptionsError("openai", { codex: { model } })).toContain("valid native");
    }
    for (const model of ["opus[1m][1m]", "opus[1m]/other", "opus[2m]", "[1m]", "inherit[1m]", "default[1m]"]) {
      expect(nativeSubagentOptionsError("claude", { claude: { model } })).toContain("valid native");
      expect(sanitizeNativeSubagentOptions({ claude: { model } })).toBeUndefined();
    }
  });

  it("retains own compaction independently of engine, delegation and native child defaults", () => {
    const source = { ...enabled, autoCompactTokens: 1_000_000, nativeSubagentOptions: { claude: { autoCompactTokens: 100_000 } } };
    const setting = threadSubagentSettingsFromApp(source);
    const stored = sanitizeThreadSubagentSettings({ parent: { ...setting, enabled: false } });
    const resolved = settingsForThreadSubagents({ ...source, autoCompactTokens: 200_000 }, "parent", stored);
    expect(resolved).toMatchObject({ autoCompactTokens: 1_000_000, subagentsEnabled: false, nativeSubagentOptions: { claude: { autoCompactTokens: 100_000 } } });
    expect(settingsForThreadSubagents(source, null, {}).autoCompactTokens).toBeUndefined();
    expect(settingsForThreadSubagents(source, "legacy", {}).autoCompactTokens).toBeUndefined();
  });

  it.each([99_999, 1_000_001, 100_000.5, NaN, Infinity, "100000", null])("keeps a malformed explicit own window fail-closed through repeated persistence: %j", (autoCompactTokens) => {
    const first = sanitizeThreadSubagentSettings({ parent: { enabled: false, engine: "mythra", autoCompactTokens } });
    const second = sanitizeThreadSubagentSettings(JSON.parse(JSON.stringify(first)));
    expect(second.parent.autoCompactTokens).toBe(0);
    const resolved = settingsForThreadSubagents(enabled, "parent", second);
    expect(autoCompactTokensError(resolved.autoCompactTokens)).toContain("whole number");
  });
});

describe("native sub-agent availability", () => {
  const readiness: ChildAgentReadiness = { codexRuntimeAvailable: true, openAiSignedIn: true, openRouterReady: false, claudeReady: true, cursorReady: false };
  const codexRuntime = { available: true, version: "0.161.0" };
  const claudeRuntime = { available: true, version: "2.1.267", loggedIn: true };

  it("uses the loaded Codex version and requires known supported CLI versions", () => {
    expect(nativeSubagentUnavailableReason("openai", { readiness, codexRuntime })).toBeNull();
    expect(nativeSubagentUnavailableReason("openai", { readiness, codexRuntime: { ...codexRuntime, runningVersion: "0.160.0" } })).toContain("0.161.0");
    expect(nativeSubagentUnavailableReason("openai", { readiness, codexRuntime: { ...codexRuntime, version: null } })).toContain("0.161.0");
    expect(nativeSubagentUnavailableReason("claude", { readiness, claudeRuntime })).toBeNull();
    for (const version of ["2.1.256", "2.1.257", "2.1.266"]) expect(nativeSubagentUnavailableReason("claude", { readiness, claudeRuntime: { ...claudeRuntime, version } })).toContain("2.1.267");
    expect(nativeSubagentVersionAtLeast("codex-cli 0.161.0-beta.1", [0, 161, 0])).toBe(false);
    expect(nativeSubagentVersionAtLeast("0.162.0", [0, 161, 0])).toBe(true);
  });

  it("requires authentication and never substitutes a managed route for an unsupported provider", () => {
    expect(nativeSubagentUnavailableReason("openai", { readiness: { ...readiness, openAiSignedIn: false }, codexRuntime })).toContain("Sign in");
    expect(nativeSubagentUnavailableReason("claude", { readiness, claudeRuntime: { ...claudeRuntime, loggedIn: false } })).toContain("Sign in");
    for (const provider of ["cursor", "openrouter", "lmstudio"] as const) expect(nativeSubagentUnavailableReason(provider, { readiness, codexRuntime, claudeRuntime })).toContain("Choose one");
  });

  it("gates exact Haiku 5.5 selection and rejects known unsupported Codex effort", () => {
    for (const model of ["claude-haiku-5-5", "claude-haiku-5-5-20261001", "haiku", " HAIKU ", "haiku[1m]", "HAIKU[1M]"]) {
      expect(nativeSubagentUnavailableReason("claude", { readiness, claudeRuntime, nativeOptions: { claude: { model } } })).toContain("2.1.293");
      expect(nativeSubagentUnavailableReason("claude", { readiness, claudeRuntime: { ...claudeRuntime, version: "2.1.293" }, nativeOptions: { claude: { model } } })).toBeNull();
    }
    expect(nativeSubagentUnavailableReason("openai", { readiness, codexRuntime, nativeOptions: { codex: { reasoningEffort: "max" } }, nativeDefaultModel: "gpt-known", nativeReasoningEfforts: { "gpt-known": ["low", "high"] } })).toContain("does not support max");
    expect(nativeSubagentUnavailableReason("openai", { readiness, codexRuntime, nativeOptions: { codex: { reasoningEffort: "max" } }, nativeDefaultModel: "unknown" })).toBeNull();
  });
});
