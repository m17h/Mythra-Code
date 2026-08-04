import { useCallback, useRef, type Dispatch, type MutableRefObject, type SetStateAction } from "react";
import { rpc, type CodexRuntimeStatus } from "../lib/codex";
import {
  interruptClaudeTurn,
  isClaudeThreadBusyError,
  killClaudeTurn,
  saveClaudeTranscript,
  startClaudeTurn,
  steerClaudeTurn,
  type ClaudeRuntimeStatus,
} from "../lib/claude";
import {
  interruptCursorTurn,
  killCursorTurn,
  saveCursorTranscript,
  startCursorTurn,
  steerCursorTurn,
  type CursorRuntimeStatus,
} from "../lib/cursor";
import { DEFAULT_CLAUDE_MODEL, DEFAULT_CURSOR_MODEL } from "../lib/appConfig";
import { threadResumeParams, threadStartParams, turnStartParams } from "../lib/turnConfig";
import { buildTurnInput, withoutSentAttachments } from "../lib/turnInput";
import { optimisticStartedThread, upsertThread } from "../lib/threadList";
import { useTaskStore } from "../lib/taskStore";
import { friendlyError } from "../lib/errors";
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
  attachments: AttachmentRecord[];
  effectiveSettings: AppSettings;
  settings: AppSettings;
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
  threadWorktreesRef: MutableRefObject<Record<string, ThreadWorktreeRecord>>;
  threadProjectBindingsRef: MutableRefObject<Record<string, string> | null>;
  activeWorkspacePathRef: MutableRefObject<string | null>;
  pendingTurnStartsRef: MutableRefObject<PendingTurnStarts>;
  skillRuntimeRootRef: MutableRefObject<string>;
  cursorSessionIdsRef: MutableRefObject<Record<string, string>>;
  executionPathFor: (threadId: string | null | undefined, logicalPath: string) => string;
  bindThreadToProject: (threadId: string, projectPath: string) => void;
  rememberThread: (thread: Thread) => void;
  persistThreadModel: (threadId: string, model: string) => void;
  persistThreadWorktrees: SetPersisted<Record<string, ThreadWorktreeRecord>>;
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
  stopTurn: () => Promise<void>;
} {
  const contextRef = useRef(context);
  contextRef.current = context;

  // Returns true when the message was delivered; the Composer restores its
  // draft when it was not.
  const sendMessage = useCallback(async (text: string): Promise<boolean> => {
    const ctx = contextRef.current;
    const {
      activeThread, activeWorkspace, activeProject, running, attachments,
      effectiveSettings, settings, customAgents, openRouterModels,
      runtimeStatus, claudeStatus, cursorStatus, account, openRouterReady,
      workspaceGitInfo, draftThreadIsolated, worktreeBusy, skillsFolder,
      threadWorktreesRef, threadProjectBindingsRef, activeWorkspacePathRef,
      pendingTurnStartsRef, skillRuntimeRootRef, cursorSessionIdsRef,
      executionPathFor, bindThreadToProject, rememberThread, persistThreadModel,
      persistThreadWorktrees, beginRunCheckpoint, discardRunCheckpoint,
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
    if (running && activeThread) {
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
          await steerCursorTurn(activeThread.id, text);
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
      if (anotherSharedRun && !window.confirm(
        "Another thread is already working in this shared project folder.\n\nBoth models can edit the same files at the same time. Continue anyway, or cancel and start this as an isolated worktree instead?",
      )) return false;
    }

    setError(null);
    // Workspace identity captured at send start. After each await below the
    // continuation may resume in a different workspace; installation into the
    // visible UI (thread list, active thread) is then skipped, while the
    // thread itself still starts and stays bound to its own project.
    const sendWorkspacePath = normalizedProjectPath(activeWorkspace.path);
    const workspaceChangedMidSend = () => activeWorkspacePathRef.current !== sendWorkspacePath;
    let pendingStart: PendingTurnStart | undefined;
    // Mark the start synchronously, before the first await, so Stop and the
    // composer reflect it immediately — and only on the thread actually
    // starting. A send with no active thread yet is tracked by the draft
    // flag until the created thread's own status takes over.
    const startingThreadId = activeThread?.id;
    if (startingThreadId) {
      useTaskStore.getState().setTaskStatus(startingThreadId, "starting");
      pendingStart = pendingTurnStartsRef.current.begin(startingThreadId);
    } else {
      setStartingDraftTurn(true);
    }
    setStatus("Starting");

    let startedThreadId: string | undefined;
    let sentMessageId: string | undefined;
    let provisionalWorktree: CreatedWorktree | undefined;
    let provisionalPersisted = false;
    const sentAttachments = [...attachments];

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
        interrupt: (threadId: string) => Promise<unknown>;
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
        persistThreadModel(thread.id, effectiveSettings.model);
        useTaskStore.getState().ensureTask(thread.id, executionPath);
        if (!workspaceChangedMidSend()) {
          setThreads((current) => upsertThread(current, thread!));
          setActiveThread(thread);
          useTaskStore.getState().setActiveThread(thread.id);
        }
      }
      startedThreadId = thread.id;
      const updatedThread = { ...thread, preview: text.slice(0, 140) || thread.preview, updatedAt: Math.floor(Date.now() / 1000) };
      rememberThread(updatedThread);
      if (!workspaceChangedMidSend()) {
        setThreads((current) => upsertThread(current, updatedThread));
        setActiveThread(updatedThread);
      }
      useTaskStore.getState().ensureTask(thread.id, executionPath);
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
        await strategy.interrupt(thread.id);
        useTaskStore.getState().setActiveTurn(thread.id, undefined);
        useTaskStore.getState().setTaskStatus(thread.id, "interrupted");
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
      if (effectiveSettings.provider === "claude") {
        if (skillsFolder && !skillRuntimeRootRef.current) await refreshLocalSkills();
        return await runLocalTurn("claude", executionPath, {
          startTurn: async (thread, updatedThread) => {
            // Appending the optimistic user message cannot flip assistant
            // presence, so resume detection is unaffected by running after it.
            const canResumeClaude = Boolean(activeThread && useTaskStore.getState().tasks[thread.id]?.messages.some((message) => message.role === "assistant"));
            await saveClaudeTranscript({ thread: updatedThread, messages: useTaskStore.getState().tasks[thread.id]?.messages ?? [], activities: useTaskStore.getState().tasks[thread.id]?.activities ?? [] });
            const result = await startClaudeTurn({ threadId: thread.id, cwd: executionPath, prompt: text, model: effectiveSettings.model || DEFAULT_CLAUDE_MODEL, effort: settings.ultra ? "ultra" : settings.reasoningEffort, permission: effectiveSettings.permission, systemPrompt: withOpenKiwiCompletionInstructions(effectiveSettings.systemPrompt), resume: canResumeClaude, attachments: sentAttachments.map((attachment) => ({ path: attachment.path, kind: attachment.kind === "image" ? "image" : "file" })), subagentsEnabled: settings.subagentsEnabled, subagentMax: settings.subagentMax, customAgents, skillsPluginPath: skillRuntimeRootRef.current || undefined });
            return { turnId: result.turnId };
          },
          interrupt: (threadId) => interruptClaudeTurn(threadId),
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
              effort: settings.ultra ? "ultra" : settings.reasoningEffort,
              permission: effectiveSettings.permission,
              systemPrompt: withOpenKiwiCompletionInstructions(effectiveSettings.systemPrompt),
              resumeSessionId: priorSessionId || undefined,
              attachments: sentAttachments.map((attachment) => ({ path: attachment.path, kind: attachment.kind === "image" ? "image" : "file" })),
            });
            cursorSessionIdsRef.current[thread.id] = result.cursorSessionId;
            return { turnId: result.turnId };
          },
          afterStart: (threadId) => scheduleCursorThreadSave(threadId),
          interrupt: (threadId) => interruptCursorTurn(threadId),
        });
      }

      await ensureSkillRoots();
      const input = buildTurnInput(text, sentAttachments);
      let threadId = activeThread?.id;
      startedThreadId = threadId;
      if (!threadId) {
        const result = await rpc<{ thread: Thread }>("thread/start", threadStartParams(effectiveSettings, executionPath, { serviceName: activeWorkspace.isChat ? "OpenKiwi Chat" : "OpenKiwi", customAgents, modelContextWindow: effectiveSettings.provider === "openrouter" ? openRouterModels.find((entry) => entry.id === effectiveSettings.model)?.context_length : undefined, interactive: true, additionalWorkspaceRoots }));
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
        persistThreadModel(startedThread.id, effectiveSettings.model);
        useTaskStore.getState().ensureTask(startedThread.id, executionPath);
        if (!workspaceChangedMidSend()) {
          setThreads((current) => upsertThread(current, startedThread));
          setActiveThread(startedThread);
          useTaskStore.getState().setActiveThread(startedThread.id);
        }
      } else if (effectiveSettings.provider === "openrouter") {
        // Re-apply the isolated provider config before every subsequent turn.
        // This repairs a persisted thread after a compatibility refresh.
        await rpc("thread/resume", { ...threadResumeParams(effectiveSettings, threadId, executionPath, { customAgents, modelContextWindow: openRouterModels.find((entry) => entry.id === effectiveSettings.model)?.context_length, excludeTurns: true, additionalWorkspaceRoots }), model: effectiveSettings.model });
      }

      if (activeThread?.id === threadId) {
        const updatedThread = { ...activeThread, updatedAt: Math.floor(Date.now() / 1000) };
        rememberThread(updatedThread);
        if (!workspaceChangedMidSend()) {
          setThreads((current) => upsertThread(current, updatedThread));
          setActiveThread(updatedThread);
        }
      }
      useTaskStore.getState().ensureTask(threadId, executionPath);
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

  const stopTurn = useCallback(async () => {
    const ctx = contextRef.current;
    const { activeThread, running, pendingTurnStartsRef, setError, setStatus, setStartingDraftTurn, setTransientStatus } = ctx;
    if (!activeThread || !running) return;
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
    try {
      if (isClaudeThread(activeThread)) await interruptClaudeTurn(activeThread.id);
      else if (isCursorThread(activeThread)) await interruptCursorTurn(activeThread.id);
      else await rpc("turn/interrupt", { threadId: activeThread.id, turnId });
      useTaskStore.getState().setActiveTurn(activeThread.id, undefined);
      useTaskStore.getState().setTaskStatus(activeThread.id, "interrupted");
      setStartingDraftTurn(false);
      setTransientStatus("Stopped");
    } catch (reason) {
      setError(friendlyError(reason));
    }
  }, []);

  return { sendMessage, stopTurn };
}
