import { describe, expect, it } from "vitest";
import { friendlyError, isAuthenticationError } from "./errors";

describe("friendlyError", () => {
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
