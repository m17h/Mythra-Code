import { describe, expect, it } from "vitest";
import { resolveProviderSystemPrompt, resolveSystemPrompt } from "./systemPrompt";

describe("provider system prompt composition", () => {
  it("layers the global prompt before the Codex subscription prompt", () => {
    expect(resolveProviderSystemPrompt("Global rules", "openai", "Codex rules", "Claude rules"))
      .toBe("Global rules\n\nCodex rules");
  });

  it("layers the global prompt before the Claude Code subscription prompt", () => {
    expect(resolveProviderSystemPrompt("Global rules", "claude", "Codex rules", "Claude rules"))
      .toBe("Global rules\n\nClaude rules");
  });

  it("uses only the global layer for API and Cursor providers", () => {
    expect(resolveProviderSystemPrompt("Global rules", "openrouter", "Codex rules", "Claude rules")).toBe("Global rules");
    expect(resolveProviderSystemPrompt("Global rules", "cursor", "Codex rules", "Claude rules")).toBe("Global rules");
  });

  it("does not create blank separators", () => {
    expect(resolveProviderSystemPrompt("", "claude", "", " Claude rules ")).toBe("Claude rules");
  });
});

describe("project system prompt composition", () => {
  it("inherits the app prompt when the project has none", () => {
    expect(resolveSystemPrompt("App rules", undefined)).toBe("App rules");
  });

  it("preserves the existing replace behavior by default", () => {
    expect(resolveSystemPrompt("App rules", "Project rules")).toBe("Project rules");
  });

  it("runs app instructions before project instructions in append mode", () => {
    expect(resolveSystemPrompt("App rules", "Project rules", "append")).toBe("App rules\n\nProject rules");
  });

  it("does not add an empty app prompt ahead of project instructions", () => {
    expect(resolveSystemPrompt("", "Project rules", "append")).toBe("Project rules");
  });

  it("treats whitespace-only prompts as empty", () => {
    expect(resolveSystemPrompt("   ", "Project rules", "append")).toBe("Project rules");
    expect(resolveSystemPrompt("App rules", "   ", "append")).toBe("App rules");
  });
});
