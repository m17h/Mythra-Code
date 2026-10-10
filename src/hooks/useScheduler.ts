import { useCallback, useEffect, useRef } from "react";
import { auditEvent, rpc, runtimeInstanceId, runtimeThreadState } from "../lib/codex";
import { useTaskStore } from "../lib/taskStore";
import { scheduleRunSnapshot, threadResumeParams, threadStartParams, turnStartParams } from "../lib/turnConfig";
import type { LMStudioModel } from "../lib/lmStudio";
import type { ResolvedSkillPrompts } from "../lib/skills";
import { SkillDependencyError } from "../lib/skillDependencies";
import { appendCurrentLearnedPreferences } from "../lib/currentLearnedPreferences";
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
  /** Automatic pre-turn file snapshot, same lifecycle user turns get. */
  beginRunCheckpoint: (threadId: string, workspacePath: string, prompt: string, provider: Provider, model: string) => Promise<string | undefined>;
  discardRunCheckpoint: (threadId: string) => void;
  onThreadStarted: (project: Project) => void;
  /** Persist fresh-thread defaults before any turn preparation can fail. */
  onThreadCreated?: (threadId: string, project: Project, options?: { autoCompactTokens?: number }) => void;
  /** App owns the shared-runtime reservation and complete cross-thread guards. */
  restartRuntimeForCapabilities?: (threadId: string, allowOwnStarting?: boolean) => Promise<string>;
  /** Reflect the admitted off policy and own window, including provider-default clearing. */
  onThreadDelegationDisabled?: (threadId: string, options: { autoCompactTokens?: number }) => void;
  /** Includes durable/unresolved native children that may not have loaded tasks. */
  threadBusyReason?: (threadId: string, ignoreOwnStarting?: boolean) => string | null;
  recordRun: (run: ScheduleRunRecord) => void;
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
  const runningRef = useRef(new Set<string>());

  const runScheduledTask = useCallback(async (scheduled: ScheduledTask) => {
    const current = depsRef.current;
    if (runningRef.current.has(scheduled.id)) return;
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
      current.updateSchedule(scheduled.id, (item) => ({ ...item, enabled: false }));
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
      current.updateSchedule(scheduled.id, (item) => ({
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
    const preparationAnchors = new Map<string, { activeTurnId?: string; pendingTurnStartOrder?: number }>();
    const busyReason = (threadId: string, ownStarting = false): string | null => {
      const state = useTaskStore.getState();
      const task = state.tasks[threadId];
      const external = current.threadBusyReason?.(threadId, ownStarting);
      if (external) return external;
      if (state.statuses[threadId] === "running" || state.statuses[threadId] === "starting" && !ownStarting
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
      current.updateSchedule(scheduled.id, (item) => ({ ...item, nextRunAt: Date.now() + 60_000 }));
      return;
    }
    runningRef.current.add(scheduled.id);
    let startedThreadId: string | undefined;
    let turnStarted = false;
    const assertIdle = (threadId: string, ownStarting = false) => {
      const reason = busyReason(threadId, ownStarting);
      if (reason) throw new Error(reason);
    };
    const claimPreparation = (threadId: string) => {
      const state = useTaskStore.getState();
      state.ensureTask(threadId, project.path);
      state.setTaskStatus(threadId, "starting");
      const task = useTaskStore.getState().tasks[threadId];
      preparationAnchors.set(threadId, { activeTurnId: task?.activeTurnId, pendingTurnStartOrder: task?.pendingTurnStartOrder });
    };
    try {
      const compactionReason = parentAutoCompactionUnavailableReason(run.provider, run.autoCompactTokens);
      if (compactionReason) throw new Error(compactionReason);
      const resolved: ResolvedSkillPrompts = current.resolveSkillPrompts
        ? await current.resolveSkillPrompts(scheduled.prompt, run.systemPrompt)
        : { prompt: await current.resolveSkillPrompt(scheduled.prompt), systemPrompt: run.systemPrompt };
      const systemPrompt = await appendCurrentLearnedPreferences(resolved.systemPrompt, scheduled.projectId);
      await current.ensureSkillRoots();
      const providerPrompt = resolved.prompt;
      // Scheduled roots retain their off policy on every iteration, including
      // old snapshots that predate thread-local delegation authority.
      const runtimeRun = { ...run, systemPrompt, subagentsEnabled: false, subagentEngine: "mythra" as const, nativeSubagentOptions: undefined };
      const capabilities = subagentCapabilitySignature({ subagentsEnabled: false, subagentMax: 1, autoCompactTokens: run.autoCompactTokens });
      const modelContextWindow = run.provider === "lmstudio"
        ? current.lmStudioModels?.find((entry) => entry.id === run.model)?.maxContextLength
        : undefined;
      const startFreshThread = async () => {
        const instance = await runtimeInstanceId();
        const started = await rpc<{ thread: Thread; model?: unknown }>("thread/start", threadStartParams(runtimeRun, project.path, {
          serviceName: "Mythra Code",
          modelContextWindow,
          interactive: false,
          perTurnSystemPrompt: true,
        }));
        current.onThreadCreated?.(started.thread.id, project, { autoCompactTokens: run.autoCompactTokens });
        recordSubagentCapabilities(started.thread.id, instance, capabilities);
        return started;
      };
      let started: { thread: Thread; model?: unknown };
      if (reuseThread && scheduled.lastThreadId) {
        const threadId = scheduled.lastThreadId;
        assertIdle(threadId);
        startedThreadId = threadId;
        claimPreparation(threadId);
        const runtime = await runtimeThreadState(threadId);
        assertIdle(threadId, true);
        const plan = planSubagentCapabilities(threadId, runtime.instance, capabilities, runtime.loaded);
        let instance = runtime.instance;
        if (plan.restartRuntime) {
          if (!current.restartRuntimeForCapabilities) throw new Error("This scheduled thread needs a safe runtime refresh before delegation can be disabled. The scheduled prompt was not sent.");
          instance = await current.restartRuntimeForCapabilities(threadId, true);
          assertIdle(threadId, true);
        }
        try {
          started = await rpc<{ thread: Thread; model?: unknown }>("thread/resume", threadResumeParams(
            runtimeRun,
            scheduled.lastThreadId,
            project.path,
            { modelContextWindow, refreshRuntimeConfig: true, interactive: false, perTurnSystemPrompt: true },
          ));
          recordSubagentCapabilities(started.thread.id, instance, capabilities);
        } catch (reason) {
          // The user may have deleted the earlier run's conversation. Keep the
          // schedule useful by establishing a new thread that later triggers
          // can reuse, rather than failing forever on a stale id.
          const message = reason instanceof Error ? reason.message : String(reason);
          if (!/no rollout found for thread id|thread.{0,30}(?:not found|does not exist|missing)|unknown thread/i.test(message)) throw reason;
          assertIdle(threadId, true);
          useTaskStore.getState().setTaskStatus(threadId, "completed");
          startedThreadId = undefined;
          started = await startFreshThread();
        }
      } else {
        started = await startFreshThread();
      }
      startedThreadId = started.thread.id;
      assertIdle(started.thread.id, reuseThread && started.thread.id === scheduled.lastThreadId);
      current.bindThreadToProject(started.thread.id, project.path);
      claimPreparation(started.thread.id);
      // Snapshot before the unattended turn edits anything; the Codex event
      // router finalizes it on turn completion like any user turn.
      try {
        await current.beginRunCheckpoint(started.thread.id, project.path, scheduled.prompt, run.provider, run.model);
        assertIdle(started.thread.id, true);
        const model = started.model;
        const params = turnStartParams(runtimeRun, started.thread.id, project.path, [
          { type: "text", text: providerPrompt, text_elements: [] },
        ], [], false, { systemPrompt, model: typeof model === "string" ? model : undefined });
        current.onThreadDelegationDisabled?.(started.thread.id, { autoCompactTokens: run.autoCompactTokens });
        assertIdle(started.thread.id, true);
        // Preparation and parameter validation can fail without a request.
        // Append only when dispatch is next, so history never claims delivery.
        useTaskStore.getState().appendUserMessage(started.thread.id, { id: `scheduled-${crypto.randomUUID()}`, role: "user", text: scheduled.prompt, skillReferences: resolved.skillReferences, skillsFolder: resolved.skillsFolder, skillDependencies: resolved.skillDependencies });
        const task = useTaskStore.getState().tasks[started.thread.id];
        preparationAnchors.set(started.thread.id, { activeTurnId: task?.activeTurnId, pendingTurnStartOrder: task?.pendingTurnStartOrder });
        await rpc("turn/start", params);
      } catch (reason) {
        // No turn started, so no completion event will finalize the snapshot.
        current.discardRunCheckpoint(started.thread.id);
        throw reason;
      }
      turnStarted = true;
      current.updateSchedule(scheduled.id, (item) => ({
        ...item,
        lastRunAt: Date.now(),
        lastThreadId: started.thread.id,
        nextRunAt: Date.now() + item.intervalMinutes * 60_000,
      }));
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
      const error = reason instanceof SkillDependencyError ? reason.message : String(reason).slice(0, 200);
      // A thread whose turn never started would otherwise stay "starting"
      // forever, blocking checkpoints, worktree operations, and deletion for
      // the whole project.
      if (startedThreadId && !turnStarted) {
        const state = useTaskStore.getState();
        const task = state.tasks[startedThreadId];
        const anchor = preparationAnchors.get(startedThreadId);
        if (state.statuses[startedThreadId] === "starting" && anchor
          && task?.activeTurnId === anchor.activeTurnId && task?.pendingTurnStartOrder === anchor.pendingTurnStartOrder) {
          state.setTaskStatus(startedThreadId, "error", error);
        }
      }
      depsRef.current.updateSchedule(scheduled.id, (item) => ({ ...item, nextRunAt: Date.now() + 5 * 60_000 }));
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
    const check = () => {
      const now = Date.now();
      for (const scheduled of depsRef.current.schedules) {
        if (scheduled.enabled && scheduled.nextRunAt <= now) void runScheduledTask(scheduled);
      }
    };
    check();
    const timer = window.setInterval(check, 30_000);
    return () => window.clearInterval(timer);
  }, [runScheduledTask]);
}
