import { describe, expect, it } from "vitest";
import { DEFAULT_CLAUDE_MODEL, DEFAULT_OPENAI_MODEL } from "./appConfig";
import { modelForProvider, providerFromThread } from "./threadProvider";

describe("thread provider resolution", () => {
  it("uses the provider recorded on an existing thread", () => {
    expect(providerFromThread({ modelProvider: "claude" }, "openai")).toBe("claude");
    expect(providerFromThread({ modelProvider: "openrouter" }, "openai")).toBe("openrouter");
  });

  it("falls back safely when an older thread has no recognized provider", () => {
    expect(providerFromThread({ modelProvider: "" }, "claude")).toBe("claude");
    expect(providerFromThread({ modelProvider: "custom" }, "openai")).toBe("openai");
  });

  it("normalizes incompatible models when a new thread changes provider", () => {
    expect(modelForProvider("claude", "gpt-5.6-sol")).toBe(DEFAULT_CLAUDE_MODEL);
    expect(modelForProvider("openai", "anthropic/claude-sonnet")).toBe(DEFAULT_OPENAI_MODEL);
    expect(modelForProvider("openrouter", "gpt-5.6-sol")).toBe("");
    expect(modelForProvider("openrouter", "anthropic/claude-sonnet")).toBe("anthropic/claude-sonnet");
  });
});
