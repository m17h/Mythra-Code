import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

import { listLMStudioModels } from "./lmStudio";

describe("LM Studio model discovery", () => {
  beforeEach(() => invoke.mockReset());

  it("keeps only LLMs, normalizes metadata, and sorts the local catalog", async () => {
    invoke.mockResolvedValue({ models: [
      { type: "llm", key: "z-model" },
      { type: "embedding", key: "embed-model" },
      { type: "llm", key: "" },
      {},
      {
        type: "llm",
        key: "a-model",
        display_name: "A Model",
        publisher: "local",
        max_context_length: 32768,
        capabilities: {
          trained_for_tool_use: true,
          reasoning: { allowed_options: ["off", "low", "medium", "invalid"], default: "medium" },
        },
      },
    ] });

    await expect(listLMStudioModels()).resolves.toEqual([
      {
        id: "a-model",
        displayName: "A Model",
        publisher: "local",
        maxContextLength: 32768,
        trainedForToolUse: true,
        reasoningEfforts: ["low", "medium"],
        defaultReasoningEffort: "medium",
      },
      {
        id: "z-model",
        displayName: "z-model",
        publisher: "Local model",
        trainedForToolUse: false,
        reasoningEfforts: [],
      },
    ]);
    expect(invoke).toHaveBeenCalledWith("list_lm_studio_models");
  });
});
