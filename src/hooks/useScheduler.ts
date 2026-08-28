import { useCallback, useEffect, useRef } from "react";
import { auditEvent, rpc } from "../lib/codex";
import { useTaskStore } from "../lib/taskStore";
import { scheduleRunSnapshot, threadResumeParams, threadStartParams, turnStartParams } from "../lib/turnConfig";
import type { LMStudioModel } from "../lib/lmStudio";
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
  bindThreadToProject: (threadId: string, projectPath: string) => void;
  /** Automatic pre-turn file snapshot, same lifecycle user turns get. */
  beginRunCheckpoint: (threadId: string, workspacePath: string, prompt: string, provider: Provider, model: string) => Promise<string | undefined>;
  discardRunCheckpoint: (threadId: string) => void;
  onThreadStarted: (project: Project) => void;
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
    const existingStatus = scheduled.lastThreadId
      ? useTaskStore.getState().statuses[scheduled.lastThreadId]
      : undefined;
    if (reuseThread && (existingStatus === "starting" || existingStatus === "running")) {
      // A recurring prompt must never collide with the previous unattended
      // turn in the same conversation. Retry soon without creating a second
      // thread or recording a misleading failed run.
      current.updateSchedule(scheduled.id, (item) => ({ ...item, nextRunAt: Date.now() + 60_000 }));
      return;
    }
    runningRef.current.add(scheduled.id);
    let startedThreadId: string | undefined;
    let turnStarted = false;
    try {
      await current.ensureSkillRoots();
      const modelContextWindow = run.provider === "lmstudio"
        ? current.lmStudioModels?.find((entry) => entry.id === run.model)?.maxContextLength
        : undefined;
      const startFreshThread = () => rpc<{ thread: Thread }>("thread/start", threadStartParams(run, project.path, {
        serviceName: "Mythra Code",
        modelContextWindow,
        interactive: false,
      }));
      let started: { thread: Thread };
      if (reuseThread && scheduled.lastThreadId) {
        try {
          started = await rpc<{ thread: Thread }>("thread/resume", threadResumeParams(
            run,
            scheduled.lastThreadId,
            project.path,
            { modelContextWindow, refreshRuntimeConfig: true },
          ));
        } catch {
          // The user may have deleted the earlier run's conversation. Keep the
          // schedule useful by establishing a new thread that later triggers
          // can reuse, rather than failing forever on a stale id.
          started = await startFreshThread();
        }
      } else {
        started = await startFreshThread();
      }
      startedThreadId = started.thread.id;
      current.bindThreadToProject(started.thread.id, project.path);
      useTaskStore.getState().ensureTask(started.thread.id, project.path);
      useTaskStore.getState().appendUserMessage(started.thread.id, { id: `scheduled-${crypto.randomUUID()}`, role: "user", text: scheduled.prompt });
      useTaskStore.getState().setTaskStatus(started.thread.id, "starting");
      // Snapshot before the unattended turn edits anything; the Codex event
      // router finalizes it on turn completion like any user turn.
      await current.beginRunCheckpoint(started.thread.id, project.path, scheduled.prompt, run.provider, run.model);
      try {
        await rpc("turn/start", turnStartParams(run, started.thread.id, project.path, [
          { type: "text", text: scheduled.prompt, text_elements: [] },
        ], [], false));
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
      // A thread whose turn never started would otherwise stay "starting"
      // forever, blocking checkpoints, worktree operations, and deletion for
      // the whole project.
      if (startedThreadId && !turnStarted) {
        useTaskStore.getState().setTaskStatus(startedThreadId, "error", String(reason).slice(0, 200));
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
        error: String(reason).slice(0, 200),
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
