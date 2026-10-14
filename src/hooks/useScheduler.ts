import { useCallback, useEffect, useRef } from "react";
import { auditEvent, rpc, runtimeInstanceId, runtimeThreadState } from "../lib/codex";
import { useTaskStore } from "../lib/taskStore";
import { scheduleRunSnapshot, threadResumeParams, threadStartParams, turnStartParams } from "../lib/turnConfig";
import type { LMStudioModel } from "../lib/lmStudio";
import type { ResolvedSkillPrompts } from "../lib/skills";
import { SkillDependencyError } from "../lib/skillDependencies";
import { appendCurrentLearnedPreferences } from "../lib/currentLearnedPreferences";
import { appendProjectInstructionContext } from "../lib/projectInstructionContext";
import { safeErrorText } from "../lib/errors";
import { planSubagentCapabilities, recordSubagentCapabilities, subagentCapabilitySignature } from "../lib/threadCapabilities";
import { isActiveAgentRecord } from "../lib/subAgentActivity";
import { parentAutoCompactionUnavailableReason } from "../lib/threadSubagentSettings";
import type { AppSettings, Project, Provider, ScheduleRunRecord, ScheduleRunSettings, ScheduledTask, Thread } from "../types";

export interface SchedulerDeps {
  schedules: ScheduledTask[];
  updateSchedule: (id: string, patch: (current: ScheduledTask) => ScheduledTask) => void;
  projects: Project[];
  chatWorkspace?: Project | null;
  settings: AppSettings;
  runtimeAvailable: boolean;
  chatGptConnected: boolean;
  openRouterReady: boolean;
  lmStudioReady?: boolean;
  lmStudioModels?: LMStudioModel[];
  ensureSkillRoots: () => Promise<void>;
  resolveSkillPrompt: (message: string) => Promise<string>;
  resolveSkillPrompts?: (message: string, systemPrompt: string, mentionSource?: string) => Promise<ResolvedSkillPrompts>;
  bindThreadToProject: (threadId: string, projectPath: string) => void;
  /** Reused conversations can execute in an isolated project worktree. */
  executionPathFor?: (threadId: string, logicalPath: string) => string;
  /** Isolated worktrees also need access to their shared Git metadata. */
  extraRootsForThread?: (threadId: string) => string[];
  /** Automatic pre-turn file snapshot, same lifecycle user turns get. */
  beginRunCheckpoint: (threadId: string, workspacePath: string, prompt: string, provider: Provider, model: string) => Promise<string | undefined>;
  discardRunCheckpoint: (threadId: string, expectedCheckpointId?: string) => void;
  onThreadStarted: (project: Project) => void;
  /** Persist fresh-thread defaults before any turn preparation can fail. */
  onThreadCreated?: (threadId: string, project: Project, options?: { autoCompactTokens?: number }) => void;
  prepareNewThreadGit?: (threadId: string, workspace: Project, enabled: boolean) => Promise<boolean>;
  /** App owns the shared-runtime reservation and complete cross-thread guards. */
  restartRuntimeForCapabilities?: (threadId: string, allowOwnStarting?: boolean) => Promise<string>;
  /** Reflect the admitted off policy and own window, including provider-default clearing. */
  onThreadDelegationDisabled?: (threadId: string, options: { autoCompactTokens?: number }) => void;
  /** Includes durable/unresolved native children that may not have loaded tasks. */
  threadBusyReason?: (threadId: string, ignoreOwnStarting?: boolean) => string | null;
  recordRun: (run: ScheduleRunRecord) => void;
}

interface SchedulePreparation {
  scheduled: ScheduledTask;
  projectId: string;
  projectPath: string;
  legacySettings?: AppSettings;
  legacyRun?: string;
  revoked: boolean;
}

class RevokedSchedulePreparation extends Error {
  constructor() {
    super("Scheduled run stopped before starting because its schedule or execution target changed.");
  }
}

class BusyScheduleThread extends Error {}

function scheduleThreadIsBusy(threadId: string, ownsStartingStatus = false): boolean {
  const state = useTaskStore.getState();
  const task = state.tasks[threadId];
  return Boolean(state.workflowOwners[threadId] || task?.activeTurnId
    || state.statuses[threadId] === "running"
    || (!ownsStartingStatus && state.statuses[threadId] === "starting"));
}

function preparationIsCurrent(preparation: SchedulePreparation, deps: SchedulerDeps): boolean {
  if (preparation.revoked) return false;
  const scheduled = deps.schedules.find((item) => item.id === preparation.scheduled.id);
  // Schedule mutations are immutable. Remember replacement, not only the final
  // enabled value: disabling and re-enabling cannot revive an earlier attempt.
  if (scheduled !== preparation.scheduled || !scheduled.enabled) return false;
  const project = scheduled.projectId === null
    ? deps.chatWorkspace
    : deps.projects.find((item) => item.id === scheduled.projectId);
  if (!project || project.id !== preparation.projectId || project.path !== preparation.projectPath) return false;
  return !preparation.legacySettings || deps.settings === preparation.legacySettings
    || JSON.stringify(scheduleRunSnapshot(deps.settings)) === preparation.legacyRun;
}

/**
 * Fires enabled schedules while the app is open. Each run uses the settings
 * snapshot captured when the schedule was created (falling back to the current
 * settings for schedules created before snapshots existed) and never issues
 * approval requests, since nobody may be present to answer them.
 */
export function useScheduler(deps: SchedulerDeps): void {
  const depsRef = useRef(deps);
  depsRef.current = deps;
  const runningRef = useRef(new Map<string, SchedulePreparation>());
  // Observe revocation while a preparation is awaiting another service, so a
  // later render restoring the original configuration cannot undo it.
  for (const preparation of runningRef.current.values()) {
    if (!preparationIsCurrent(preparation, deps)) preparation.revoked = true;
  }

  const runScheduledTask = useCallback(async (scheduled: ScheduledTask) => {
    const current = depsRef.current;
    if (runningRef.current.has(scheduled.id)) return;
    if (scheduled.unconfirmedThreadId) {
      if (scheduled.unconfirmedBaselineUnknown) return;
      const task = useTaskStore.getState().tasks[scheduled.unconfirmedThreadId];
      // A missing/restored-idle task is not evidence that a dispatched turn
      // settled. The durable latch also survives renderer reloads and edits.
      if (!task || task.activeTurnId || !task.lastCompletedTurnId
        || task.lastCompletedTurnId === scheduled.unconfirmedCompletedTurnId
        || !["completed", "interrupted", "error"].includes(task.status)) return;
    }
    const updateOwnedSchedule = (patch: (item: ScheduledTask) => ScheduledTask) => {
      depsRef.current.updateSchedule(scheduled.id, (item) => item === scheduled && item.enabled ? patch(item) : item);
    };
    const project = scheduled.projectId === null
      ? current.chatWorkspace ?? null
      : current.projects.find((item) => item.id === scheduled.projectId);
    const run: ScheduleRunSettings = scheduled.run ?? scheduleRunSnapshot(current.settings);
    if (!project) {
      // The normal-chat path is established asynchronously during startup.
      // A due chat schedule should wait for it, not permanently disable itself
      // because the renderer checked a few milliseconds too early.
      if (scheduled.projectId === null) return;
      // A silent return here would retry every 30 seconds forever with no
      // trace. Disable the schedule and record why it can never fire.
      const error = "This schedule's project was removed from Mythra Code, so the schedule was disabled.";
      updateOwnedSchedule((item) => ({ ...item, enabled: false }));
      current.recordRun({
        id: crypto.randomUUID(),
        scheduleId: scheduled.id,
        scheduleName: scheduled.name,
        projectId: scheduled.projectId,
        at: Date.now(),
        status: "failed",
        error,
      });
      void auditEvent("schedule.failed", { scheduleId: scheduled.id, error }).catch(() => {});
      return;
    }
    if (run.provider === "claude" || run.provider === "cursor") {
      const error = `${run.provider === "cursor" ? "Cursor" : "Claude"} scheduled tasks are not enabled yet. Use an OpenAI, OpenRouter, or LM Studio schedule.`;
      updateOwnedSchedule((item) => ({
        ...item,
        nextRunAt: Date.now() + item.intervalMinutes * 60_000,
      }));
      current.recordRun({
        id: crypto.randomUUID(),
        scheduleId: scheduled.id,
        scheduleName: scheduled.name,
        projectId: scheduled.projectId,
        at: Date.now(),
        status: "failed",
        error,
      });
      void auditEvent("schedule.failed", { scheduleId: scheduled.id, error }).catch(() => {});
      return;
    }
    if (!current.runtimeAvailable) return;
    if (run.provider === "openai" && !current.chatGptConnected) return;
    if (run.provider === "openrouter" && !current.openRouterReady) return;
    if (run.provider === "lmstudio" && !current.lmStudioReady) return;
    const reuseThread = scheduled.threadMode === "reuse" && Boolean(scheduled.lastThreadId);
    let executionPath = reuseThread && scheduled.lastThreadId
      ? current.executionPathFor?.(scheduled.lastThreadId, project.path) ?? project.path
      : project.path;
    let reusingExecutionPath = reuseThread;
    let createdFreshThread = false;
    const preparationAnchors = new Map<string, { activeTurnId?: string; pendingTurnStartOrder?: number }>();
    const busyReason = (threadId: string, ownStarting = false): string | null => {
      const state = useTaskStore.getState();
      const task = state.tasks[threadId];
      const external = depsRef.current.threadBusyReason?.(threadId, ownStarting);
      if (external) return external;
      if (scheduleThreadIsBusy(threadId, ownStarting) || state.statuses[threadId] === "running" || state.statuses[threadId] === "starting" && !ownStarting
        || state.workflowOwners[threadId] || task?.approvals.length || task?.agents.some((agent) => isActiveAgentRecord(agent.status))
        || ownStarting && (task?.activeTurnId !== preparationAnchors.get(threadId)?.activeTurnId
          || task?.pendingTurnStartOrder !== preparationAnchors.get(threadId)?.pendingTurnStartOrder)) {
        return "Finish or stop this thread and every sub-agent before starting a scheduled turn.";
      }
      return null;
    };
    if (reuseThread && scheduled.lastThreadId && busyReason(scheduled.lastThreadId)) {
      // A recurring prompt must never collide with the previous unattended
      // turn in the same conversation. Retry soon without creating a second
      // thread or recording a misleading failed run.
      updateOwnedSchedule((item) => ({ ...item, nextRunAt: Date.now() + 60_000 }));
      return;
    }
    const preparation: SchedulePreparation = {
      scheduled,
      projectId: project.id,
      projectPath: project.path,
      ...(scheduled.run ? {} : { legacySettings: current.settings, legacyRun: JSON.stringify(run) }),
      revoked: false,
    };
    runningRef.current.set(scheduled.id, preparation);
    const assertCurrent = () => {
      const live = depsRef.current;
      if (!preparationIsCurrent(preparation, live)
        || reusingExecutionPath && scheduled.lastThreadId
          && (live.executionPathFor?.(scheduled.lastThreadId, project.path) ?? project.path) !== executionPath) {
        preparation.revoked = true;
        throw new RevokedSchedulePreparation();
      }
    };
    let startedThreadId: string | undefined;
    let ownsStartingStatus = false;
    let ownedCheckpointId: string | undefined;
    let pendingMessageId: string | undefined;
    let pendingMessageOrder: number | undefined;
    let completedTurnBeforeDispatch: string | undefined;
    let observedRuntimeAfterDispatch = false;
    let unconfirmedAcknowledgement = false;
    let turnDispatched = false;
    let turnStarted = false;
    const assertIdle = (threadId: string, ownStarting = false) => {
      if (ownStarting && !stillOwnsStartingStatus(threadId)) throw new RevokedSchedulePreparation();
      if (scheduleThreadIsBusy(threadId, ownStarting)) throw new BusyScheduleThread();
      const reason = busyReason(threadId, ownStarting);
      if (reason) throw new Error(reason);
    };
    const claimPreparation = (threadId: string) => {
      const state = useTaskStore.getState();
      state.ensureTask(threadId, executionPath);
      state.setTaskStatus(threadId, "starting");
      ownsStartingStatus = true;
      const task = useTaskStore.getState().tasks[threadId];
      preparationAnchors.set(threadId, { activeTurnId: task?.activeTurnId, pendingTurnStartOrder: task?.pendingTurnStartOrder });
    };
    const stillOwnsStartingStatus = (threadId: string) => {
      const state = useTaskStore.getState();
      const task = state.tasks[threadId];
      const anchor = preparationAnchors.get(threadId);
      return ownsStartingStatus && state.statuses[threadId] === "starting" && anchor
        && !task?.activeTurnId && !state.workflowOwners[threadId]
        && task?.activeTurnId === anchor.activeTurnId && task?.pendingTurnStartOrder === anchor.pendingTurnStartOrder;
    };
    try {
      assertCurrent();
      const compactionReason = parentAutoCompactionUnavailableReason(run.provider, run.autoCompactTokens);
      if (compactionReason) throw new Error(compactionReason);
      const resolved: ResolvedSkillPrompts = current.resolveSkillPrompts
        ? await current.resolveSkillPrompts(scheduled.prompt, run.systemPrompt)
        : { prompt: await current.resolveSkillPrompt(scheduled.prompt), systemPrompt: run.systemPrompt };
      assertCurrent();
      const systemPrompt = await appendCurrentLearnedPreferences(resolved.systemPrompt, scheduled.projectId);
      assertCurrent();
      await current.ensureSkillRoots();
      assertCurrent();
      // Reserve reused threads before selected-file disk work so Stop still
      // owns the preparation, without refreshing the runtime to read files.
      if (reuseThread && scheduled.lastThreadId) {
        assertIdle(scheduled.lastThreadId);
        startedThreadId = scheduled.lastThreadId;
        claimPreparation(scheduled.lastThreadId);
      }
      let projectSystemPrompt = await appendProjectInstructionContext(
        systemPrompt, scheduled.projectId === null ? null : executionPath, run, () => {
          assertCurrent();
          if (reuseThread && scheduled.lastThreadId) assertIdle(scheduled.lastThreadId, true);
        },
      );
      assertCurrent();
      const providerPrompt = resolved.prompt;
      // Scheduled roots retain their off policy on every iteration, including
      // old snapshots that predate thread-local delegation authority.
      const runtimeRun = { ...run, systemPrompt, subagentsEnabled: false, subagentEngine: "mythra" as const, nativeSubagentOptions: undefined };
      const modelContextWindow = run.provider === "lmstudio"
        ? current.lmStudioModels?.find((entry) => entry.id === run.model)?.maxContextLength
        : undefined;
      const capabilities = subagentCapabilitySignature(
        { subagentsEnabled: false, subagentMax: 1, autoCompactTokens: run.autoCompactTokens },
        { provider: run.provider, lmStudioBaseUrl: run.lmStudioBaseUrl, modelContextWindow },
      );
      const startFreshThread = async () => {
        assertCurrent();
        const priorExecutionPath = executionPath;
        reusingExecutionPath = false;
        executionPath = project.path;
        // A missing isolated thread falls back to the logical project. Its
        // root files may differ from the worktree snapshot already read.
        if (priorExecutionPath !== executionPath) {
          projectSystemPrompt = await appendProjectInstructionContext(
            systemPrompt, scheduled.projectId === null ? null : executionPath, run, assertCurrent,
          );
          assertCurrent();
        }
        const instance = await runtimeInstanceId();
        assertCurrent();
        const started = await rpc<{ thread: Thread; model?: unknown }>("thread/start", threadStartParams(runtimeRun, project.path, {
          serviceName: "Mythra Code",
          modelContextWindow,
          interactive: false,
          perTurnSystemPrompt: true,
        }));
        startedThreadId = started.thread.id;
        createdFreshThread = true;
        current.onThreadCreated?.(started.thread.id, project, { autoCompactTokens: run.autoCompactTokens });
        recordSubagentCapabilities(started.thread.id, instance, capabilities);
        assertCurrent();
        return started;
      };
      let started: { thread: Thread; model?: unknown };
      if (reuseThread && scheduled.lastThreadId) {
        const threadId = scheduled.lastThreadId;
        assertIdle(threadId, true);
        const runtime = await runtimeThreadState(threadId);
        assertCurrent();
        assertIdle(threadId, true);
        const plan = planSubagentCapabilities(threadId, runtime.instance, capabilities, runtime.loaded);
        let instance = runtime.instance;
        if (plan.restartRuntime) {
          const restart = depsRef.current.restartRuntimeForCapabilities;
          if (!restart) throw new Error("This scheduled thread needs a safe runtime refresh before delegation can be disabled. The scheduled prompt was not sent.");
          instance = await restart(threadId, true);
          assertCurrent();
          assertIdle(threadId, true);
        }
        try {
          assertCurrent();
          assertIdle(threadId, true);
          started = await rpc<{ thread: Thread; model?: unknown }>("thread/resume", threadResumeParams(
            runtimeRun,
            scheduled.lastThreadId,
            executionPath,
            { modelContextWindow, refreshRuntimeConfig: true, interactive: false, perTurnSystemPrompt: true,
              additionalWorkspaceRoots: current.extraRootsForThread?.(threadId) ?? [] },
          ));
          recordSubagentCapabilities(started.thread.id, instance, capabilities);
          startedThreadId = started.thread.id;
          assertCurrent();
        } catch (reason) {
          // A revoked resume must not create a replacement conversation.
          assertCurrent();
          if (reason instanceof BusyScheduleThread) throw reason;
          // The user may have deleted the earlier run's conversation. Keep the
          // schedule useful by establishing a new thread that later triggers
          // can reuse, rather than failing forever on a stale id.
          const message = reason instanceof Error ? reason.message : String(reason);
          if (!/no rollout found for thread id|thread.{0,30}(?:not found|does not exist|missing)|unknown thread/i.test(message)) {
            if (scheduleThreadIsBusy(threadId, true)) throw new BusyScheduleThread();
            throw reason;
          }
          const competingClaim = busyReason(threadId, true);
          if (competingClaim) throw new Error(competingClaim);
          assertIdle(threadId, true);
          useTaskStore.getState().setTaskStatus(threadId, "completed");
          startedThreadId = undefined;
          started = await startFreshThread();
        }
      } else {
        started = await startFreshThread();
      }
      startedThreadId = started.thread.id;
      assertCurrent();
      assertIdle(started.thread.id, reuseThread && started.thread.id === scheduled.lastThreadId);
      current.bindThreadToProject(started.thread.id, project.path);
      claimPreparation(started.thread.id);
      assertCurrent();
      if (!stillOwnsStartingStatus(started.thread.id)) throw new RevokedSchedulePreparation();
      assertIdle(started.thread.id, true);
      const initializeNewThreadGit = createdFreshThread && !project.isChat && current.settings.automaticGitInitialization === true;
      // Snapshot before the unattended turn edits anything; the Codex event
      // router finalizes it on turn completion like any user turn.
      try {
        assertCurrent();
        if (!initializeNewThreadGit) ownedCheckpointId = await current.beginRunCheckpoint(started.thread.id, executionPath, scheduled.prompt, run.provider, run.model);
        assertCurrent();
        assertIdle(started.thread.id, true);
        const model = started.model;
        const params = turnStartParams({ ...runtimeRun, systemPrompt: projectSystemPrompt }, started.thread.id, executionPath, [
          { type: "text", text: providerPrompt, text_elements: [] },
        ], reusingExecutionPath ? current.extraRootsForThread?.(started.thread.id) ?? [] : [], false,
        { systemPrompt: projectSystemPrompt, model: typeof model === "string" ? model : undefined });
        current.onThreadDelegationDisabled?.(started.thread.id, { autoCompactTokens: run.autoCompactTokens });
        assertIdle(started.thread.id, true);
        assertCurrent();
        // Show the captured prompt before optional Git setup. Failed/stopped
        // starts remove it through the existing undelivered-prompt cleanup.
        pendingMessageId = `scheduled-${crypto.randomUUID()}`;
        completedTurnBeforeDispatch = useTaskStore.getState().tasks[started.thread.id]?.lastCompletedTurnId;
        useTaskStore.getState().appendUserMessage(started.thread.id, { id: pendingMessageId, role: "user", text: scheduled.prompt, skillReferences: resolved.skillReferences, skillsFolder: resolved.skillsFolder, skillDependencies: resolved.skillDependencies });
        pendingMessageOrder = useTaskStore.getState().tasks[started.thread.id]?.messages.find((message) => message.id === pendingMessageId)?.timelineOrder;
        const task = useTaskStore.getState().tasks[started.thread.id];
        preparationAnchors.set(started.thread.id, { activeTurnId: task?.activeTurnId, pendingTurnStartOrder: task?.pendingTurnStartOrder });
        if (initializeNewThreadGit) {
          await current.prepareNewThreadGit?.(started.thread.id, project, true);
          assertCurrent();
          assertIdle(started.thread.id, true);
          ownedCheckpointId = await current.beginRunCheckpoint(started.thread.id, executionPath, scheduled.prompt, run.provider, run.model);
        }
        assertCurrent();
        assertIdle(started.thread.id, true);
        turnDispatched = true;
        const result = await rpc<{ turn?: { id?: string } }>("turn/start", params);
        if (typeof result?.turn?.id !== "string" || !result.turn.id.trim()) {
          throw new Error("MYTHRA_DELIVERY_UNCERTAIN: The runtime accepted the start without returning its turn identifier.");
        }
      } catch (reason) {
        // The client identity is reconciled locally from the native prompt
        // echo, not transmitted as a request ID. Use it only when no competing
        // local prompt entered this reserved start; otherwise the same text
        // could belong to that prompt. A new active turn alone is ambiguous.
        const task = useTaskStore.getState().tasks[started.thread.id];
        const competingPrompt = task?.messages.some((message) => message.role === "user"
          && message.clientMessageId && message.clientMessageId !== pendingMessageId
          && message.text === scheduled.prompt
          && pendingMessageOrder !== undefined && (message.timelineOrder ?? -1) >= pendingMessageOrder);
        const acceptedMessage = turnDispatched && pendingMessageId && !competingPrompt
          ? task?.messages.find((message) =>
            message.clientMessageId === pendingMessageId && message.id !== pendingMessageId
            && message.turnId && message.turnId !== completedTurnBeforeDispatch)
          : undefined;
        if (!acceptedMessage) {
          observedRuntimeAfterDispatch = turnDispatched && Boolean(task?.activeTurnId
            || (task?.lastCompletedTurnId && task.lastCompletedTurnId !== completedTurnBeforeDispatch));
          const message = reason instanceof Error ? reason.message : reason;
          unconfirmedAcknowledgement = turnDispatched && (observedRuntimeAfterDispatch
            || /^(?:Error:\s*)?MYTHRA_DELIVERY_UNCERTAIN:/.test(safeErrorText(reason))
            || message === "Codex App Server timed out while handling turn/start");
          if (pendingMessageId && !unconfirmedAcknowledgement) {
            const ownsPendingStart = stillOwnsStartingStatus(started.thread.id);
            useTaskStore.getState().removeMessage(started.thread.id, pendingMessageId);
            // Removing our undelivered prompt also clears its pending order.
            // Keep the preparation receipt aligned without adopting another
            // turn's claim so cleanup can settle only our own starting status.
            if (ownsPendingStart) {
              const task = useTaskStore.getState().tasks[started.thread.id];
              preparationAnchors.set(started.thread.id, { activeTurnId: task?.activeTurnId, pendingTurnStartOrder: task?.pendingTurnStartOrder });
            }
          }
          // Runtime activity without this prompt's echo is ambiguous. Keep its
          // checkpoint and status, but do not report that the schedule started.
          if (ownedCheckpointId && !unconfirmedAcknowledgement) current.discardRunCheckpoint(started.thread.id, ownedCheckpointId);
          throw reason;
        }
      }
      turnStarted = true;
      // Dispatch is the ownership boundary. A later disable/delete does not
      // interrupt accepted work or rewrite the user's new schedule state.
      if (preparationIsCurrent(preparation, depsRef.current)) {
        updateOwnedSchedule((item) => ({
          ...item,
          lastRunAt: Date.now(),
          lastThreadId: started.thread.id,
          unconfirmedThreadId: undefined,
          unconfirmedCompletedTurnId: undefined,
          unconfirmedBaselineUnknown: undefined,
          nextRunAt: Date.now() + item.intervalMinutes * 60_000,
        }));
      }
      void auditEvent("schedule.started", { scheduleId: scheduled.id, projectId: project.id }, started.thread.id).catch(() => {});
      current.recordRun({
        id: crypto.randomUUID(),
        scheduleId: scheduled.id,
        scheduleName: scheduled.name,
        projectId: scheduled.projectId,
        threadId: started.thread.id,
        at: Date.now(),
        status: "started",
      });
      current.onThreadStarted(project);
    } catch (reason) {
      if (!turnDispatched && (reason instanceof RevokedSchedulePreparation || !preparationIsCurrent(preparation, depsRef.current))) {
        if (startedThreadId && !turnStarted && stillOwnsStartingStatus(startedThreadId)) {
          useTaskStore.getState().setTaskStatus(startedThreadId, "interrupted");
        }
        return;
      }
      if (reason instanceof BusyScheduleThread) {
        if (startedThreadId && stillOwnsStartingStatus(startedThreadId)) {
          useTaskStore.getState().setTaskStatus(startedThreadId, "interrupted");
        }
        updateOwnedSchedule((item) => ({ ...item, nextRunAt: Date.now() + 60_000 }));
        return;
      }
      const baselineUnknown = unconfirmedAcknowledgement && reusingExecutionPath && !completedTurnBeforeDispatch;
      const error = unconfirmedAcknowledgement
        ? baselineUnknown
          ? "Scheduled prompt delivery could not be confirmed. Automatic runs are paused because earlier history was unavailable. Inspect this conversation; after confirming its work has stopped, recreate the schedule to resume automatic runs."
          : `Scheduled prompt delivery could not be confirmed. Automatic runs are paused; check or stop the conversation before retrying. ${String(reason).slice(0, 120)}`
        : reason instanceof SkillDependencyError ? reason.message : String(reason).slice(0, 200);
      // A thread whose turn never started would otherwise stay "starting"
      // forever, blocking checkpoints, worktree operations, and deletion for
      // the whole project.
      if (startedThreadId && !turnStarted && !unconfirmedAcknowledgement && stillOwnsStartingStatus(startedThreadId)) {
        useTaskStore.getState().setTaskStatus(startedThreadId, "error", error);
      }
      if (unconfirmedAcknowledgement && startedThreadId) {
        const unconfirmedThreadId = startedThreadId;
        depsRef.current.updateSchedule(scheduled.id, (item) => ({
          ...item,
          unconfirmedThreadId,
          unconfirmedCompletedTurnId: completedTurnBeforeDispatch,
          unconfirmedBaselineUnknown: baselineUnknown || undefined,
          // Keep concurrent edits/enabling decisions; only pause the exact
          // schedule that admitted this failed acknowledgement.
          ...(item === scheduled ? { enabled: false, lastThreadId: unconfirmedThreadId } : {}),
        }));
      } else if (preparationIsCurrent(preparation, depsRef.current)) {
        updateOwnedSchedule((item) => ({ ...item,
          nextRunAt: Date.now() + 5 * 60_000,
        }));
      }
      depsRef.current.recordRun({
        id: crypto.randomUUID(),
        scheduleId: scheduled.id,
        scheduleName: scheduled.name,
        projectId: scheduled.projectId,
        threadId: startedThreadId,
        at: Date.now(),
        status: "failed",
        error,
      });
      void auditEvent("schedule.failed", { scheduleId: scheduled.id, error: String(reason) }).catch(() => {});
    } finally {
      runningRef.current.delete(scheduled.id);
    }
  }, []);

  useEffect(() => {
    const preparations = runningRef.current;
    const check = () => {
      const now = Date.now();
      for (const scheduled of depsRef.current.schedules) {
        if (scheduled.enabled && scheduled.nextRunAt <= now) void runScheduledTask(scheduled);
      }
    };
    check();
    const timer = window.setInterval(check, 30_000);
    return () => {
      window.clearInterval(timer);
      for (const preparation of preparations.values()) preparation.revoked = true;
    };
  }, [runScheduledTask]);
}
