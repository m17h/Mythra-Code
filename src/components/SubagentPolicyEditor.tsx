import { Check, Minus, Plus, ShieldCheck } from "lucide-react";
import { ChildAgentRoster } from "./ChildAgentRoster";
import { crewSafeConcurrency, type ChildAgentReadiness } from "../lib/childAgents";
import type { ProjectSubagentSettings } from "../types";
import type { Provider } from "../types";
import type { ChildAgentModelOption } from "./ChildAgentRoster";
import type { ModelFavorites } from "../lib/modelFavorites";

/**
 * One complete sub-agent preset: whether the model may delegate, its parallel
 * budget, and the explicit roster it may delegate to.
 *
 * Deliberately the *only* place these controls exist. A policy is edited in
 * two contexts — the defaults a scope hands to new threads, and a saved preset
 * — and the two used to be spelled out separately, which meant reading the
 * same three switches twice to work out which one was in force. Sharing this
 * editor makes them obviously the same thing configured for a different
 * purpose, and the surrounding screen is what says which one you are editing.
 */
export function SubagentPolicyEditor({ policy, readiness, disabled, modelCatalogs, modelFavorites, onToggleModelFavorite, onDiscoverOpenRouterModels, onChange }: {
  policy: ProjectSubagentSettings;
  readiness: ChildAgentReadiness;
  disabled: boolean;
  modelCatalogs?: Partial<Record<Provider, ChildAgentModelOption[]>>;
  modelFavorites?: ModelFavorites;
  onToggleModelFavorite?: (provider: Provider, model: string) => void;
  onDiscoverOpenRouterModels?: (query: string) => void;
  onChange: (next: ProjectSubagentSettings) => void;
}) {
  const roster = { ...policy.childAgents, enabled: true };
  const enabledSubAgents = roster.targets.filter((target) => target.enabled).length;
  const simultaneousCeiling = Math.max(1, enabledSubAgents);
  return (
    <div className={`subagent-policy-editor ${disabled ? "disabled" : ""}`} inert={disabled ? true : undefined}>
      <div className="policy-card">
        <div className={`policy-row ${policy.enabled ? "on" : ""}`}>
          <span>
            <strong>Sub-agents</strong>
            <small>{policy.enabled
              ? "The model may split a turn across parallel sub-agents."
              : "Delegation tools stay hidden from the model."}</small>
          </span>
          <button
            type="button"
            role="switch"
            aria-label="Allow sub-agent spawning"
            aria-checked={policy.enabled}
            className={`toggle-switch ${policy.enabled ? "on" : ""}`}
            onClick={() => onChange({ ...policy, enabled: !policy.enabled, childAgents: roster })}
          >
            <span />
          </button>
        </div>

        <div className={`policy-row ${policy.enabled ? "" : "muted"}`}>
          <span>
            <strong>Max running at once</strong>
            <small>{enabledSubAgents
              ? `Choose from ${enabledSubAgents} enabled sub-agent${enabledSubAgents === 1 ? "" : "s"} below; only this many may run simultaneously.`
              : "Maximum simultaneous runs after sub-agents are added below."}</small>
          </span>
          <div className="number-stepper" aria-label="Maximum concurrent sub-agents">
            <button
              type="button"
              aria-label="Fewer concurrent sub-agents"
              disabled={!policy.enabled || policy.maxConcurrent <= 1}
              onClick={() => onChange({ ...policy, maxConcurrent: Math.max(1, policy.maxConcurrent - 1) })}
            ><Minus size={13} /></button>
            <strong>{policy.maxConcurrent}</strong>
            <button
              type="button"
              aria-label="More concurrent sub-agents"
              disabled={!policy.enabled || policy.maxConcurrent >= simultaneousCeiling}
              onClick={() => onChange({ ...policy, maxConcurrent: Math.min(simultaneousCeiling, policy.maxConcurrent + 1) })}
            ><Plus size={13} /></button>
          </div>
        </div>
      </div>

      <ChildAgentRoster
        value={roster}
        enabled={policy.enabled}
        readiness={readiness}
        {...(modelCatalogs ? { modelCatalogs } : {})}
        {...(modelFavorites ? { modelFavorites } : {})}
        {...(onToggleModelFavorite ? { onToggleModelFavorite } : {})}
        {...(onDiscoverOpenRouterModels ? { onDiscoverOpenRouterModels } : {})}
        onChange={(childAgents) => {
          const nextRoster = { ...childAgents, enabled: true };
          onChange({ ...policy, maxConcurrent: crewSafeConcurrency(policy.maxConcurrent, nextRoster), childAgents: nextRoster });
        }}
      />

      <ul className="policy-guarantees" aria-label="Sub-agent boundaries">
        <li><ShieldCheck size={13} aria-hidden="true" /> Inherits your permission mode</li>
        <li><Check size={13} aria-hidden="true" /> Runs in the thread’s own folder</li>
        <li><Check size={13} aria-hidden="true" /> Sub-agents cannot delegate further</li>
        <li><Check size={13} aria-hidden="true" /> Frozen when a thread starts</li>
      </ul>
    </div>
  );
}
