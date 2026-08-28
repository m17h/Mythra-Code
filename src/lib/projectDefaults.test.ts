import { describe, expect, it } from "vitest";
import { sanitizeProjectDefaultOverrides, sanitizeProjectDefaults } from "./projectDefaults";

describe("project defaults", () => {
  it("keeps valid routing and optional appearance defaults", () => {
    expect(sanitizeProjectDefaults({
      provider: "claude",
      model: "claude-opus-5",
      theme: "midnight",
      effortSlider: "coil",
    })).toEqual({
      provider: "claude",
      model: "claude-opus-5",
      theme: "midnight",
      effortSlider: "coil",
    });
  });

  it("rejects unusable routing and drops malformed appearance values", () => {
    expect(sanitizeProjectDefaults({ provider: "unknown", model: "anything" })).toBeNull();
    expect(sanitizeProjectDefaults({ provider: "openrouter", model: "not-a-provider-slug" })).toBeNull();
    expect(sanitizeProjectDefaults({ provider: "openai", model: "gpt-5.6-sol", theme: "broken", effortSlider: "broken" }))
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
