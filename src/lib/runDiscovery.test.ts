import { expect, it } from "vitest";
import { DEFAULT_RUN_DISCOVERY, sanitizeRunDiscoveryPreferences } from "./runDiscovery";
it("defaults to Luna on Fast and sanitizes malformed persisted preferences", () => {
  expect(sanitizeRunDiscoveryPreferences(null)).toEqual(DEFAULT_RUN_DISCOVERY);
  expect(sanitizeRunDiscoveryPreferences({ provider: "other", model: " ", effort: "invalid", fast: "yes" })).toEqual(DEFAULT_RUN_DISCOVERY);
  expect(sanitizeRunDiscoveryPreferences({ provider: "claude", model: "claude-opus-5", effort: "ultra", fast: false })).toEqual({ provider: "claude", model: "claude-opus-5", effort: "max", fast: false });
});
it("remembers model choices across a provider round-trip instead of selecting an expensive first entry", async () => {
  const { switchRunDiscoveryProvider } = await import("./runDiscovery");
  const catalogs = { openai: [{ id: "gpt-6-astra", label: "Astra" }, { id: "gpt-5.6-luna", label: "Luna" }], claude: [{ id: "claude-opus-5", label: "Opus" }] };
  const claude = switchRunDiscoveryProvider(DEFAULT_RUN_DISCOVERY, "claude", catalogs);
  const restored = switchRunDiscoveryProvider(claude, "openai", catalogs);
  expect(restored.model).toBe("gpt-5.6-luna");
  expect(sanitizeRunDiscoveryPreferences(restored).models).toEqual({ openai: "gpt-5.6-luna", claude: "claude-opus-5" });
});

it("retains all providers, trimmed model choices and catalog-specific effort values", async () => {
  const { DISCOVERY_PROVIDERS, switchRunDiscoveryProvider } = await import("./runDiscovery");
  for (const { value: provider } of DISCOVERY_PROVIDERS) {
    const choice = sanitizeRunDiscoveryPreferences({ provider, model: " custom-model ", effort: "minimal", fast: true, models: { [provider]: " custom-model " } });
    expect(choice).toMatchObject({ provider, model: "custom-model", effort: "minimal", models: { [provider]: "custom-model" } });
    const other = switchRunDiscoveryProvider(choice, provider === "openai" ? "claude" : "openai", {});
    expect(switchRunDiscoveryProvider(other, provider, {})).toMatchObject({ provider, model: "custom-model", effort: "minimal" });
  }
});

it("selects a newly loaded model instead of restoring an empty provider choice", async () => {
  const { switchRunDiscoveryProvider } = await import("./runDiscovery");
  const empty = switchRunDiscoveryProvider(DEFAULT_RUN_DISCOVERY, "lmstudio", {});
  const other = switchRunDiscoveryProvider(empty, "openai", {});
  const loaded = switchRunDiscoveryProvider(other, "lmstudio", { lmstudio: [{ id: "local-model", label: "Local" }] });
  expect(loaded.model).toBe("local-model");
});

it("normalizes legacy Ultra settings to the supported Maximum effort", () => {
  expect(sanitizeRunDiscoveryPreferences({ provider: "openai", model: "m", effort: "ultra" }).effort).toBe("max");
});
