import { useState } from "react";
import { act, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import type { ChildAgentRequest } from "./lib/agentBridge";
import type { ChildAgentPolicy } from "./lib/childAgents";
import { ensureChildAgentBridge, resetChildAgentLaunches } from "./lib/childAgentSessions";
import { resetTaskStore, useTaskStore } from "./lib/taskStore";
import { useTerminal, type TerminalController } from "./hooks/useTerminal";
import { useChildAgents, type ChildAgentContext } from "./hooks/useChildAgents";

// Only native transport/provider boundaries are replaced. Both production
// hooks, launch-context ownership, snapshots and the task store run together
// in a real browser. This does not establish native process behavior.
const bridge = vi.hoisted(() => ({
  startChildAgentSession: vi.fn(), endChildAgentSession: vi.fn(),
  onChildAgentRequest: vi.fn(), respondToChildAgentRequest: vi.fn(),
  reportChildAgentFinished: vi.fn(),
}));
const codex = vi.hoisted(() => ({ rpc: vi.fn(), auditEvent: vi.fn() }));
vi.mock("./lib/agentBridge", () => bridge);
vi.mock("./lib/codex", () => ({ ...codex, listLmStudioModels: vi.fn() }));
vi.mock("./lib/childRun", () => ({ startChildAgentTurn: vi.fn() }));
vi.mock("./lib/claude", () => ({ claudeNativeCompactionConflict: vi.fn(), isClaudeTurnActive: vi.fn(), killClaudeTurn: vi.fn(), loadClaudeTranscript: vi.fn() }));
vi.mock("./lib/cursor", () => ({ isCursorTurnActive: vi.fn(), killCursorTurn: vi.fn(), loadCursorTranscript: vi.fn() }));

const A = "/fixture/project-a/.worktrees/thread-a";
const B = "/fixture/project-b";
const POLICY: ChildAgentPolicy = {
  sessionId: "terminal-session", rootThreadId: "thread-a", maxConcurrent: 1,
  permission: "ask", systemPrompt: "", projectInstructionsEnabled: false,
  reasoningEffort: "high", serviceTier: null, targets: [], capturedAt: 1,
};
const readiness = { codexRuntimeAvailable: false, openAiSignedIn: false, openRouterReady: false, claudeReady: false, cursorReady: false };
const noop = () => undefined;
let deliver: ((request: ChildAgentRequest) => void) | undefined;
let terminal: TerminalController;
let finishCommand: (result: { exitCode: number; stdout: string; stderr: string }) => void;

function Harness() {
  const [selected, setSelected] = useState(A);
  const [panelOpen, setPanelOpen] = useState(false);
  const [timeoutMinutes, setTimeoutMinutes] = useState(17);
  terminal = useTerminal({ scrollback: 100_000, permission: "ask", scope: selected, timeoutMinutes, onError: noop });
  const context: ChildAgentContext = {
    policies: { [POLICY.sessionId]: POLICY }, links: {}, persistChildAgentLinks: noop,
    openRouterModels: [], readiness, projectPathForThread: () => A,
    executionPathFor: () => A, isolationGitDirFor: () => undefined, serviceNameFor: () => "Fixture",
    bindThreadToProject: noop, rememberThread: noop, persistThreadModel: noop,
    persistThreadReasoning: noop, setThreads: noop, cursorSessionIdsRef: { current: {} },
    scheduleClaudeThreadSave: noop, scheduleCursorThreadSave: noop,
    projectSubagentSettingsForThread: () => ({ enabled: false, maxConcurrent: 1, childAgents: { enabled: false, targets: [] } }),
    applyProjectSubagentSettings: noop, applyProjectRunCommand: noop,
    projectRunCommandForThread: () => ({ command: "npm run dev", updatedAt: 1 }),
    applyProjectCheckCommand: noop, projectCheckCommandForThread: () => undefined,
    beginRunCheckpoint: async () => undefined, discardRunCheckpoint: noop,
    resolveSkillPrompt: async (message) => message,
    runProjectCommand: async (rootThreadId, run) => {
      if (rootThreadId !== POLICY.rootThreadId) return { started: false };
      if (selected === A) setPanelOpen(true);
      void terminal.run(run.command, [], A);
      return { started: true, exited: false, output: terminal.tail(A, 1_500) };
    },
    readProjectTerminal: (scope, maximum) => terminal.snapshot(scope, maximum),
  };
  useChildAgents(context);
  return <div>
    <output aria-label="Selected project">{selected}</output>
    <output aria-label="Terminal panel">{panelOpen ? "open" : "closed"}</output>
    <output aria-label="Selected terminal command">{terminal.runningCommand || "idle"}</output>
    <button onClick={() => deliver?.({ requestId: "run", sessionId: POLICY.sessionId, tool: "set_project_run_command", arguments: { run: true } })}>Model starts Run command</button>
    <button onClick={() => { setSelected(B); setTimeoutMinutes(0); setPanelOpen(false); }}>Select project B and disable future deadlines</button>
    <button onClick={() => deliver?.({ requestId: "read", sessionId: POLICY.sessionId, tool: "read_project_terminal", terminalScope: A, arguments: { maxCharacters: 120 } })}>Model reads captured terminal</button>
    <button onClick={() => deliver?.({ requestId: "foreign", sessionId: POLICY.sessionId, tool: "read_project_terminal", terminalScope: B, arguments: {} })}>Model requests another scope</button>
  </div>;
}

beforeEach(async () => {
  resetTaskStore();
  resetChildAgentLaunches();
  vi.resetAllMocks();
  deliver = undefined;
  bridge.startChildAgentSession.mockResolvedValue({ name: "mythra_agents", command: "/fixture/app", args: [], configPath: "/fixture/config", toolNames: ["read_project_terminal", "set_project_run_command", "propose_agent_settings"] });
  bridge.onChildAgentRequest.mockImplementation(async (handler) => { deliver = handler; return noop; });
  bridge.respondToChildAgentRequest.mockResolvedValue(undefined);
  bridge.endChildAgentSession.mockResolvedValue(undefined);
  codex.rpc.mockImplementation(async (method) => {
    if (method === "command/exec") return new Promise((resolve) => { finishCommand = resolve; });
    return {};
  });
  await ensureChildAgentBridge({
    threadId: POLICY.rootThreadId, policies: { [POLICY.sessionId]: POLICY }, links: {},
    settings: { childAgents: { enabled: false, targets: [] }, subagentsEnabled: false, subagentMax: 1, subagentEngine: "mythra" },
    permission: "ask", systemPrompt: "", projectInstructionsEnabled: false,
    reasoningEffort: "high", serviceTier: null, readiness, projectPath: A,
  });
});

it("runs and reads the captured project after selection changes without opening the panel or changing the task", async () => {
  render(<Harness />);
  await waitFor(() => expect(deliver).toBeTypeOf("function"));
  await page.getByRole("button", { name: "Model starts Run command" }).click();
  await waitFor(() => expect(codex.rpc).toHaveBeenCalledWith("command/exec", expect.objectContaining({ cwd: A, timeoutMs: 17 * 60_000 })));
  expect(screen.getByLabelText("Terminal panel")).toHaveTextContent("open");
  const processId = codex.rpc.mock.calls.find(([method]) => method === "command/exec")![1].processId as string;
  await act(async () => { terminal.appendProcess("\u001b[32mready in project A\u001b[0m\n", processId); });
  await page.getByRole("button", { name: "Select project B and disable future deadlines" }).click();
  expect(screen.getByLabelText("Selected project")).toHaveTextContent(B);
  expect(screen.getByLabelText("Selected terminal command")).toHaveTextContent("idle");
  const before = useTaskStore.getState();
  const taskBefore = before.tasks[POLICY.rootThreadId];
  const statusesBefore = before.statuses;
  const callsBeforeRead = codex.rpc.mock.calls.length;
  await page.getByRole("button", { name: "Model reads captured terminal" }).click();
  await waitFor(() => expect(bridge.respondToChildAgentRequest).toHaveBeenCalledWith("read", expect.objectContaining({ scope: A, running: true, command: "npm run dev", text: "$ npm run dev\nready in project A\n", lifetime: "app-session" })));
  expect(screen.getByLabelText("Terminal panel")).toHaveTextContent("closed");
  expect(screen.getByLabelText("Selected project")).toHaveTextContent(B);
  expect(useTaskStore.getState().tasks[POLICY.rootThreadId]).toBe(taskBefore);
  expect(useTaskStore.getState().statuses).toBe(statusesBefore);
  expect(codex.rpc).toHaveBeenCalledTimes(callsBeforeRead);
  expect(terminal.snapshot(B).text).toBe("");
  expect(terminal.snapshot(A).running).toBe(true);

  await act(async () => { finishCommand({ exitCode: 0, stdout: "final A output", stderr: "" }); });
  await page.getByRole("button", { name: "Model reads captured terminal" }).click();
  await waitFor(() => expect(bridge.respondToChildAgentRequest).toHaveBeenLastCalledWith("read", expect.objectContaining({ scope: A, running: false, command: "", text: expect.stringContaining("final A output\n[exit 0]") })));
  expect(screen.getByLabelText("Terminal panel")).toHaveTextContent("closed");
  expect(codex.rpc.mock.calls.find(([method]) => method === "command/exec")![1]).toMatchObject({ timeoutMs: 17 * 60_000 });
});

it("reads an empty captured terminal without starting anything and rejects a different execution folder", async () => {
  render(<Harness />);
  await waitFor(() => expect(deliver).toBeTypeOf("function"));
  const before = useTaskStore.getState();
  await page.getByRole("button", { name: "Model reads captured terminal" }).click();
  await waitFor(() => expect(bridge.respondToChildAgentRequest).toHaveBeenCalledWith("read", expect.objectContaining({ scope: A, running: false, text: "", retainedCharacters: 0 })));
  expect(useTaskStore.getState()).toBe(before);
  expect(screen.getByLabelText("Terminal panel")).toHaveTextContent("closed");
  expect(codex.rpc).not.toHaveBeenCalled();
  await page.getByRole("button", { name: "Model requests another scope" }).click();
  await waitFor(() => expect(bridge.respondToChildAgentRequest).toHaveBeenLastCalledWith("foreign", null, expect.stringContaining("captured execution folder")));
  expect(codex.rpc).not.toHaveBeenCalled();
  expect(useTaskStore.getState()).toBe(before);
});
