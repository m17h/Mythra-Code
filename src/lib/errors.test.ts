import { describe, expect, it } from "vitest";
import { friendlyError, isAuthenticationError } from "./errors";
import { SKILL_DEPENDENCY_LIMITS, SkillDependencyError } from "./skillDependencies";

describe("friendlyError", () => {
  it.each(["permission denied", "no such file or directory", "operation timed out"])("preserves the dependency reason chain for %s", (message) => {
    const error = new SkillDependencyError({
      version: 1,
      limits: { ...SKILL_DEPENDENCY_LIMITS },
      roots: [],
      nodes: [],
      edges: [],
      issues: [{ code: "read-failed", message, chain: ["review", "guide.md"] }],
    });

    expect(friendlyError(error)).toBe(error.message);
    expect(friendlyError(error)).toContain("review → guide.md");
    expect(friendlyError(error)).toContain("Skills were not loaded and the model was not started.");
  });

  it("turns protocol capability failures into recovery guidance", () => {
    expect(friendlyError("thread/resume.runtimeWorkspaceRoots requires experimentalApi capability"))
      .toMatch(/reconnect.*Restart the runtime/i);
  });

  it("turns missing runtime failures into setup guidance", () => {
    expect(friendlyError("Could not start codex app-server: No such file or directory"))
      .toBe("The Codex runtime could not be found. Install the official Codex CLI, then try again.");
  });

  it("removes noisy transport prefixes from unknown errors", () => {
    expect(friendlyError("App Server error: useful detail")).toBe("useful detail");
  });
});


it.each(["401 Unauthorized", "refresh_token_reused", "Your token has expired", "Please sign in again"])("recognizes auth rejection: %s", (message) => {
  expect(isAuthenticationError(new Error(message))).toBe(true);
});
it.each(["500 Internal Server Error", "Timed out contacting OAuth server", "Network offline"])("does not sign out on transient failure: %s", (message) => {
  expect(isAuthenticationError(new Error(message))).toBe(false);
});
