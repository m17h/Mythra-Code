import type { Thread } from "../../../types";
import { rpc } from "../../codex";
import { saveClaudeTranscript } from "../../claude";
import { saveCursorTranscript } from "../../cursor";
import { threadStartParams } from "../../turnConfig";
import { sidebarThread } from "../../threadList";
import { flushPendingStateWrites } from "../../storage";
import { useTaskStore } from "../../taskStore";
import type { HostParityActions } from "./parityActions";
import { HostReadError } from "./scope";

/** Prepare an empty destination now, then use the ordinary durable thread
 * scheduler. No provider input, active selection, or viewer timer is involved.
 * This intentionally uses the first-prompt bookkeeping hooks, not sidebar row
 * mutations; input later re-resolves settings and authority for this thread. */
export async function scheduleNewPrompt(args: Readonly<Record<string, unknown>>,
  operation: Parameters<HostParityActions["execute"]>[2], queue: HostParityActions["execute"]): ReturnType<HostParityActions["execute"]> {
  const ctx = operation.context, workspace = ctx.activeWorkspace!, settings = ctx.effectiveSettings;
  if (ctx.activeThread || !operation.delivery.openOwner) throw new HostReadError("unsupported", "Choose a new-thread draft to schedule a new conversation.");
  // An isolated checkout is an independent native effect, not permission granted
  // by thread/start. Never silently change an isolated draft to shared.
  if (ctx.draftThreadIsolated) throw new HostReadError("unsupported", "Schedule into an existing isolated conversation instead.");
  operation.assertAllowed();
  await operation.delivery.openOwner("start", operation.delivery.attemptId);
  operation.assertAllowed();
  const provider = settings.provider;
  let thread: Thread;
  if (provider === "claude" || provider === "cursor") {
    thread = { id: crypto.randomUUID(), cwd: workspace.path, name: null, preview: "", updatedAt: Math.floor(Date.now() / 1000), modelProvider: provider };
    // A local provider has no native session until input is actually delivered.
    // Saving an empty transcript is preparation only, never an accepted turn.
    if (provider === "claude") await saveClaudeTranscript({ thread, messages: [], activities: [] });
    else await saveCursorTranscript({ thread, cursorSessionId: "", messages: [], activities: [] });
  } else {
    await ctx.ensureSkillRoots(); operation.assertAllowed();
    const modelContextWindow = provider === "openrouter" ? ctx.openRouterModels.find((entry) => entry.id === settings.model)?.context_length
      : provider === "lmstudio" ? ctx.lmStudioModels?.find((entry) => entry.id === settings.model)?.maxContextLength : undefined;
    const prepared = await rpc<{ thread: Thread; runtimeInstance: string }>("thread/start", {
      ...threadStartParams(settings, workspace.path, { serviceName: workspace.isChat ? "Mythra Code Chat" : "Mythra Code", customAgents: ctx.customAgents,
        modelContextWindow, interactive: true, perTurnSystemPrompt: true, additionalWorkspaceRoots: [] }), remoteDelivery: operation.delivery.metadata(),
    });
    thread = prepared.thread;
    if (!thread?.id || thread.cwd !== workspace.path) throw new HostReadError("uncertain", "The prepared conversation identity was not confirmed.");
    ctx.onCodexRuntimeOwned?.(thread.id, prepared.runtimeInstance);
    await operation.delivery.bindOwner?.(thread.id);
  }
  operation.delivery.assertAllowed();
  ctx.bindThreadToProject(thread.id, workspace.path);
  ctx.rememberThread(sidebarThread(thread));
  ctx.onThreadCreated(thread.id, { deferred: true, subagentsEnabled: settings.subagentsEnabled, subagentEngine: settings.subagentEngine,
    nativeSubagentMax: settings.nativeSubagentMax, nativeSubagentOptions: settings.nativeSubagentOptions, autoCompactTokens: settings.autoCompactTokens });
  ctx.persistThreadModel(thread.id, settings.model);
  ctx.persistThreadReasoning(thread.id, { reasoningEffort: settings.reasoningEffort, ultra: settings.ultra });
  useTaskStore.getState().ensureTask(thread.id, workspace.path);
  await operation.delivery.bindThread(thread.id);
  await flushPendingStateWrites();
  const next = { ...operation, context: { ...ctx, activeThread: thread }, assertAllowed: () => operation.delivery.assertAllowed() };
  return queue("prompt.scheduleNew", args, next);
}
