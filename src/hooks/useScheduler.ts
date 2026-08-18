import { useCallback, useEffect, useRef } from "react";
import { auditEvent, rpc } from "../lib/codex";
import { useTaskStore } from "../lib/taskStore";
import { scheduleRunSnapshot, threadStartParams, turnStartParams } from "../lib/turnConfig";
import type { LmStudioModel } from "../components/LmStudioModelControl";
import type { AppSettings, Project, ScheduleRunRecord, ScheduleRunSettings, ScheduledTask, Thread } from "../types";

export interface SchedulerDeps {
  schedules: ScheduledTask[];
  updateSchedule: (id: string, patch: (current: ScheduledTask) => ScheduledTask) => void;
  projects: Project[];
  settings: AppSettings;
  runtimeAvailable: boolean;
  chatGptConnected: boolean;
  openRouterReady: boolean;
  lmStudioReady?: boolean;
  lmStudioModels?: LmStudioModel[];
  ensureSkillRoots: () => Promise<void>;
  bindThreadToProject: (threadId: string, projectPath: string) => void;
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
    const project = current.projects.find((item) => item.id === scheduled.projectId);
    const run: ScheduleRunSettings = scheduled.run ?? scheduleRunSnapshot(current.settings);
    if (!project) {
      // A silent return here would retry every 30 seconds forever with no
      // trace. Disable the schedule and record why it can never fire.
      const error = "This schedule's project was removed from OpenKiwi, so the schedule was disabled.";
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
    runningRef.current.add(scheduled.id);
    let startedThreadId: string | undefined;
    let turnStarted = false;
    try {
      await current.ensureSkillRoots();
      const started = await rpc<{ thread: Thread }>("thread/start", threadStartParams(run, project.path, {
        serviceName: "OpenKiwi",
        modelContextWindow: run.provider === "lmstudio"
          ? current.lmStudioModels?.find((entry) => entry.id === run.model)?.context_length
          : undefined,
        interactive: false,
      }));
      startedThreadId = started.thread.id;
      current.bindThreadToProject(started.thread.id, project.path);
      useTaskStore.getState().ensureTask(started.thread.id, project.path);
      useTaskStore.getState().appendUserMessage(started.thread.id, { id: `scheduled-${crypto.randomUUID()}`, role: "user", text: scheduled.prompt });
      useTaskStore.getState().setTaskStatus(started.thread.id, "starting");
      await rpc("turn/start", turnStartParams(run, started.thread.id, project.path, [
        { type: "text", text: scheduled.prompt, text_elements: [] },
      ]));
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
