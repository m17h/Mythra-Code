import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ChildAgentBridgeLaunch } from "./agentBridge";

const bridge = vi.hoisted(() => ({ startChildAgentSession: vi.fn(), endChildAgentSession: vi.fn() }));
vi.mock("./agentBridge", () => bridge);

import { ensureChildAgentBridge, projectTerminalScopeForSession, releaseChildAgentSession, releaseChildAgentSessions, resetChildAgentLaunches } from "./childAgentSessions";

const launch: ChildAgentBridgeLaunch = { name: "mythra_agents", command: "/fixture/app", args: [], configPath: "/fixture/mcp.json", toolNames: ["read_project_terminal", "propose_agent_settings"] };
const input = {
  threadId: "root", projectPath: "/fixture/project", policies: {}, links: {},
  settings: { subagentEngine: "mythra" as const, subagentsEnabled: false, subagentMax: 1, childAgents: { enabled: false, targets: [] } },
  permission: "read-only" as const, systemPrompt: "", projectInstructionsEnabled: false,
  reasoningEffort: "high" as const, serviceTier: null,
  readiness: { codexRuntimeAvailable: true, openAiSignedIn: true, openRouterReady: false, claudeReady: false, cursorReady: false },
  newSessionId: () => "registration-review", settingsProposalsEnabled: true,
};

beforeEach(() => { resetChildAgentLaunches(); vi.resetAllMocks(); bridge.endChildAgentSession.mockResolvedValue(undefined); });
afterEach(() => { vi.restoreAllMocks(); });

it("does not restore terminal read authority after release wins a pending registration", async () => {
  let complete!: (value: ChildAgentBridgeLaunch) => void;
  bridge.startChildAgentSession.mockImplementation(() => new Promise<ChildAgentBridgeLaunch>((resolve) => { complete = resolve; }));
  const pending = ensureChildAgentBridge(input);
  await vi.waitFor(() => expect(complete).toBeDefined());
  const released = releaseChildAgentSession("registration-review");
  complete(launch);
  await pending.catch(() => undefined);
  await released;
  expect(projectTerminalScopeForSession("registration-review")).toBeUndefined();
});

it("does not restore terminal read authority after reload clears a pending registration", async () => {
  let complete!: (value: ChildAgentBridgeLaunch) => void;
  bridge.startChildAgentSession.mockImplementation(() => new Promise<ChildAgentBridgeLaunch>((resolve) => { complete = resolve; }));
  const pending = ensureChildAgentBridge(input);
  await vi.waitFor(() => expect(complete).toBeDefined());
  resetChildAgentLaunches();
  complete(launch);
  await pending.catch(() => undefined);
  expect(projectTerminalScopeForSession("registration-review")).toBeUndefined();
});

it("cancels an ensure released before its native registration starts", async () => {
  bridge.startChildAgentSession.mockResolvedValue(launch);
  const pending = ensureChildAgentBridge(input).catch(() => undefined);
  await releaseChildAgentSession("registration-review");
  await pending;
  expect(bridge.startChildAgentSession).not.toHaveBeenCalled();
  expect(projectTerminalScopeForSession("registration-review")).toBeUndefined();
});

it("retires stale native material before registering a newer execution folder", async () => {
  let complete!: (value: ChildAgentBridgeLaunch) => void;
  const operations: string[] = [];
  bridge.startChildAgentSession.mockImplementationOnce(() => {
    operations.push("old-start");
    return new Promise<ChildAgentBridgeLaunch>((resolve) => { complete = resolve; });
  }).mockImplementationOnce(async () => { operations.push("new-start"); return launch; });
  bridge.endChildAgentSession.mockImplementation(async () => { operations.push("end"); });
  const old = ensureChildAgentBridge(input).catch(() => undefined);
  await vi.waitFor(() => expect(complete).toBeDefined());
  const released = releaseChildAgentSession("registration-review");
  const next = ensureChildAgentBridge({ ...input, projectPath: "/fixture/new-project" });
  complete(launch);
  await old;
  await released;
  await next;
  expect(operations).toEqual(["old-start", "end", "end", "new-start"]);
  expect(projectTerminalScopeForSession("registration-review")).toBe("/fixture/new-project");
});

it("serializes overlapping execution-folder registrations and keeps only the newest scope", async () => {
  let complete!: (value: ChildAgentBridgeLaunch) => void;
  const operations: string[] = [];
  bridge.startChildAgentSession.mockImplementationOnce(() => {
    operations.push("old-start");
    return new Promise<ChildAgentBridgeLaunch>((resolve) => { complete = resolve; });
  }).mockImplementationOnce(async () => { operations.push("new-start"); return launch; });
  bridge.endChildAgentSession.mockImplementation(async () => { operations.push("end"); });
  const old = ensureChildAgentBridge(input).catch(() => undefined);
  await vi.waitFor(() => expect(complete).toBeDefined());
  const next = ensureChildAgentBridge({ ...input, projectPath: "/fixture/new-project" });
  await Promise.resolve();
  complete(launch);
  await old;
  await next;
  expect(operations).toEqual(["old-start", "end", "new-start"]);
  expect(projectTerminalScopeForSession("registration-review")).toBe("/fixture/new-project");
});

it("does not restart an off-mode bridge when release interrupts its internal replacement", async () => {
  bridge.startChildAgentSession.mockResolvedValue(launch);
  const first = await ensureChildAgentBridge(input);
  let completeEnd!: () => void;
  bridge.endChildAgentSession.mockImplementationOnce(() => new Promise<void>((resolve) => { completeEnd = resolve; })).mockResolvedValue(undefined);
  const replacement = ensureChildAgentBridge({ ...input, projectPath: "/fixture/rebound", policies: { [first!.policy.sessionId]: first!.policy } }).catch(() => undefined);
  await vi.waitFor(() => expect(completeEnd).toBeDefined());
  const released = releaseChildAgentSession("registration-review");
  completeEnd();
  await replacement;
  await released;
  expect(bridge.startChildAgentSession).toHaveBeenCalledOnce();
  expect(projectTerminalScopeForSession("registration-review")).toBeUndefined();
});

it.each(["release", "reload"])("cancels a child registration when %s wins its asynchronous identity calculation", async (mode) => {
  let completeDigest!: (value: ArrayBuffer) => void;
  const digest = new Uint8Array(32).buffer;
  vi.spyOn(crypto.subtle, "digest").mockImplementationOnce(() => new Promise<ArrayBuffer>((resolve) => { completeDigest = resolve; })).mockResolvedValue(digest);
  bridge.startChildAgentSession.mockResolvedValue(launch);
  const pending = ensureChildAgentBridge({ ...input, threadId: "native-child", isChildThread: true, newSessionId: undefined }).catch(() => undefined);
  expect(completeDigest).toBeDefined();
  if (mode === "release") await releaseChildAgentSessions({}, "native-child", {}, true);
  else resetChildAgentLaunches();
  completeDigest(digest);
  await pending;
  expect(bridge.startChildAgentSession).not.toHaveBeenCalled();
});

it("does not let an old child identity calculation replace newer permission and scope", async () => {
  let completeDigest!: (value: ArrayBuffer) => void;
  const digest = new Uint8Array(32).buffer;
  vi.spyOn(crypto.subtle, "digest").mockImplementationOnce(() => new Promise<ArrayBuffer>((resolve) => { completeDigest = resolve; })).mockResolvedValue(digest);
  bridge.startChildAgentSession.mockResolvedValue({ ...launch, toolNames: ["language_tool_query"] });
  const childInput = { ...input, threadId: "native-child", isChildThread: true, newSessionId: undefined };
  const old = ensureChildAgentBridge({ ...childInput, permission: "full" }).catch(() => undefined);
  await ensureChildAgentBridge({ ...childInput, projectPath: "/fixture/new-project" });
  completeDigest(digest);
  await old;
  expect(bridge.startChildAgentSession).toHaveBeenCalledOnce();
  expect(bridge.startChildAgentSession).toHaveBeenCalledWith(expect.objectContaining({ permission: "read-only" }), [], [], expect.objectContaining({ projectPath: "/fixture/new-project" }));
});

it("releases the exact provisional child identity before a synchronous first registration can proceed", async () => {
  bridge.startChildAgentSession.mockResolvedValue(launch);
  const pending = ensureChildAgentBridge({ ...input, threadId: "native-child", isChildThread: true }).catch(() => undefined);
  const released = await releaseChildAgentSessions({}, "native-child", {}, true);
  await pending;
  expect(released).toEqual(["registration-review"]);
  expect(bridge.endChildAgentSession).toHaveBeenCalledWith("registration-review");
  expect(bridge.startChildAgentSession).not.toHaveBeenCalled();
});

it("orders a newer child registration after an older release whose identity calculation is pending", async () => {
  let completeDigest!: (value: ArrayBuffer) => void;
  const digest = new Uint8Array(32).buffer;
  vi.spyOn(crypto.subtle, "digest").mockImplementationOnce(() => new Promise<ArrayBuffer>((resolve) => { completeDigest = resolve; })).mockResolvedValue(digest);
  const operations: string[] = [];
  bridge.startChildAgentSession.mockImplementation(async () => { operations.push("start"); return launch; });
  bridge.endChildAgentSession.mockImplementation(async () => { operations.push("end"); });
  const released = releaseChildAgentSessions({}, "native-child", {}, true);
  expect(completeDigest).toBeDefined();
  const next = ensureChildAgentBridge({ ...input, threadId: "native-child", isChildThread: true, newSessionId: undefined });
  await Promise.resolve();
  expect(bridge.startChildAgentSession).not.toHaveBeenCalled();
  completeDigest(digest);
  await released;
  await next;
  expect(operations).toEqual(["end", "start"]);
});
