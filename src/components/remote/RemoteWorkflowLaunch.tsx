import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { Project, ScheduleRunSettings } from "../../types";
import type { WorkflowDefinition } from "../../lib/workflows";
import type { WireWorkflowView } from "../../lib/remote/wire-resources";
import { WorkflowRunDialog } from "../WorkflowRunDialog";
import type { WireResourceResult } from "../../lib/remote/wire-resources";
import type { WireParityReadResult } from "../../lib/remote/wire";
import { hostRead, startRemoteWorkflow } from "../../lib/remote/remoteActions";

/** Run settings a host may also share. Missing ones are left off the dialog. */
type HostRun = { permission?: ScheduleRunSettings["permission"]; reasoningEffort?: ScheduleRunSettings["reasoningEffort"]; ultra?: boolean };

/** The host's workflow, as the shared review dialog reads it. Nothing in it can
 * start anything here: the dialog only collects the inputs for workflows.start. */
export function workflowFromView(view: WireWorkflowView): WorkflowDefinition {
  const run = view as WireWorkflowView & HostRun;
  return {
    id: view.id, name: view.name, description: view.description, projectId: "", enabled: view.enabled, trigger: { type: "manual" }, skillNames: [],
    variables: view.variables.map((variable) => ({ ...variable })),
    steps: view.steps.map((step) => step.type === "agent"
      ? { id: step.id, name: step.name, type: "agent", prompt: step.prompt ?? "", continueOnError: step.continueOnError }
      : { id: step.id, name: step.name, type: "command", command: step.command ?? "", continueOnError: step.continueOnError }),
    run: { provider: view.provider, model: view.model, permission: run.permission ?? "ask", reasoningEffort: run.reasoningEffort ?? "medium", ...(run.ultra ? { ultra: true } : {}) } as ScheduleRunSettings,
    createdAt: 0, updatedAt: 0,
  };
}

export interface RemoteWorkflowLaunchState { view: WireWorkflowView; prompt?: string; notice?: ReactNode; submitting?: boolean; blocked?: boolean }

export function RemoteWorkflowLaunch({ launch, name, projects, workspaceId, onClose, onRun }: {
  launch: RemoteWorkflowLaunchState;
  name: string;
  projects: { id: string; name: string }[];
  workspaceId: string | undefined;
  onClose: () => void;
  onRun: (workflowId: string, variables: Record<string, string>, projectId: string) => void;
}) {
  const workflow = useMemo(() => workflowFromView(launch.view), [launch.view]);
  // Paths stay on the host; a project is named by where it is.
  const choices = useMemo(() => projects.map((project) => ({ id: project.id, name: project.name, path: `On ${name}` }) as Project), [name, projects]);
  const run = launch.view as WireWorkflowView & HostRun;
  return <WorkflowRunDialog workflow={workflow} projects={choices} {...(workspaceId ? { initialProjectId: workspaceId } : {})} {...(launch.prompt ? { userPrompt: launch.prompt } : {})}
    machine={{ name, permission: run.permission !== undefined, effort: run.reasoningEffort !== undefined }} notice={launch.notice} submitting={Boolean(launch.submitting)} runBlocked={Boolean(launch.blocked)} onClose={onClose} onRun={onRun} />;
}

interface Launch {
  id: string;
  scope: string;
  workspaceId: string;
  threadId?: string;
  revision: string;
  view: WireWorkflowView;
  prompt?: string;
  submitting: boolean;
  /** The host cut the view short: what was shown isn't the whole recipe. */
  truncated: boolean;
  changed: string;
  resolve: (accepted: boolean) => void;
}

/**
 * The reviewed launch shared by the palette, the composer and the Tools panel.
 * Each launch has its own identity and the project, thread and revision it was
 * reviewed against. Moving away cancels it, Run now can't be pressed twice, and
 * only the launch that was answered is settled.
 */
export function useRemoteWorkflowLaunch({ device, name, workspaceId, threadId, revision, projects, onNotice }: {
  device: string; name: string; workspaceId: string | undefined; threadId: string | undefined; revision: string;
  projects: { id: string; name: string }[]; onNotice: (message: string) => void;
}) {
  const scope = `${device}/${workspaceId ?? ""}/${threadId ?? ""}`;
  const scopeRef = useRef(scope);
  scopeRef.current = scope;
  const [launch, setLaunch] = useState<Launch | null>(null);
  const launchRef = useRef<Launch | null>(null);
  const reviewing = useRef(false);
  const put = (next: Launch | null) => { launchRef.current = next; setLaunch(next); };
  const settle = useCallback((id: string, accepted: boolean) => {
    const current = launchRef.current;
    if (!current || current.id !== id) return;
    put(null);
    current.resolve(accepted);
  }, []);
  // A launch belongs to where it was reviewed. Leaving cancels it.
  useEffect(() => { const current = launchRef.current; if (current && current.scope !== scope) settle(current.id, false); }, [scope, settle]);
  useEffect(() => () => { const current = launchRef.current; if (current) { launchRef.current = null; current.resolve(false); } }, []);
  // The view and whether it was cut short. The digest covers the whole recipe, so a
  // shortened view can't be what someone approves.
  const readView = (target: { workspaceId: string; threadId?: string }, workflowId: string) =>
    hostRead<WireResourceResult>(device, "workflows.view", { workspaceId: target.workspaceId, ...(target.threadId ? { threadId: target.threadId } : {}), workflowId })
      .then((result) => { const view = result.workflows?.find((entry) => entry.id === workflowId); return view ? { view, truncated: result.truncated === true } : undefined; });
  const review = useCallback(async (workflowId: string, prompt?: string): Promise<boolean> => {
    if (!workspaceId) { onNotice(`Choose a project on ${name} first.`); return false; }
    if (launchRef.current || reviewing.current) return false;
    reviewing.current = true;
    const frozen = { scope, workspaceId, ...(threadId ? { threadId } : {}), revision };
    try {
      let read: { view: WireWorkflowView; truncated: boolean } | undefined;
      try { read = await readView(frozen, workflowId); }
      catch { onNotice(`Mythra Code couldn't read that workflow on ${name}. Try again.`); return false; }
      if (scopeRef.current !== frozen.scope) return false;
      if (!read) { onNotice(`That workflow isn't available on ${name}.`); return false; }
      const { view, truncated } = read;
      if (view.runs.some((run) => run.status === "running")) { onNotice(`“${view.name}” is already running on ${name}.`); return false; }
      if (prompt?.trim() && !view.steps.some((step) => step.type === "agent")) { onNotice("This recipe only runs commands. Use its inputs instead of an additional prompt."); return false; }
      // Opened after the key that chose it has finished, so that Enter can't also press the dialog's first button.
      await new Promise((done) => setTimeout(done, 0));
      if (scopeRef.current !== frozen.scope || launchRef.current) return false;
      const reviewed = view;
      return await new Promise<boolean>((resolve) => put({ id: crypto.randomUUID(), ...frozen, view: reviewed, truncated, ...(prompt?.trim() ? { prompt } : {}), submitting: false, changed: "", resolve }));
    } finally { reviewing.current = false; }
  }, [device, name, onNotice, revision, scope, threadId, workspaceId]);
  /** The recipe changed after review: read it again and show what it is now. Nothing starts. */
  const reReview = useCallback(async (id: string) => {
    const current = launchRef.current;
    if (!current || current.id !== id) return;
    let read: { view: WireWorkflowView; truncated: boolean } | undefined;
    try { read = await readView(current, current.view.id); } catch { read = undefined; }
    const still = launchRef.current;
    if (!still || still.id !== id) return;
    if (!read) { onNotice(`That workflow isn't available on ${name} anymore.`); settle(id, false); return; }
    put({ ...still, view: read.view, truncated: read.truncated, changed: "" });
  }, [device, name, onNotice, settle]);
  const start = useCallback(async (id: string, variables: Record<string, string>, projectId: string) => {
    const current = launchRef.current;
    // Never started from a view that didn't show everything.
    if (!current || current.id !== id || current.submitting || current.truncated) return;
    put({ ...current, submitting: true, changed: "" });
    let target: { workspaceId: string; threadId?: string; revision: string } = { workspaceId: current.workspaceId, ...(current.threadId ? { threadId: current.threadId } : {}), revision: current.revision };
    // Another project is checked against that project, not the thread it was opened from.
    if (projectId !== current.workspaceId) {
      try { target = { workspaceId: projectId, revision: (await hostRead<WireParityReadResult>(device, "workflows.list", { workspaceId: projectId })).revision }; }
      catch {
        const still = launchRef.current;
        if (still?.id === id) put({ ...still, submitting: false });
        onNotice(`Mythra Code couldn't reach that project on ${name}. Try again.`);
        return;
      }
    }
    const digest = typeof current.view.digest === "string" && current.view.digest ? current.view.digest : undefined;
    const outcome = await startRemoteWorkflow(device, name, { ...target, workflowId: current.view.id, variables, ...(digest ? { digest } : {}), ...(current.prompt ? { userPrompt: current.prompt } : {}) });
    const still = launchRef.current;
    if (!still || still.id !== id) return;
    if (outcome.ok) { settle(id, true); return; }
    if (outcome.code === "workflow_changed") { put({ ...still, submitting: false, changed: outcome.message }); return; }
    // Refused or unconfirmed: said once, and never sent again from here.
    onNotice(outcome.message);
    settle(id, false);
  }, [device, name, onNotice, settle]);
  const dialog = launch ? <RemoteWorkflowLaunch key={`${launch.id}:${launch.view.digest ?? ""}`} name={name} workspaceId={launch.workspaceId} projects={projects}
    launch={{ view: launch.view, ...(launch.prompt ? { prompt: launch.prompt } : {}), submitting: launch.submitting, blocked: launch.truncated,
      ...(launch.truncated ? { notice: <div className="workflow-command-warning" role="alert"><span><strong>Too long to review here</strong>
        <small>This workflow is too long to review here. Open it on {name} to run it.</small></span></div> } : launch.changed ? { notice: <div className="workflow-command-warning" role="alert"><span><strong>This workflow changed</strong><small>{launch.changed}</small>
        <button type="button" className="secondary-button" onClick={() => void reReview(launch.id)}>Review again</button></span></div> } : {}) }}
    onClose={() => settle(launch.id, false)} onRun={(_workflowId, variables, projectId) => { void start(launch.id, variables, projectId); }} /> : null;
  return { review, dialog, open: Boolean(launch) };
}
