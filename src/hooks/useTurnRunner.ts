import { useCallback, useEffect, useRef, type Dispatch, type MutableRefObject, type SetStateAction } from "react";
import { rpc, runtimeInstanceId, type CodexRuntimeStatus } from "../lib/codex";
import {
  isClaudeThreadBusyError,
  killClaudeTurn,
  saveClaudeTranscript,
  startClaudeTurn,
  steerClaudeTurn,
  type ClaudeRuntimeStatus,
} from "../lib/claude";
import {
  killCursorTurn,
  saveCursorTranscript,
  startCursorTurn,
  steerCursorTurn,
  type CursorRuntimeStatus,
} from "../lib/cursor";
import { DEFAULT_CLAUDE_MODEL, DEFAULT_CURSOR_MODEL } from "../lib/appConfig";
import { cacheChildAgentPolicy, ensureChildAgentBridge, releaseChildAgentSession, type ChildAgentBridgeResult } from "../lib/childAgentSessions";
import { childAgentPolicyForThread, type ChildAgentLink, type ChildAgentPolicy, type ChildAgentReadiness } from "../lib/childAgents";
import {
  planSubagentCapabilities,
  recordSubagentCapabilities,
  subagentCapabilitySignature,
} from "../lib/threadCapabilities";
import { threadResumeParams, threadStartParams, turnStartParams } from "../lib/turnConfig";
import { buildTurnInput, withoutSentAttachments } from "../lib/turnInput";
import { optimisticStartedThread, upsertThread } from "../lib/threadList";
import { useTaskStore } from "../lib/taskStore";
import { friendlyError } from "../lib/errors";
import { clearProviderStopIntent, markProviderStopIntent } from "../lib/providerStopIntent";
import { isClaudeThread, isCursorThread } from "../lib/threadProvider";
import { withOpenKiwiCompletionInstructions } from "../lib/completionPrompt";
import {
  createThreadWorktree,
  removeThreadWorktree,
  type CreatedWorktree,
  type ThreadWorktreeRecord,
  type WorkspaceGitInfo,
} from "../lib/worktrees";
import { normalizedProjectPath } from "../lib/paths";
import { PendingTurnStarts, type PendingTurnStart } from "../lib/pendingTurnStarts";
import type { SetPersisted } from "./usePersistedState";
import type { OpenRouterModel } from "../components/OpenRouterModelControl";
import type { AttachmentRecord } from "../components/StudioDock";
import type { Account, AppSettings, CustomAgentProfile, Project, Provider, SettingsSection, Thread, Turn } from "../types";

const queuedDeliveries = new Map<string, { threadId: string; context: TurnRunnerContext }>();
const activeQueuedDeliveries = new Set<string>();

/**
 * Release the captured delivery contexts for a thread. A context pins the whole
 * App render context, so a deleted conversation must not keep one alive. With
 * no thread id every capture is dropped, which tests use to isolate cases.
 */
export function forgetQueuedDeliveries(threadId?: string): void {
  if (threadId === undefined) {
    queuedDeliveries.clear();
    activeQueuedDeliveries.clear();
    return;
  }
  for (const [queuedTurnId, delivery] of queuedDeliveries) {
    if (delivery.threadId === threadId) queuedDeliveries.delete(queuedTurnId);
  }
  activeQueuedDeliveries.delete(threadId);
}

function queuedDeliveryContext(context: TurnRunnerContext, threadId: string, attachments: AttachmentRecord[]): TurnRunnerContext {
  const visible = () => useTaskStore.getState().activeThreadId === threadId;
  return {
    ...context,
    running: false,
    deferredDelivery: true,
    attachments: attachments.map((attachment) => ({ ...attachment })),
    // Always treat a deferred send as background-capable. The normal delivery
    // path still updates durable thread/task state and the sidebar entry, but
    // it must never activate a task or clear attachments in whichever
    // conversation the user happens to be viewing when the queued turn starts.
    // The live workspace ref is deliberately kept: delivery still has to know
    // whether the user is in the workspace this turn was queued from.
    setActiveThread: () => undefined,
    setAttachments: () => undefined,
    setStartingDraftTurn: () => undefined,
    setError: (error) => { if (visible()) context.setError(error); },
    setStatus: (status) => { if (visible()) context.setStatus(status); },
    setTransientStatus: (status) => { if (visible()) context.setTransientStatus(status); },
  };
}

/** The verbatim isolation record persisted for a thread's private worktree. */
function threadWorktreeRecord(threadId: string, project: Project, worktree: CreatedWorktree): ThreadWorktreeRecord {
  return {
    threadId,
    projectId: project.id,
    projectPath: project.path,
    path: worktree.path,
    branch: worktree.branch,
    baseCommit: worktree.baseCommit,
    gitDir: worktree.gitDir,
    createdAt: Date.now(),
    status: "active",
  };
}

export interface TurnRunnerContext {
  activeThread: Thread | null;
  activeWorkspace: Project | null;
  activeProject: Project | null;
  running: boolean;
  /**
   * Set only on the synthetic context a queued follow-up is delivered with.
   * Such a send starts without the user watching, so it must never block the
   * window on a modal prompt.
   */
  deferredDelivery?: boolean;
  attachments: AttachmentRecord[];
  effectiveSettings: AppSettings;
  customAgents: CustomAgentProfile[];
  openRouterModels: OpenRouterModel[];
  runtimeStatus: CodexRuntimeStatus | null;
  claudeStatus: ClaudeRuntimeStatus | null;
  cursorStatus: CursorRuntimeStatus | null;
  account: Account | null;
  openRouterReady: boolean;
  workspaceGitInfo: WorkspaceGitInfo | null;
  draftThreadIsolated: boolean;
  worktreeBusy: boolean;
  skillsFolder: string;
  /** Bridge sessions for cross-provider sub-agents, keyed by session id. */
  childAgentPolicies: Record<string, ChildAgentPolicy>;
  childAgentLinks: Record<string, ChildAgentLink>;
  childAgentReadiness: ChildAgentReadiness;
  persistChildAgentPolicies: SetPersisted<Record<string, ChildAgentPolicy>>;
  threadWorktreesRef: MutableRefObject<Record<string, ThreadWorktreeRecord>>;
  threadProjectBindingsRef: MutableRefObject<Record<string, string> | null>;
  activeWorkspacePathRef: MutableRefObject<string | null>;
  pendingTurnStartsRef: MutableRefObject<PendingTurnStarts>;
  skillRuntimeRootRef: MutableRefObject<string>;
  cursorSessionIdsRef: MutableRefObject<Record<string, string>>;
  executionPathFor: (threadId: string | null | undefined, logicalPath: string) => string;
  bindThreadToProject: (threadId: string, projectPath: string) => void;
  rememberThread: (thread: Thread) => void;
  onThreadCreated: (threadId: string) => void;
  persistThreadModel: (threadId: string, model: string) => void;
  persistThreadWorktrees: SetPersisted<Record<string, ThreadWorktreeRecord>>;
  /** Restart the shared Codex app-server between idle turns so startup-only
   * capability config can be reapplied to an already loaded thread. Resolves
   * with the identity of the app-server that replaced it. */
  restartRuntimeForCapabilities: (threadId: string) => Promise<string>;
  beginRunCheckpoint: (threadId: string, workspacePath: string, prompt: string, provider: Provider, model: string) => Promise<string | undefined>;
  discardRunCheckpoint: (threadId: string) => void;
  refreshLocalSkills: () => Promise<unknown>;
  ensureSkillRoots: () => Promise<void>;
  scheduleClaudeThreadSave: (threadId: string) => void;
  scheduleCursorThreadSave: (threadId: string) => void;
  setThreads: Dispatch<SetStateAction<Thread[]>>;
  setActiveThread: Dispatch<SetStateAction<Thread | null>>;
  setAttachments: Dispatch<SetStateAction<AttachmentRecord[]>>;
  setDraftThreadIsolated: (isolated: boolean) => void;
  setStartingDraftTurn: (starting: boolean) => void;
  setError: (error: string | null) => void;
  setStatus: (status: string) => void;
  setTransientStatus: (message: string) => void;
  setRuntimeSetupOpen: (open: boolean) => void;
  setAuthRequiredOpen: (open: boolean) => void;
  openSettings: (section?: SettingsSection) => void;
}

/**
 * Owns the send/steer/stop turn lifecycle for all providers. The context is
 * rebuilt by App on every render and read through a ref, so the stable
 * callbacks always see fresh state; each call snapshots the context once at
 * entry, mirroring the closure captures of the original inline handlers, so
 * mid-flight awaits keep operating on the workspace the send started in.
 */
export function useTurnRunner(context: TurnRunnerContext): {
  sendMessage: (text: string) => Promise<boolean>;
  steerMessage: (text: string) => Promise<boolean>;
  steerQueuedMessage: (queuedTurnId: string) => Promise<void>;
  retryQueuedMessage: (queuedTurnId: string) => void;
  removeQueuedMessage: (queuedTurnId: string) => void;
  stopTurn: () => Promise<void>;
} {
  const contextRef = useRef(context);
  contextRef.current = context;
  const draftGenerationRef = useRef(0);

  // Returns true when the message was delivered; the Composer restores its
  // draft when it was not.
  const deliverMessage = useCallback(async (ctx: TurnRunnerContext, text: string, mode: "turn" | "steer"): Promise<boolean> => {
    const {
      activeThread, activeWorkspace, activeProject, running, attachments, deferredDelivery,
      effectiveSettings, customAgents, openRouterModels,
      runtimeStatus, claudeStatus, cursorStatus, account, openRouterReady,
      workspaceGitInfo, draftThreadIsolated, worktreeBusy, skillsFolder,
      childAgentPolicies, childAgentLinks, childAgentReadiness, persistChildAgentPolicies,
      threadWorktreesRef, threadProjectBindingsRef, activeWorkspacePathRef,
      pendingTurnStartsRef, skillRuntimeRootRef, cursorSessionIdsRef,
      executionPathFor, bindThreadToProject, rememberThread, onThreadCreated, persistThreadModel,
      persistThreadWorktrees, restartRuntimeForCapabilities, beginRunCheckpoint, discardRunCheckpoint,
      refreshLocalSkills, ensureSkillRoots, scheduleClaudeThreadSave, scheduleCursorThreadSave,
      setThreads, setActiveThread, setAttachments, setDraftThreadIsolated,
      setStartingDraftTurn, setError, setStatus, setTransientStatus,
      setRuntimeSetupOpen, setAuthRequiredOpen, openSettings,
    } = ctx;
    if (!text || !activeWorkspace) return false;
    const currentIsolation = activeThread ? threadWorktreesRef.current[activeThread.id] : undefined;
    if (currentIsolation && worktreeBusy) {
      setError("Wait for the isolated worktree operation to finish before starting another model turn.");
      return false;
    }
    if (currentIsolation?.status === "missing" || currentIsolation?.status === "removed") {
      setError("This thread's isolated worktree is unavailable. Recreate it or explicitly continue in the shared project before sending another message.");
      return false;
    }
    if (!activeThread && draftThreadIsolated && (!workspaceGitInfo?.isRepo || !workspaceGitInfo.isRoot || !workspaceGitInfo.hasCommit)) {
      setError("Isolated threads require a Git repository root with at least one commit.");
      return false;
    }
    if (effectiveSettings.provider !== "claude" && effectiveSettings.provider !== "cursor" && !runtimeStatus?.available) {
      setRuntimeSetupOpen(true);
      return false;
    }
    if (effectiveSettings.provider === "openai" && account?.type !== "chatgpt") {
      setAuthRequiredOpen(true);
      return false;
    }
    if (effectiveSettings.provider === "openrouter" && !openRouterReady) {
      openSettings("models");
      setError("Add an OpenRouter API key before using OpenRouter.");
      return false;
    }
    if (effectiveSettings.provider === "claude" && (!claudeStatus?.available || !claudeStatus.loggedIn)) {
      openSettings("models");
      setError(claudeStatus?.available ? "Sign in to Claude Code before using your Claude subscription." : "Install Claude Code, then sign in before using the Claude provider.");
      return false;
    }
    if (effectiveSettings.provider === "cursor" && (!cursorStatus?.available || !cursorStatus.loggedIn)) {
      openSettings("models");
      setError(cursorStatus?.available ? "Sign in to Cursor Agent before using your Cursor subscription." : "Install Cursor Agent, then sign in before using the Cursor provider.");
      return false;
    }
    if (effectiveSettings.provider === "openrouter" && !effectiveSettings.model.trim()) {
      setError("Choose an OpenRouter model before starting this thread.");
      return false;
    }
    if (mode === "steer" && running && activeThread) {
      const sentAttachments = [...attachments];
      setError(null);
      const steerMessageId = `local-${crypto.randomUUID()}`;
      useTaskStore.getState().appendUserMessage(activeThread.id, { id: steerMessageId, role: "user", text });
      try {
        if (isClaudeThread(activeThread)) {
          await steerClaudeTurn(
            activeThread.id,
            text,
            sentAttachments.map((attachment) => ({ path: attachment.path, kind: attachment.kind === "image" ? "image" : "file" })),
          );
          scheduleClaudeThreadSave(activeThread.id);
        } else if (isCursorThread(activeThread)) {
          await steerCursorTurn(
            activeThread.id,
            text,
            sentAttachments.map((attachment) => ({ path: attachment.path, kind: attachment.kind === "image" ? "image" : "file" })),
          );
          scheduleCursorThreadSave(activeThread.id);
        } else {
          await rpc("turn/steer", { threadId: activeThread.id, input: buildTurnInput(text, sentAttachments) });
        }
        setAttachments((current) => withoutSentAttachments(current, sentAttachments));
        setTransientStatus("Direction added");
        return true;
      } catch (reason) {
        // The message never reached the runtime — remove the optimistic bubble
        // so a retry does not duplicate it in the timeline.
        useTaskStore.getState().removeMessage(activeThread.id, steerMessageId);
        setError(friendlyError(reason));
        return false;
      }
    }

    const willUseSharedFolder = !currentIsolation && !(draftThreadIsolated && !activeThread);
    if (willUseSharedFolder) {
      const sharedPath = normalizedProjectPath(activeWorkspace.path);
      const taskState = useTaskStore.getState();
      const anotherSharedRun = Object.entries(taskState.statuses).some(([threadId, threadStatus]) => {
        if (threadId === activeThread?.id || (threadStatus !== "starting" && threadStatus !== "running")) return false;
        const logicalPath = threadProjectBindingsRef.current?.[threadId];
        const executionPath = taskState.tasks[threadId]?.workspacePath
          ?? (logicalPath ? executionPathFor(threadId, logicalPath) : undefined);
        return Boolean(executionPath && normalizedProjectPath(executionPath) === sharedPath);
      });
      if (anotherSharedRun) {
        // A queued follow-up starts on its own schedule, possibly while the
        // user is reading another conversation. A modal there would block the
        // whole window with no context, but silently allowing two models to
        // edit one shared folder is unsafe. Hold the queue at this entry and
        // let the user retry it once the other run is finished.
        if (deferredDelivery && activeThread) {
          const overlapMessage = "This queued follow-up is waiting because another conversation is working in the same shared project folder. Start it again after that task finishes.";
          useTaskStore.getState().upsertActivity(activeThread.id, {
            id: `shared-folder-overlap-${activeThread.id}-${Date.now()}`,
            kind: "warning",
            title: "Another thread is working in this project folder",
            detail: overlapMessage,
          });
          throw new Error(overlapMessage);
        } else if (!window.confirm(
          "Another thread is already working in this shared project folder.\n\nBoth models can edit the same files at the same time. Continue anyway, or cancel and start this as an isolated worktree instead?",
        )) return false;
      }
    }

    setError(null);
    // Workspace identity captured at send start. After each await below the
    // continuation may resume in a different workspace; installation into the
    // visible UI (thread list, active thread) is then skipped, while the
    // thread itself still starts and stays bound to its own project.
    const sendWorkspacePath = normalizedProjectPath(activeWorkspace.path);
    const workspaceChangedMidSend = () => activeWorkspacePathRef.current !== sendWorkspacePath;
    let pendingStart: PendingTurnStart | undefined;
    let draftGeneration: number | undefined;
    // Mark the start synchronously, before the first await, so Stop and the
    // composer reflect it immediately — and only on the thread actually
    // starting. A send with no active thread yet is tracked by the draft
    // flag until the created thread's own status takes over.
    const startingThreadId = activeThread?.id;
    if (startingThreadId) {
      useTaskStore.getState().beginAgentRun(startingThreadId);
      useTaskStore.getState().setTaskStatus(startingThreadId, "starting");
      pendingStart = pendingTurnStartsRef.current.begin(startingThreadId);
    } else {
      draftGeneration = ++draftGenerationRef.current;
      setStartingDraftTurn(true);
    }
    setStatus("Starting");

    let startedThreadId: string | undefined;
    let sentMessageId: string | undefined;
    let provisionalWorktree: CreatedWorktree | undefined;
    let provisionalPersisted = false;
    let childBridge: ChildAgentBridgeResult | null = null;
    const sentAttachments = [...attachments];

    // The approved cross-provider destinations are captured once, on the first
    // turn of a thread, and reused verbatim afterwards. Binding them to the
    // thread id can only happen once the runtime has reported it.
    const rememberChildAgentPolicy = (threadId: string) => {
      if (!childBridge) return;
      const { policy, captured } = childBridge;
      if (!captured && policy.rootThreadId === threadId) return;
      const next = { ...policy, rootThreadId: threadId };
      childBridge = { ...childBridge, policy: next, captured: false };
      cacheChildAgentPolicy(next);
      persistChildAgentPolicies((current) => ({ ...current, [next.sessionId]: next }));
    };

    // Shared body of the Claude/Cursor subscription paths: bootstrap the
    // locally-owned thread record, bump its preview, mark the run, take the
    // checkpoint, post the optimistic message, then hand off to the provider
    // strategy for its transcript save + start RPC. Cleanup on failure is
    // handled by sendMessage's own catch via the shared mutable markers.
    const runLocalTurn = async (
      provider: "claude" | "cursor",
      executionPath: string,
      strategy: {
        startTurn: (thread: Thread, updatedThread: Thread) => Promise<{ turnId: string }>;
        afterStart?: (threadId: string) => void;
        hardStop: (threadId: string) => Promise<unknown>;
      },
    ): Promise<boolean> => {
      let thread = activeThread;
      if (!thread) {
        thread = { id: crypto.randomUUID(), name: null, preview: text.slice(0, 140), cwd: executionPath, updatedAt: Math.floor(Date.now() / 1000), modelProvider: provider };
        startedThreadId = thread.id;
        bindThreadToProject(thread.id, activeWorkspace.path);
        if (provisionalWorktree && activeProject) {
          const record = threadWorktreeRecord(thread.id, activeProject, provisionalWorktree);
          persistThreadWorktrees((current) => ({ ...current, [thread!.id]: record }));
          provisionalPersisted = true;
          setDraftThreadIsolated(false);
        }
        rememberThread(thread);
        onThreadCreated(thread.id);
        persistThreadModel(thread.id, effectiveSettings.model);
        useTaskStore.getState().ensureTask(thread.id, executionPath);
        if (!workspaceChangedMidSend()) {
          setThreads((current) => upsertThread(current, thread!));
          setActiveThread(thread);
          useTaskStore.getState().setActiveThread(thread.id);
        }
      }
      startedThreadId = thread.id;
      rememberChildAgentPolicy(thread.id);
      // Stop landed while this brand-new thread was still being created. The
      // prompt was never delivered, so report it as undelivered and let the
      // composer hand the user their text back instead of silently eating it.
      if (!activeThread && draftGeneration !== draftGenerationRef.current) {
        useTaskStore.getState().setTaskStatus(thread.id, "interrupted");
        setStartingDraftTurn(false);
        setTransientStatus("Stopped");
        return false;
      }
      const updatedThread = { ...thread, preview: text.slice(0, 140) || thread.preview, updatedAt: Math.floor(Date.now() / 1000) };
      rememberThread(updatedThread);
      if (!workspaceChangedMidSend()) {
        setThreads((current) => upsertThread(current, updatedThread));
        setActiveThread(updatedThread);
      }
      useTaskStore.getState().ensureTask(thread.id, executionPath);
      if (!activeThread) useTaskStore.getState().beginAgentRun(thread.id);
      useTaskStore.getState().setTaskStatus(thread.id, "starting");
      if (!pendingStart) pendingStart = pendingTurnStartsRef.current.begin(thread.id);
      await beginRunCheckpoint(thread.id, executionPath, text, effectiveSettings.provider, effectiveSettings.model);
      sentMessageId = `local-${crypto.randomUUID()}`;
      useTaskStore.getState().appendUserMessage(thread.id, { id: sentMessageId, role: "user", text });
      const result = await strategy.startTurn(thread, updatedThread);
      // Provider events can race ahead of the start RPC response. If a very
      // short turn already delivered its result, reinstalling it here would
      // resurrect the completed thread as permanently running.
      const completedBeforeStartReturned = useTaskStore.getState().tasks[thread.id]?.lastCompletedTurnId === result.turnId;
      if (!completedBeforeStartReturned) {
        useTaskStore.getState().setActiveTurn(thread.id, result.turnId);
        useTaskStore.getState().setTaskStatus(thread.id, "running");
      }
      setStartingDraftTurn(false);
      setAttachments((current) => withoutSentAttachments(current, sentAttachments));
      strategy.afterStart?.(thread.id);
      if (pendingTurnStartsRef.current.finish(thread.id, pendingStart) && !completedBeforeStartReturned) {
        markProviderStopIntent(thread.id, result.turnId);
        try {
          await strategy.hardStop(thread.id);
        } catch (reason) {
          clearProviderStopIntent(thread.id, result.turnId);
          throw reason;
        }
        useTaskStore.getState().setActiveTurn(thread.id, undefined);
        useTaskStore.getState().setTaskStatus(thread.id, "interrupted");
        clearProviderStopIntent(thread.id, result.turnId);
        setTransientStatus("Stopped");
      }
      return true;
    };

    try {
      let executionPath = activeWorkspace.path;
      if (!activeThread && draftThreadIsolated && activeProject) {
        provisionalWorktree = await createThreadWorktree(activeProject.path, text);
        executionPath = provisionalWorktree.path;
      } else if (activeThread) {
        executionPath = executionPathFor(activeThread.id, activeWorkspace.path);
      }
      const isolationGitDir = provisionalWorktree?.gitDir ?? currentIsolation?.gitDir;
      const additionalWorkspaceRoots = isolationGitDir ? [isolationGitDir] : [];
      childBridge = await ensureChildAgentBridge({
        threadId: activeThread?.id,
        policies: childAgentPolicies,
        links: childAgentLinks,
        settings: effectiveSettings,
        permission: effectiveSettings.permission,
        systemPrompt: effectiveSettings.systemPrompt,
        projectInstructionsEnabled: effectiveSettings.projectInstructionsEnabled,
        reasoningEffort: effectiveSettings.ultra ? "ultra" : effectiveSettings.reasoningEffort,
        serviceTier: effectiveSettings.serviceTier,
        readiness: childAgentReadiness,
        settingsProposalsEnabled: Boolean(activeProject),
      });
      // A captured cross-provider policy freezes one concurrency budget for
      // the whole conversation. Use that same budget for provider-native
      // sub-agents too, so the number displayed by the command center is the
      // number Claude/Codex actually receives. Threads that never captured a
      // roster continue to use the live project setting.
      const capturedPolicy = childAgentPolicyForThread(childAgentPolicies, activeThread?.id);
      const runtimeSubagentMax = childBridge?.policy.maxConcurrent
        ?? capturedPolicy?.maxConcurrent
        ?? effectiveSettings.subagentMax;
      const runtimeSettings = runtimeSubagentMax === effectiveSettings.subagentMax
        ? effectiveSettings
        : { ...effectiveSettings, subagentMax: runtimeSubagentMax };
      if (effectiveSettings.provider === "claude") {
        if (skillsFolder && !skillRuntimeRootRef.current) await refreshLocalSkills();
        return await runLocalTurn("claude", executionPath, {
          startTurn: async (thread, updatedThread) => {
            // Appending the optimistic user message cannot flip assistant
            // presence, so resume detection is unaffected by running after it.
            const canResumeClaude = Boolean(activeThread && useTaskStore.getState().tasks[thread.id]?.messages.some((message) => message.role === "assistant"));
            await saveClaudeTranscript({ thread: updatedThread, messages: useTaskStore.getState().tasks[thread.id]?.messages ?? [], activities: useTaskStore.getState().tasks[thread.id]?.activities ?? [] });
            const result = await startClaudeTurn({ threadId: thread.id, cwd: executionPath, prompt: text, model: effectiveSettings.model || DEFAULT_CLAUDE_MODEL, effort: effectiveSettings.ultra ? "ultra" : effectiveSettings.reasoningEffort, permission: effectiveSettings.permission, systemPrompt: withOpenKiwiCompletionInstructions(effectiveSettings.systemPrompt, Boolean(childBridge?.launch.toolNames.includes("spawn_agent")), Boolean(childBridge?.launch.toolNames.includes("propose_agent_settings"))), resume: canResumeClaude, attachments: sentAttachments.map((attachment) => ({ path: attachment.path, kind: attachment.kind === "image" ? "image" : "file" })), subagentsEnabled: effectiveSettings.subagentsEnabled, subagentMax: runtimeSubagentMax, customAgents, skillsPluginPath: skillRuntimeRootRef.current || undefined, childAgentBridgeConfig: childBridge?.launch.configPath });
            return { turnId: result.turnId };
          },
          hardStop: (threadId) => killClaudeTurn(threadId),
        });
      }

      if (effectiveSettings.provider === "cursor") {
        return await runLocalTurn("cursor", executionPath, {
          startTurn: async (thread, updatedThread) => {
            const priorSessionId = cursorSessionIdsRef.current[thread.id];
            await saveCursorTranscript({ thread: updatedThread, cursorSessionId: priorSessionId ?? "", messages: useTaskStore.getState().tasks[thread.id]?.messages ?? [], activities: useTaskStore.getState().tasks[thread.id]?.activities ?? [] });
            const result = await startCursorTurn({
              threadId: thread.id,
              cwd: executionPath,
              prompt: text,
              model: effectiveSettings.model || DEFAULT_CURSOR_MODEL,
              effort: effectiveSettings.ultra ? "ultra" : effectiveSettings.reasoningEffort,
              permission: effectiveSettings.permission,
              systemPrompt: withOpenKiwiCompletionInstructions(effectiveSettings.systemPrompt, Boolean(childBridge?.launch.toolNames.includes("spawn_agent")), Boolean(childBridge?.launch.toolNames.includes("propose_agent_settings"))),
              resumeSessionId: priorSessionId || undefined,
              attachments: sentAttachments.map((attachment) => ({ path: attachment.path, kind: attachment.kind === "image" ? "image" : "file" })),
              childAgentBridge: childBridge
                ? { name: childBridge.launch.name, command: childBridge.launch.command, args: childBridge.launch.args }
                : undefined,
            });
            cursorSessionIdsRef.current[thread.id] = result.cursorSessionId;
            return { turnId: result.turnId };
          },
          afterStart: (threadId) => scheduleCursorThreadSave(threadId),
          hardStop: (threadId) => killCursorTurn(threadId),
        });
      }

      await ensureSkillRoots();
      const input = buildTurnInput(text, sentAttachments);
      // The Codex app server keeps one thread alive across turns and only reads
      // this config when a thread is started or resumed, so the capabilities it
      // is holding have to be compared against the ones this turn wants — and
      // against the app-server identity that was told about them, because a
      // runtime that has since restarted holds nothing at all.
      let runtimeInstance = await runtimeInstanceId();
      const capabilities = subagentCapabilitySignature({
        subagentsEnabled: effectiveSettings.subagentsEnabled,
        subagentMax: runtimeSubagentMax,
        // The same policy receives a new token/config path whenever its bridge
        // is rebuilt. App-server must be refreshed so it starts that process,
        // rather than retaining an MCP process holding the revoked old token.
        bridgeInstanceId: childBridge?.launch.configPath,
      });
      let threadId = activeThread?.id;
      startedThreadId = threadId;
      if (!threadId) {
        const result = await rpc<{ thread: Thread }>("thread/start", threadStartParams(runtimeSettings, executionPath, { serviceName: activeWorkspace.isChat ? "OpenKiwi Chat" : "OpenKiwi", customAgents, modelContextWindow: effectiveSettings.provider === "openrouter" ? openRouterModels.find((entry) => entry.id === effectiveSettings.model)?.context_length : undefined, interactive: true, additionalWorkspaceRoots, childAgentBridge: childBridge?.launch }));
        const startedThread = optimisticStartedThread(result.thread, text);
        threadId = startedThread.id;
        startedThreadId = threadId;
        bindThreadToProject(startedThread.id, activeWorkspace.path);
        if (provisionalWorktree && activeProject) {
          const record = threadWorktreeRecord(startedThread.id, activeProject, provisionalWorktree);
          persistThreadWorktrees((current) => ({ ...current, [startedThread.id]: record }));
          provisionalPersisted = true;
          setDraftThreadIsolated(false);
        }
        rememberThread(startedThread);
        onThreadCreated(startedThread.id);
        persistThreadModel(startedThread.id, effectiveSettings.model);
        recordSubagentCapabilities(startedThread.id, runtimeInstance, capabilities);
        useTaskStore.getState().ensureTask(startedThread.id, executionPath);
        if (!workspaceChangedMidSend()) {
          setThreads((current) => upsertThread(current, startedThread));
          setActiveThread(startedThread);
          useTaskStore.getState().setActiveThread(startedThread.id);
        }
      } else {
        // Startup-only config overrides are intentionally ignored by Codex
        // when thread/resume rejoins a thread already loaded in app-server.
        // Refresh the managed runtime between turns before resuming whenever
        // that runtime is holding this thread with different capabilities.
        // This keeps the same durable thread/history while making the visible
        // switch real; a runtime that restarted since then has nothing loaded
        // and takes the new config from the resume alone.
        const plan = planSubagentCapabilities(threadId, runtimeInstance, capabilities);
        if (plan.restartRuntime) runtimeInstance = await restartRuntimeForCapabilities(threadId);
        if (effectiveSettings.provider === "openrouter" || plan.resume) {
          const resume = threadResumeParams(runtimeSettings, threadId, executionPath, { customAgents, modelContextWindow: openRouterModels.find((entry) => entry.id === effectiveSettings.model)?.context_length, excludeTurns: true, additionalWorkspaceRoots, childAgentBridge: childBridge?.launch, refreshRuntimeConfig: true });
          await rpc("thread/resume", effectiveSettings.provider === "openrouter" ? { ...resume, model: effectiveSettings.model } : resume);
          recordSubagentCapabilities(threadId, runtimeInstance, capabilities);
        }
      }

      if (activeThread?.id === threadId) {
        const updatedThread = { ...activeThread, updatedAt: Math.floor(Date.now() / 1000) };
        rememberThread(updatedThread);
        if (!workspaceChangedMidSend()) {
          setThreads((current) => upsertThread(current, updatedThread));
          setActiveThread(updatedThread);
        }
      }
      rememberChildAgentPolicy(threadId);
      // See runLocalTurn: a draft stopped before its turn started keeps its text.
      if (!activeThread && draftGeneration !== draftGenerationRef.current) {
        useTaskStore.getState().setTaskStatus(threadId, "interrupted");
        setStartingDraftTurn(false);
        setTransientStatus("Stopped");
        return false;
      }
      useTaskStore.getState().ensureTask(threadId, executionPath);
      if (!activeThread) useTaskStore.getState().beginAgentRun(threadId);
      useTaskStore.getState().setTaskStatus(threadId, "starting");
      if (!pendingStart) pendingStart = pendingTurnStartsRef.current.begin(threadId);
      await beginRunCheckpoint(threadId, executionPath, text, effectiveSettings.provider, effectiveSettings.model);
      sentMessageId = `local-${crypto.randomUUID()}`;
      useTaskStore.getState().appendUserMessage(threadId, { id: sentMessageId, role: "user", text });

      const result = await rpc<{ turn: Turn }>("turn/start", turnStartParams(effectiveSettings, threadId, executionPath, input, additionalWorkspaceRoots));
      const resultTurnId = result.turn?.id;
      const completedBeforeStartReturned = Boolean(
        resultTurnId
        && useTaskStore.getState().tasks[threadId]?.lastCompletedTurnId === resultTurnId,
      );
      if (resultTurnId && !completedBeforeStartReturned) {
        useTaskStore.getState().setActiveTurn(threadId, resultTurnId);
      }
      setStartingDraftTurn(false);
      setAttachments((current) => withoutSentAttachments(current, sentAttachments));
      if (pendingTurnStartsRef.current.finish(threadId, pendingStart) && !completedBeforeStartReturned) {
        // The user pressed stop while the turn was still starting.
        if (resultTurnId) await rpc("turn/interrupt", { threadId, turnId: resultTurnId });
        useTaskStore.getState().setActiveTurn(threadId, undefined);
        useTaskStore.getState().setTaskStatus(threadId, "interrupted");
        setTransientStatus("Stopped");
      }
      return true;
    } catch (reason) {
      setStartingDraftTurn(false);
      // Use the locally captured thread ids: for a brand-new thread the
      // activeThread closure is still null here (which used to leave the
      // thread stuck in "starting" forever), and a failure before the send
      // resolved its thread must still clear the "starting" mark applied at
      // the top of this function.
      const failedThreadId = startedThreadId ?? startingThreadId;
      // `captured` is cleared the moment the policy is bound to a thread and
      // persisted. Anything still flagged as captured was registered with the
      // backend for a turn that never started, so nothing will ever reuse it —
      // including a policy captured mid-conversation for an existing thread.
      if (childBridge?.captured) {
        await releaseChildAgentSession(childBridge.policy.sessionId);
      }
      if (provisionalWorktree && activeProject && !provisionalPersisted) {
        void removeThreadWorktree(
          undefined,
          activeProject.path,
          provisionalWorktree.path,
          provisionalWorktree.branch,
          true,
          true,
        ).catch(() => undefined);
      }
      if (failedThreadId) {
        discardRunCheckpoint(failedThreadId);
        if (pendingStart) pendingTurnStartsRef.current.finish(failedThreadId, pendingStart);
        if (sentMessageId) useTaskStore.getState().removeMessage(failedThreadId, sentMessageId);
        useTaskStore.getState().setTaskStatus(failedThreadId, "error", friendlyError(reason));
        if (isClaudeThreadBusyError(reason)) {
          // The backend slot is held by a Claude process the UI no longer
          // tracks (e.g. after an event loss). Free it so a retry succeeds
          // instead of failing until OpenKiwi restarts.
          void killClaudeTurn(failedThreadId).catch(() => undefined);
        } else if (effectiveSettings.provider === "cursor" && /already working/i.test(friendlyError(reason))) {
          void killCursorTurn(failedThreadId).catch(() => undefined);
        }
      }
      setStatus("Ready");
      setError(friendlyError(reason));
      return false;
    }
  }, []);

  const pumpQueuedThread = useCallback(async (threadId: string, force = false): Promise<void> => {
    if (activeQueuedDeliveries.has(threadId)) return;
    const task = useTaskStore.getState().tasks[threadId];
    if (!task || task.status === "starting" || task.status === "running") return;
    // "idle" is the status a task carries when its queue was restored from disk
    // in a later app session: the run those follow-ups were queued behind no
    // longer exists, so the oldest one is simply the next thing to start.
    if (!force && task.status !== "completed" && task.status !== "idle") return;
    // Strictly FIFO: only ever start the head. A head left "failed" (or being
    // steered) holds the queue until the user retries or removes it, so
    // follow-ups can never silently run out of the order they were written in.
    const queuedTurn = task.queuedTurns[0];
    if (!queuedTurn || queuedTurn.status !== "queued") return;
    const queuedContext = queuedDeliveries.get(queuedTurn.id)?.context;
    // A durable queue can outlive the renderer. Once the user opens that task,
    // the render path below reattaches a fresh delivery context and pumping
    // resumes; guessing provider/workspace settings before then is unsafe.
    if (!queuedContext) return;

    activeQueuedDeliveries.add(threadId);
    useTaskStore.getState().setQueuedTurnStatus(threadId, queuedTurn.id, "sending");
    let delivered = false;
    try {
      delivered = await deliverMessage(queuedContext, queuedTurn.text, "turn");
      if (delivered) {
        useTaskStore.getState().removeQueuedTurn(threadId, queuedTurn.id);
        queuedDeliveries.delete(queuedTurn.id);
      } else {
        const error = useTaskStore.getState().tasks[threadId]?.error ?? "The queued turn could not be started.";
        useTaskStore.getState().setQueuedTurnStatus(threadId, queuedTurn.id, "failed", error);
      }
    } catch (reason) {
      // Delivery reports failure by returning false; an actual throw would
      // otherwise leave this thread's queue wedged for the rest of the session.
      useTaskStore.getState().setQueuedTurnStatus(threadId, queuedTurn.id, "failed", friendlyError(reason));
    } finally {
      activeQueuedDeliveries.delete(threadId);
    }

    // A very fast provider can finish before its start call resolves. If that
    // happened, there was no later status transition to wake the next item.
    if (delivered && useTaskStore.getState().tasks[threadId]?.status === "completed") {
      queueMicrotask(() => { void pumpQueuedThread(threadId); });
    }
  }, [deliverMessage]);

  // Reattach durable queue entries to the live provider/workspace context
  // whenever their task is open. Entries created during this app session keep
  // their original captured context and therefore continue in the background.
  const activeThreadId = context.activeThread?.id ?? null;
  if (activeThreadId) {
    const queuedTurns = useTaskStore.getState().tasks[activeThreadId]?.queuedTurns ?? [];
    for (const queuedTurn of queuedTurns) {
      // Refresh live readiness/settings for entries the user can act on. The
      // thread/provider/workspace identity remains the same, while a sign-in,
      // model repair, or settings change made after queuing can now unblock a
      // retry without requiring an app restart.
      if (activeQueuedDeliveries.has(activeThreadId)) continue;
      queuedDeliveries.set(queuedTurn.id, {
        threadId: activeThreadId,
        context: queuedDeliveryContext(context, activeThreadId, queuedTurn.attachments),
      });
    }
  }

  useEffect(() => {
    const unsubscribe = useTaskStore.subscribe((state, previous) => {
      // This fires for every store write, which during a turn means every
      // streamed delta flush. A task's status only ever changes together with
      // its `statuses` entry, so an unchanged statuses map means no completion
      // to react to — and scanning every task's queue per animation frame is
      // pure waste.
      if (state.statuses === previous.statuses) return;
      for (const threadId in state.statuses) {
        if (state.statuses[threadId] !== "completed" || previous.statuses[threadId] === "completed") continue;
        if (state.tasks[threadId]?.queuedTurns.some((entry) => entry.status === "queued")) {
          void pumpQueuedThread(threadId);
        }
      }
    });
    return unsubscribe;
  }, [pumpQueuedThread]);

  // Opening a task is the moment a queue restored from a previous app session
  // gains a live delivery context (attached during the render above), so it is
  // also the moment those follow-ups become startable.
  useEffect(() => {
    if (activeThreadId) void pumpQueuedThread(activeThreadId);
  }, [activeThreadId, pumpQueuedThread]);

  const sendMessage = useCallback(async (text: string): Promise<boolean> => {
    const ctx = contextRef.current;
    if (!text || !ctx.activeWorkspace) return false;
    if (ctx.running && !ctx.activeThread) return false;
    if (ctx.running && ctx.activeThread) {
      const sentAttachments = [...ctx.attachments];
      const queuedTurn = useTaskStore.getState().enqueueTurn(ctx.activeThread.id, text, sentAttachments);
      queuedDeliveries.set(queuedTurn.id, {
        threadId: ctx.activeThread.id,
        context: queuedDeliveryContext(ctx, ctx.activeThread.id, sentAttachments),
      });
      ctx.setAttachments((current) => withoutSentAttachments(current, sentAttachments));
      ctx.setError(null);
      ctx.setTransientStatus("Message queued for the next turn");
      return true;
    }
    return deliverMessage(ctx, text, "turn");
  }, [deliverMessage]);

  const steerMessage = useCallback(async (text: string): Promise<boolean> => {
    const ctx = contextRef.current;
    if (ctx.running && !ctx.activeThread) return false;
    return deliverMessage(ctx, text, ctx.running && ctx.activeThread ? "steer" : "turn");
  }, [deliverMessage]);

  const steerQueuedMessage = useCallback(async (queuedTurnId: string): Promise<void> => {
    const ctx = contextRef.current;
    const threadId = ctx.activeThread?.id;
    if (!threadId || !ctx.running) return;
    const queuedTurn = useTaskStore.getState().tasks[threadId]?.queuedTurns.find((entry) => entry.id === queuedTurnId);
    if (!queuedTurn || queuedTurn.status === "sending") return;
    useTaskStore.getState().setQueuedTurnStatus(threadId, queuedTurn.id, "sending");
    const delivered = await deliverMessage(
      { ...ctx, attachments: queuedTurn.attachments, setAttachments: () => undefined },
      queuedTurn.text,
      "steer",
    );
    if (delivered) {
      useTaskStore.getState().removeQueuedTurn(threadId, queuedTurn.id);
      queuedDeliveries.delete(queuedTurn.id);
    } else {
      useTaskStore.getState().setQueuedTurnStatus(threadId, queuedTurn.id, "failed", "The message could not be steered into the active turn.");
    }
  }, [deliverMessage]);

  const retryQueuedMessage = useCallback((queuedTurnId: string) => {
    const threadId = contextRef.current.activeThread?.id;
    if (!threadId) return;
    const head = useTaskStore.getState().tasks[threadId]?.queuedTurns[0];
    if (head?.id !== queuedTurnId) return;
    useTaskStore.getState().setQueuedTurnStatus(threadId, queuedTurnId, "queued");
    void pumpQueuedThread(threadId, true);
  }, [pumpQueuedThread]);

  const removeQueuedMessage = useCallback((queuedTurnId: string) => {
    const threadId = contextRef.current.activeThread?.id;
    if (!threadId) return;
    const wasHead = useTaskStore.getState().tasks[threadId]?.queuedTurns[0]?.id === queuedTurnId;
    useTaskStore.getState().removeQueuedTurn(threadId, queuedTurnId);
    queuedDeliveries.delete(queuedTurnId);
    if (wasHead) void pumpQueuedThread(threadId);
  }, [pumpQueuedThread]);

  const stopTurn = useCallback(async () => {
    const ctx = contextRef.current;
    const { activeThread, running, pendingTurnStartsRef, setError, setStatus, setStartingDraftTurn, setTransientStatus } = ctx;
    if (!running) return;
    // A draft send has no thread to interrupt yet, and its runtime call may not
    // even have been made. Advancing the generation is the cutoff: whichever
    // point the send has reached, it aborts as soon as it learns its thread id.
    if (!activeThread) {
      draftGenerationRef.current += 1;
      setStartingDraftTurn(false);
      setTransientStatus("Stopped");
      return;
    }
    const turnId = useTaskStore.getState().tasks[activeThread.id]?.activeTurnId;
    if (!turnId) {
      // If this thread's turn/start RPC is still in flight, flag that exact
      // pending start so sendMessage interrupts the turn the moment its id is
      // known. When this thread has no start in flight (e.g. the user
      // navigated here while another thread was starting), there is nothing
      // to stop and no intent must be recorded.
      if (pendingTurnStartsRef.current.requestCancel(activeThread.id)) {
        setStatus("Stopping");
      }
      return;
    }
    const localProvider = isClaudeThread(activeThread) || isCursorThread(activeThread);
    if (localProvider) markProviderStopIntent(activeThread.id, turnId);
    try {
      if (isClaudeThread(activeThread)) await killClaudeTurn(activeThread.id);
      else if (isCursorThread(activeThread)) await killCursorTurn(activeThread.id);
      else await rpc("turn/interrupt", { threadId: activeThread.id, turnId });
      useTaskStore.getState().setActiveTurn(activeThread.id, undefined);
      useTaskStore.getState().setTaskStatus(activeThread.id, "interrupted");
      if (localProvider) clearProviderStopIntent(activeThread.id, turnId);
      setStartingDraftTurn(false);
      setTransientStatus("Stopped");
    } catch (reason) {
      if (localProvider) clearProviderStopIntent(activeThread.id, turnId);
      setError(friendlyError(reason));
      throw reason;
    }
  }, []);

  return { sendMessage, steerMessage, steerQueuedMessage, retryQueuedMessage, removeQueuedMessage, stopTurn };
}
