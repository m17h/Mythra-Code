import { describe, expect, it } from "vitest";
import { sanitizeProjectDefaultOverrides } from "./projectDefaults";
import { MAX_PROJECT_PROFILE_PROMPT, MAX_PROJECT_PROMPT_PROFILES, MAX_PROJECT_PROMPT_PROFILE_NAME, sanitizeProjectPromptProfiles, updateProjectPromptOverrides } from "./projectPromptProfiles";
import { resolveSystemPrompt } from "./systemPrompt";
import type { ProjectPromptProfile } from "../types";

const profile: ProjectPromptProfile = { id: "review", name: "Review", prompt: "Use @review", mode: "append" };

describe("project prompt profiles", () => {
  it("rejects malformed, duplicate and oversized snapshots without changing their instructions", () => {
    expect(sanitizeProjectPromptProfiles(null)).toEqual([]);
    expect(sanitizeProjectPromptProfiles({ profile })).toEqual([]);
    expect(sanitizeProjectPromptProfiles([null, [], { ...profile, mode: "broken" }, { ...profile, prompt: 1 },
      { ...profile, name: " " }, { ...profile, id: " " }, { ...profile, name: "n".repeat(MAX_PROJECT_PROMPT_PROFILE_NAME + 1) },
      { ...profile, prompt: "p".repeat(MAX_PROJECT_PROFILE_PROMPT + 1) }, profile, { ...profile, name: "Duplicate" }])).toEqual([profile]);
    expect(sanitizeProjectPromptProfiles(Array.from({ length: 100 }, (_, i) => ({ ...profile, id: `profile-${i}` })))).toHaveLength(MAX_PROJECT_PROMPT_PROFILES);
  });

  it("sanitizes persisted profile metadata without migrating or replacing existing effective instructions", () => {
    const original = { systemPrompt: "  Existing instructions  ", systemPromptMode: "append" as const, systemPromptProfiles: [profile], systemPromptProfileId: profile.id };
    const [project] = sanitizeProjectDefaultOverrides([{ id: "a", name: "A", path: "/a", overrides: original }]);
    expect(project.overrides).toEqual({ systemPrompt: original.systemPrompt, systemPromptMode: "append", systemPromptProfiles: [profile] });
    expect(resolveSystemPrompt("Global", project.overrides?.systemPrompt, project.overrides?.systemPromptMode)).toBe("Global\n\nExisting instructions");
    const [legacy] = sanitizeProjectDefaultOverrides([{ id: "a", name: "A", path: "/a", overrides: { systemPrompt: "Legacy text" } }]);
    expect(legacy.overrides).toEqual({ systemPrompt: "Legacy text" });
  });

  it("saves selection atomically, keeps project isolation and preserves other overrides", () => {
    const previous = { systemPrompt: "Old", defaults: { provider: "openai" as const, model: "gpt-6.1-sol" }, systemPromptProfiles: [profile] };
    const saved = updateProjectPromptOverrides(previous, profile.prompt, profile.mode, { profiles: [profile], selectedProfileId: profile.id });
    expect(saved).toEqual({ ...previous, systemPrompt: profile.prompt, systemPromptMode: "append", systemPromptProfileId: "review" });
    expect(previous.systemPrompt).toBe("Old");
    expect(updateProjectPromptOverrides(undefined, "Other project", "replace")).toEqual({ systemPrompt: "Other project" });
    expect(updateProjectPromptOverrides(saved, "Edited", "replace")?.systemPromptProfileId).toBeUndefined();
  });

  it("deleting an active profile keeps its instructions and layering", () => {
    const active = { systemPrompt: profile.prompt, systemPromptMode: profile.mode, systemPromptProfiles: [profile], systemPromptProfileId: profile.id };
    expect(updateProjectPromptOverrides(active, profile.prompt, profile.mode, { profiles: [] })).toEqual({ systemPrompt: profile.prompt, systemPromptMode: "append" });
    expect(updateProjectPromptOverrides(active, undefined, "replace", { profiles: [profile] })).toEqual({ systemPromptProfiles: [profile] });
  });
});
