import { useState } from "react";
import { AlertTriangle, Check, Plus, Trash2 } from "lucide-react";
import {
  CHILD_AGENT_PROVIDERS,
  CHILD_AGENT_REASONING_EFFORTS,
  MAX_CHILD_AGENT_TARGETS,
  SUGGESTED_CHILD_AGENT_TARGETS,
  childAgentModel,
  childAgentTargetIssue,
  describeChildAgentReasoning,
  providerDisplayName,
  sanitizeChildAgentIdInput,
  uniqueChildAgentId,
  type ChildAgentReadiness,
} from "../lib/childAgents";
import type { ChildAgentSettings, ChildAgentTarget, Provider } from "../types";

/**
 * The roster of provider/model destinations a root agent may delegate to.
 *
 * Deliberately lives in Settings rather than the composer: choosing which
 * providers a thread can spawn on is a considered decision made once, and a
 * thread freezes the answer when it starts. The composer only ever shows the
 * resulting one-line summary.
 */
export function ChildAgentRoster({ value, subagentsEnabled, readiness, onChange }: {
  value: ChildAgentSettings;
  subagentsEnabled: boolean;
  readiness: ChildAgentReadiness;
  onChange: (next: ChildAgentSettings) => void;
}) {
  const [draftId, setDraftId] = useState("");
  const [draftProvider, setDraftProvider] = useState<Provider>("claude");
  const [draftModel, setDraftModel] = useState("");

  const setTargets = (targets: ChildAgentTarget[]) => onChange({ ...value, targets });
  const updateTarget = (id: string, patch: Partial<ChildAgentTarget>) => {
    setTargets(value.targets.map((target) => (target.id === id ? { ...target, ...patch } : target)));
  };

  const addTarget = (candidate: Omit<ChildAgentTarget, "enabled">) => {
    if (value.targets.length >= MAX_CHILD_AGENT_TARGETS) return;
    const id = uniqueChildAgentId(candidate.id || candidate.provider, value.targets);
    setTargets([...value.targets, { ...candidate, id, label: candidate.label || id, enabled: true }]);
    setDraftId("");
    setDraftModel("");
  };

  const full = value.targets.length >= MAX_CHILD_AGENT_TARGETS;
  const unusedSuggestions = SUGGESTED_CHILD_AGENT_TARGETS.filter(
    (suggestion) => !value.targets.some((target) => target.provider === suggestion.provider),
  );

  return (
    <>
      <div className={`agent-settings-card ${value.enabled && subagentsEnabled ? "enabled" : ""}`}>
        <div className="agent-toggle-copy">
          <strong>Allow cross-provider sub-agents</strong>
          <small>
            {!subagentsEnabled
              ? "Turn sub-agent spawning on first — cross-provider children use the same budget and depth rules."
              : value.enabled
                ? "The root agent may delegate to the destinations below. Each child runs in this thread’s folder under the same permission mode."
                : "The root agent may only delegate inside its own provider."}
          </small>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={value.enabled}
          aria-label="Allow cross-provider sub-agents"
          disabled={!subagentsEnabled}
          className={`toggle-switch ${value.enabled && subagentsEnabled ? "on" : ""}`}
          onClick={() => onChange({ ...value, enabled: !value.enabled })}
        >
          <span />
        </button>
      </div>

      <div className={`agent-limit-row child-agent-roster ${value.enabled && subagentsEnabled ? "" : "disabled"}`}>
        <div>
          <strong>Approved destinations</strong>
          <small>Each destination becomes one named choice in the model’s spawn tool. A thread freezes this list when it starts.</small>
        </div>
      </div>

      {value.targets.length > 0 && (
        <div className="child-agent-list">
          {value.targets.map((target) => {
            const issue = childAgentTargetIssue(target, readiness);
            return (
              <div className="child-agent-row" key={target.id}>
                <div className="child-agent-identity">
                  <code>{target.id}</code>
                  <small>{providerDisplayName(target.provider)} · {childAgentModel(target) || "choose a model"}</small>
                </div>
                <select
                  aria-label={`Provider for ${target.id}`}
                  value={target.provider}
                  onChange={(event) => updateTarget(target.id, { provider: event.target.value as Provider, model: "" })}
                >
                  {CHILD_AGENT_PROVIDERS.map((provider) => (
                    <option key={provider} value={provider}>{providerDisplayName(provider)}</option>
                  ))}
                </select>
                <input
                  aria-label={`Model for ${target.id}`}
                  maxLength={128}
                  value={target.model}
                  placeholder="Provider default"
                  onChange={(event) => updateTarget(target.id, { model: event.target.value })}
                />
                <input
                  aria-label={`When to use ${target.id}`}
                  maxLength={400}
                  value={target.description}
                  placeholder="When the root agent should pick this"
                  onChange={(event) => updateTarget(target.id, { description: event.target.value })}
                />
                <button
                  type="button"
                  role="switch"
                  aria-checked={target.enabled}
                  aria-label={`Enable ${target.id}`}
                  className={`toggle-switch ${target.enabled ? "on" : ""}`}
                  onClick={() => updateTarget(target.id, { enabled: !target.enabled })}
                >
                  <span />
                </button>
                <button
                  type="button"
                  className="child-agent-remove"
                  aria-label={`Remove ${target.id}`}
                  onClick={() => setTargets(value.targets.filter((entry) => entry.id !== target.id))}
                >
                  <Trash2 size={13} />
                </button>
                <div className="child-agent-reasoning">
                  <span>Reasoning</span>
                  <select
                    aria-label={`Reasoning control for ${target.id}`}
                    value={target.reasoningMode}
                    onChange={(event) => updateTarget(target.id, { reasoningMode: event.target.value as ChildAgentTarget["reasoningMode"] })}
                  >
                    <option value="inherit">Inherit parent</option>
                    <option value="fixed">You set the level</option>
                    <option value="agent">Main agent decides</option>
                  </select>
                  {target.reasoningMode === "fixed" && (
                    <select
                      aria-label={`Reasoning level for ${target.id}`}
                      value={target.reasoningEffort}
                      onChange={(event) => updateTarget(target.id, { reasoningEffort: event.target.value as ChildAgentTarget["reasoningEffort"] })}
                    >
                      {CHILD_AGENT_REASONING_EFFORTS.map((effort) => <option key={effort} value={effort}>{effort}</option>)}
                    </select>
                  )}
                  {target.reasoningMode === "agent" && (
                    <select
                      aria-label={`Maximum reasoning for ${target.id}`}
                      value={target.reasoningMaxEffort}
                      onChange={(event) => updateTarget(target.id, { reasoningMaxEffort: event.target.value as ChildAgentTarget["reasoningMaxEffort"] })}
                    >
                      {CHILD_AGENT_REASONING_EFFORTS.map((effort) => <option key={effort} value={effort}>{effort}</option>)}
                    </select>
                  )}
                  <small>{describeChildAgentReasoning(target)}</small>
                </div>
                {issue && target.enabled && (
                  <p className="child-agent-issue" role="status"><AlertTriangle size={12} /> {issue}</p>
                )}
              </div>
            );
          })}
        </div>
      )}

      <div className="inline-create three">
        <input
          aria-label="New destination name"
          maxLength={40}
          value={draftId}
          placeholder="Name, e.g. reviewer"
          onChange={(event) => setDraftId(sanitizeChildAgentIdInput(event.target.value))}
        />
        <select aria-label="New destination provider" value={draftProvider} onChange={(event) => setDraftProvider(event.target.value as Provider)}>
          {CHILD_AGENT_PROVIDERS.map((provider) => (
            <option key={provider} value={provider}>{providerDisplayName(provider)}</option>
          ))}
        </select>
        <input
          aria-label="New destination model"
          maxLength={128}
          value={draftModel}
          placeholder="Model (blank for provider default)"
          onChange={(event) => setDraftModel(event.target.value)}
        />
        <button
          type="button"
          disabled={!draftId.trim() || full}
          onClick={() => addTarget({ id: draftId, provider: draftProvider, model: draftModel.trim(), label: draftId, description: "", reasoningMode: "inherit", reasoningEffort: "medium", reasoningMaxEffort: "high" })}
        >
          <Plus size={12} /> Add
        </button>
      </div>

      {unusedSuggestions.length > 0 && !full && (
        <div className="child-agent-suggestions">
          {unusedSuggestions.map((suggestion) => (
            <button type="button" key={suggestion.provider} onClick={() => addTarget(suggestion)}>
              <Plus size={11} /> {suggestion.label}
            </button>
          ))}
        </div>
      )}

      <div className="agent-safety-row">
        <span><Check size={13} /> Children inherit this thread’s folder</span>
        <span><Check size={13} /> Same permission mode</span>
        <span><Check size={13} /> Children cannot delegate further</span>
      </div>
    </>
  );
}
