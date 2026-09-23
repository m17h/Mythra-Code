import { describe, expect, it } from "vitest";
import { onboardingProviderReadiness } from "./onboardingReadiness";

type ReadinessInput = Parameters<typeof onboardingProviderReadiness>[0];

const readyInput: ReadinessInput = {
  runtimeStatus: { available: true, compatible: true },
  claudeStatus: { available: true, loggedIn: true },
  cursorStatus: { available: true, loggedIn: true },
  account: { type: "chatgpt" },
  openRouterReady: true,
  lmStudioReady: true,
};

describe("onboardingProviderReadiness", () => {
  it("requires a usable runtime and connection for each of the five providers", () => {
    const statuses = onboardingProviderReadiness(readyInput);
    expect(Object.keys(statuses)).toEqual(["openai", "openrouter", "lmstudio", "claude", "cursor"]);
    expect(Object.values(statuses).every(({ ready }) => ready)).toBe(true);
  });

  it("keeps Codex-backed providers pending while runtime detection is unfinished", () => {
    const statuses = onboardingProviderReadiness({ ...readyInput, runtimeStatus: null });
    for (const provider of ["openai", "openrouter", "lmstudio"] as const) {
      expect(statuses[provider]).toEqual({ ready: false, detail: "Checking Codex runtime…" });
    }
    expect(statuses.claude.ready).toBe(true);
    expect(statuses.cursor.ready).toBe(true);
  });

  it("does not call saved credentials ready without an installed compatible Codex runtime", () => {
    for (const [runtimeStatus, detail] of [
      [{ available: false, compatible: false }, "Install Codex CLI"],
      [{ available: true, compatible: false }, "Update Codex runtime"],
    ] as const) {
      const statuses = onboardingProviderReadiness({ ...readyInput, runtimeStatus });
      for (const provider of ["openai", "openrouter", "lmstudio"] as const) {
        expect(statuses[provider]).toEqual({ ready: false, detail });
      }
    }
  });

  it("points to the missing provider setup after its runtime is usable", () => {
    const statuses = onboardingProviderReadiness({
      ...readyInput,
      account: { type: "apiKey" },
      openRouterReady: false,
      lmStudioReady: false,
      claudeStatus: { available: true, loggedIn: false },
      cursorStatus: { available: true, loggedIn: false },
    });
    expect(statuses.openai).toEqual({ ready: false, detail: "Sign in to ChatGPT" });
    expect(statuses.openrouter).toEqual({ ready: false, detail: "Add an OpenRouter API key" });
    expect(statuses.lmstudio).toEqual({ ready: false, detail: "Connect your LM Studio server and load a model" });
    expect(statuses.claude).toEqual({ ready: false, detail: "Sign in to Claude" });
    expect(statuses.cursor).toEqual({ ready: false, detail: "Sign in to Cursor" });
  });

  it("keeps Claude and Cursor pending or missing even if a login flag is true", () => {
    const checking = onboardingProviderReadiness({ ...readyInput, claudeStatus: null, cursorStatus: null });
    expect(checking.claude).toEqual({ ready: false, detail: "Checking Claude Code…" });
    expect(checking.cursor).toEqual({ ready: false, detail: "Checking Cursor Agent…" });

    const missing = onboardingProviderReadiness({
      ...readyInput,
      claudeStatus: { available: false, loggedIn: true },
      cursorStatus: { available: false, loggedIn: true },
    });
    expect(missing.claude).toEqual({ ready: false, detail: "Install Claude Code" });
    expect(missing.cursor).toEqual({ ready: false, detail: "Install Cursor Agent" });
  });
});
