import { invoke } from "@tauri-apps/api/core";
import type { TurnRunnerContext } from "../../hooks/useTurnRunner";
import type { Project, Thread } from "../../types";
import { useTaskStore } from "../taskStore";
import type { WorkflowDefinition } from "../workflows";
import type { HostParityActions } from "./host";
import { HostReadError } from "./host/scope";
import type { WireParityReadResult, WireParityRow, WireProvider } from "./wire";

const MAX_ROWS = 200;
function hash(text: string): string {
  let a = 0x811c9dc5;
  let b = 0xcbf29ce4;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    a = Math.imul(a ^ code, 0x01000193) >>> 0;
    b = Math.imul(b + code, 0x85ebca6b) >>> 0;
  }
  return `r${a.toString(36)}${b.toString(36)}`;
}

export interface HostParityDeps {
  getProject(workspaceId: string): Project | null;
  updateProject(workspaceId: string, change: (project: Project) => Project): void;
  getWorkflows(): readonly WorkflowDefinition[];
  getPublicSkills(): readonly { name: string; description?: string; enabled?: boolean }[];
  getArchived(workspaceId: string): readonly { id: string; label: string; archivedAt: number; provider?: string; child: boolean }[];
  searchThreads(context: TurnRunnerContext, query: string): Promise<readonly Thread[]>;
  archiveThread(threadId: string): Promise<void>;
  deleteThread(threadId: string): Promise<void>;
  stopWorkflow(workflowId: string, runId: string): Promise<boolean>;
  pumpQueue(threadId: string): void;
  /** Whether this checkpoint is shown for this target, then flips its Accepted mark. */
  acceptCheckpoint(context: TurnRunnerContext, checkpointId: string): boolean;
  stopAgent(parentThreadId: string, agentId: string): Promise<void>;
}

/** Reads and the writes this app can do against a supplied target. Anything that
 * needs an engine seam it doesn't have yet refuses, and never pretends. */
export function createHostParity(deps: HostParityDeps): HostParityActions {
  const unavailable = () => new HostReadError("unsupported", "This host action isn't available on this device yet.");
  const projectFor = (context: TurnRunnerContext) => {
    const id = context.activeProject?.id;
    const project = id ? deps.getProject(id) : null;
    if (!project) throw new HostReadError("thread_unavailable", "This project is unavailable.");
    return project;
  };
  const threadId = (context: TurnRunnerContext) => {
    const id = context.activeThread?.id;
    if (!id) throw new HostReadError("thread_unavailable", "This conversation is unavailable.");
    return id;
  };
  const queueRow = (context: TurnRunnerContext) => {
    const id = context.activeThread?.id;
    return id ? useTaskStore.getState().tasks[id]?.queuedTurns ?? [] : [];
  };
  const revision = (context: TurnRunnerContext) => {
    const state = useTaskStore.getState();
    const id = context.activeThread?.id ?? "";
    const task = id ? state.tasks[id] : undefined;
    const parent = id ? state.parentRuns[id] : undefined;
    return hash(JSON.stringify([
      context.activeWorkspace?.id, id, task?.status, task?.activeTurnId, task?.messages.length,
      task?.queuedTurns.map((entry) => [entry.id, entry.status, entry.text.length, entry.editing, entry.deliverAt]),
      parent?.id, parent?.phase, id ? state.workflowOwners[id]?.workflowId : undefined,
      context.activeProject ? deps.getProject(context.activeProject.id)?.overrides : undefined,
    ]));
  };
  const respond = (context: TurnRunnerContext, rows: WireParityRow[], truncated = false, timezone?: string): WireParityReadResult => ({
    revision: revision(context), rows: rows.slice(0, MAX_ROWS), truncated: truncated || rows.length > MAX_ROWS, ...(timezone ? { timezone } : {}),
  });
  const queueRows = (entries: ReturnType<typeof queueRow>): WireParityRow[] => entries.map((entry) => ({
    id: entry.id, queueId: entry.id, text: entry.text, status: entry.status, createdAt: entry.createdAt,
    ...(entry.editing ? { editing: true } : {}), ...(entry.deliverAt ? { deliverAt: entry.deliverAt } : {}),
  }));
  const workflowRow = (workflow: WorkflowDefinition): WireParityRow => ({
    id: workflow.id, name: workflow.name, description: workflow.description, enabled: workflow.enabled,
  });
  const workflowsFor = (context: TurnRunnerContext) => deps.getWorkflows().filter((workflow) => !workflow.projectId || workflow.projectId === context.activeProject?.id);
  return {
    revision,
    async read(op, args, context) {
      switch (op) {
        case "queue.read": return respond(context, queueRows(queueRow(context).filter((entry) => !entry.deliverAt)));
        case "schedules.read": return respond(context, queueRows(queueRow(context).filter((entry) => entry.deliverAt)), false, Intl.DateTimeFormat().resolvedOptions().timeZone);
        case "workflows.list": return respond(context, workflowsFor(context).map(workflowRow));
        case "workflows.read": {
          const workflow = workflowsFor(context).find((entry) => entry.id === args.workflowId);
          if (!workflow) throw new HostReadError("thread_unavailable", "This workflow is unavailable.");
          return respond(context, [{ ...workflowRow(workflow),
            variables: workflow.variables?.map((variable) => ({ id: variable.name, label: variable.name, required: variable.promptOnRun === true, ...(variable.value ? { default: variable.value } : {}) })) }]);
        }
        case "projects.settings.read": {
          const project = projectFor(context);
          const defaults = project.overrides?.defaults;
          // The description is the host's display path, for Copy path. Nothing accepts it back.
          return respond(context, [{ id: project.id, name: project.name, description: project.path, ...(defaults ? { provider: defaults.provider as WireProvider, model: defaults.model } : {}),
            ...(project.overrides?.run?.command ? { command: project.overrides.run.command } : {}) }]);
        }
        case "projects.instructions.read": {
          const project = projectFor(context);
          return respond(context, [{ id: project.id, prompt: project.overrides?.systemPrompt ?? "", mode: project.overrides?.systemPromptMode ?? "replace" },
            ...(project.overrides?.systemPromptProfiles ?? []).map((profile) => ({ id: profile.id, name: profile.name, prompt: profile.prompt, mode: profile.mode }))]);
        }
        case "skills.list": return respond(context, deps.getPublicSkills().map((skill) => ({ id: skill.name, name: skill.name, description: skill.description, enabled: skill.enabled !== false })));
        case "threads.archived": return respond(context, deps.getArchived(context.activeWorkspace?.id ?? "").map((entry) => ({
          id: entry.id, threadId: entry.id, name: entry.label, archived: true, updatedAt: entry.archivedAt, ...(entry.provider ? { provider: entry.provider as WireProvider } : {}),
        })));
        case "threads.search": {
          const query = typeof args.query === "string" ? args.query.trim() : "";
          if (!query) return respond(context, []);
          const found = await deps.searchThreads(context, query);
          return respond(context, found.map((thread) => ({ id: thread.id, threadId: thread.id, name: thread.name ?? thread.preview, description: thread.preview })));
        }
        case "parent.read": {
          const run = useTaskStore.getState().parentRuns[threadId(context)];
          return respond(context, run ? [{ id: run.id, runId: run.id, status: run.phase }] : []);
        }
        case "checks.read": case "checks.status": {
          const project = projectFor(context);
          return respond(context, project.overrides?.check?.command ? [{ id: project.id, command: project.overrides.check.command }] : []);
        }
        default: throw unavailable();
      }
    },
    async execute(op, args, operation) {
      const { context, assertAllowed } = operation;
      switch (op) {
        case "queue.remove": case "queue.retry": {
          const id = threadId(context);
          const entry = queueRow(context).find((row) => row.id === args.queueId);
          // A prompt already handed over can't be taken back or sent again.
          if (!entry || entry.status === "sending" || entry.remoteDelivery && entry.remoteDelivery.disposition !== "queued") {
            throw new HostReadError("stale_target", "That message can't be changed anymore.");
          }
          assertAllowed();
          // A prompt another device queued is durably refused before its row goes.
          if (op === "queue.remove" && entry.remoteDelivery) {
            const { device, opId, opSeq } = entry.remoteDelivery;
            await invoke("remote_work_reject_queued", { generation: operation.generation, device, opId, opSeq });
          }
          if (op === "queue.remove") useTaskStore.getState().removeQueuedTurn(id, entry.id);
          else useTaskStore.getState().setQueuedTurnStatus(id, entry.id, "queued");
          deps.pumpQueue(id);
          return { state: "accepted", threadId: id };
        }
        case "thread.archiveMany": case "thread.deleteMany": {
          const ids = Array.isArray(args.threadIds) ? args.threadIds.filter((id): id is string => typeof id === "string") : [];
          for (const id of ids) {
            assertAllowed();
            await (op === "thread.archiveMany" ? deps.archiveThread(id) : deps.deleteThread(id));
          }
          return { state: "accepted" };
        }
        case "checkpoint.accept": {
          assertAllowed();
          if (!deps.acceptCheckpoint(context, String(args.checkpointId))) throw new HostReadError("stale_target", "That checkpoint is no longer available.");
          return { state: "accepted" };
        }
        case "agents.stop": {
          const parent = threadId(context), agentId = String(args.agentId);
          const agent = useTaskStore.getState().tasks[parent]?.agents.find((entry) => entry.id === agentId);
          if (!agent || agent.canStop === false) throw new HostReadError("stale_target", "That sub-agent is no longer running.");
          assertAllowed();
          await deps.stopAgent(parent, agentId);
          return { state: "accepted" };
        }
        case "workflows.stop": {
          const stopped = await deps.stopWorkflow(String(args.workflowId), String(args.runId));
          if (!stopped) throw new HostReadError("stale_target", "That workflow run has already ended.");
          return { state: "accepted" };
        }
        case "projects.settings.set": {
          const project = projectFor(context);
          assertAllowed();
          deps.updateProject(project.id, (current) => ({
            ...current,
            ...(typeof args.name === "string" && args.name.trim() ? { name: args.name.trim() } : {}),
            ...(typeof args.provider === "string" && typeof args.model === "string" ? { overrides: { ...current.overrides,
              defaults: { ...current.overrides?.defaults, provider: args.provider as never, model: args.model } } } : {}),
          }));
          return { state: "accepted" };
        }
        case "projects.instructions.set": {
          const project = projectFor(context);
          assertAllowed();
          deps.updateProject(project.id, (current) => ({ ...current, overrides: { ...current.overrides,
            systemPrompt: String(args.prompt ?? ""), systemPromptMode: args.mode === "append" ? "append" : "replace" } }));
          return { state: "accepted" };
        }
        case "projects.run.set": {
          const project = projectFor(context);
          assertAllowed();
          deps.updateProject(project.id, (current) => ({ ...current, overrides: { ...current.overrides, run: { ...current.overrides?.run, command: String(args.command ?? ""), updatedAt: Date.now(),
            ...(typeof args.setupCommand === "string" ? { setupCommand: args.setupCommand } : {}), ...(typeof args.label === "string" ? { label: args.label } : {}) } } }));
          return { state: "accepted" };
        }
        case "projects.check.set": {
          const project = projectFor(context);
          assertAllowed();
          deps.updateProject(project.id, (current) => ({ ...current, overrides: { ...current.overrides, check: { ...current.overrides?.check, command: String(args.command ?? ""), updatedAt: Date.now() } } }));
          return { state: "accepted" };
        }
        default: throw unavailable();
      }
    },
  };
}
