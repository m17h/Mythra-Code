import { describe, expect, it } from "vitest";
import type { ScheduleRunSettings } from "../types";
import { MYTHRA_CODE_DELEGATION_INSTRUCTIONS, MYTHRA_CODE_NATIVE_DELEGATION_POLICY, MYTHRA_CODE_SKILL_MENTION_INSTRUCTIONS, mythraCodeDeveloperInstructions } from "./completionPrompt";

/** Skill-mention plus completion guidance: what every turn carries. */
const BASE_INSTRUCTIONS = mythraCodeDeveloperInstructions(false);
import { childAgentMcpConfig, normalizeLmStudioBaseUrl, threadResumeParams, threadRuntimeConfig, threadStartParams, turnStartParams, withCurrentSystemPrompt } from "./turnConfig";
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

describe("current system prompt turn transport", () => {
  it("retains skill/completion guidance in the actual mode override, not only thread/start", () => {
    const params = turnStartParams(baseRun, "thread-1", "/project", [], [], true, { systemPrompt: "CURRENT SYSTEM" });
    const mode = params.collaborationMode as { settings: { developer_instructions: string } };
    expect(mode.settings.developer_instructions).toContain(MYTHRA_CODE_SKILL_MENTION_INSTRUCTIONS);
    expect(mode.settings.developer_instructions).toContain(BASE_INSTRUCTIONS);
  });

  it("preserves the current exact delegation and project tool guidance with a system override", () => {
    const developerInstructions = mythraCodeDeveloperInstructions(true, true, { toolAvailable: true, run: null }, { toolAvailable: true, check: null });
    const params = turnStartParams(baseRun, "thread-1", "/project", [], [], true, { systemPrompt: "CURRENT SYSTEM", developerInstructions });
    const mode = params.collaborationMode as { settings: { developer_instructions: string } };
    expect(mode.settings.developer_instructions).toContain(developerInstructions);
    expect(mode.settings.developer_instructions).toContain("set_project_run_command");
    expect(mode.settings.developer_instructions).toContain("set_project_check_command");
    expect(mode.settings.developer_instructions).toContain("CURRENT SYSTEM");
  });
  it.each(["openai", "openrouter", "lmstudio"] as const)("delivers %s instructions through the per-turn developer channel", (provider) => {
    const run = { ...baseRun, provider, model: "selected/model", reasoningEffort: "high" as const };
    const params = turnStartParams(run, "thread-1", "/project", [], [], true, { systemPrompt: "RESOLVED SYSTEM SKILL" });
    expect(params.collaborationMode).toMatchObject({ mode: "default", settings: {
      model: "selected/model", reasoning_effort: "high", developer_instructions: expect.stringContaining("RESOLVED SYSTEM SKILL"),
    } });
    expect(params.input).toEqual([]);
    expect(params).toMatchObject({ approvalPolicy: "on-request", sandboxPolicy: { type: "workspaceWrite" } });
  });

  it("makes an empty current system prompt explicitly clear older app skill snapshots", () => {
    const params = turnStartParams(baseRun, "thread-1", "/project", [], [], true, { systemPrompt: "" });
    const mode = params.collaborationMode as { settings: { developer_instructions: string } };
    expect(mode.settings.developer_instructions).toMatch(/latest.*authoritative/i);
    expect(mode.settings.developer_instructions).toMatch(/supersedes.*earlier/i);
    expect(mode.settings.developer_instructions).toMatch(/no additional app system prompt/i);
    expect(mode.settings.developer_instructions).toMatch(/user.*skills.*remain valid/i);
  });

  it("does not change legacy default behavior when no prompt override is supplied", () => {
    expect(turnStartParams(baseRun, "thread-1", "/project", [])).not.toHaveProperty("collaborationMode");
  });

  it("uses a known current model only when the selected run model is empty, never a guessed default", () => {
    const run = { ...baseRun, model: "", ultra: true };
    expect(turnStartParams(run, "thread-1", "/project", [], [], false, { systemPrompt: "current", model: "actual-loaded-model" })).toMatchObject({
      approvalPolicy: "never", collaborationMode: { settings: { model: "actual-loaded-model", reasoning_effort: "ultra" } },
    });
    expect(() => turnStartParams(run, "thread-1", "/project", [], [], true, { systemPrompt: "current" })).toThrow(/current model/i);
  });

  it("preserves existing collaboration guidance, mode, and unrelated options without mutating them", () => {
    const original = { threadId: "thread-1", model: "selected-model", effort: "high", serviceTier: "priority", outputSchema: { type: "object" }, collaborationMode: {
      mode: "plan", settings: { model: "older-model", reasoning_effort: "low", developer_instructions: "Keep the existing plan guidance." },
    } };
    const params = withCurrentSystemPrompt(original, "CURRENT SYSTEM", "fallback-not-used");
    expect(params).toMatchObject({ serviceTier: "priority", outputSchema: { type: "object" }, collaborationMode: { mode: "plan", settings: {
      model: "selected-model", reasoning_effort: "high", developer_instructions: expect.stringContaining("Keep the existing plan guidance."),
    } } });
    expect((params.collaborationMode as { settings: { developer_instructions: string } }).settings.developer_instructions).toContain("CURRENT SYSTEM");
    expect(original.collaborationMode.settings.developer_instructions).toBe("Keep the existing plan guidance.");
  });

  it("resumes genuinely unloaded threads with resolved base instructions", () => {
    expect(threadResumeParams({ ...baseRun, systemPrompt: "RESOLVED BASE" }, "thread-1", "/project")).toHaveProperty("baseInstructions", "RESOLVED BASE");
  });

  it.each(["RAW @skill", "RESOLVED SYSTEM SKILL"])("uses a single current snapshot rather than sticky startup instructions for %s", (systemPrompt) => {
    const run = { ...baseRun, systemPrompt };
    expect(threadStartParams(run, "/project", { interactive: true, perTurnSystemPrompt: true })).toHaveProperty("baseInstructions", "");
    expect(threadResumeParams(run, "thread-1", "/project", { perTurnSystemPrompt: true })).toHaveProperty("baseInstructions", "");
    expect(threadStartParams(run, "/project", { interactive: true })).toHaveProperty("baseInstructions", systemPrompt);
    expect(threadResumeParams(run, "thread-1", "/project")).toHaveProperty("baseInstructions", systemPrompt);
    const mode = turnStartParams(run, "thread-1", "/project", [], [], true, { systemPrompt }).collaborationMode as { settings: { developer_instructions: string } };
    expect(mode.settings.developer_instructions.split(systemPrompt)).toHaveLength(2);
  });
});

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
    expect(threadStartParams(run, "/tmp/project", { interactive: false })).toMatchObject({ approvalPolicy: "never", config: { features: { default_mode_request_user_input: false } } });
    expect(threadResumeParams(run, "thread-1", "/tmp/project", { interactive: false, refreshRuntimeConfig: true })).toMatchObject({
      approvalPolicy: "never",
      config: { features: { default_mode_request_user_input: false } },
    });
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

  it("enables interactive OpenAI questions while retaining the delegation boundary", () => {
    const config = threadRuntimeConfig(baseRun, { modelContextWindow: 1_000_000 });
    expect(config).not.toHaveProperty("model_context_window");
    expect(config).not.toHaveProperty("apps");
    expect(config.features).toEqual({ default_mode_request_user_input: true, multi_agent: false, multi_agent_v2: false });
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

  it("exposes the saved Checks command when its project tool is available without delegation", () => {
    const projectBridge = { ...bridge, toolNames: ["propose_agent_settings", "set_project_run_command", "set_project_check_command"] };
    const params = threadStartParams(baseRun, "/tmp/project", {
      interactive: true,
      childAgentBridge: projectBridge,
      projectCheckCommand: { command: "npm run verify", updatedAt: 1 },
    });
    expect(params.developerInstructions).toContain("set_project_check_command");
    expect(params.developerInstructions).toContain("`npm run verify`");
    expect(params.config).toMatchObject({ developer_instructions: expect.stringContaining("set_project_check_command") });
    expect(threadStartParams(baseRun, "/tmp/project", { interactive: true }).developerInstructions).not.toContain("set_project_check_command");
  });

  it("keeps the Checks tool and guidance on OpenRouter and LM Studio starts and resumes", () => {
    const projectBridge = { ...bridge, toolNames: ["propose_agent_settings", "set_project_run_command", "set_project_check_command"] };
    for (const run of [
      { ...baseRun, provider: "openrouter" as const, model: "x-ai/grok-4.5" },
      { ...baseRun, provider: "lmstudio" as const, model: "local-model" },
    ]) {
      const options = { childAgentBridge: projectBridge, projectCheckCommand: { command: "npm run verify", updatedAt: 1 } };
      const start = threadStartParams(run, "/tmp/project", { ...options, interactive: true });
      const resume = threadResumeParams(run, "thread-1", "/tmp/project", options);
      for (const params of [start, resume]) {
        expect(params.developerInstructions).toContain("set_project_check_command");
        expect(params.developerInstructions).toContain("`npm run verify`");
        expect(params.config).toMatchObject({
          mcp_servers: { mythra_agents: { command: projectBridge.command } },
          developer_instructions: expect.stringContaining("set_project_check_command"),
        });
      }
    }
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
