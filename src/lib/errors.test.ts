import { describe, expect, it } from "vitest";
import { friendlyError } from "./errors";

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
