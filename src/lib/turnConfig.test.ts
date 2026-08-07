import { describe, expect, it } from "vitest";
import type { ScheduleRunSettings } from "../types";
import { OPENKIWI_COMPLETION_INSTRUCTIONS } from "./completionPrompt";
import { childAgentMcpConfig, threadResumeParams, threadRuntimeConfig, threadStartParams } from "./turnConfig";

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

  it("attaches the bridge to a new thread without disturbing the rest of its configuration", () => {
    const withBridge = threadStartParams(baseRun, "/tmp/project", { interactive: true, childAgentBridge: bridge });
    const without = threadStartParams(baseRun, "/tmp/project", { interactive: true });
    expect(withBridge.config).toMatchObject({ mcp_servers: { openkiwi: { command: bridge.command } } });
    expect({ ...(withBridge.config as Record<string, unknown>), mcp_servers: undefined })
      .toEqual({ ...(without.config as Record<string, unknown>), mcp_servers: undefined });
  });

  it("re-applies the bridge when an OpenRouter thread re-sends its configuration", () => {
    const params = threadResumeParams({ ...baseRun, provider: "openrouter", model: "x-ai/grok-4.5" }, "thread-1", "/tmp/project", {
      childAgentBridge: bridge,
    });
    expect(params.config).toMatchObject({ mcp_servers: { openkiwi: { args: bridge.args } } });
  });

  it("re-applies the bridge when an OpenAI thread is resumed after a runtime restart", () => {
    const params = threadResumeParams(baseRun, "thread-1", "/tmp/project", { childAgentBridge: bridge });
    expect(params.config).toMatchObject({ mcp_servers: { openkiwi: { args: bridge.args } } });
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
