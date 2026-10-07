import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Thread } from "../types";
import { defaultPreferenceLearningScope } from "../lib/preferenceLearning";
import { createPreferenceLearningStore } from "../lib/preferenceLearningStore";
import { useTaskStore } from "../lib/taskStore";
import { usePreferenceLearning } from "./usePreferenceLearning";
import { feedbackSkillInvocationText, formatFeedbackPrompt } from "../lib/reviewFeedback";
import type { PreferenceLearningScopeState } from "../lib/preferenceLearningTypes";
const bridge = vi.hoisted(() => ({ store: null as ReturnType<typeof createPreferenceLearningStore> | null, invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: bridge.invoke }));
vi.mock("../lib/preferenceLearningStore", async (original) => {
  const actual = await original<typeof import("../lib/preferenceLearningStore")>();
  return { ...actual, getPreferenceLearningScope: (key: string) => bridge.store!.get(key), getPreferenceLearningHydrated: () => bridge.store!.isHydrated(),
    loadPreferenceLearning: () => bridge.store!.load(), subscribePreferenceLearning: (listener: () => void) => bridge.store!.subscribe(listener),
    getPreferenceLearningJob: (key: string) => bridge.store!.getJob(key), setPreferenceLearningJob: (key: string, job: Parameters<typeof actual.setPreferenceLearningJob>[1]) => bridge.store!.setJob(key, job),
    reservePreferenceLearningAnalysis: (...args: Parameters<typeof actual.reservePreferenceLearningAnalysis>) => bridge.store!.reserve(...args),
    commitPreferenceAnalysis: (...args: Parameters<typeof actual.commitPreferenceAnalysis>) => bridge.store!.commit(...args) };
});
const thread = (id = "t"): Thread => ({ id, name: null, cwd: "/p", preview: "", updatedAt: 1, modelProvider: "openai" });
function fixture(enabled = true) {
  let states: PreferenceLearningScopeState[] = [{ ...defaultPreferenceLearningScope("app"), enabled, enabledAt: Date.now() - 10, revision: 1 }];
  bridge.store = createPreferenceLearningStore({ list: async () => states, save: async (scopeKey, revision, value) => {
    const current = states.find((state) => state.scopeKey === scopeKey);
    if (current?.revision !== revision) throw new Error("stale");
    const next = { scopeKey, revision: revision + 1, ...value }; states = states.map((state) => state.scopeKey === scopeKey ? next : state); return next;
  } });
  const onUpdated = vi.fn();
  return { options: { catalogs: { openai: [{ id: "gpt-6-luna", label: "Luna" }] }, lmStudioBaseUrl: "http://localhost:1234", getThread: (id: string) => thread(id), getProjectId: () => null,
    isEligibleThread: () => true, onUpdated, debounceMs: 60_000 }, onUpdated };
}
function addTurn(id = "t", userId = "local-u", text = "Keep answers brief.", turnId = "turn") {
  useTaskStore.getState().ensureTask(id);
  useTaskStore.getState().appendUserMessage(id, { id: userId, role: "user", text, turnId });
  useTaskStore.getState().setActiveTurn(id, turnId);
  useTaskStore.getState().startAssistantMessage(id, { id: `a-${turnId}`, role: "assistant", text: "Okay", turnId, phase: "final" });
}
async function settle() { await act(async () => { await vi.advanceTimersByTimeAsync(60_001); }); }
function historyBridge(analysis: () => Promise<unknown> = async () => ({ preferences: [] })) {
  bridge.invoke.mockImplementation((command: string, args: { method?: string; params?: { threadId?: string } }) => {
    if (command === "codex_rpc" && args.method === "thread/read") return Promise.resolve({ thread: thread(args.params?.threadId) });
    if (command === "codex_rpc") return Promise.resolve({ data: [{ id: "turn", status: "completed", items: [{ id: "local-u", type: "userMessage", text: "Keep answers brief." }] }], nextCursor: null });
    return command === "analyze_user_preferences" ? analysis() : Promise.resolve(undefined);
  });
}
beforeEach(() => { vi.useFakeTimers(); useTaskStore.setState({ tasks: {}, statuses: {} }); bridge.invoke.mockReset().mockImplementation((command: string) => command === "analyze_user_preferences" ? Promise.resolve({ preferences: [{ instruction: "Keep answers brief.", evidenceIds: ["t:local-u"] }] }) : Promise.resolve(undefined)); });
afterEach(() => { vi.useRealTimers(); });
describe("automatic preference learning runner", () => {
  it("skips missing native history references and analyzes the remaining durable conversation", async () => {
    const { options } = fixture();
    const analysis = vi.fn(async () => ({ preferences: [] }));
    historyBridge(analysis);
    const read = bridge.invoke.getMockImplementation()!;
    bridge.invoke.mockImplementation((command: string, args: { method?: string; params?: { threadId?: string } }) => {
      if (command === "codex_rpc" && args.method === "thread/read" && args.params?.threadId === "missing") return Promise.reject("thread not loaded: missing");
      return read(command, args);
    });
    const view = renderHook(() => usePreferenceLearning({ ...options, getHistoryThreads: async () => [thread("valid"), thread("missing")] }));
    await act(async () => {});
    await act(async () => { await view.result.current.requestHistory("app"); });
    expect(view.result.current.historyProgress).toMatchObject({ status: "partial", threads: 2, messages: 1, skipped: 1 });
    expect(analysis).toHaveBeenCalledTimes(1);
    expect(bridge.store!.get("app").checkpoints.valid).toBeTruthy();
    expect(bridge.store!.get("app").checkpoints.missing).toBeUndefined();
    expect(bridge.store!.get("app").analysisRequestsAt).toHaveLength(1);
  });
  it("finishes all-missing native history as partial without analysis or quota reservation", async () => {
    const { options } = fixture();
    bridge.invoke.mockImplementation((command: string, args: { method?: string; params?: { threadId?: string } }) => {
      if (command === "codex_rpc" && args.method === "thread/read") return Promise.reject(`thread not loaded: ${args.params?.threadId}`);
      throw new Error("No other request may run for missing history");
    });
    const view = renderHook(() => usePreferenceLearning({ ...options, getHistoryThreads: async () => [thread("missing")] }));
    await act(async () => {});
    await act(async () => { await view.result.current.requestHistory("app"); });
    expect(view.result.current.historyProgress).toMatchObject({ status: "partial", threads: 1, messages: 0, skipped: 1 });
    expect(bridge.invoke).toHaveBeenCalledExactlyOnceWith("codex_rpc", { method: "thread/read", params: { threadId: "missing", includeTurns: false } });
    expect(bridge.store!.get("app").analysisRequestsAt).toBeUndefined();
    expect(bridge.store!.get("app").revision).toBe(1);
  });
  it.each(["claude", "cursor"])("finishes all-missing local %s history as partial without analysis or quota reservation", async (provider) => {
    const { options } = fixture();
    bridge.invoke.mockImplementation((command: string) => {
      if (command === "local_transcript_page_read") return Promise.resolve(null);
      throw new Error("No other request may run for missing local history");
    });
    const missing = { ...thread("missing"), modelProvider: provider };
    const view = renderHook(() => usePreferenceLearning({ ...options, getThread: () => missing, getHistoryThreads: async () => [missing] }));
    await act(async () => {});
    await act(async () => { await view.result.current.requestHistory("app"); });
    expect(view.result.current.historyProgress).toMatchObject({ status: "partial", threads: 1, messages: 0, skipped: 1 });
    expect(bridge.invoke).toHaveBeenCalledExactlyOnceWith("local_transcript_page_read", { provider, threadId: "missing", cursor: null, byteBudget: 40 * 1024 });
    expect(bridge.store!.get("app").analysisRequestsAt).toBeUndefined();
    expect(bridge.store!.get("app").revision).toBe(1);
  });
  it("keeps history analyzing until its provider resolves and reports unchanged saved success", async () => {
    const { options } = fixture(); let finish!: (value: unknown) => void;
    historyBridge(() => new Promise((resolve) => { finish = resolve; }));
    const getHistoryThreads = vi.fn(async () => [thread()]);
    const view = renderHook(() => usePreferenceLearning({ ...options, getHistoryThreads })); await act(async () => {});
    await act(async () => { await view.result.current.requestHistory("app"); });
    expect(view.result.current.historyProgress).toMatchObject({ status: "analyzing", messages: 1 });
    const runId = view.result.current.historyProgress!.runId;
    expect(runId).toBeTruthy();
    await act(async () => { await view.result.current.requestHistory("app"); }); expect(getHistoryThreads).toHaveBeenCalledTimes(1);
    await act(async () => { finish({ preferences: [] }); });
    expect(view.result.current.historyProgress).toMatchObject({ runId, status: "complete", changed: false });
    expect(bridge.store!.get("app").checkpoints.t).toBeTruthy();
  });
  it("keeps history queued through native reservation and saving through the native commit", async () => {
    const { options } = fixture(); let state: PreferenceLearningScopeState = { ...defaultPreferenceLearningScope("app"), enabled: true, enabledAt: Date.now() - 10, revision: 1 };
    const releases: Array<() => void> = [];
    bridge.store = createPreferenceLearningStore({ list: async () => [state], save: async (scopeKey, revision, value) => {
      await new Promise<void>((resolve) => { releases.push(resolve); });
      state = { scopeKey, revision: revision + 1, ...value }; return state;
    } });
    historyBridge(async () => ({ preferences: [{ instruction: "Keep answers brief.", evidenceIds: ["t:local-u"] }] }));
    const view = renderHook(() => usePreferenceLearning({ ...options, getHistoryThreads: async () => [thread()] })); await act(async () => {});
    await act(async () => { await view.result.current.requestHistory("app"); });
    expect(view.result.current.historyProgress?.status).toBe("queued");
    expect(bridge.invoke.mock.calls.filter(([command]) => command === "analyze_user_preferences")).toHaveLength(0);
    await act(async () => { releases[0](); });
    expect(view.result.current.historyProgress?.status).toBe("saving");
    expect(bridge.store!.get("app").markdown).toBe("");
    await act(async () => { releases[1](); });
    expect(view.result.current.historyProgress).toMatchObject({ status: "complete", changed: true });
    expect(bridge.store!.get("app").markdown).toContain("Keep answers brief.");
  });
  it("reports history provider errors without a premature completion and allows retry", async () => {
    const { options } = fixture(); const analysis = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce({ preferences: [] }); historyBridge(analysis);
    const view = renderHook(() => usePreferenceLearning({ ...options, getHistoryThreads: async () => [thread()] })); await act(async () => {});
    await act(async () => { await view.result.current.requestHistory("app"); });
    expect(view.result.current.historyProgress?.status).toBe("error");
    const failedRun = view.result.current.historyProgress!.runId;
    expect(bridge.store!.get("app").checkpoints).toEqual({});
    await act(async () => { await view.result.current.requestHistory("app"); });
    expect(view.result.current.historyProgress?.status).toBe("complete");
    expect(view.result.current.historyProgress!.runId).not.toBe(failedRun); expect(analysis).toHaveBeenCalledTimes(2);
  });
  it("does not let a cancelled provider's late result complete a newer history run", async () => {
    const { options } = fixture(); let finish!: (value: unknown) => void;
    historyBridge(() => new Promise((resolve) => { finish = resolve; }));
    let finishDiscovery!: (value: Thread[]) => void;
    const getHistoryThreads = vi.fn().mockResolvedValueOnce([thread()]).mockImplementationOnce(() => new Promise<Thread[]>((resolve) => { finishDiscovery = resolve; }));
    const view = renderHook(() => usePreferenceLearning({ ...options, getHistoryThreads })); await act(async () => {});
    await act(async () => { await view.result.current.requestHistory("app"); });
    const firstRun = view.result.current.historyProgress!.runId;
    act(() => view.result.current.cancelScope("app")); expect(view.result.current.historyProgress?.status).toBe("cancelled");
    let secondRequest!: Promise<void>; act(() => { secondRequest = view.result.current.requestHistory("app"); });
    expect(getHistoryThreads).toHaveBeenCalledTimes(2);
    const secondRun = view.result.current.historyProgress!.runId; expect(secondRun).not.toBe(firstRun);
    await act(async () => { finish({ preferences: [] }); });
    expect(view.result.current.historyProgress).toMatchObject({ runId: secondRun, status: "reading" });
    await act(async () => { finishDiscovery([]); await secondRequest; });
    expect(view.result.current.historyProgress).toMatchObject({ runId: secondRun, status: "complete", messages: 0 });
  });
  it("reports a failed native history save as an error without advancing checkpoints", async () => {
    const { options } = fixture(); let state: PreferenceLearningScopeState = { ...defaultPreferenceLearningScope("app"), enabled: true, enabledAt: Date.now() - 10, revision: 1 };
    let saves = 0;
    bridge.store = createPreferenceLearningStore({ list: async () => [state], save: async (scopeKey, revision, value) => {
      if (++saves === 2) throw new Error("disk write failed");
      state = { scopeKey, revision: revision + 1, ...value }; return state;
    } });
    historyBridge(async () => ({ preferences: [{ instruction: "Keep answers brief.", evidenceIds: ["t:local-u"] }] }));
    const view = renderHook(() => usePreferenceLearning({ ...options, getHistoryThreads: async () => [thread()] })); await act(async () => {});
    await act(async () => { await view.result.current.requestHistory("app"); });
    expect(view.result.current.historyProgress).toMatchObject({ status: "error" });
    expect(view.result.current.historyProgress?.message).toContain("could not be saved");
    expect(bridge.store!.get("app").checkpoints).toEqual({}); expect(bridge.store!.get("app").markdown).toBe("");
  });
  it.each(["model", "disable", "clear"])("reports the accepted history save before a later %s change", async (change) => {
    const { options } = fixture(); let state: PreferenceLearningScopeState = { ...defaultPreferenceLearningScope("app"), enabled: true, enabledAt: Date.now() - 10, revision: 1 };
    let saves = 0; let release!: () => void;
    bridge.store = createPreferenceLearningStore({ list: async () => [state], save: async (scopeKey, revision, value) => {
      if (++saves === 2) await new Promise<void>((resolve) => { release = resolve; });
      state = { scopeKey, revision: revision + 1, ...value }; return state;
    } });
    historyBridge(async () => ({ preferences: [{ instruction: "Keep answers brief.", evidenceIds: ["t:local-u"] }] })); const view = renderHook(() => usePreferenceLearning({ ...options, getHistoryThreads: async () => [thread()] })); await act(async () => {});
    await act(async () => { await view.result.current.requestHistory("app"); }); expect(view.result.current.historyProgress?.status).toBe("saving");
    let configured!: Promise<PreferenceLearningScopeState>; act(() => {
      configured = change === "clear" ? bridge.store!.clear("app")
        : bridge.store!.configure("app", change === "disable" ? { enabled: false } : { model: "gpt-6-sol" });
    });
    expect(view.result.current.historyProgress?.status).toBe("saving");
    await act(async () => { release(); await configured; });
    expect(view.result.current.historyProgress).toMatchObject({ status: "complete", changed: true, superseded: true });
    expect(options.onUpdated).not.toHaveBeenCalled();
    expect(bridge.store!.get("app").markdown).toBe(change === "clear" ? "" : "- Keep answers brief.");
    expect(bridge.store!.getJob("app").status).toBe("idle");
  });
  it("finishes an already dispatched atomic save when explicit cancellation arrives", async () => {
    const { options } = fixture(); let state: PreferenceLearningScopeState = { ...defaultPreferenceLearningScope("app"), enabled: true, enabledAt: Date.now() - 10, revision: 1 };
    let saves = 0; let release!: () => void;
    bridge.store = createPreferenceLearningStore({ list: async () => [state], save: async (scopeKey, revision, value) => {
      if (++saves === 2) await new Promise<void>((resolve) => { release = resolve; });
      state = { scopeKey, revision: revision + 1, ...value }; return state;
    } });
    historyBridge(); const view = renderHook(() => usePreferenceLearning({ ...options, getHistoryThreads: async () => [thread()] })); await act(async () => {});
    await act(async () => { await view.result.current.requestHistory("app"); }); expect(view.result.current.historyProgress?.status).toBe("saving");
    act(() => view.result.current.cancelScope("app")); expect(view.result.current.historyProgress?.status).toBe("saving");
    await act(async () => { release(); });
    expect(view.result.current.historyProgress).toMatchObject({ status: "complete", changed: false });
    expect(bridge.store!.get("app").checkpoints.t).toBeTruthy();
  });
  it("reports a full history request budget as error without calling the analysis provider", async () => {
    const { options } = fixture(); const state: PreferenceLearningScopeState = { ...defaultPreferenceLearningScope("app"), enabled: true, enabledAt: Date.now() - 10, revision: 1,
      analysisRequestsAt: Array.from({ length: 12 }, () => Date.now() - 1) };
    bridge.store = createPreferenceLearningStore({ list: async () => [state], save: vi.fn() }); historyBridge();
    const view = renderHook(() => usePreferenceLearning({ ...options, getHistoryThreads: async () => [thread()] })); await act(async () => {});
    await act(async () => { await view.result.current.requestHistory("app"); });
    expect(view.result.current.historyProgress?.status).toBe("error"); expect(view.result.current.historyProgress?.message).toContain("daily request limit");
    expect(bridge.invoke.mock.calls.filter(([command]) => command === "analyze_user_preferences")).toHaveLength(0);
  });
  it("reports a full learning queue as a history error instead of completion", async () => {
    const { options } = fixture(); let states: PreferenceLearningScopeState[] = ["app", ...Array.from({ length: 6 }, (_, index) => `project:p${index}`)]
      .map((scopeKey) => ({ ...defaultPreferenceLearningScope(scopeKey), enabled: true, enabledAt: Date.now() - 10, revision: 1 }));
    bridge.store = createPreferenceLearningStore({ list: async () => states, save: async (scopeKey, revision, value) => {
      const next = { scopeKey, revision: revision + 1, ...value }; states = states.map((state) => state.scopeKey === scopeKey ? next : state); return next;
    } });
    historyBridge(() => new Promise(() => {}));
    const view = renderHook(() => usePreferenceLearning({ ...options, getProjectId: (candidate) => candidate.id.startsWith("p") ? candidate.id : null, getHistoryThreads: async () => [thread("past")] })); await act(async () => {});
    addTurn(); act(() => { view.result.current.captureUserPrompt("t", "local-u", "Keep answers brief."); useTaskStore.getState().completeTurn("t", "turn", "completed"); }); await settle();
    for (let index = 0; index < 6; index += 1) {
      const id = `p${index}`; addTurn(id); act(() => { view.result.current.captureUserPrompt(id, "local-u", "Keep answers brief."); useTaskStore.getState().completeTurn(id, "turn", "completed"); });
    }
    await act(async () => { await view.result.current.requestHistory("app"); });
    expect(view.result.current.historyProgress?.status).toBe("error"); expect(view.result.current.historyProgress?.message).toContain("queue is full");
    expect(bridge.invoke.mock.calls.filter(([command]) => command === "analyze_user_preferences")).toHaveLength(1);
  });
  it("reports bounded coverage only after a successful history save", async () => {
    const { options } = fixture(); let finish!: (value: unknown) => void;
    historyBridge(() => new Promise((resolve) => { finish = resolve; }));
    const view = renderHook(() => usePreferenceLearning({ ...options, getHistoryThreads: async () => Array.from({ length: 9 }, (_, index) => thread(`t${index}`)) })); await act(async () => {});
    await act(async () => { await view.result.current.requestHistory("app"); });
    expect(view.result.current.historyProgress).toMatchObject({ status: "analyzing", limited: true, threads: 8 });
    await act(async () => { finish({ preferences: [] }); });
    expect(view.result.current.historyProgress).toMatchObject({ status: "partial", changed: false, limited: true, threads: 8 });
  });
  it("marks an empty history scan complete without any provider request", async () => {
    const { options } = fixture(); historyBridge();
    const view = renderHook(() => usePreferenceLearning({ ...options, getHistoryThreads: async () => [] })); await act(async () => {});
    await act(async () => { await view.result.current.requestHistory("app"); });
    expect(view.result.current.historyProgress).toMatchObject({ status: "complete", messages: 0, changed: false });
    expect(bridge.invoke).not.toHaveBeenCalled();
  });
  it("reports no eligible messages when earlier queued work checkpoints its selected history", async () => {
    const { options } = fixture(); let finish!: (value: unknown) => void;
    const analyze = vi.fn(() => new Promise((resolve) => { finish = resolve; })); historyBridge(analyze);
    const view = renderHook(() => usePreferenceLearning({ ...options, getHistoryThreads: async () => [thread()] })); await act(async () => {});
    addTurn(); act(() => { view.result.current.captureUserPrompt("t", "local-u", "Keep answers brief."); useTaskStore.getState().completeTurn("t", "turn", "completed"); }); await settle();
    await act(async () => { await view.result.current.requestHistory("app"); });
    expect(view.result.current.historyProgress).toMatchObject({ status: "queued", messages: 1 });
    await act(async () => { finish({ preferences: [] }); });
    expect(view.result.current.historyProgress).toMatchObject({ status: "complete", messages: 0, changed: false });
    expect(analyze).toHaveBeenCalledTimes(1);
  });
  it("reports discovery failure as an error and never submits partial history", async () => {
    const { options } = fixture(); historyBridge();
    const view = renderHook(() => usePreferenceLearning({ ...options, getHistoryThreads: async () => { throw new Error("metadata offline"); } })); await act(async () => {});
    await act(async () => { await view.result.current.requestHistory("app"); });
    expect(view.result.current.historyProgress?.status).toBe("error"); expect(bridge.invoke).not.toHaveBeenCalled();
  });
  it("hydrates on mount but never scans old completed tasks", async () => {
    const { options } = fixture(); addTurn(); useTaskStore.getState().completeTurn("t", "turn", "completed");
    renderHook(() => usePreferenceLearning(options)); await settle();
    expect(bridge.store!.isHydrated()).toBe(true); expect(bridge.invoke).not.toHaveBeenCalled();
  });
  it("captures only opt-in authored submissions and waits for completion plus quiet cadence", async () => {
    const { options, onUpdated } = fixture(); const view = renderHook(() => usePreferenceLearning(options)); await act(async () => {});
    addTurn(); act(() => view.result.current.captureUserPrompt("t", "local-u", "Keep answers brief."));
    await settle(); expect(bridge.invoke).not.toHaveBeenCalled();
    act(() => useTaskStore.getState().completeTurn("t", "turn", "completed"));
    await act(async () => { await vi.advanceTimersByTimeAsync(59_000); }); expect(bridge.invoke).not.toHaveBeenCalled();
    await settle(); expect(onUpdated).toHaveBeenCalledExactlyOnceWith("app");
    expect(JSON.parse(bridge.store!.get("app").checkpoints.t)).toHaveLength(1);
    act(() => useTaskStore.getState().completeTurn("t", "turn", "completed")); await settle(); expect(onUpdated).toHaveBeenCalledTimes(1);
  });
  it("handles accepted callbacks arriving after a very short completed response", async () => {
    const { options, onUpdated } = fixture(); const view = renderHook(() => usePreferenceLearning(options)); await act(async () => {});
    addTurn(); useTaskStore.getState().completeTurn("t", "turn", "completed");
    act(() => view.result.current.captureUserPrompt("t", "local-u", "Keep answers brief.")); await settle(); expect(onUpdated).toHaveBeenCalledTimes(1);
  });
  it.each(["disable", "clear", "model", "edit"])("discards a late provider result after %s without advancing checkpoint", async (change) => {
    let finish!: (value: unknown) => void; bridge.invoke.mockImplementation((command: string) => command === "analyze_user_preferences" ? new Promise((resolve) => { finish = resolve; }) : Promise.resolve(undefined));
    const { options, onUpdated } = fixture(); const view = renderHook(() => usePreferenceLearning(options)); await act(async () => {});
    addTurn(); act(() => { view.result.current.captureUserPrompt("t", "local-u", "Keep answers brief."); useTaskStore.getState().completeTurn("t", "turn", "completed"); }); await settle();
    await act(async () => {
      if (change === "clear") await bridge.store!.clear("app");
      else if (change === "edit") await bridge.store!.edit("app", "- Manual preference.");
      else await bridge.store!.configure("app", change === "model" ? { model: "gpt-6-sol" } : { enabled: false });
      finish({ preferences: [] });
    });
    expect(bridge.invoke).toHaveBeenCalledWith("run_discovery_cancel", expect.any(Object)); expect(onUpdated).not.toHaveBeenCalled(); expect(bridge.store!.get("app").checkpoints).toEqual({});
  });
  it("cancels immediately when settings change during the native request reservation", async () => {
    const { options } = fixture(); let state: PreferenceLearningScopeState = { ...defaultPreferenceLearningScope("app"), enabled: true, enabledAt: Date.now() - 10, revision: 1 };
    let release!: () => void; let saves = 0;
    bridge.store = createPreferenceLearningStore({ list: async () => [state], save: async (scopeKey, revision, value) => {
      if (++saves === 1) await new Promise<void>((resolve) => { release = resolve; });
      state = { scopeKey, revision: revision + 1, ...value }; return state;
    } });
    const view = renderHook(() => usePreferenceLearning(options)); await act(async () => {});
    addTurn(); act(() => { view.result.current.captureUserPrompt("t", "local-u", "Keep answers brief."); useTaskStore.getState().completeTurn("t", "turn", "completed"); }); await settle();
    let configured!: Promise<PreferenceLearningScopeState>;
    act(() => { configured = bridge.store!.configure("app", { enabled: false }); });
    expect(bridge.invoke).toHaveBeenCalledWith("run_discovery_cancel", expect.any(Object));
    await act(async () => { release(); await configured; });
    expect(bridge.invoke.mock.calls.filter(([command]) => command === "analyze_user_preferences")).toHaveLength(0);
    expect(bridge.store!.getJob("app").status).toBe("idle");
  });
  it("releases unmounted jobs without letting their late result overwrite a remounted queue", async () => {
    let finish!: (value: unknown) => void; bridge.invoke.mockImplementation((command: string) => command === "analyze_user_preferences" ? new Promise((resolve) => { finish = resolve; }) : Promise.resolve(undefined));
    const { options } = fixture(); const view = renderHook(() => usePreferenceLearning(options)); await act(async () => {});
    addTurn(); act(() => { view.result.current.captureUserPrompt("t", "local-u", "Keep answers brief."); useTaskStore.getState().completeTurn("t", "turn", "completed"); }); await settle();
    view.unmount(); expect(bridge.store!.getJob("app").status).toBe("idle");
    const next = renderHook(() => usePreferenceLearning(options));
    addTurn("t", "local-new", "Use diagrams.", "new"); act(() => { next.result.current.captureUserPrompt("t", "local-new", "Use diagrams."); useTaskStore.getState().completeTurn("t", "new", "completed"); });
    await act(async () => { finish({ preferences: [] }); });
    expect(bridge.store!.getJob("app").status).toBe("queued");
  });
  it("never collects while disabled or learns generated user-role messages", async () => {
    const { options } = fixture(false); const view = renderHook(() => usePreferenceLearning(options)); await act(async () => {});
    addTurn(); act(() => view.result.current.captureUserPrompt("t", "local-u", "Keep answers brief."));
    await act(async () => { await bridge.store!.configure("app", { enabled: true }); });
    act(() => useTaskStore.getState().completeTurn("t", "turn", "completed")); await settle(); expect(bridge.invoke).not.toHaveBeenCalled();
  });
  it("does not inherit another scope's receipt when enabled later in the same millisecond", async () => {
    const { options } = fixture(); let states: PreferenceLearningScopeState[] = [
      { ...defaultPreferenceLearningScope("app"), enabled: true, enabledAt: Date.now() - 10, revision: 1 },
      defaultPreferenceLearningScope("project:p"),
    ];
    bridge.store = createPreferenceLearningStore({ list: async () => states, save: async (scopeKey, revision, value) => {
      const next = { scopeKey, revision: revision + 1, ...value }; states = states.map((state) => state.scopeKey === scopeKey ? next : state); return next;
    } });
    const view = renderHook(() => usePreferenceLearning({ ...options, getProjectId: () => "p" })); await act(async () => {});
    addTurn(); act(() => view.result.current.captureUserPrompt("t", "local-u", "Keep answers brief."));
    await act(async () => { await bridge.store!.configure("project:p", { enabled: true }); });
    act(() => useTaskStore.getState().completeTurn("t", "turn", "completed")); await settle();
    expect(bridge.invoke.mock.calls.filter(([command]) => command === "analyze_user_preferences")).toHaveLength(1);
    expect(bridge.store!.get("project:p").checkpoints).toEqual({});
  });
  it("revokes captured receipts on clear even before the millisecond clock advances", async () => {
    const { options } = fixture(); const view = renderHook(() => usePreferenceLearning(options)); await act(async () => {});
    addTurn(); act(() => view.result.current.captureUserPrompt("t", "local-u", "Keep answers brief."));
    await act(async () => { await bridge.store!.clear("app"); });
    act(() => useTaskStore.getState().completeTurn("t", "turn", "completed")); await settle();
    expect(bridge.invoke).not.toHaveBeenCalled();
  });
  it("does not save or retry failed analysis", async () => {
    bridge.invoke.mockRejectedValue(new Error("offline")); const { options } = fixture(); const view = renderHook(() => usePreferenceLearning(options)); await act(async () => {});
    addTurn(); act(() => { view.result.current.captureUserPrompt("t", "local-u", "Keep answers brief."); useTaskStore.getState().completeTurn("t", "turn", "completed"); }); await settle(); await settle();
    expect(bridge.invoke).toHaveBeenCalledTimes(1); expect(bridge.store!.get("app").checkpoints).toEqual({}); expect(bridge.store!.getJob("app").status).toBe("error");
  });
  it("analyzes discovered history absent from the current sidebar using independent pages", async () => {
    const { options } = fixture(); bridge.invoke.mockImplementation((command: string, args: { method?: string }) => {
      if (command === "codex_rpc" && args.method === "thread/read") return Promise.resolve({ thread: thread() });
      if (command === "codex_rpc") return Promise.resolve({ data: [{ id: "turn", status: "completed", items: [{ id: "local-u", type: "userMessage", text: "Keep answers brief." }] }], nextCursor: null });
      return Promise.resolve({ preferences: [{ instruction: "Keep answers brief.", evidenceIds: ["t:local-u"] }] });
    });
    const view = renderHook(() => usePreferenceLearning({ ...options, getThread: () => undefined, getHistoryThreads: async () => [thread()] })); await act(async () => {});
    await act(async () => { await view.result.current.requestHistory("app"); });
    expect(view.result.current.historyProgress?.messages).toBe(1); expect(bridge.store!.get("app").markdown).toContain("Keep answers brief.");
    await act(async () => { await view.result.current.requestHistory("app"); });
    expect(bridge.invoke.mock.calls.filter(([command]) => command === "analyze_user_preferences")).toHaveLength(1);
    expect(view.result.current.historyProgress?.messages).toBe(0);
  });
  it("learns annotated human feedback while withholding quoted check output", async () => {
    const { options, onUpdated } = fixture(); const view = renderHook(() => usePreferenceLearning(options)); await act(async () => {});
    const notes = [{ id: "note", createdAt: Date.now(), comment: "Keep answers brief.", anchor: { kind: "check" as const, command: "cat secrets", cwd: "/p", checkedAt: Date.now(), exitCode: 0, output: "password=supersecretvalue" } }];
    const transcript = formatFeedbackPrompt("", notes); const authored = feedbackSkillInvocationText("", notes);
    addTurn("t", "local-u", transcript);
    act(() => { view.result.current.captureUserPrompt("t", "local-u", authored); useTaskStore.getState().completeTurn("t", "turn", "completed"); }); await settle();
    expect(onUpdated).toHaveBeenCalledTimes(1);
    const request = bridge.invoke.mock.calls.find(([command]) => command === "analyze_user_preferences")![1];
    expect(request.payload).toContain("Keep answers brief."); expect(request.payload).not.toContain("supersecretvalue"); expect(request.payload).not.toContain("cat secrets");
  });
  it("discards deleted or edited authored sources before dispatch", async () => {
    const { options } = fixture(); const view = renderHook(() => usePreferenceLearning(options)); await act(async () => {});
    addTurn(); act(() => { view.result.current.captureUserPrompt("t", "local-u", "Keep answers brief."); useTaskStore.getState().completeTurn("t", "turn", "completed"); useTaskStore.getState().removeMessage("t", "local-u"); }); await settle();
    expect(bridge.invoke).not.toHaveBeenCalled(); expect(bridge.store!.get("app").checkpoints).toEqual({});
  });
  it("bounds metadata discovery before caching so the newest eight threads are examined", async () => {
    const { options } = fixture(); bridge.invoke.mockImplementation((command: string, args: { method?: string; params?: { threadId?: string } }) => {
      if (command === "codex_rpc" && args.method === "thread/read") return Promise.resolve({ thread: thread(args.params!.threadId) });
      if (command === "codex_rpc") return Promise.resolve({ data: [], nextCursor: null });
      return Promise.resolve({ preferences: [] });
    });
    const view = renderHook(() => usePreferenceLearning({ ...options, getThread: () => undefined, getHistoryThreads: async () => Array.from({ length: 300 }, (_, index) => thread(`newest-${index}`)) })); await act(async () => {});
    await act(async () => { await view.result.current.requestHistory("app"); });
    const readIds = bridge.invoke.mock.calls.filter(([command, args]) => command === "codex_rpc" && args.method === "thread/read").map(([, args]) => args.params.threadId);
    expect(readIds.sort()).toEqual(Array.from({ length: 8 }, (_, index) => `newest-${index}`).sort());
    expect(view.result.current.historyProgress).toMatchObject({ limited: true, status: "partial", threads: 8 });
  });
  it("keeps separate authored messages in history with a long thread identity", async () => {
    const { options } = fixture(); const candidate = thread("thread".repeat(40));
    bridge.invoke.mockImplementation((command: string, args: { method?: string }) => {
      if (command === "codex_rpc" && args.method === "thread/read") return Promise.resolve({ thread: candidate });
      if (command === "codex_rpc") return Promise.resolve({ data: [{ id: "turn", status: "completed", items: [
        { id: "user-one", type: "userMessage", text: "Use diagrams." },
        { id: "user-two", type: "userMessage", text: "Be brief." },
      ] }], nextCursor: null });
      return Promise.resolve({ preferences: [] });
    });
    const view = renderHook(() => usePreferenceLearning({ ...options, getThread: () => undefined, getHistoryThreads: async () => [candidate] })); await act(async () => {});
    await act(async () => { await view.result.current.requestHistory("app"); });
    const request = bridge.invoke.mock.calls.find(([command]) => command === "analyze_user_preferences")![1];
    expect(JSON.parse(request.payload).messages).toHaveLength(2);
  });
  it("preserves the newer scope's quiet window while a different scope finishes", async () => {
    const { options } = fixture(); let states: PreferenceLearningScopeState[] = [bridge.store!.get("app"), { ...defaultPreferenceLearningScope("project:p"), enabled: true, enabledAt: Date.now() - 10, revision: 1 }];
    states[0] = { ...defaultPreferenceLearningScope("app"), enabled: true, enabledAt: Date.now() - 10, revision: 1 };
    bridge.store = createPreferenceLearningStore({ list: async () => states, save: async (scopeKey, revision, value) => { const next = { scopeKey, revision: revision + 1, ...value }; states = states.map((state) => state.scopeKey === scopeKey ? next : state); return next; } });
    const view = renderHook(() => usePreferenceLearning({ ...options, getProjectId: (candidate) => candidate.id === "later" ? "p" : null })); await act(async () => {});
    addTurn(); act(() => { view.result.current.captureUserPrompt("t", "local-u", "Keep answers brief."); useTaskStore.getState().completeTurn("t", "turn", "completed"); });
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    addTurn("later"); act(() => { view.result.current.captureUserPrompt("later", "local-u", "Keep answers brief."); useTaskStore.getState().completeTurn("later", "turn", "completed"); });
    await act(async () => { await vi.advanceTimersByTimeAsync(30_001); });
    // The app batch coalesces both conversations; the project batch remains quiet.
    expect(bridge.invoke).not.toHaveBeenCalled();
    await settle(); expect(bridge.invoke.mock.calls.filter(([command]) => command === "analyze_user_preferences")).toHaveLength(2);
  });
  it("includes the previous completed response as context for a correction", async () => {
    const { options } = fixture(); const view = renderHook(() => usePreferenceLearning(options)); await act(async () => {});
    addTurn("t", "local-old", "Please explain this.", "old");
    act(() => view.result.current.captureUserPrompt("t", "local-old", "Please explain this."));
    useTaskStore.getState().startAssistantMessage("t", { id: "previous-answer", role: "assistant", text: "Earlier example with too much detail", phase: "final", turnId: "old", streaming: false });
    useTaskStore.getState().completeTurn("t", "old", "completed");
    addTurn(); act(() => { view.result.current.captureUserPrompt("t", "local-u", "Keep answers brief."); useTaskStore.getState().completeTurn("t", "turn", "completed"); }); await settle();
    const request = bridge.invoke.mock.calls.find(([command]) => command === "analyze_user_preferences")![1];
    const sources = JSON.parse(request.payload).messages;
    expect(sources).toContainEqual(expect.objectContaining({ id: "t:previous-answer", role: "assistant" }));
    expect(sources).toContainEqual(expect.objectContaining({ id: "t:local-u", role: "user" }));
  });
  it("withholds old assistant context until its authored turn was captured while enabled", async () => {
    const { options } = fixture(); const view = renderHook(() => usePreferenceLearning(options)); await act(async () => {});
    useTaskStore.getState().ensureTask("t");
    useTaskStore.getState().startAssistantMessage("t", { id: "private-old", role: "assistant", text: "Private old conversation", phase: "final", turnId: "old", streaming: false });
    useTaskStore.getState().completeTurn("t", "old", "completed");
    addTurn(); act(() => { view.result.current.captureUserPrompt("t", "local-u", "Keep answers brief."); useTaskStore.getState().completeTurn("t", "turn", "completed"); }); await settle();
    const request = bridge.invoke.mock.calls.find(([command]) => command === "analyze_user_preferences")![1];
    expect(request.payload).not.toContain("Private old conversation");
  });
  it("keeps accepted sources when a late provider echo replaces their optimistic IDs", async () => {
    const { options, onUpdated } = fixture(); const view = renderHook(() => usePreferenceLearning(options)); await act(async () => {});
    addTurn(); act(() => { view.result.current.captureUserPrompt("t", "local-u", "Keep answers brief."); useTaskStore.getState().completeTurn("t", "turn", "completed"); });
    act(() => useTaskStore.getState().completeMessage("t", { id: "provider-u", role: "user", text: "Keep answers brief.", turnId: "turn" }));
    expect(useTaskStore.getState().tasks.t.messages.find((message) => message.role === "user")).toMatchObject({ id: "provider-u", clientMessageId: "local-u" });
    await settle(); expect(onUpdated).toHaveBeenCalledExactlyOnceWith("app");
  });
  it("collects a successful terminal transition after an earlier error for the same turn", async () => {
    const { options, onUpdated } = fixture(); const view = renderHook(() => usePreferenceLearning(options)); await act(async () => {});
    addTurn(); act(() => { view.result.current.captureUserPrompt("t", "local-u", "Keep answers brief."); useTaskStore.getState().completeTurn("t", "turn", "error"); });
    await settle(); expect(bridge.invoke).not.toHaveBeenCalled();
    act(() => useTaskStore.getState().completeTurn("t", "turn", "completed"));
    await settle(); expect(onUpdated).toHaveBeenCalledExactlyOnceWith("app");
  });
  it("discards a completed source that becomes interrupted during analysis", async () => {
    let finish!: (value: unknown) => void; bridge.invoke.mockImplementation((command: string) => command === "analyze_user_preferences" ? new Promise((resolve) => { finish = resolve; }) : Promise.resolve(undefined));
    const { options, onUpdated } = fixture(); const view = renderHook(() => usePreferenceLearning(options)); await act(async () => {});
    addTurn(); act(() => { view.result.current.captureUserPrompt("t", "local-u", "Keep answers brief."); useTaskStore.getState().completeTurn("t", "turn", "completed"); }); await settle();
    await act(async () => { useTaskStore.getState().completeTurn("t", "turn", "interrupted"); finish({ preferences: [{ instruction: "Keep answers brief.", evidenceIds: ["t:local-u"] }] }); });
    expect(onUpdated).not.toHaveBeenCalled(); expect(bridge.store!.get("app").checkpoints).toEqual({});
  });
  it("does not persist a result after its scope is removed", async () => {
    const { options, onUpdated } = fixture(); let valid = true; let finish!: (value: unknown) => void;
    bridge.invoke.mockImplementation((command: string) => command === "analyze_user_preferences" ? new Promise((resolve) => { finish = resolve; }) : Promise.resolve(undefined));
    const view = renderHook(() => usePreferenceLearning({ ...options, isScopeValid: () => valid })); await act(async () => {});
    addTurn(); act(() => { view.result.current.captureUserPrompt("t", "local-u", "Keep answers brief."); useTaskStore.getState().completeTurn("t", "turn", "completed"); }); await settle();
    valid = false; await act(async () => { finish({ preferences: [{ instruction: "Keep answers brief.", evidenceIds: ["t:local-u"] }] }); });
    expect(onUpdated).not.toHaveBeenCalled(); expect(bridge.store!.get("app").checkpoints).toEqual({});
  });
  it("skips oversized or obvious-secret prompts before holding receipts", async () => {
    const { options } = fixture(); const view = renderHook(() => usePreferenceLearning(options)); await act(async () => {});
    addTurn("t", "local-u", "password=secretpasswordvalue");
    act(() => { view.result.current.captureUserPrompt("t", "local-u", "password=secretpasswordvalue"); useTaskStore.getState().completeTurn("t", "turn", "completed"); });
    addTurn("t", "local-large", "x".repeat(4001), "large");
    act(() => { view.result.current.captureUserPrompt("t", "local-large", "x".repeat(4001)); useTaskStore.getState().completeTurn("t", "large", "completed"); }); await settle();
    expect(bridge.invoke).not.toHaveBeenCalled();
  });
  it("bounds repeated history cursors and reports partial coverage", async () => {
    const { options } = fixture(); bridge.invoke.mockImplementation((command: string, args: { method?: string }) => {
      if (command === "codex_rpc" && args.method === "thread/read") return Promise.resolve({ thread: thread() });
      if (command === "codex_rpc") return Promise.resolve({ data: [], nextCursor: "same" });
      return Promise.resolve({ preferences: [] });
    });
    const view = renderHook(() => usePreferenceLearning({ ...options, getHistoryThreads: async () => [thread()] })); await act(async () => {});
    await act(async () => { await view.result.current.requestHistory("app"); });
    expect(view.result.current.historyProgress).toMatchObject({ pages: 3, limited: true, status: "partial" });
    expect(bridge.invoke.mock.calls.filter(([command, args]) => command === "codex_rpc" && args.method === "thread/turns/list")).toHaveLength(3);
    expect(bridge.invoke.mock.calls.filter(([command]) => command === "analyze_user_preferences")).toHaveLength(0);
  });
});
