import { useState } from "react";
import { Bot, Check, Clock3, NotebookPen, Play, Plus, Save, Trash2, Workflow, Wrench } from "lucide-react";
import type { AppSettings, CustomAgentProfile, Project, ProjectAction, PromptProfile, ScheduledTask, ScheduleRunRecord } from "../types";
import { rpc } from "../lib/codex";
import { friendlyError } from "../lib/errors";
import { scheduleRunSnapshot } from "../lib/turnConfig";
import type { LocalSkill } from "../lib/skills";
import type { WorkflowDefinition, WorkflowRunRecord } from "../lib/workflows";
import { workflowFromSchedule } from "../lib/workflows";
import { WorkflowManager } from "./WorkflowManager";

export interface McpServerView { name: string; status: string; tools: number }

export function HarnessSettings({ section, settings, profiles, agents, actions, schedules, workflows, workflowRuns, projects, skills, onSettings, onProfiles, onAgents, onActions, onSchedules, onWorkflows, onRunWorkflow, onStopWorkflow, mcpServers = [], onMcpChanged, scheduleRuns = [], onOpenRun }: {
  section: "prompts" | "agents" | "workflows" | "tools";
  settings: AppSettings;
  profiles: PromptProfile[];
  agents: CustomAgentProfile[];
  actions: ProjectAction[];
  schedules: ScheduledTask[];
  workflows: WorkflowDefinition[];
  workflowRuns: WorkflowRunRecord[];
  projects: Project[];
  skills: LocalSkill[];
  onSettings: (value: AppSettings) => void;
  onProfiles: (value: PromptProfile[]) => void;
  onAgents: (value: CustomAgentProfile[]) => void;
  onActions: (value: ProjectAction[]) => void;
  onSchedules: (value: ScheduledTask[]) => void;
  onWorkflows: (value: WorkflowDefinition[]) => void;
  onRunWorkflow: (workflowId: string, variables?: Record<string, string>) => Promise<void> | void;
  onStopWorkflow: (workflowId: string) => Promise<boolean> | boolean;
  mcpServers?: McpServerView[];
  onMcpChanged?: () => void;
  scheduleRuns?: ScheduleRunRecord[];
  onOpenRun?: (threadId: string) => void;
}) {
  const [profileName, setProfileName] = useState("");
  const [agentName, setAgentName] = useState("");
  const [agentInstructions, setAgentInstructions] = useState("");
  const [actionName, setActionName] = useState("");
  const [actionCommand, setActionCommand] = useState("");
  const [scheduleName, setScheduleName] = useState("");
  const [schedulePrompt, setSchedulePrompt] = useState("");
  const [scheduleProject, setScheduleProject] = useState("");
  // Raw text while typing — clamping per keystroke makes values like 45
  // untypeable (the leading "4" snaps to 5). Clamped on blur and on submit.
  const [scheduleMinutes, setScheduleMinutes] = useState("60");
  const [mcpName, setMcpName] = useState("");
  const [mcpCommand, setMcpCommand] = useState("");
  const [mcpStatus, setMcpStatus] = useState("");

  const saveProfile = () => {
    if (!profileName.trim()) return;
    const profile: PromptProfile = {
      id: crypto.randomUUID(),
      name: profileName.trim(),
      prompt: settings.systemPrompt,
      codexPrompt: settings.codexSystemPrompt,
      claudePrompt: settings.claudeSystemPrompt,
    };
    onProfiles([...profiles, profile]);
    onSettings({ ...settings, promptProfileId: profile.id });
    setProfileName("");
  };

  return <>
    {section === "prompts" &&
    <section className="settings-section">
      <div className="settings-section-heading"><div className="settings-icon"><NotebookPen size={17} /></div><div><h3>Prompt profiles</h3><p>Save and switch complete global, Codex, and Claude prompt sets. OpenKiwi includes no built-in profiles.</p></div></div>
      {profiles.length ? (
        <div className="profile-grid">{profiles.map((profile) => {
          const characters = profile.prompt.length + (profile.codexPrompt?.length ?? 0) + (profile.claudePrompt?.length ?? 0);
          return <div key={profile.id} className={`profile-card ${settings.promptProfileId === profile.id ? "selected" : ""}`}>
            <button className="profile-apply" onClick={() => onSettings({ ...settings, promptProfileId: profile.id, systemPrompt: profile.prompt, codexSystemPrompt: profile.codexPrompt ?? "", claudeSystemPrompt: profile.claudePrompt ?? "" })}>
              <span><strong>{profile.name}</strong><small>{characters ? `${characters} characters across all layers` : "Empty prompt set"}</small></span>
              {settings.promptProfileId === profile.id && <Check size={13} />}
            </button>
            <button className="profile-delete" aria-label={`Delete ${profile.name}`} onClick={() => {
              if (!window.confirm(`Delete the prompt profile “${profile.name}”?`)) return;
              onProfiles(profiles.filter((item) => item.id !== profile.id));
              if (settings.promptProfileId === profile.id) onSettings({ ...settings, promptProfileId: "" });
            }}><Trash2 size={12} /></button>
          </div>;
        })}</div>
      ) : <div className="compact-note"><NotebookPen size={14} /><span><strong>No prompt profiles yet</strong><small>Configure the prompt layers above, then save your first custom profile.</small></span></div>}
      <div className="inline-create"><input value={profileName} onChange={(event) => setProfileName(event.target.value)} placeholder="Profile name" /><button onClick={saveProfile} disabled={!profileName.trim()}><Save size={12} /> Save current prompts</button></div>
    </section>}

    {section === "agents" &&
    <section className="settings-section">
      <div className="settings-section-heading"><div className="settings-icon"><Bot size={17} /></div><div><h3>Custom agents</h3><p>Expose named specialist configurations when sub-agents are enabled.</p></div></div>
      <div className="manager-list">{agents.map((agent) => <div key={agent.id}><button className={`mini-toggle ${agent.enabled ? "on" : ""}`} aria-label={`${agent.enabled ? "Disable" : "Enable"} ${agent.name}`} aria-pressed={agent.enabled} onClick={() => onAgents(agents.map((item) => item.id === agent.id ? { ...item, enabled: !item.enabled } : item))}><span /></button><span><strong>{agent.name}</strong><small>{agent.instructions}</small></span><button className="manager-delete" aria-label={`Delete ${agent.name}`} onClick={() => { if (window.confirm(`Delete the custom agent “${agent.name}” and its instructions? This cannot be undone.`)) onAgents(agents.filter((item) => item.id !== agent.id)); }}><Trash2 size={12} /></button></div>)}</div>
      <div className="stacked-create"><input value={agentName} onChange={(event) => setAgentName(event.target.value)} placeholder="Agent name (for example: reviewer)" /><textarea value={agentInstructions} onChange={(event) => setAgentInstructions(event.target.value)} placeholder="Specialist instructions" rows={3} /><button onClick={() => { if (!agentName.trim() || !agentInstructions.trim()) return; onAgents([...agents, { id: crypto.randomUUID(), name: agentName.trim(), description: agentInstructions.trim().slice(0, 90), instructions: agentInstructions.trim(), enabled: true }]); setAgentName(""); setAgentInstructions(""); }} disabled={!agentName.trim() || !agentInstructions.trim()}><Plus size={12} /> Add custom agent</button></div>
    </section>}

    {section === "workflows" && <>
    <WorkflowManager
      workflows={workflows}
      runs={workflowRuns}
      projects={projects}
      skills={skills}
      settings={settings}
      onWorkflows={onWorkflows}
      onRun={onRunWorkflow}
      onStop={onStopWorkflow}
      onOpenRun={onOpenRun}
    />

    <section className="settings-section">
      <div className="settings-section-heading"><div className="settings-icon"><Play size={17} /></div><div><h3>Quick project actions</h3><p>Keep lightweight one-click commands for the Workspace panel. Use an agent workflow when you need multiple ordered steps, triggers, skills, or run history.</p></div></div>
      <div className="manager-list">{actions.map((action) => <div key={action.id}><Play size={12} /><span><strong>{action.name}</strong><small>{action.command}</small></span><button className="manager-delete" aria-label={`Delete ${action.name}`} onClick={() => { if (window.confirm(`Delete the project action “${action.name}”?`)) onActions(actions.filter((item) => item.id !== action.id)); }}><Trash2 size={12} /></button></div>)}</div>
      <div className="inline-create two"><input value={actionName} onChange={(event) => setActionName(event.target.value)} placeholder="Action name" /><input value={actionCommand} onChange={(event) => setActionCommand(event.target.value)} placeholder="Command" /><button onClick={() => { if (!actionName.trim() || !actionCommand.trim()) return; onActions([...actions, { id: crypto.randomUUID(), name: actionName.trim(), command: actionCommand.trim() }]); setActionName(""); setActionCommand(""); }}><Plus size={12} /> Add</button></div>
    </section>

    <section className="settings-section">
      <div className="settings-section-heading"><div className="settings-icon"><Clock3 size={17} /></div><div><h3>Simple scheduled prompts</h3><p>Existing single-prompt schedules remain fully supported. Converted workflows start disabled, so the original schedule cannot run twice while you review the richer workflow.</p></div></div>
      <div className="manager-list scheduled-workflow-list">{schedules.map((schedule) => <div key={schedule.id}><button className={`mini-toggle ${schedule.enabled ? "on" : ""}`} aria-label={`${schedule.enabled ? "Disable" : "Enable"} ${schedule.name}`} aria-pressed={schedule.enabled} onClick={() => onSchedules(schedules.map((item) => item.id === schedule.id ? { ...item, enabled: !item.enabled, nextRunAt: Date.now() + item.intervalMinutes * 60_000 } : item))}><span /></button><span><strong>{schedule.name}</strong><small>Every {schedule.intervalMinutes} min · {projects.find((project) => project.id === schedule.projectId)?.name ?? "No project"}</small></span><span className="manager-row-actions"><button title={`Convert ${schedule.name} to an agent workflow`} aria-label={`Convert ${schedule.name} to workflow`} disabled={!schedule.projectId} onClick={() => onWorkflows([workflowFromSchedule(schedule, scheduleRunSnapshot(settings)), ...workflows])}><Workflow size={11} /></button><button className="manager-delete" aria-label={`Delete ${schedule.name}`} onClick={() => { if (window.confirm(`Delete the scheduled task “${schedule.name}”? It will stop running.`)) onSchedules(schedules.filter((item) => item.id !== schedule.id)); }}><Trash2 size={12} /></button></span></div>)}</div>
      {scheduleRuns.length > 0 && (
        <>
          <h3 className="panel-label">Recent runs</h3>
          <div className="schedule-run-list">
            {scheduleRuns.slice(0, 10).map((run) => (
              <div key={run.id} className={run.status === "failed" ? "failed" : ""}>
                <span className={`status-orb ${run.status === "failed" ? "failed" : "ready"}`} />
                <span className="schedule-run-copy">
                  <strong>{run.scheduleName}</strong>
                  <small>{new Date(run.at).toLocaleString()}{run.status === "failed" ? ` · ${run.error ?? "failed"}` : ""}</small>
                </span>
                {run.threadId && onOpenRun && (
                  <button onClick={() => onOpenRun(run.threadId!)} title="Open the thread this run created" aria-label={`Open run thread for ${run.scheduleName}`}><Play size={11} /> Open</button>
                )}
              </div>
            ))}
          </div>
        </>
      )}
      <div className="schedule-create"><input value={scheduleName} onChange={(event) => setScheduleName(event.target.value)} placeholder="Task name" /><select value={scheduleProject} onChange={(event) => setScheduleProject(event.target.value)}><option value="">Choose project…</option>{projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}</select><input type="number" min={5} aria-label="Interval in minutes" value={scheduleMinutes} onChange={(event) => setScheduleMinutes(event.target.value)} onBlur={(event) => setScheduleMinutes(String(Math.max(5, Number(event.target.value) || 5)))} /><textarea value={schedulePrompt} onChange={(event) => setSchedulePrompt(event.target.value)} placeholder="Prompt to run" rows={3} /><button onClick={() => { if (!scheduleName.trim() || !schedulePrompt.trim() || !scheduleProject) return; const intervalMinutes = Math.max(5, Number(scheduleMinutes) || 5); onSchedules([...schedules, { id: crypto.randomUUID(), name: scheduleName.trim(), prompt: schedulePrompt.trim(), projectId: scheduleProject, intervalMinutes, enabled: true, nextRunAt: Date.now() + intervalMinutes * 60_000, run: scheduleRunSnapshot(settings) }]); setScheduleName(""); setSchedulePrompt(""); }} disabled={!scheduleName.trim() || !schedulePrompt.trim() || !scheduleProject}><Plus size={12} /> Add schedule</button></div>
    </section>
    </>}

    {section === "tools" &&
    <section className="settings-section">
      <div className="settings-section-heading"><div className="settings-icon"><Wrench size={17} /></div><div><h3>MCP servers</h3><p>Add a local stdio MCP server. Its command is written to OpenKiwi’s isolated Codex configuration.</p></div></div>
      {mcpServers.length > 0 && (
        <div className="manager-list">
          {mcpServers.map((server) => (
            <div key={server.name}>
              <Wrench size={12} />
              <span><strong>{server.name}</strong><small>{server.status} · {server.tools} tool{server.tools === 1 ? "" : "s"}</small></span>
              <button
                className="manager-delete"
                aria-label={`Remove MCP server ${server.name}`}
                onClick={() => {
                  if (!window.confirm(`Remove the MCP server “${server.name}” from OpenKiwi’s configuration?`)) return;
                  setMcpStatus("Removing…");
                  void rpc("config/value/write", { keyPath: `mcp_servers.${server.name}`, value: null, mergeStrategy: "replace" })
                    .catch(() => rpc("config/value/delete", { keyPath: `mcp_servers.${server.name}` }))
                    .then(() => rpc("config/mcpServer/reload"))
                    .then(() => {
                      setMcpStatus(`Removed ${server.name}.`);
                      onMcpChanged?.();
                    })
                    .catch((reason) => setMcpStatus(friendlyError(reason)));
                }}
              >
                <Trash2 size={12} />
              </button>
            </div>
          ))}
        </div>
      )}
      <div className="inline-create two"><input value={mcpName} onChange={(event) => setMcpName(event.target.value)} placeholder="Server name" /><input value={mcpCommand} onChange={(event) => setMcpCommand(event.target.value)} placeholder="Command, for example: npx -y package" /><button disabled={!mcpName.trim() || !mcpCommand.trim()} onClick={() => { const parts = mcpCommand.trim().split(/\s+/); setMcpStatus("Saving…"); void rpc("config/value/write", { keyPath: `mcp_servers.${mcpName.trim().replace(/[^a-zA-Z0-9_-]/g, "-")}`, value: { command: parts[0], args: parts.slice(1) }, mergeStrategy: "upsert" }).then(() => rpc("config/mcpServer/reload")).then(() => { setMcpStatus("Connected. Open Workspace tools → Tools to inspect it."); setMcpName(""); setMcpCommand(""); onMcpChanged?.(); }).catch((reason) => setMcpStatus(friendlyError(reason))); }}><Plus size={12} /> Add</button></div>
      {mcpStatus && <div className="manager-status">{mcpStatus}</div>}
      <div className="compact-note mcp-controls-note"><Wrench size={14} /><span><strong>MCP controls</strong><small>Complete MCP OAuth from Workspace tools → Tools. Manage local Markdown workflows in the dedicated Skills section.</small></span></div>
    </section>}
  </>;
}
