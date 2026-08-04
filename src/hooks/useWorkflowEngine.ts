import { useCallback, useEffect, useRef } from "react";
import { auditEvent, rpc } from "../lib/codex";
import { friendlyError } from "../lib/errors";
import { useTaskStore, type TaskStatus } from "../lib/taskStore";
import { commandSandbox, threadStartParams, turnStartParams } from "../lib/turnConfig";
import {
  interpolateWorkflowText,
  nextWorkflowFailureAt,
  nextWorkflowRunAt,
  normalizeWorkflow,
  shouldRunWorkflowStep,
  validateWorkflow,
  workflowPrompt,
  workflowStepRetries,
  type WorkflowDefinition,
  type WorkflowRunRecord,
  type WorkflowRunSource,
  type WorkflowRunStepRecord,
} from "../lib/workflows";
import type { CustomAgentProfile, Project, Thread, Turn } from "../types";

const TERMINAL_STATUSES = new Set<TaskStatus>(["completed", "interrupted", "error"]);

class WorkflowStoppedError extends Error {
  readonly code = "workflow_stopped";

  constructor() {
    super("Workflow was stopped.");
    this.name = "WorkflowStoppedError";
  }
}

class WorkflowTurnTimeoutError extends Error {
  readonly code = "workflow_turn_timeout";

  constructor() {
    super("The workflow step timed out.");
    this.name = "WorkflowTurnTimeoutError";
  }
}

function workflowErrorCode(reason: unknown): string | undefined {
  return reason && typeof reason === "object" && "code" in reason
    ? String(reason.code)
    : undefined;
}

function isWorkflowStoppedError(reason: unknown): boolean {
  return reason instanceof WorkflowStoppedError || workflowErrorCode(reason) === "workflow_stopped";
}

function isWorkflowTurnTimeoutError(reason: unknown): boolean {
  return reason instanceof WorkflowTurnTimeoutError
    || workflowErrorCode(reason) === "workflow_turn_timeout"
    || (reason instanceof Error && (
      reason.name === "WorkflowTurnTimeoutError"
      || reason.message === "The workflow step timed out."
    ));
}

interface ActiveWorkflowRun {
  runId: string;
  stopRequested: boolean;
  threadId?: string;
  turnId?: string;
  processId?: string;
  waitController?: AbortController;
  publish: (patch: Partial<WorkflowRunRecord>) => void;
}

function replaceStep(
  steps: WorkflowRunStepRecord[],
  stepId: string,
  patch: Partial<WorkflowRunStepRecord>,
): WorkflowRunStepRecord[] {
  return steps.map((step) => step.stepId === stepId ? { ...step, ...patch } : step);
}

function workflowVariables(
  workflow: WorkflowDefinition,
  project: Project,
  source: WorkflowRunSource,
  runId: string,
  startedAt: number,
  overrides: Record<string, string>,
): Record<string, string> {
  const configured = Object.fromEntries((workflow.variables ?? []).map((variable) => [
    variable.name,
    overrides[variable.name] ?? variable.value,
  ]));
  return {
    ...configured,
    workflowName: workflow.name,
    projectName: project.name,
    projectPath: project.path,
    trigger: source,
    runId,
    timestamp: new Date(startedAt).toISOString(),
    date: new Date(startedAt).toISOString().slice(0, 10),
    previousStepStatus: "none",
    previousStepOutput: "",
    previousExitCode: "",
  };
}

function createActiveWaitSignal(active: ActiveWorkflowRun): AbortSignal {
  const controller = new AbortController();
  active.waitController = controller;
  if (active.stopRequested) controller.abort();
  return controller.signal;
}

function clearActiveWaitSignal(active: ActiveWorkflowRun, signal: AbortSignal): void {
  if (active.waitController?.signal === signal) active.waitController = undefined;
}

function waitForRetry(active: ActiveWorkflowRun, seconds: number): Promise<void> {
  if (seconds <= 0) return Promise.resolve();
  const signal = createActiveWaitSignal(active);
  return new Promise((resolve, reject) => {
    const stop = () => {
      window.clearTimeout(timer);
      clearActiveWaitSignal(active, signal);
      reject(new WorkflowStoppedError());
    };
    const timer = window.setTimeout(() => {
      signal.removeEventListener("abort", stop);
      clearActiveWaitSignal(active, signal);
      resolve();
    }, seconds * 1_000);
    signal.addEventListener("abort", stop, { once: true });
    if (signal.aborted) stop();
  });
}

export function waitForWorkflowTurn(
  threadId: string,
  turnId?: string,
  signal?: AbortSignal,
  timeoutMs = 2 * 60 * 60_000,
  onTimeout?: () => void,
): Promise<TaskStatus> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (status: TaskStatus) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      unsubscribe();
      signal?.removeEventListener("abort", stop);
      if (status === "completed") resolve(status);
      else if (status === "interrupted") reject(new WorkflowStoppedError());
      else reject(new Error("The agent step failed."));
    };
    const inspect = () => {
      const state = useTaskStore.getState();
      const task = state.tasks[threadId];
      if (turnId && task?.lastCompletedTurnId !== turnId) return;
      const status = turnId ? task?.lastCompletedTurnStatus : state.statuses[threadId];
      if (status && TERMINAL_STATUSES.has(status)) finish(status);
    };
    const stop = () => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      unsubscribe();
      reject(new WorkflowStoppedError());
    };
    const unsubscribe = useTaskStore.subscribe(inspect);
    const timer = window.setTimeout(() => {
      if (settled) return;
      settled = true;
      unsubscribe();
      signal?.removeEventListener("abort", stop);
      onTimeout?.();
      reject(new WorkflowTurnTimeoutError());
    }, timeoutMs);
    signal?.addEventListener("abort", stop, { once: true });
    if (signal?.aborted) {
      stop();
      return;
    }
    inspect();
  });
}

interface WorkflowEngineDeps {
  workflows: WorkflowDefinition[];
  projects: Project[];
  runtimeAvailable: boolean;
  chatGptConnected: boolean;
  openRouterReady: boolean;
  customAgents: CustomAgentProfile[];
  ensureSkillRoots: () => Promise<void>;
  bindThreadToProject: (threadId: string, projectPath: string) => void;
  updateWorkflow: (id: string, patch: (current: WorkflowDefinition) => WorkflowDefinition) => void;
  recordRun: (run: WorkflowRunRecord) => void;
  onThreadStarted: (project: Project, threadId: string, source: WorkflowRunSource) => void;
  onError: (message: string) => void;
  turnTimeoutMs?: number;
}

type WorkflowPreflightResult =
  | { ready: true; workflow: WorkflowDefinition; project: Project }
  | { ready: false; retryWhenReady: boolean; message: string };

function workflowPreflight(
  current: WorkflowEngineDeps,
  storedWorkflow: WorkflowDefinition,
): WorkflowPreflightResult {
  const workflow = normalizeWorkflow(storedWorkflow);
  const validationError = validateWorkflow(workflow);
  if (validationError) return { ready: false, retryWhenReady: false, message: validationError };
  const project = current.projects.find((item) => item.id === workflow.projectId);
  if (!project) return { ready: false, retryWhenReady: false, message: "The workflow project is no longer available." };
  if (!current.runtimeAvailable) {
    return { ready: false, retryWhenReady: true, message: "Install or reconnect the Codex runtime before running workflows." };
  }
  if (workflow.run.provider === "openai" && !current.chatGptConnected) {
    return { ready: false, retryWhenReady: true, message: "Sign in to ChatGPT before running this OpenAI workflow." };
  }
  if (workflow.run.provider === "openrouter" && !current.openRouterReady) {
    return { ready: false, retryWhenReady: true, message: "Add an OpenRouter API key before running this workflow." };
  }
  if (workflow.run.provider === "claude" || workflow.run.provider === "cursor") {
    const provider = workflow.run.provider === "cursor" ? "Cursor" : "Claude";
    return { ready: false, retryWhenReady: false, message: `${provider} workflows are not enabled yet. Run these steps from a ${provider} project thread, or save the workflow with OpenAI/OpenRouter.` };
  }
  return { ready: true, workflow, project };
}

async function interruptActiveTurn(active: ActiveWorkflowRun): Promise<void> {
  if (!active.threadId || !active.turnId) return;
  await rpc("turn/interrupt", {
    threadId: active.threadId,
    turnId: active.turnId,
  }).catch(() => undefined);
}

export function useWorkflowEngine(deps: WorkflowEngineDeps) {
  const depsRef = useRef(deps);
  depsRef.current = deps;
  const runningRef = useRef(new Map<string, ActiveWorkflowRun>());
  const appStartRef = useRef(new Set<string>());

  const stopWorkflow = useCallback(async (workflowId: string): Promise<boolean> => {
    const active = runningRef.current.get(workflowId);
    if (!active) return false;
    if (!active.stopRequested) {
      active.stopRequested = true;
      active.publish({ stopRequestedAt: Date.now() });
    }
    active.waitController?.abort();
    const requests: Array<Promise<unknown>> = [];
    if (active.processId) {
      requests.push(rpc("command/exec/terminate", { processId: active.processId }).catch(() => undefined));
    }
    requests.push(interruptActiveTurn(active));
    await Promise.all(requests);
    return true;
  }, []);

  const runWorkflow = useCallback(async (
    workflowId: string,
    source: WorkflowRunSource = "manual",
    variableOverrides: Record<string, string> = {},
  ): Promise<string | undefined> => {
    const current = depsRef.current;
    const storedWorkflow = current.workflows.find((item) => item.id === workflowId);
    if (!storedWorkflow || runningRef.current.has(workflowId)) return undefined;
    const preflight = workflowPreflight(current, storedWorkflow);
    if (!preflight.ready) {
      if (source === "manual") current.onError(preflight.message);
      return undefined;
    }
    const { workflow, project } = preflight;

    const runId = crypto.randomUUID();
    const startedAt = Date.now();
    const variables = workflowVariables(workflow, project, source, runId, startedAt, variableOverrides);
    let threadId: string | undefined;
    let steps: WorkflowRunStepRecord[] = workflow.steps.map((step) => ({
      stepId: step.id,
      name: step.name,
      type: step.type,
      status: "pending",
      attempts: 0,
    }));
    let runState: WorkflowRunRecord = {
      id: runId,
      workflowId: workflow.id,
      workflowName: workflow.name,
      projectId: workflow.projectId,
      source,
      startedAt,
      currentStep: 0,
      stepCount: workflow.steps.length,
      status: "running",
      variables,
      steps,
    };
    const publish = (patch: Partial<WorkflowRunRecord>) => {
      runState = { ...runState, ...patch };
      current.recordRun(runState);
    };
    const active: ActiveWorkflowRun = { runId, stopRequested: false, publish };

    runningRef.current.set(workflowId, active);
    publish({});
    try {
      await current.ensureSkillRoots();
      const started = await rpc<{ thread: Thread }>("thread/start", threadStartParams(workflow.run, project.path, {
        serviceName: `OpenKiwi Workflow: ${workflow.name}`,
        customAgents: current.customAgents,
        interactive: source === "manual",
      }));
      threadId = started.thread.id;
      active.threadId = threadId;
      if (active.stopRequested) throw new WorkflowStoppedError();
      current.bindThreadToProject(threadId, project.path);
      useTaskStore.getState().ensureTask(threadId, project.path);
      await rpc("thread/name/set", { threadId, name: `Workflow: ${workflow.name}` }).catch(() => {});
      current.onThreadStarted(project, threadId, source);
      publish({ threadId });

      let previousStatus: "none" | "completed" | "failed" | "skipped" = "none";
      for (const [index, step] of workflow.steps.entries()) {
        if (active.stopRequested) throw new WorkflowStoppedError();
        variables.previousStepStatus = previousStatus;
        if (!shouldRunWorkflowStep(step, previousStatus, variables)) {
          previousStatus = "skipped";
          variables.previousStepStatus = "skipped";
          variables.previousExitCode = "";
          steps = replaceStep(steps, step.id, {
            status: "skipped",
            finishedAt: Date.now(),
            output: "Condition was not met.",
          });
          publish({ threadId, currentStep: index + 1, variables: { ...variables }, steps });
          continue;
        }

        publish({ threadId, currentStep: index + 1 });
        const stepInputVariables = { ...variables };
        const retry = workflowStepRetries(step);
        let stepError: unknown;
        let stepOutput = "";
        for (let attempt = 1; attempt <= retry.count + 1; attempt += 1) {
          if (active.stopRequested) throw new WorkflowStoppedError();
          const attemptStartedAt = Date.now();
          let attemptTurnTimedOut = false;
          stepOutput = "";
          steps = replaceStep(steps, step.id, {
            status: "running",
            attempts: attempt,
            startedAt: steps.find((item) => item.stepId === step.id)?.startedAt ?? attemptStartedAt,
            finishedAt: undefined,
            output: undefined,
            error: undefined,
          });
          publish({ steps });
          try {
            if (step.type === "command") {
              const command = interpolateWorkflowText(step.command, stepInputVariables);
              variables.previousExitCode = "";
              const activityId = `workflow-${runId}-${step.id}`;
              const processId = `workflow-${runId}-${step.id}-${attempt}`;
              active.processId = processId;
              useTaskStore.getState().upsertActivity(threadId, {
                id: activityId,
                kind: "command",
                title: command,
                detail: attempt > 1 ? `${step.name} · attempt ${attempt}` : step.name,
                status: "inProgress",
              });
              const result = await rpc<{ exitCode: number; stdout: string; stderr: string }>("command/exec", {
                command: ["/bin/zsh", "-lc", command],
                processId,
                cwd: project.path,
                timeoutMs: 30 * 60_000,
                sandboxPolicy: commandSandbox(workflow.run.permission, project.path),
              });
              active.processId = undefined;
              stepOutput = [result.stdout, result.stderr].filter(Boolean).join("\n").trim().slice(-12_000);
              useTaskStore.getState().upsertActivity(threadId, {
                id: activityId,
                kind: "command",
                title: command,
                detail: stepOutput || step.name,
                status: result.exitCode === 0 ? "completed" : "failed",
              });
              variables.previousExitCode = String(result.exitCode);
              if (result.exitCode !== 0) throw new Error(`Command exited with code ${result.exitCode}.`);
            } else {
              const prompt = workflowPrompt(workflow, step, index, stepInputVariables);
              variables.previousExitCode = "";
              const beforeMessages = useTaskStore.getState().tasks[threadId]?.messages.length ?? 0;
              useTaskStore.getState().appendUserMessage(threadId, {
                id: `workflow-${runId}-${step.id}`,
                role: "user",
                text: prompt,
              });
              useTaskStore.getState().setTaskStatus(threadId, "starting");
              const result = await rpc<{ turn: Turn }>("turn/start", turnStartParams(
                workflow.run,
                threadId,
                project.path,
                [{ type: "text", text: prompt, text_elements: [] }],
              ));
              active.turnId = result.turn?.id;
              if (!active.turnId) throw new Error("The runtime did not return a turn identifier.");
              if (useTaskStore.getState().tasks[threadId]?.lastCompletedTurnId !== active.turnId) {
                useTaskStore.getState().setActiveTurn(threadId, active.turnId);
              }
              if (active.stopRequested) {
                await interruptActiveTurn(active);
                throw new WorkflowStoppedError();
              }
              const signal = createActiveWaitSignal(active);
              try {
                await waitForWorkflowTurn(
                  threadId,
                  active.turnId,
                  signal,
                  current.turnTimeoutMs ?? 2 * 60 * 60_000,
                  () => { attemptTurnTimedOut = true; },
                );
              } finally {
                clearActiveWaitSignal(active, signal);
              }
              active.turnId = undefined;
              const messages = useTaskStore.getState().tasks[threadId]?.messages.slice(beforeMessages) ?? [];
              stepOutput = [...messages].reverse().find((message) => message.role === "assistant")?.text.trim().slice(-12_000) ?? "";
            }
            if (active.stopRequested) throw new WorkflowStoppedError();
            steps = replaceStep(steps, step.id, {
              status: "completed",
              finishedAt: Date.now(),
              output: stepOutput,
              error: undefined,
            });
            publish({ steps });
            stepError = undefined;
            break;
          } catch (reason) {
            const turnTimedOut = attemptTurnTimedOut
              || isWorkflowTurnTimeoutError(reason)
              || (step.type === "agent"
                && Date.now() - attemptStartedAt >= (current.turnTimeoutMs ?? 2 * 60 * 60_000));
            if (turnTimedOut) await interruptActiveTurn(active);
            active.processId = undefined;
            active.turnId = undefined;
            stepError = reason;
            // An agent turn that never started (turn/start rejected) leaves
            // the workflow thread in "starting" with no runtime event coming
            // to repair it. Reset it here whenever this attempt is terminal —
            // a retried attempt re-marks "starting" itself.
            const stopped = active.stopRequested || isWorkflowStoppedError(reason);
            const willRetry = !stopped && attempt <= retry.count && !turnTimedOut;
            if (!willRetry && useTaskStore.getState().tasks[threadId]?.status === "starting") {
              useTaskStore.getState().setTaskStatus(
                threadId,
                stopped ? "interrupted" : "error",
                stopped ? undefined : friendlyError(reason),
              );
            }
            if (stopped) {
              throw new WorkflowStoppedError();
            }
            if (attempt <= retry.count && !turnTimedOut) {
              steps = replaceStep(steps, step.id, {
                status: "running",
                error: `${friendlyError(reason)} Retrying…`,
              });
              publish({ steps });
              await waitForRetry(active, retry.delaySeconds);
              continue;
            }
            steps = replaceStep(steps, step.id, {
              status: "failed",
              finishedAt: Date.now(),
              output: stepOutput,
              error: friendlyError(reason),
            });
            publish({ steps });
            break;
          }
        }

        if (stepError) {
          previousStatus = "failed";
          variables.previousStepStatus = "failed";
          variables.previousStepOutput = stepOutput || friendlyError(stepError);
          publish({ variables: { ...variables } });
          if (!step.continueOnError) throw stepError;
          useTaskStore.getState().upsertActivity(threadId, {
            id: `workflow-warning-${runId}-${step.id}`,
            kind: "warning",
            title: `${step.name} failed; workflow continued`,
            detail: friendlyError(stepError),
            status: "failed",
          });
        } else {
          previousStatus = "completed";
          variables.previousStepStatus = "completed";
          variables.previousStepOutput = stepOutput;
          publish({ variables: { ...variables }, steps });
        }
      }

      const finishedAt = Date.now();
      publish({
        threadId,
        currentStep: workflow.steps.length,
        finishedAt,
        status: "completed",
        variables: { ...variables },
        steps,
      });
      current.updateWorkflow(workflow.id, (item) => ({
        ...item,
        lastRunAt: finishedAt,
        lastThreadId: threadId,
        nextRunAt: source === "interval"
          ? nextWorkflowRunAt(item.trigger, finishedAt)
          : item.nextRunAt,
        consecutiveFailures: source === "interval" ? 0 : item.consecutiveFailures,
        updatedAt: finishedAt,
      }));
      void auditEvent("workflow.completed", {
        workflowId: workflow.id,
        source,
        stepCount: workflow.steps.length,
      }, threadId).catch(() => {});
      return threadId;
    } catch (reason) {
      const stopped = active.stopRequested || isWorkflowStoppedError(reason);
      const message = stopped ? "Workflow was stopped." : friendlyError(reason);
      const finishedAt = Date.now();
      if (stopped) {
        steps = steps.map((step) => step.status !== "running" ? step : {
          ...step,
          status: "interrupted",
          finishedAt,
          error: message,
        });
      }
      publish({
        threadId,
        finishedAt,
        status: stopped ? "interrupted" : "failed",
        error: message.slice(0, 300),
        variables: { ...variables },
        steps,
      });
      current.updateWorkflow(workflow.id, (item) => {
        const consecutiveFailures = stopped
          ? item.consecutiveFailures ?? 0
          : (item.consecutiveFailures ?? 0) + 1;
        return {
          ...item,
          lastRunAt: finishedAt,
          lastThreadId: threadId ?? item.lastThreadId,
          nextRunAt: source === "interval"
            ? stopped
              ? nextWorkflowRunAt(item.trigger, finishedAt)
              : nextWorkflowFailureAt(item.trigger, consecutiveFailures, finishedAt)
            : item.nextRunAt,
          consecutiveFailures: source === "interval" ? consecutiveFailures : item.consecutiveFailures,
          updatedAt: finishedAt,
        };
      });
      void auditEvent(stopped ? "workflow.interrupted" : "workflow.failed", {
        workflowId: workflow.id,
        source,
        error: message,
      }, threadId).catch(() => {});
      if (source === "manual" && !stopped) current.onError(message);
      return threadId;
    } finally {
      active.waitController?.abort();
      runningRef.current.delete(workflowId);
    }
  }, []);

  useEffect(() => {
    const check = () => {
      const now = Date.now();
      const current = depsRef.current;
      for (const workflow of current.workflows) {
        if (!workflow.enabled) continue;
        if (workflow.trigger.type === "manual") continue;
        const preflight = workflowPreflight(current, workflow);
        if (!preflight.ready) {
          if (!preflight.retryWhenReady) {
            const source = workflow.trigger.type === "app-start" ? "app-start" : "interval";
            const due = workflow.trigger.type === "app-start"
              ? !appStartRef.current.has(workflow.id)
              : (workflow.nextRunAt ?? 0) <= now;
            if (due) {
              current.recordRun({
                id: crypto.randomUUID(),
                workflowId: workflow.id,
                workflowName: workflow.name,
                projectId: workflow.projectId,
                source,
                startedAt: now,
                finishedAt: now,
                currentStep: 0,
                stepCount: workflow.steps.length,
                status: "failed",
                error: preflight.message,
              });
              void auditEvent("workflow.preflightFailed", {
                workflowId: workflow.id,
                source,
                error: preflight.message,
              }).catch(() => {});
            }
            if (workflow.trigger.type === "interval" && due) {
              current.updateWorkflow(workflow.id, (item) => ({
                ...item,
                nextRunAt: nextWorkflowRunAt(item.trigger, now),
                updatedAt: now,
              }));
            }
            if (workflow.trigger.type === "app-start") appStartRef.current.add(workflow.id);
          }
          continue;
        }
        if (workflow.trigger.type === "interval" && (workflow.nextRunAt ?? 0) <= now) {
          void runWorkflow(workflow.id, "interval");
        }
        if (workflow.trigger.type === "app-start" && !appStartRef.current.has(workflow.id)) {
          appStartRef.current.add(workflow.id);
          void runWorkflow(workflow.id, "app-start");
        }
      }
    };
    check();
    const timer = window.setInterval(check, 30_000);
    return () => window.clearInterval(timer);
  }, [runWorkflow, deps.runtimeAvailable, deps.chatGptConnected, deps.openRouterReady]);

  return { runWorkflow, stopWorkflow };
}
