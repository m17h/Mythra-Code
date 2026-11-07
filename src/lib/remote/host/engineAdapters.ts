import { buildParentNotice, parentRunProgress, wokenParentQuestions } from "../../parentRun";
import { storedQueuedTurnsForThread, useTaskStore, adoptRemoteParentDismissal } from "../../taskStore";
import type { Project } from "../../../types";
import { analyzeSkillPrompts, readLocalSkill, type LocalSkill } from "../../skills";
import { sanitizeProjectRunCommand } from "../../projectRun";
import { sanitizeProjectCheckCommand } from "../../projectChecks";
import { sanitizeProjectPromptProfileOverrides } from "../../projectPromptProfiles";
import type { HostContextSources } from "./hostContext";
import type { HostParityActions } from "./parityActions";
import { invoke } from "@tauri-apps/api/core";
import { createHostCommandActions, hostCommandRows } from "./commandActions";
import { setHostDiscoverySettings } from "./discoverySettings";
import { createWorkflowExecution } from "./workflowExecution";
import { markRemoteEngineRetiring, remoteEngineOwner, remoteEngineStopped } from "./engineOwners";
import { nativeRefusal } from "./nativeActions";
import { commitHostState, operationStamp } from "./stateCommit";
import { createHostQueueActions } from "./queueActions";
import { HostReadError, idArg } from "./scope";
import type { WireParityRow } from "../wire";
import { getOpenRouterCredits, rpc } from "../../codex";

/** Concrete shared-state adapters wrap App's domain/lifecycle extraction. */
export function createHostEngineAdapters(sources: HostContextSources, fallback: HostParityActions, pump: (id: string) => void, isCurrent: () => boolean = () => true, getRunner?: () => import("./workTypes").RemoteTurnRunner) {
  const queue = createHostQueueActions(pump);
  const commands = createHostCommandActions(sources, isCurrent);
  const workflows = new Map<string, ReturnType<typeof createWorkflowExecution>>();
  const queueOps = new Set(["queue.edit.begin", "queue.edit.finish", "queue.remove", "queue.retry", "prompt.schedule", "schedules.edit", "schedules.reschedule", "schedules.release", "schedules.remove"]);
  const projectOps = new Set(["projects.settings.set", "projects.instructions.set", "projects.profiles.save", "projects.profiles.delete", "projects.profiles.select", "projects.run.set", "projects.check.set"]);
  const adapter: HostParityActions = {
    revision: fallback.revision,
    async read(op, args, context) {
      const result = (rows: WireParityRow[]) => ({ revision: fallback.revision(context), rows, truncated: rows.length > 200 });
      if (op === "run.status" || op === "checks.read" || op === "checks.status") return result(hostCommandRows(op === "run.status" ? "run" : "checks", context));
      if ((op === "queue.read" || op === "schedules.read") && context.activeThread) {
        const entries = storedQueuedTurnsForThread(context.activeThread.id);
        return result(entries.filter((entry) => op !== "schedules.read" || entry.deliverAt !== undefined).slice(0, 200).map((entry) => ({
          id: entry.id, queueId: entry.id, text: entry.text, status: entry.status, createdAt: entry.createdAt,
          ...(entry.editing ? { editing: true } : {}), ...(entry.deliverAt === undefined ? {} : { deliverAt: entry.deliverAt }),
        })));
      }
      if (op === "models.list" || op === "models.search") {
        const query = typeof args.query === "string" ? args.query.toLowerCase() : "";
        return result(sources.getProviderCatalog().flatMap((provider) => provider.models.filter((m) => !query || `${m.name} ${m.id}`.toLowerCase().includes(query))
          .map((model) => ({ id: `${provider.id}:${model.id}`, name: model.name, provider: provider.id, model: model.id, effort: model.defaultEffort }))).slice(0, 200));
      }
      if (op === "models.refresh") {
        if (!sources.refreshProviderCatalog) throw new HostReadError("unsupported", "The other device can't refresh its models right now.");
        await sources.refreshProviderCatalog(context.effectiveSettings.provider);
        return adapter.read("models.list", args, context);
      }
      if (op === "usage.account.read" || op === "usage.account.refresh") {
        const provider = context.effectiveSettings.provider;
        if (provider === "openrouter") {
          const balance = await getOpenRouterCredits();
          return result([{ id: "openrouter-credits", name: "OpenRouter credits", provider, value: balance.remaining,
            ...(balance.used === null ? {} : { limit: balance.remaining + balance.used }) }]);
        }
        if (sources.getAccountUsage) {
          if (op === "usage.account.refresh") await sources.refreshAccountUsage?.(provider);
          return result(sources.getAccountUsage().filter((row) => row.provider === provider).map((row, index) => ({
            id: `${provider}-quota-${index}`, provider, name: row.label, value: row.usedPercent, limit: 100,
            ...(row.resetsAt === null ? {} : { deliverAt: row.resetsAt * 1000 }) })));
        }
        if (provider === "openai") {
          const raw = await rpc<{ rateLimits?: { primary?: { usedPercent?: number; resetsAt?: number }; secondary?: { usedPercent?: number; resetsAt?: number } } }>("account/rateLimits/read");
          return result([raw.rateLimits?.primary, raw.rateLimits?.secondary].flatMap((row, index) => row && typeof row.usedPercent === "number" && Number.isFinite(row.usedPercent)
            ? [{ id: `openai-quota-${index}`, name: index === 0 ? "Short window" : "Long window", provider: "openai" as const, value: row.usedPercent, limit: 100,
              ...(typeof row.resetsAt === "number" ? { deliverAt: row.resetsAt * 1000 } : {}) }] : []));
        }
        return result([]); // Provider exposes no quota, not a viewer-local fallback.
      }
      if (op === "skills.read" || op === "skills.analyze") {
        const skills: readonly LocalSkill[] = sources.getLocalSkills?.() ?? [];
        const folder = sources.getBaseContext().skillsFolder;
        if (op === "skills.read") {
          const skill = skills.find((entry) => entry.name === idArg(args.skillId));
          if (!skill) throw new HostReadError("thread_unavailable", "This skill on the other device is not available.");
          return result([{ id: skill.name, name: skill.name, text: (await readLocalSkill(folder, skill.path)).slice(0, 65536), enabled: skill.enabled }]);
        }
        const report = await analyzeSkillPrompts(String(args.query ?? ""), context.effectiveSettings.systemPrompt, folder, [...skills]);
        return result(report.nodes.map((node, index) => ({ id: `dependency-${index}`, name: node.name, status: node.status, value: node.characterCount })));
      }
      return fallback.read(op, args, context);
    },
    async execute(op, args, operation) {
      if (op === "discovery.settings.set") { await setHostDiscoverySettings(sources, args, operation); return { state: "accepted" }; }
      if (op === "run.start" || op === "run.stop" || op === "checks.start" || op === "checks.stop") return commands.execute(op, args, operation);
      if (op === "parent.continue" || op === "parent.dismiss") {
        const id = operation.context.activeThread?.id, run = id ? useTaskStore.getState().parentRuns[id] : undefined;
        if (!id || !run || run.id !== args.parentRunId || run.phase !== "paused") throw new HostReadError("stale_target", "This parent run is no longer paused.");
        if (op === "parent.dismiss") {
          await commitHostState(operation, ["kiwi.parentRuns"], (rows) => {
            const value = rows[0].value as Record<string, { id: string }> | null;
            if (!value || value[id]?.id !== run.id) throw new HostReadError("stale_target", "This saved parent run changed.");
            const next = { ...value }; delete next[id]; return { "kiwi.parentRuns": next };
          }, { adopt: () => adoptRemoteParentDismissal(id, run.id) });
          return { state: "accepted", threadId: id };
        }
        const runner = getRunner?.();
        if (!runner?.continueParentTo || !sources.getParentObligations) throw new HostReadError("unsupported", "The other device's parent continuation source is not attached.");
        const obligations = sources.getParentObligations(run);
        const result = await runner.continueParentTo({ ...operation.context, remoteDelivery: operation.delivery }, {
          parentRunId: run.id, notice: buildParentNotice(crypto.randomUUID(), obligations), progress: parentRunProgress(obligations), wokenQuestions: wokenParentQuestions(obligations),
        });
        if (result.state !== "accepted") throw new HostReadError(result.state === "uncertain" ? "uncertain" : "busy", "This parent continuation did not start.");
        return { state: "accepted", threadId: id };
      }
      if (op === "workflows.start") {
        const engine = sources.getWorkflowEngine?.();
        if (!engine) throw new HostReadError("unsupported", "Workflows aren't ready on the other device yet.");
        const id = idArg(args.workflowId);
        if (workflows.has(id)) throw new HostReadError("busy", "This workflow already owns a run.");
        const variables = args.variables as Record<string, string> | undefined;
        const controller = createWorkflowExecution(sources, operation, isCurrent, variables);
        workflows.set(id, controller);
        const running = engine.runWorkflow(id, "manual", variables ?? {}, operation.context.activeWorkspace!.id, {
          ...(typeof args.userPrompt === "string" ? { userPrompt: args.userPrompt } : {}), remote: controller.execution,
        });
        void running.then((threadId) => { if (!threadId) controller.execution.failed(new HostReadError("unsupported", "This workflow could not start.")); })
          .catch((reason) => controller.execution.failed(reason)).finally(() => { if (workflows.get(id) === controller && controller.execution.finished) workflows.delete(id); });
        const accepted = await controller.admission;
        return { state: "accepted", workflowRunId: accepted.runId, ...(accepted.threadId ? { threadId: accepted.threadId } : {}) };
      }
      if (op === "workflows.stop") {
        const id = idArg(args.workflowId), runId = idArg(args.runId), controller = workflows.get(id), engine = sources.getWorkflowEngine?.();
        const threadId = operation.context.activeThread?.id;
        const local = threadId ? remoteEngineOwner(threadId, undefined, runId) : undefined;
        const ownerHandle = controller?.execution.ownerRunId === runId ? controller.execution.ownerHandle : local?.local ? local.ownerHandle : undefined;
        if (!engine || !ownerHandle || !controller && (!threadId || useTaskStore.getState().workflowOwners[threadId]?.workflowId !== id)) throw new HostReadError("stale_target", "This workflow has no matching native execution owner.");
        operation.assertAllowed();
        markRemoteEngineRetiring(ownerHandle);
        controller?.cancel();
        const stopped = await engine.stopWorkflowRun(id, runId, async () => {
          let cutoff: { confirmed: boolean };
          try { cutoff = await invoke("remote_work_owner_retire", { stamp: operationStamp(operation), ownerHandle }); }
          catch (reason) { throw nativeRefusal(reason); }
          if (cutoff.confirmed !== true) throw new HostReadError("uncertain", "The other device couldn't confirm the workflow stopped. Check the conversation.");
        });
        if (!stopped) throw new HostReadError("stale_target", "This workflow run ended before Stop.");
        controller?.retired(); remoteEngineStopped(ownerHandle); workflows.delete(id);
        return { state: "accepted", workflowRunId: runId };
      }
      if (queueOps.has(op)) return queue.execute(op, args, operation);
      if (!projectOps.has(op)) return fallback.execute(op, args, operation);
      const workspaceId = operation.context.activeProject?.id;
      if (!workspaceId) throw new HostReadError("thread_unavailable", "Project settings require a saved project.");
      await commitHostState(operation, ["kiwi.projects"], (rows) => {
        const projects = Array.isArray(rows[0].value) ? rows[0].value as Project[] : [];
        if (!projects.some((p) => p.id === workspaceId && p.path === operation.context.activeProject!.path)) throw new HostReadError("stale_target", "This project moved or was removed.");
        return { "kiwi.projects": projects.map((project) => {
          if (project.id !== workspaceId) return project;
          let overrides = { ...project.overrides };
          if (op === "projects.settings.set") return { ...project, ...(typeof args.name === "string" && args.name.trim() ? { name: args.name.trim() } : {}),
            ...(args.provider && args.model ? { overrides: { ...overrides, defaults: { provider: args.provider as never, model: args.model as string } } } : {}) };
          if (op === "projects.instructions.set") overrides = { ...overrides, systemPrompt: String(args.prompt), systemPromptMode: args.mode === "append" ? "append" : "replace" };
          if (op === "projects.run.set") overrides.run = sanitizeProjectRunCommand({ command: args.command, setupCommand: args.setupCommand, label: args.label });
          if (op === "projects.check.set") overrides.check = sanitizeProjectCheckCommand({ command: args.command });
          if (op.startsWith("projects.profiles.")) {
            const profiles = [...(overrides.systemPromptProfiles ?? [])], id = typeof args.profileId === "string" ? args.profileId : crypto.randomUUID();
            const index = profiles.findIndex((p) => p.id === id);
            if (op === "projects.profiles.save") {
              if (typeof args.name !== "string" || !args.name.trim() || typeof args.prompt !== "string") throw new HostReadError("unsupported", "A profile name and instructions are required.");
              const next = { id, name: args.name.trim(), prompt: args.prompt, mode: args.mode === "append" ? "append" as const : "replace" as const };
              if (index < 0) profiles.push(next); else profiles[index] = next;
            } else {
              if (index < 0) throw new HostReadError("stale_target", "This instruction profile was removed.");
              if (op === "projects.profiles.delete") profiles.splice(index, 1);
              else overrides = { ...overrides, systemPromptProfileId: id, systemPrompt: profiles[index].prompt, systemPromptMode: profiles[index].mode };
            }
            overrides.systemPromptProfiles = profiles;
            overrides = sanitizeProjectPromptProfileOverrides(overrides);
          }
          return { ...project, overrides };
        }) };
      });
      return { state: "accepted" };
    },
  };
  return { adapter, dispose: () => { commands.dispose(); queue.dispose(); for (const controller of workflows.values()) controller.cancel(); workflows.clear(); } };
}
