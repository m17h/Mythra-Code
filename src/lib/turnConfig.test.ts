import { describe, expect, it } from "vitest";
import type { ScheduleRunSettings } from "../types";
import { OPENKIWI_COMPLETION_INSTRUCTIONS } from "./completionPrompt";
import { threadResumeParams, threadRuntimeConfig, threadStartParams } from "./turnConfig";

const baseRun: ScheduleRunSettings = {
  provider: "openai",
  model: "gpt-5.6-luna",
  permission: "ask",
  systemPrompt: "",
  projectInstructionsEnabled: true,
  subagentsEnabled: true,
  subagentMax: 3,
  reasoningEffort: "medium",
  ultra: false,
  serviceTier: null,
};

describe("OpenRouter runtime isolation", () => {
  it("disables connected-app tools while preserving local coding features", () => {
    const config = threadRuntimeConfig({ ...baseRun, provider: "openrouter", model: "google/test" }, { modelContextWindow: 1_000_000 });
    expect(config).toMatchObject({
      model_context_window: 1_000_000,
      features: { multi_agent: true, apps: false, remote_plugin: false },
      apps: { _default: { enabled: false } },
    });
    expect(config).not.toHaveProperty("features.shell_tool");
  });

  it("does not change the OpenAI tool configuration", () => {
    const config = threadRuntimeConfig(baseRun, { modelContextWindow: 1_000_000 });
    expect(config).not.toHaveProperty("model_context_window");
    expect(config).not.toHaveProperty("apps");
    expect(config.features).toEqual({ multi_agent: true });
  });

  it("applies the isolation to new OpenRouter threads", () => {
    const params = threadStartParams({ ...baseRun, provider: "openrouter", model: "google/test" }, "/tmp/project", {
      interactive: true,
      modelContextWindow: 128_000,
    });
    expect(params.modelProvider).toBe("openrouter");
    expect(params.config).toMatchObject({ model_context_window: 128_000, features: { apps: false } });
  });

  it("re-applies the isolation when an existing OpenRouter thread is resumed", () => {
    const params = threadResumeParams({ ...baseRun, provider: "openrouter", model: "google/test" }, "thread-1", "/tmp/project", {
      excludeTurns: true,
      modelContextWindow: 128_000,
    });
    expect(params).toMatchObject({
      threadId: "thread-1",
      excludeTurns: true,
      modelProvider: "openrouter",
      config: { model_context_window: 128_000, features: { apps: false, remote_plugin: false } },
    });
  });

  it("asks every new and resumed thread for a concise final summary", () => {
    const start = threadStartParams(baseRun, "/tmp/project", { interactive: true });
    const resume = threadResumeParams(baseRun, "thread-1", "/tmp/project");

    expect(start.developerInstructions).toBe(OPENKIWI_COMPLETION_INSTRUCTIONS);
    expect(start.config).toMatchObject({ developer_instructions: OPENKIWI_COMPLETION_INSTRUCTIONS });
    expect(resume.developerInstructions).toBe(OPENKIWI_COMPLETION_INSTRUCTIONS);
  });
});
