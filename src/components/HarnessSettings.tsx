import { useId, useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import type { CustomAgentProfile, ProjectAction } from "../types";
import { rpc } from "../lib/codex";
import { confirmDialog } from "../lib/confirmDialog";
import { friendlyError } from "../lib/errors";
import { mcpServerConnected, mcpStatusLabel } from "../lib/statusLabels";
import { Switch } from "./SettingsBits";

/**
 * The three small list editors that used to share one component: custom
 * agents (Sub-agents), quick actions (Workflows) and MCP servers (MCP &
 * language servers). Each renders in its own pane. Everything here saves the moment it is
 * added or removed.
 *
 * Half-typed entries live in `HarnessDrafts`, owned by Settings, so leaving a
 * pane and coming back keeps what was typed.
 */

export interface McpServerView { name: string; status: string; tools: number }

export type HarnessDrafts = {
  agentName: string;
  agentInstructions: string;
  actionName: string;
  actionCommand: string;
  mcpName: string;
  mcpCommand: string;
  mcpStatus: string;
};

export const EMPTY_HARNESS_DRAFTS: HarnessDrafts = {
  agentName: "", agentInstructions: "", actionName: "", actionCommand: "", mcpName: "", mcpCommand: "", mcpStatus: "",
};

type DraftProps = {
  drafts: HarnessDrafts;
  onDrafts: (update: (current: HarnessDrafts) => HarnessDrafts) => void;
};

export function CustomAgentsSettings({ agents, onAgents, drafts, onDrafts, sectionId }: DraftProps & {
  /** Anchor for the pane's jump list. */
  sectionId?: string;
  agents: CustomAgentProfile[];
  onAgents: (value: CustomAgentProfile[]) => void;
}) {
  const id = useId();
  const name = drafts.agentName;
  const instructions = drafts.agentInstructions;
  const ready = Boolean(name.trim() && instructions.trim());
  const add = () => {
    if (!ready) return;
    onAgents([...agents, { id: crypto.randomUUID(), name: name.trim(), description: instructions.trim().slice(0, 90), instructions: instructions.trim(), enabled: true }]);
    onDrafts((current) => ({ ...current, agentName: "", agentInstructions: "" }));
  };
  return <div className="set-group" id={sectionId}>
    <div className="set-group-head"><h4 tabIndex={-1}>Custom agents</h4></div>
    <p>Optional specialist instructions that can be offered alongside your sub-agent presets.</p>
    <div className="set-card">
      {agents.map((agent) => (
        <div className="set-row harness-row" key={agent.id}>
          <div className="set-copy"><strong>{agent.name}</strong><small className="harness-row-detail">{agent.instructions}</small></div>
          <div className="set-control">
            <Switch checked={agent.enabled} label={`Use ${agent.name}`} onChange={() => onAgents(agents.map((item) => item.id === agent.id ? { ...item, enabled: !item.enabled } : item))} />
            <button type="button" className="icon-button harness-delete" aria-label={`Delete ${agent.name}`} title="Delete" onClick={async () => { if (await confirmDialog(`Delete the custom agent “${agent.name}” and its instructions? This can’t be undone.`, { confirmLabel: "Delete agent" })) onAgents(agents.filter((item) => item.id !== agent.id)); }}><Trash2 size={13} /></button>
          </div>
        </div>
      ))}
      <div className="set-body harness-create">
        <label className="field-label" htmlFor={`${id}-name`}><span>Name</span></label>
        <input id={`${id}-name`} className="harness-input" value={name} onChange={(event) => onDrafts((current) => ({ ...current, agentName: event.target.value }))} placeholder="For example, reviewer" />
        <label className="field-label" htmlFor={`${id}-instructions`}><span>Instructions</span></label>
        <textarea id={`${id}-instructions`} className="harness-input" value={instructions} onChange={(event) => onDrafts((current) => ({ ...current, agentInstructions: event.target.value }))} placeholder="What this agent focuses on and how it should work" rows={3} />
        <div className="harness-create-actions"><button type="button" className="secondary-button" onClick={add} disabled={!ready}><Plus size={12} /> Add custom agent</button></div>
      </div>
    </div>
  </div>;
}

export function QuickActionsSettings({ actions, onActions, drafts, onDrafts }: DraftProps & {
  actions: ProjectAction[];
  onActions: (value: ProjectAction[]) => void;
}) {
  const id = useId();
  const name = drafts.actionName;
  const command = drafts.actionCommand;
  const ready = Boolean(name.trim() && command.trim());
  const add = () => {
    if (!ready) return;
    onActions([...actions, { id: crypto.randomUUID(), name: name.trim(), command: command.trim() }]);
    onDrafts((current) => ({ ...current, actionName: "", actionCommand: "" }));
  };
  return <section className="set-group">
    <div className="set-group-head"><h4>Quick actions</h4></div>
    <p>One-click commands in Tools → Actions.</p>
    <div className="set-card">
      {actions.map((action) => (
        <div className="set-row harness-row" key={action.id}>
          <div className="set-copy"><strong>{action.name}</strong><small className="harness-row-detail"><code>{action.command}</code></small></div>
          <div className="set-control">
            <button type="button" className="icon-button harness-delete" aria-label={`Delete ${action.name}`} title="Delete" onClick={async () => { if (await confirmDialog(`Delete the quick action “${action.name}”?`, { confirmLabel: "Delete action" })) onActions(actions.filter((item) => item.id !== action.id)); }}><Trash2 size={13} /></button>
          </div>
        </div>
      ))}
      <div className="set-body harness-create two">
        <div className="harness-field">
          <label className="field-label" htmlFor={`${id}-name`}><span>Name</span></label>
          <input id={`${id}-name`} className="harness-input" value={name} onChange={(event) => onDrafts((current) => ({ ...current, actionName: event.target.value }))} placeholder="For example, Test" />
        </div>
        <div className="harness-field">
          <label className="field-label" htmlFor={`${id}-command`}><span>Command</span></label>
          <input id={`${id}-command`} className="harness-input mono" value={command} spellCheck={false} onChange={(event) => onDrafts((current) => ({ ...current, actionCommand: event.target.value }))} onKeyDown={(event) => { if (event.key === "Enter") add(); }} placeholder="npm test" />
        </div>
        <div className="harness-create-actions"><button type="button" className="secondary-button" onClick={add} disabled={!ready}><Plus size={12} /> Add action</button></div>
      </div>
    </div>
  </section>;
}

export function McpServerSettings({ mcpServers = [], onMcpChanged, onSignIn, drafts, onDrafts }: DraftProps & {
  mcpServers?: McpServerView[];
  onMcpChanged?: () => void;
  /** Opens the place where a server's sign-in can be finished (the
   * Tools's Skills & MCP tab); absent when no project is open. */
  onSignIn?: () => void;
}) {
  const id = useId();
  const [saving, setSaving] = useState(false);
  const name = drafts.mcpName;
  const command = drafts.mcpCommand;
  const status = drafts.mcpStatus;
  const setStatus = (mcpStatus: string) => onDrafts((current) => ({ ...current, mcpStatus }));
  const ready = Boolean(name.trim() && command.trim()) && !saving;
  const add = () => {
    if (!ready) return;
    const parts = command.trim().split(/\s+/);
    setSaving(true);
    setStatus("Saving…");
    void rpc("config/value/write", { keyPath: `mcp_servers.${name.trim().replace(/[^a-zA-Z0-9_-]/g, "-")}`, value: { command: parts[0], args: parts.slice(1) }, mergeStrategy: "upsert" })
      .then(() => rpc("config/mcpServer/reload"))
      .then(() => {
        onDrafts((current) => ({ ...current, mcpName: "", mcpCommand: "", mcpStatus: "Server added." }));
        onMcpChanged?.();
      })
      .catch((reason) => setStatus(friendlyError(reason)))
      .finally(() => setSaving(false));
  };
  return <section className="set-group mcp-server-settings" id="tools-mcp">
    <div className="set-group-head"><h4 tabIndex={-1}>MCP servers</h4></div>
    <p>Local servers that give agents extra tools.</p>
    <div className="set-card">
      {mcpServers.map((server) => (
        <div className="set-row harness-row" key={server.name}>
          <div className="set-copy"><strong>{server.name}</strong><small>{server.tools} tool{server.tools === 1 ? "" : "s"}</small></div>
          <div className="set-control">
            <span className={`provider-status${mcpServerConnected(server.status) ? " on" : ""}`}>{mcpStatusLabel(server.status)}</span>
            {server.status === "needsAuth" && onSignIn && <button type="button" className="secondary-button" onClick={onSignIn} title="Finish signing in from Tools → Skills & MCP">Sign in</button>}
            <button
              type="button"
              className="icon-button harness-delete"
              aria-label={`Remove MCP server ${server.name}`}
              title="Remove"
              onClick={async () => {
                if (!await confirmDialog(`Remove the MCP server “${server.name}”? Agents will no longer be able to use its tools.`, { confirmLabel: "Remove server" })) return;
                setStatus("Removing…");
                void rpc("config/value/write", { keyPath: `mcp_servers.${server.name}`, value: null, mergeStrategy: "replace" })
                  .catch(() => rpc("config/value/delete", { keyPath: `mcp_servers.${server.name}` }))
                  .then(() => rpc("config/mcpServer/reload"))
                  .then(() => {
                    setStatus(`Removed ${server.name}.`);
                    onMcpChanged?.();
                  })
                  .catch((reason) => setStatus(friendlyError(reason)));
              }}
            ><Trash2 size={13} /></button>
          </div>
        </div>
      ))}
      <div className="set-body harness-create two">
        <div className="harness-field">
          <label className="field-label" htmlFor={`${id}-name`}><span>Name</span></label>
          <input id={`${id}-name`} className="harness-input" value={name} onChange={(event) => onDrafts((current) => ({ ...current, mcpName: event.target.value }))} placeholder="For example, browser" />
        </div>
        <div className="harness-field">
          <label className="field-label" htmlFor={`${id}-command`}><span>Command</span></label>
          <input id={`${id}-command`} className="harness-input mono" value={command} spellCheck={false} onChange={(event) => onDrafts((current) => ({ ...current, mcpCommand: event.target.value }))} onKeyDown={(event) => { if (event.key === "Enter") add(); }} placeholder="npx -y package" />
        </div>
        <div className="harness-create-actions"><button type="button" className="secondary-button" disabled={!ready} onClick={add}><Plus size={12} /> Add server</button></div>
        {status && <p className="harness-status" role="status">{status}</p>}
      </div>
    </div>
  </section>;
}
