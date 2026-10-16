import { useState } from "react";
import { Bot, ChevronDown, Play, Plus, Trash2, Wrench } from "lucide-react";
import type { AppSettings, CustomAgentProfile, Project, ProjectAction, Provider, ScheduledTask, ScheduleRunRecord } from "../types";
import { rpc } from "../lib/codex";
import { confirmDialog } from "../lib/confirmDialog";
import { friendlyError } from "../lib/errors";
import type { LocalSkill } from "../lib/skills";
import type { WorkflowDefinition, WorkflowRunRecord } from "../lib/workflows";
import { WorkflowManager } from "./WorkflowManager";
import { ScheduledTasksSettings } from "./ScheduledTasksSettings";
import type { ChildAgentModelOption } from "./ChildAgentRoster";

export interface McpServerView { name: string; status: string; tools: number }

export function HarnessSettings({ section, visible = true, settings, agents, actions, schedules, workflows, workflowRuns, projects, skills, modelCatalogs, onDiscoverOpenRouterModels, onAgents, onActions, onSchedules, onWorkflows, onRunWorkflow, onStopWorkflow, mcpServers = [], onMcpChanged, scheduleRuns = [], onOpenRun }: {
  section: "agents" | "workflows" | "scheduled-tasks" | "tools";
  visible?: boolean;
  settings: AppSettings;
  agents: CustomAgentProfile[];
  actions: ProjectAction[];
  schedules: ScheduledTask[];
  workflows: WorkflowDefinition[];
  workflowRuns: WorkflowRunRecord[];
  projects: Project[];
  skills: LocalSkill[];
  modelCatalogs?: Partial<Record<Provider, ChildAgentModelOption[]>>;
  onDiscoverOpenRouterModels?: (query: string) => void;
  onAgents: (value: CustomAgentProfile[]) => void;
  onActions: (value: ProjectAction[]) => void;
  onSchedules: (value: ScheduledTask[] | ((current: ScheduledTask[]) => ScheduledTask[])) => void;
  onWorkflows: (value: WorkflowDefinition[]) => void;
  onRunWorkflow: (workflowId: string, variables?: Record<string, string>, projectId?: string) => Promise<void> | void;
  onStopWorkflow: (workflowId: string) => Promise<boolean> | boolean;
  mcpServers?: McpServerView[];
  onMcpChanged?: () => void;
  scheduleRuns?: ScheduleRunRecord[];
  onOpenRun?: (threadId: string) => void;
}) {
  const [agentName, setAgentName] = useState("");
  const [agentInstructions, setAgentInstructions] = useState("");
  const [actionName, setActionName] = useState("");
  const [actionCommand, setActionCommand] = useState("");
  const [mcpName, setMcpName] = useState("");
  const [mcpCommand, setMcpCommand] = useState("");
  const [mcpStatus, setMcpStatus] = useState("");

  return <>
    {section === "agents" && <div className="set-group">
    <h4>Custom agents</h4>
    <details className="custom-agent-settings">
      <summary className="custom-agent-summary">
        <span className="custom-agent-mark"><Bot size={16} /></span>
        <span><strong>Custom agent profiles</strong><small>Optional specialist instructions that can be exposed alongside your sub-agent presets.</small></span>
        <ChevronDown size={15} aria-hidden="true" />
      </summary>
      <div className="custom-agent-content">
        <div className="manager-list">{agents.map((agent) => <div key={agent.id}><button className={`mini-toggle ${agent.enabled ? "on" : ""}`} aria-label={`${agent.enabled ? "Disable" : "Enable"} ${agent.name}`} aria-pressed={agent.enabled} onClick={() => onAgents(agents.map((item) => item.id === agent.id ? { ...item, enabled: !item.enabled } : item))}><span /></button><span><strong>{agent.name}</strong><small>{agent.instructions}</small></span><button className="manager-delete" aria-label={`Delete ${agent.name}`} onClick={async () => { if (await confirmDialog(`Delete the custom agent “${agent.name}” and its instructions? This cannot be undone.`)) onAgents(agents.filter((item) => item.id !== agent.id)); }}><Trash2 size={12} /></button></div>)}</div>
        <div className="stacked-create"><input value={agentName} onChange={(event) => setAgentName(event.target.value)} placeholder="Agent name (for example: reviewer)" /><textarea value={agentInstructions} onChange={(event) => setAgentInstructions(event.target.value)} placeholder="Specialist instructions" rows={3} /><button onClick={() => { if (!agentName.trim() || !agentInstructions.trim()) return; onAgents([...agents, { id: crypto.randomUUID(), name: agentName.trim(), description: agentInstructions.trim().slice(0, 90), instructions: agentInstructions.trim(), enabled: true }]); setAgentName(""); setAgentInstructions(""); }} disabled={!agentName.trim() || !agentInstructions.trim()}><Plus size={12} /> Add custom agent</button></div>
      </div>
    </details>
    </div>}

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

    <section className="set-group">
      <h4>Quick project actions</h4>
      <p>Keep lightweight one-click commands for the Workspace panel. Use an agent workflow when you need multiple ordered steps, triggers, skills, or run history.</p>
      <div className="manager-list">{actions.map((action) => <div key={action.id}><Play size={12} /><span><strong>{action.name}</strong><small>{action.command}</small></span><button className="manager-delete" aria-label={`Delete ${action.name}`} onClick={async () => { if (await confirmDialog(`Delete the project action “${action.name}”?`)) onActions(actions.filter((item) => item.id !== action.id)); }}><Trash2 size={12} /></button></div>)}</div>
      <div className="inline-create two"><input value={actionName} onChange={(event) => setActionName(event.target.value)} placeholder="Action name" /><input value={actionCommand} onChange={(event) => setActionCommand(event.target.value)} placeholder="Command" /><button onClick={() => { if (!actionName.trim() || !actionCommand.trim()) return; onActions([...actions, { id: crypto.randomUUID(), name: actionName.trim(), command: actionCommand.trim() }]); setActionName(""); setActionCommand(""); }}><Plus size={12} /> Add</button></div>
    </section>
    </>}

    {section === "scheduled-tasks" && <ScheduledTasksSettings
      visible={visible}
      settings={settings}
      schedules={schedules}
      projects={projects}
      modelCatalogs={modelCatalogs}
      scheduleRuns={scheduleRuns}
      workflows={workflows}
      onSchedules={onSchedules}
      onWorkflows={onWorkflows}
      onDiscoverOpenRouterModels={onDiscoverOpenRouterModels}
      onOpenRun={onOpenRun}
    />}

    {section === "tools" &&
    <section className="set-group mcp-server-settings">
      <h4>MCP servers</h4>
      <p>Add a local stdio MCP server. Its command is written to Mythra Code’s isolated Codex configuration.</p>
      {mcpServers.length > 0 && (
        <div className="manager-list">
          {mcpServers.map((server) => (
            <div key={server.name}>
              <Wrench size={12} />
              <span><strong>{server.name}</strong><small>{server.status} · {server.tools} tool{server.tools === 1 ? "" : "s"}</small></span>
              <button
                className="manager-delete"
                aria-label={`Remove MCP server ${server.name}`}
                onClick={async () => {
                  if (!await confirmDialog(`Remove the MCP server “${server.name}” from Mythra Code’s configuration?`)) return;
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
    </section>}
  </>;
}
