import { describe, expect, it } from "vitest";
import { resolveSystemPrompt } from "./systemPrompt";

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
