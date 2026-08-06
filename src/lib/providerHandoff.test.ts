import { describe, expect, it } from "vitest";
import { buildProviderHandoffPrompt, sanitizePendingHandoff } from "./providerHandoff";

describe("provider handoff prompt", () => {
  it("preserves the original goal and newest context while identifying provenance", () => {
    const prompt = buildProviderHandoffPrompt({
      title: "Fix checkout",
      sourceProvider: "openai",
      sourceModel: "gpt-5.6-sol",
      workspaceName: "Store",
      workspacePath: "/tmp/store",
      messages: [
        { id: "goal", role: "user", text: "Fix checkout failures" },
        { id: "answer", role: "assistant", text: "I found a race in payment.ts" },
        { id: "followup", role: "user", text: "Keep the public API unchanged" },
      ],
    });

    expect(prompt).toContain("Continue “Fix checkout” from a provider handoff.");
    expect(prompt).toContain("Source provider: OpenAI (gpt-5.6-sol)");
    expect(prompt).toContain("Fix checkout failures");
    expect(prompt).toContain("Keep the public API unchanged");
    expect(prompt).toContain("inspect the actual files and Git state");
  });

  it("hard-bounds oversized context while keeping the initial goal and newest state", () => {
    const prompt = buildProviderHandoffPrompt({
      title: "Large task",
      sourceProvider: "openai",
      sourceModel: "gpt-5.6-sol",
      workspaceName: "Kiwi",
      workspacePath: "/projects/kiwi",
      messages: [
        { id: "goal", role: "user", text: `Keep this goal. ${"a".repeat(30_000)}` },
        { id: "latest", role: "assistant", text: `${"b".repeat(30_000)} Latest state marker.` },
      ],
    });

    expect(prompt.length).toBeLessThan(19_000);
    expect(prompt).toContain("Keep this goal.");
    expect(prompt).toContain("Latest state marker.");
    expect(prompt).toContain("truncated");
  });

  it("rejects incomplete or unknown persisted handoff destinations", () => {
    expect(sanitizePendingHandoff({ targetProvider: "claude" })).toBeNull();
    expect(sanitizePendingHandoff({
      sourceThreadId: "source",
      sourceTitle: "Task",
      sourceProvider: "openai",
      sourceModel: "gpt-5.6-sol",
      workspacePath: "/tmp/project",
      targetProvider: "unknown",
      createdAt: 1,
    })).toBeNull();
  });
});
