import test from "node:test";
import assert from "node:assert/strict";

// The bridge talks to Rust through Tauri's invoke; record what it is asked.
const calls = [];
const THEME_TOOL_NAMES = ["get_theme_design_kit", "list_custom_themes", "get_custom_theme", "create_custom_theme", "update_custom_theme", "undo_custom_theme", "apply_custom_theme", "capture_app_screenshot"];
let registration = 0;
// Just enough of a browser window for modules that subscribe at import time.
globalThis.window = globalThis.window ?? { addEventListener() {}, removeEventListener() {} };
window.__TAURI_INTERNALS__ = {
  invoke: async (command, args) => {
    calls.push({ command, args });
    if (command === "child_agent_session_start") {
      const options = args.options;
      const names = [
        ...(options.targets?.length ? ["spawn_mythra_agent"] : options.projectPath ? ["propose_agent_settings"] : []),
        ...(options.themeTools && !options.childThread ? THEME_TOOL_NAMES : []),
      ];
      registration += 1;
      return { registrationId: `r${registration}`, name: "mythra_agents", command: "/app", args: ["--openkiwi-agent-bridge", `/s${registration}/session.json`], configPath: `/s${registration}/mcp.json`, toolNames: names };
    }
    return null;
  },
};

const { ensureChildAgentBridge, resetChildAgentLaunches } = await import("./childAgentSessions.ts");
const { childAgentMcpConfig, codexSupportsMcpToolApproval, threadStartParams } = await import("./turnConfig.ts");
const { MYTHRA_CODE_THEME_INSTRUCTIONS, THEME_DESIGNER_INSTRUCTIONS, mythraCodeDeveloperInstructions, withMythraCodeCompletionInstructions } = await import("./completionPrompt.ts");
const { DEFAULT_CHILD_AGENT_SETTINGS } = await import("./appConfig.ts");

function input(overrides = {}) {
  return {
    policies: {}, links: {}, permission: "ask", provider: "claude", systemPrompt: "", projectInstructionsEnabled: false,
    reasoningEffort: "medium", serviceTier: null,
    readiness: { codexRuntimeAvailable: true, openAiSignedIn: true, openRouterReady: true, claudeReady: true, cursorReady: true },
    settings: { childAgents: { ...DEFAULT_CHILD_AGENT_SETTINGS, enabled: false }, subagentsEnabled: false, subagentMax: 2, subagentEngine: "mythra", managedSubagentV2: false },
    promoteStagedEdits: true,
    newSessionId: () => "session-a",
    ...overrides,
  };
}

const starts = () => calls.filter((call) => call.command === "child_agent_session_start");

test("a plain chat without theme tools still gets no bridge", async () => {
  resetChildAgentLaunches();
  calls.length = 0;
  assert.equal(await ensureChildAgentBridge(input()), null);
  assert.equal(starts().length, 0);
});

test("a plain chat with theme tools registers a theme-only root bridge once", async () => {
  resetChildAgentLaunches();
  calls.length = 0;
  const first = await ensureChildAgentBridge(input({ themeToolsEnabled: true }));
  assert.ok(first);
  assert.deepEqual(first.launch.toolNames, THEME_TOOL_NAMES);
  assert.equal(first.policy.targets.length, 0);
  assert.equal(first.captured, true);
  const options = starts()[0].args.options;
  assert.equal(options.themeTools, true);
  assert.equal(options.childThread, undefined);
  assert.equal(options.projectPath, undefined);
  // The next turn reuses the same registration instead of rotating it.
  const policies = { [first.policy.sessionId]: { ...first.policy, rootThreadId: "thread-1" } };
  const second = await ensureChildAgentBridge(input({ themeToolsEnabled: true, threadId: "thread-1", policies }));
  assert.equal(second.launch.registrationId, first.launch.registrationId);
  assert.equal(starts().length, 1);
});

test("switching theme tools off revokes the plain chat's bridge", async () => {
  resetChildAgentLaunches();
  calls.length = 0;
  const first = await ensureChildAgentBridge(input({ themeToolsEnabled: true }));
  const policies = { [first.policy.sessionId]: { ...first.policy, rootThreadId: "thread-1" } };
  assert.equal(await ensureChildAgentBridge(input({ themeToolsEnabled: false, threadId: "thread-1", policies })), null);
  assert.ok(calls.some((call) => call.command === "child_agent_session_end" && call.args.sessionId === first.policy.sessionId));
});

test("toggling theme tools on a project thread rotates to a matching bridge", async () => {
  resetChildAgentLaunches();
  calls.length = 0;
  const project = { projectPath: "/tmp", settingsProposalsEnabled: true };
  const without = await ensureChildAgentBridge(input({ ...project, themeToolsEnabled: false }));
  assert.ok(!without.launch.toolNames.includes("create_custom_theme"));
  const policies = { [without.policy.sessionId]: { ...without.policy, rootThreadId: "thread-p" } };
  const withThemes = await ensureChildAgentBridge(input({ ...project, themeToolsEnabled: true, threadId: "thread-p", policies }));
  assert.ok(withThemes.launch.toolNames.includes("create_custom_theme"));
  assert.notEqual(withThemes.launch.registrationId, without.launch.registrationId);
  assert.equal(starts().at(-1).args.options.themeTools, true);
});

test("child threads never ask for theme tools", async () => {
  resetChildAgentLaunches();
  calls.length = 0;
  const child = await ensureChildAgentBridge(input({ themeToolsEnabled: true, threadId: "child-1", isChildThread: true, projectPath: "/tmp" }));
  assert.ok(child);
  assert.equal(starts()[0].args.options.themeTools, undefined);
  assert.ok(!child.launch.toolNames.includes("create_custom_theme"));
});

const bridge = (toolNames) => ({ registrationId: "r", name: "mythra_agents", command: "/app", args: ["--openkiwi-agent-bridge", "/s/session.json"], configPath: "/s/mcp.json", toolNames });

test("Codex approves theme tools only on a runtime known to support it", () => {
  assert.equal(codexSupportsMcpToolApproval("0.167.0"), true);
  assert.equal(codexSupportsMcpToolApproval("codex-cli 0.167.1"), true);
  assert.equal(codexSupportsMcpToolApproval("0.168.2"), true);
  assert.equal(codexSupportsMcpToolApproval("0.166.9"), false);
  assert.equal(codexSupportsMcpToolApproval("0.167.0-alpha.1"), false);
  assert.equal(codexSupportsMcpToolApproval(undefined), false);
  const themed = childAgentMcpConfig(bridge(["set_project_run_command", ...THEME_TOOL_NAMES]), "0.167.1");
  assert.deepEqual(themed.mcp_servers.mythra_agents.tools, Object.fromEntries(THEME_TOOL_NAMES.map((tool) => [tool, { approval_mode: "approve" }])));
  assert.equal(themed.mcp_servers.mythra_agents.tools.set_project_run_command, undefined);
  assert.equal(childAgentMcpConfig(bridge(THEME_TOOL_NAMES), "0.160.0").mcp_servers.mythra_agents.tools, undefined);
  assert.equal(childAgentMcpConfig(bridge(THEME_TOOL_NAMES)).mcp_servers.mythra_agents.tools, undefined);
  assert.equal(childAgentMcpConfig(bridge(["spawn_mythra_agent"]), "0.167.1").mcp_servers.mythra_agents.tools, undefined);
});

test("Codex thread start carries the approval keys and the theme guidance", () => {
  const run = { provider: "openai", model: "gpt-5", permission: "read-only", systemPrompt: "", subagentsEnabled: false, subagentMax: 1, subagentEngine: "mythra", reasoningEffort: "medium", ultra: false, serviceTier: null, projectInstructionsEnabled: false };
  const params = threadStartParams(run, "/tmp", { interactive: true, childAgentBridge: bridge(THEME_TOOL_NAMES), codexVersion: "0.167.1", themeDesigner: true });
  assert.equal(params.config.mcp_servers.mythra_agents.tools.create_custom_theme.approval_mode, "approve");
  assert.ok(params.developerInstructions.includes(MYTHRA_CODE_THEME_INSTRUCTIONS));
  assert.ok(params.developerInstructions.includes(THEME_DESIGNER_INSTRUCTIONS));
  assert.ok(params.config.developer_instructions.includes(MYTHRA_CODE_THEME_INSTRUCTIONS));
  const plain = threadStartParams(run, "/tmp", { interactive: true });
  assert.ok(!plain.developerInstructions.includes("Mythra Code themes"));
});

test("theme guidance follows the registered tools; the designer brief stands alone", () => {
  assert.ok(!mythraCodeDeveloperInstructions().includes("Mythra Code themes"));
  const withTools = mythraCodeDeveloperInstructions(false, false, null, null, false, false, false, { toolsAvailable: true });
  assert.ok(withTools.includes(MYTHRA_CODE_THEME_INSTRUCTIONS));
  assert.ok(!withTools.includes(THEME_DESIGNER_INSTRUCTIONS));
  const designerOff = withMythraCodeCompletionInstructions("Be brief.", false, false, null, null, false, false, false, { toolsAvailable: false, designer: true });
  assert.ok(designerOff.startsWith("Be brief."));
  assert.ok(designerOff.includes("Let models create and change themes"));
  assert.ok(!designerOff.includes(MYTHRA_CODE_THEME_INSTRUCTIONS));
  // Budgets: the always-on line stays short; the designer brief stays compact.
  assert.ok(MYTHRA_CODE_THEME_INSTRUCTIONS.length < 520, `${MYTHRA_CODE_THEME_INSTRUCTIONS.length}`);
  assert.ok(THEME_DESIGNER_INSTRUCTIONS.length < 1_600, `${THEME_DESIGNER_INSTRUCTIONS.length}`);
});
