import { describe, expect, it } from "vitest";
import type { ScheduleRunSettings } from "../types";
import { OPENKIWI_DELEGATION_INSTRUCTIONS, openKiwiDeveloperInstructions } from "./completionPrompt";

/** Skill-mention plus completion guidance: what every turn carries. */
const BASE_INSTRUCTIONS = openKiwiDeveloperInstructions(false);
import { childAgentMcpConfig, normalizeLmStudioBaseUrl, threadResumeParams, threadRuntimeConfig, threadStartParams } from "./turnConfig";
import { LM_STUDIO_RUNTIME_PROVIDER_ID } from "./providerIds";

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
      features: { multi_agent: false, apps: false, remote_plugin: false },
      apps: { _default: { enabled: false } },
    });
    expect(config).not.toHaveProperty("features.shell_tool");
  });

  it("does not change the OpenAI tool configuration", () => {
    const config = threadRuntimeConfig(baseRun, { modelContextWindow: 1_000_000 });
    expect(config).not.toHaveProperty("model_context_window");
    expect(config).not.toHaveProperty("apps");
    expect(config.features).toEqual({ multi_agent: false });
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

    expect(start.developerInstructions).toBe(BASE_INSTRUCTIONS);
    expect(start.config).toMatchObject({ developer_instructions: BASE_INSTRUCTIONS });
    expect(resume.developerInstructions).toBe(BASE_INSTRUCTIONS);
  });
});

describe("LM Studio runtime routing", () => {
  const lmStudioRun: ScheduleRunSettings = {
    ...baseRun,
    provider: "lmstudio",
    model: "lmstudio-community/qwen3-coder",
    lmStudioBaseUrl: "http://127.0.0.1:1234/v1",
  };

  it("normalizes server URLs", () => {
    expect(normalizeLmStudioBaseUrl("http://127.0.0.1:1234")).toBe("http://127.0.0.1:1234/v1");
    expect(normalizeLmStudioBaseUrl("http://localhost:1234/v1/")).toBe("http://localhost:1234/v1");
  });

  it("routes new and resumed threads through the configured LM Studio Responses provider", () => {
    expect(threadStartParams(lmStudioRun, "/tmp/project", { interactive: true })).toMatchObject({
      model: "lmstudio-community/qwen3-coder",
      modelProvider: LM_STUDIO_RUNTIME_PROVIDER_ID,
      config: {
        model_providers: { [LM_STUDIO_RUNTIME_PROVIDER_ID]: { base_url: "http://127.0.0.1:1234/v1", env_key: "LMSTUDIO_API_KEY", wire_api: "responses" } },
        features: { apps: false, remote_plugin: false },
        apps: { _default: { enabled: false } },
      },
    });
    expect(threadResumeParams(lmStudioRun, "thread-local", "/tmp/project")).toMatchObject({
      threadId: "thread-local",
      modelProvider: LM_STUDIO_RUNTIME_PROVIDER_ID,
      config: { features: { apps: false, remote_plugin: false } },
    });
    expect(threadRuntimeConfig(lmStudioRun)).not.toHaveProperty("model_providers.lmstudio");
  });
});

describe("cross-provider sub-agent bridge", () => {
  const bridge = {
    name: "openkiwi",
    command: "/Applications/OpenKiwi.app/Contents/MacOS/openkiwi",
    args: ["--openkiwi-agent-bridge", "/data/child-agents/abc/session.json"],
    configPath: "/data/child-agents/abc/mcp.json",
    toolNames: ["spawn_agent", "agent_status", "collect_agent", "cancel_agent"],
  };

  it("registers the bridge as a per-thread MCP server", () => {
    expect(childAgentMcpConfig(bridge)).toEqual({
      mcp_servers: {
        openkiwi: {
          command: bridge.command,
          args: bridge.args,
          startup_timeout_sec: 30,
          tool_timeout_sec: 310,
        },
      },
    });
  });

  it("adds nothing at all when a thread may not delegate across providers", () => {
    expect(childAgentMcpConfig(undefined)).toEqual({});
    expect(threadRuntimeConfig(baseRun)).not.toHaveProperty("mcp_servers");
    expect(threadStartParams(baseRun, "/tmp/project", { interactive: true }).config).not.toHaveProperty("mcp_servers");
  });

  it("attaches the bridge and makes it the sole sub-agent route", () => {
    const withBridge = threadStartParams(baseRun, "/tmp/project", { interactive: true, childAgentBridge: bridge });
    const without = threadStartParams(baseRun, "/tmp/project", { interactive: true });
    expect(withBridge).toMatchObject({
      developerInstructions: expect.stringContaining(OPENKIWI_DELEGATION_INSTRUCTIONS),
      config: {
        developer_instructions: expect.stringContaining(OPENKIWI_DELEGATION_INSTRUCTIONS),
        mcp_servers: { openkiwi: { command: bridge.command } },
        features: { multi_agent: false },
      },
    });
    expect(without).toMatchObject({
      developerInstructions: BASE_INSTRUCTIONS,
      config: { features: { multi_agent: false } },
    });
  });

  it("re-applies the bridge when an OpenRouter thread re-sends its configuration", () => {
    const params = threadResumeParams({ ...baseRun, provider: "openrouter", model: "x-ai/grok-4.5" }, "thread-1", "/tmp/project", {
      childAgentBridge: bridge,
    });
    expect(params.config).toMatchObject({ mcp_servers: { openkiwi: { args: bridge.args } } });
  });

  it("re-applies the bridge when an OpenAI thread is resumed after a runtime restart", () => {
    const params = threadResumeParams(baseRun, "thread-1", "/tmp/project", { childAgentBridge: bridge });
    expect(params).toMatchObject({
      developerInstructions: expect.stringContaining(OPENKIWI_DELEGATION_INSTRUCTIONS),
      config: {
        developer_instructions: expect.stringContaining(OPENKIWI_DELEGATION_INSTRUCTIONS),
        mcp_servers: { openkiwi: { args: bridge.args } },
        features: { multi_agent: false },
      },
    });
    expect(params).not.toHaveProperty("modelProvider");
  });

  it("leaves the bridge out of a child thread's own configuration", () => {
    // A child runs with sub-agents off and no bridge, so it has no delegation
    // surface of its own — the structural half of the depth-one rule.
    const childRun = { ...baseRun, subagentsEnabled: false, subagentMax: 1 };
    const config = threadRuntimeConfig(childRun);
    expect(config).not.toHaveProperty("mcp_servers");
    expect(config).toMatchObject({ agents: { max_threads: 1, max_depth: 1 }, features: { multi_agent: false } });
  });
});
