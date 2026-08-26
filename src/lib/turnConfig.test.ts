import { describe, expect, it } from "vitest";
import type { ScheduleRunSettings } from "../types";
import { MYTHRA_CODE_DELEGATION_INSTRUCTIONS, MYTHRA_CODE_NATIVE_DELEGATION_POLICY, mythraCodeDeveloperInstructions } from "./completionPrompt";

/** Skill-mention plus completion guidance: what every turn carries. */
const BASE_INSTRUCTIONS = mythraCodeDeveloperInstructions(false);
import { childAgentMcpConfig, normalizeLmStudioBaseUrl, threadResumeParams, threadRuntimeConfig, threadStartParams, turnStartParams } from "./turnConfig";
import { LM_STUDIO_RUNTIME_PROVIDER_ID } from "./providerIds";
import { codexModelProviderId, providerFromThread } from "./threadProvider";

/** Provider ids Codex ships built in and refuses to let a config override. */
const CODEX_RESERVED_PROVIDER_IDS = ["openai", "lmstudio", "ollama", "amazon-bedrock"];

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

describe("permission policy", () => {
  it.each([
    ["read-only", "never", "readOnly"],
    ["ask", "on-request", "workspaceWrite"],
    ["full", "never", "dangerFullAccess"],
  ] as const)("keeps %s consistent across start, resume, and every interactive turn", (permission, approvalPolicy, sandboxType) => {
    const run = { ...baseRun, permission };
    const start = threadStartParams(run, "/tmp/project", { interactive: true });
    const resume = threadResumeParams(run, "thread-1", "/tmp/project");
    const turn = turnStartParams(run, "thread-1", "/tmp/project", []);

    expect(start).toMatchObject({ approvalPolicy, sandbox: permission === "ask" ? "workspace-write" : permission === "full" ? "danger-full-access" : "read-only" });
    expect(resume).toMatchObject({ approvalPolicy, sandbox: permission === "ask" ? "workspace-write" : permission === "full" ? "danger-full-access" : "read-only" });
    expect(turn).toMatchObject({ approvalPolicy, sandboxPolicy: { type: sandboxType } });
  });

  it("never pauses an unattended Ask to act run for approval", () => {
    const run = { ...baseRun, permission: "ask" as const };
    expect(threadStartParams(run, "/tmp/project", { interactive: false })).toMatchObject({ approvalPolicy: "never" });
    expect(turnStartParams(run, "thread-1", "/tmp/project", [], [], false)).toMatchObject({
      approvalPolicy: "never",
      sandboxPolicy: { type: "workspaceWrite" },
    });
  });
});

describe("OpenRouter runtime isolation", () => {
  it("disables connected-app tools while preserving local coding features", () => {
    const config = threadRuntimeConfig({ ...baseRun, provider: "openrouter", model: "google/test" }, { modelContextWindow: 1_000_000 });
    expect(config).toMatchObject({
      model_context_window: 1_000_000,
      features: { multi_agent: false, multi_agent_v2: false, apps: false, remote_plugin: false },
      apps: { _default: { enabled: false } },
    });
    expect(config).not.toHaveProperty("features.shell_tool");
  });

  it("does not change the OpenAI tool configuration", () => {
    const config = threadRuntimeConfig(baseRun, { modelContextWindow: 1_000_000 });
    expect(config).not.toHaveProperty("model_context_window");
    expect(config).not.toHaveProperty("apps");
    expect(config.features).toEqual({ multi_agent: false, multi_agent_v2: false });
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

describe("LM Studio provider configuration", () => {
  it("normalizes server roots to the OpenAI-compatible v1 endpoint", () => {
    expect(normalizeLmStudioBaseUrl("http://127.0.0.1:1234")).toBe("http://127.0.0.1:1234/v1");
    expect(normalizeLmStudioBaseUrl("http://localhost:1234/v1/")).toBe("http://localhost:1234/v1");
  });

  it("registers LM Studio as a Responses provider without connected apps", () => {
    const run = { ...baseRun, provider: "lmstudio" as const, model: "qwen/local", lmStudioBaseUrl: "http://127.0.0.1:1234" };
    const start = threadStartParams(run, "/tmp/project", { interactive: true, modelContextWindow: 262_144 });
    expect(start).toMatchObject({
      model: "qwen/local",
      modelProvider: LM_STUDIO_RUNTIME_PROVIDER_ID,
      config: {
        model_providers: {
          [LM_STUDIO_RUNTIME_PROVIDER_ID]: {
            name: "LM Studio",
            base_url: "http://127.0.0.1:1234/v1",
            env_key: "LMSTUDIO_API_KEY",
            wire_api: "responses",
          },
        },
        features: { apps: false, remote_plugin: false },
        apps: { _default: { enabled: false } },
        model_context_window: 262_144,
      },
    });
  });

  it("reapplies the provider configuration when a local thread resumes", () => {
    const run = { ...baseRun, provider: "lmstudio" as const, model: "local-model", lmStudioBaseUrl: "http://mac-studio.local:1234/v1" };
    expect(threadResumeParams(run, "thread-local", "/tmp/project")).toMatchObject({
      modelProvider: LM_STUDIO_RUNTIME_PROVIDER_ID,
      config: { model_providers: { [LM_STUDIO_RUNTIME_PROVIDER_ID]: { base_url: "http://mac-studio.local:1234/v1" } } },
    });
  });

  /**
   * Codex fails the whole config load with "model_providers contains reserved
   * built-in provider IDs" when any generated entry shadows a built-in. Nothing
   * Mythra Code writes into `model_providers` or `modelProvider` may use one.
   */
  it("never names a reserved Codex built-in provider in the generated config", () => {
    const runs: ScheduleRunSettings[] = [
      { ...baseRun, provider: "lmstudio", model: "qwen/local", lmStudioBaseUrl: "http://127.0.0.1:1234" },
      { ...baseRun, provider: "openrouter", model: "x-ai/grok-4.5" },
      { ...baseRun, provider: "openai", model: "gpt-5.6-luna" },
    ];
    for (const run of runs) {
      for (const params of [
        threadStartParams(run, "/tmp/project", { interactive: true }),
        threadResumeParams(run, "thread-1", "/tmp/project", { refreshRuntimeConfig: true }),
      ]) {
        const config = params.config as { model_providers?: Record<string, unknown> } | undefined;
        for (const id of Object.keys(config?.model_providers ?? {})) {
          expect(CODEX_RESERVED_PROVIDER_IDS).not.toContain(id);
        }
        if (params.modelProvider !== undefined) {
          expect(CODEX_RESERVED_PROVIDER_IDS).not.toContain(params.modelProvider);
        }
      }
    }
  });

  it("keeps `lmstudio` as the app-facing identity while renaming only the Codex id", () => {
    expect(codexModelProviderId("lmstudio")).toBe(LM_STUDIO_RUNTIME_PROVIDER_ID);
    expect(codexModelProviderId("openrouter")).toBe("openrouter");
    expect(codexModelProviderId("openai")).toBeUndefined();
    // A thread the runtime reports back under the private id is still LM Studio,
    // and threads persisted before the rename keep resolving too.
    expect(providerFromThread({ modelProvider: LM_STUDIO_RUNTIME_PROVIDER_ID }, "openai")).toBe("lmstudio");
    expect(providerFromThread({ modelProvider: "lmstudio" }, "openai")).toBe("lmstudio");
  });
});

describe("cross-provider sub-agent bridge", () => {
  const bridge = {
    name: "mythra_agents",
    command: "/Applications/Mythra Code.app/Contents/MacOS/mythra-code",
    args: ["--openkiwi-agent-bridge", "/data/child-agents/abc/session.json"],
    configPath: "/data/child-agents/abc/mcp.json",
    toolNames: ["spawn_mythra_agent", "agent_status", "collect_agent", "cancel_agent"],
  };

  it("registers the bridge as a per-thread MCP server", () => {
    expect(childAgentMcpConfig(bridge)).toEqual({
      mcp_servers: {
        mythra_agents: {
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
      developerInstructions: expect.stringContaining(MYTHRA_CODE_DELEGATION_INSTRUCTIONS),
      config: {
        developer_instructions: expect.stringContaining(MYTHRA_CODE_DELEGATION_INSTRUCTIONS),
        mcp_servers: { mythra_agents: { command: bridge.command } },
        features: { multi_agent: false, multi_agent_v2: false },
      },
    });
    expect(without).toMatchObject({
      developerInstructions: BASE_INSTRUCTIONS,
      config: { features: { multi_agent: false, multi_agent_v2: false } },
    });
  });

  it("re-applies the bridge when an OpenRouter thread re-sends its configuration", () => {
    const params = threadResumeParams({ ...baseRun, provider: "openrouter", model: "x-ai/grok-4.5" }, "thread-1", "/tmp/project", {
      childAgentBridge: bridge,
    });
    expect(params.config).toMatchObject({ mcp_servers: { mythra_agents: { args: bridge.args } } });
  });

  it("re-applies the bridge when an OpenAI thread is resumed after a runtime restart", () => {
    const params = threadResumeParams(baseRun, "thread-1", "/tmp/project", { childAgentBridge: bridge });
    expect(params).toMatchObject({
      developerInstructions: expect.stringContaining(MYTHRA_CODE_DELEGATION_INSTRUCTIONS),
      config: {
        developer_instructions: expect.stringContaining(MYTHRA_CODE_DELEGATION_INSTRUCTIONS),
        mcp_servers: { mythra_agents: { args: bridge.args } },
        features: { multi_agent: false, multi_agent_v2: false },
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
    expect(config).toMatchObject({ agents: { max_threads: 1, max_depth: 1 }, features: { multi_agent: false, multi_agent_v2: false } });
  });

  it("never hands the native agent runtime a parallel budget of its own", () => {
    // `subagentMax` is the Mythra Code bridge's budget and the bridge enforces it
    // per spawn. Mirroring it into `agents.max_threads` gave Codex a second,
    // independent budget stacked on top, so a root configured for two children
    // could reach four workers.
    for (const subagentMax of [1, 2, 3, 24]) {
      const config = threadRuntimeConfig({ ...baseRun, subagentMax });
      expect(config).toMatchObject({
        agents: { max_threads: 1, max_depth: 1 },
        features: { multi_agent: false, multi_agent_v2: false },
      });
    }
  });

  it("keeps both native delegation generations off on every start and resume", () => {
    const start = threadStartParams(baseRun, "/work", { interactive: true });
    const resume = threadResumeParams(baseRun, "thread-1", "/work", { refreshRuntimeConfig: true });
    for (const params of [start, resume]) {
      expect(params).toMatchObject({
        config: {
          multi_agent_mode: { custom: MYTHRA_CODE_NATIVE_DELEGATION_POLICY },
          agents: { max_threads: 1, max_depth: 1 },
          features: { multi_agent: false, multi_agent_v2: false },
        },
      });
    }
  });

  it("suppresses the newer host-injected team role even when the bridge is enabled", () => {
    const params = threadStartParams(baseRun, "/work", { interactive: true, childAgentBridge: bridge });
    expect(params.config).toMatchObject({
      multi_agent_mode: { custom: expect.stringContaining("Never use collaboration.spawn_agent") },
      mcp_servers: { mythra_agents: { command: bridge.command } },
    });
  });
});
