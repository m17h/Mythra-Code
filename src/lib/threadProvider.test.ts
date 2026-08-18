import { describe, expect, it } from "vitest";
import { DEFAULT_CLAUDE_MODEL, DEFAULT_CURSOR_MODEL, DEFAULT_OPENAI_MODEL } from "./appConfig";
import { modelForProvider, providerFromThread } from "./threadProvider";
import { LM_STUDIO_RUNTIME_PROVIDER_ID } from "./providerIds";

describe("thread provider resolution", () => {
  it("uses the provider recorded on an existing thread", () => {
    expect(providerFromThread({ modelProvider: "claude" }, "openai")).toBe("claude");
    expect(providerFromThread({ modelProvider: "openrouter" }, "openai")).toBe("openrouter");
    expect(providerFromThread({ modelProvider: "lmstudio" }, "openai")).toBe("lmstudio");
    expect(providerFromThread({ modelProvider: LM_STUDIO_RUNTIME_PROVIDER_ID }, "openai")).toBe("lmstudio");
    expect(providerFromThread({ modelProvider: "cursor" }, "openai")).toBe("cursor");
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
    expect(modelForProvider("lmstudio", "lmstudio-community/qwen3-coder")).toBe("lmstudio-community/qwen3-coder");
    expect(modelForProvider("lmstudio", "gpt-oss-20b")).toBe("gpt-oss-20b");
    expect(modelForProvider("lmstudio", "")).toBe("");
    expect(modelForProvider("cursor", "")).toBe(DEFAULT_CURSOR_MODEL);
    expect(modelForProvider("cursor", "cursor-grok-4.5")).toBe("cursor-grok-4.5");
  });
});
