import { describe, expect, it } from "vitest";
import { sanitizeProjectDefaultOverrides, sanitizeProjectDefaults } from "./projectDefaults";

describe("project defaults", () => {
  it.each(["dart", "filament"])("migrates a retired %s project selection without dropping its appearance override", (retired) => {
    const defaults = sanitizeProjectDefaults({ provider: "claude", model: "claude-opus-5", effortSlider: retired });
    expect(defaults?.effortSlider).toBe("comet");
    expect(defaults?.effortSlider).toBeDefined();
  });
  it.each(["atari", "synthwave"])("preserves the %s theme in per-project settings", (theme) => {
    expect(sanitizeProjectDefaults({ provider: "openai", model: "gpt-5.6-sol", theme })?.theme).toBe(theme);
  });
  it.each(["midnight", "monochrome"])("migrates a retired %s project theme to Mythra without dropping the override", (retired) => {
    expect(sanitizeProjectDefaults({ provider: "openai", model: "gpt-5.6-sol", theme: retired })?.theme).toBe("mythra");
    const [project] = sanitizeProjectDefaultOverrides([{
      id: "project-1",
      name: "Project",
      path: "/project",
      overrides: { defaults: { provider: "openai", model: "gpt-5.6-sol", theme: retired } } as never,
    }]);
    expect(project.overrides?.defaults).toEqual({ provider: "openai", model: "gpt-5.6-sol", theme: "mythra" });
  });
  it("keeps valid routing and optional appearance defaults", () => {
    expect(sanitizeProjectDefaults({
      provider: "claude",
      model: "claude-opus-5",
      theme: "synthwave",
      effortSlider: "coil",
      chatFont: "serif",
    })).toEqual({
      provider: "claude",
      model: "claude-opus-5",
      theme: "synthwave",
      effortSlider: "coil",
      chatFont: "serif",
    });
  });

  it("rejects unusable routing and drops malformed appearance values", () => {
    expect(sanitizeProjectDefaults({ provider: "unknown", model: "anything" })).toBeNull();
    expect(sanitizeProjectDefaults({ provider: "openrouter", model: "not-a-provider-slug" })).toBeNull();
    expect(sanitizeProjectDefaults({ provider: "openai", model: "gpt-5.6-sol", theme: "broken", effortSlider: "broken", chatFont: "Papyrus" }))
      .toEqual({ provider: "openai", model: "gpt-5.6-sol" });
  });

  it("retires legacy model and permission overrides without removing other project settings", () => {
    expect(sanitizeProjectDefaultOverrides([{
      id: "project-1",
      name: "Project",
      path: "/project",
      overrides: {
        model: "gpt-legacy",
        permission: "full",
        systemPrompt: "Keep this",
      } as never,
    }])).toEqual([{
      id: "project-1",
      name: "Project",
      path: "/project",
      overrides: { systemPrompt: "Keep this" },
    }]);
  });
});
