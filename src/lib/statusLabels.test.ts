import { describe, expect, it } from "vitest";
import { agentStatusLabel, mcpServerConnected, mcpStatusLabel, worktreeStatusLabel } from "./statusLabels";

describe("status labels", () => {
  it("names the runtime's agent states in plain words", () => {
    expect(agentStatusLabel("inProgress")).toBe("Working");
    expect(agentStatusLabel("started")).toBe("Starting");
    expect(agentStatusLabel("completed")).toBe("Finished");
    expect(agentStatusLabel("failed")).toBe("Failed");
  });

  it("names worktree states in plain words", () => {
    expect(worktreeStatusLabel("active")).toBe("Active");
    expect(worktreeStatusLabel("applied")).toBe("Applied to project");
    expect(worktreeStatusLabel("missing")).toBe("Missing on disk");
  });

  it("names MCP auth states consistently with the Connect action", () => {
    expect(mcpStatusLabel("ready")).toBe("Connected");
    expect(mcpStatusLabel("oAuth")).toBe("Connected · OAuth");
    expect(mcpStatusLabel("bearerToken")).toBe("Connected · token");
    expect(mcpServerConnected("ready")).toBe(true);
    expect(mcpServerConnected("oAuth")).toBe(true);
    expect(mcpServerConnected("bearerToken")).toBe(true);
    expect(mcpServerConnected("needsAuth")).toBe(false);
  });

  it("falls back to a readable form for an unknown value", () => {
    expect(agentStatusLabel("awaitingReview")).toBe("Awaiting review");
    expect(mcpStatusLabel("handshake_failed")).toBe("Handshake failed");
    expect(worktreeStatusLabel("")).toBe("");
  });
});
