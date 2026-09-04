import { useId, useState } from "react";
import { AlertTriangle, ChevronDown, Plus, Trash2 } from "lucide-react";
import { ProviderLogo } from "./BrandLogos";
import { AppSelectMenu, type AppSelectOption } from "./AppSelectMenu";
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
import { favoriteModels, type ModelFavorites } from "../lib/modelFavorites";

export interface ChildAgentModelOption {
  id: string;
  label: string;
  detail?: string;
  keywords?: string;
}

const BUILTIN_MODEL_CATALOGS: Record<Provider, ChildAgentModelOption[]> = {
  openai: [
    { id: "gpt-6-astra", label: "Astra", detail: "gpt-6-astra · frontier intelligence" },
    { id: "gpt-5.6-sol", label: "Sol", detail: "gpt-5.6-sol · detail & polish" },
    { id: "gpt-5.6-terra", label: "Terra", detail: "gpt-5.6-terra · everyday power" },
    { id: "gpt-5.6-luna", label: "Luna", detail: "gpt-5.6-luna · fast & focused" },
  ],
  claude: [
    { id: "claude-fable-5", label: "Fable 5", detail: "Frontier coding" },
    { id: "claude-opus-5", label: "Opus 5", detail: "Deepest reasoning" },
    { id: "claude-sonnet-5", label: "Sonnet 5", detail: "Balanced power" },
    { id: "claude-haiku-4-5", label: "Haiku 4.5", detail: "Fast and efficient" },
  ],
  cursor: [{ id: "auto", label: "Auto", detail: "Cursor recommended" }],
  openrouter: [],
  lmstudio: [],
};

const REASONING_MODE_OPTIONS: AppSelectOption[] = [
  { value: "inherit", label: "Inherit parent", detail: "Use the main agent's level" },
  { value: "fixed", label: "You set the level", detail: "Always use one chosen level" },
  { value: "agent", label: "Main agent decides", detail: "Let the main agent choose within a ceiling" },
];

const REASONING_LABELS: Record<(typeof CHILD_AGENT_REASONING_EFFORTS)[number], string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Maximum",
  ultra: "Ultra",
};

const REASONING_OPTIONS: AppSelectOption[] = CHILD_AGENT_REASONING_EFFORTS.map((effort) => ({
  value: effort,
  label: REASONING_LABELS[effort],
}));

function modelOptionsFor(
  provider: Provider,
  catalogs: Partial<Record<Provider, ChildAgentModelOption[]>> | undefined,
  selectedModel: string,
): AppSelectOption[] {
  const supplied = catalogs?.[provider];
  const catalog = supplied?.length ? supplied : BUILTIN_MODEL_CATALOGS[provider];
  const options: AppSelectOption[] = catalog.map((entry) => ({
    value: entry.id,
    label: entry.label,
    detail: entry.detail ?? entry.id,
    keywords: entry.keywords,
    icon: <ProviderLogo provider={provider} size={11} />,
  }));
  if (selectedModel && !options.some((option) => option.value === selectedModel)) {
    options.unshift({
      value: selectedModel,
      label: selectedModel,
      detail: "Previously configured model",
      icon: <ProviderLogo provider={provider} size={11} />,
    });
  }
  return options;
}

/**
 * The roster of provider/model destinations a root agent may delegate to.
 *
 * Choosing which providers a thread can spawn on is a considered decision made
 * once, and a thread freezes the answer when it starts — so the durable place
 * to make it is Settings, and the composer only ever shows the resulting
 * summary.
 *
 * Every worker is one collapsed line by default: who it is, where it runs, and
 * who controls its reasoning. The eight controls that define a worker only
 * appear for the one worker being edited, which is what keeps a roster of a
 * dozen destinations readable.
 */
export function ChildAgentRoster({ value, enabled, readiness, modelCatalogs, modelFavorites = {}, onToggleModelFavorite, onDiscoverOpenRouterModels, onChange }: {
  value: ChildAgentSettings;
  /** Cross-provider delegation is on *and* sub-agents themselves are on. */
  enabled: boolean;
  readiness: ChildAgentReadiness;
  modelCatalogs?: Partial<Record<Provider, ChildAgentModelOption[]>>;
  modelFavorites?: ModelFavorites;
  onToggleModelFavorite?: (provider: Provider, model: string) => void;
  onDiscoverOpenRouterModels?: (query: string) => void;
  onChange: (next: ChildAgentSettings) => void;
}) {
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [draftId, setDraftId] = useState("");
  const [draftProvider, setDraftProvider] = useState<Provider>("claude");
  const panelPrefix = useId();

  const setTargets = (targets: ChildAgentTarget[]) => onChange({ ...value, targets });
  const updateTarget = (id: string, patch: Partial<ChildAgentTarget>) => {
    setTargets(value.targets.map((target) => (target.id === id ? { ...target, ...patch } : target)));
  };
  const removeTarget = (id: string) => {
    setExpandedId((current) => (current === id ? null : current));
    setTargets(value.targets.filter((target) => target.id !== id));
  };

  const full = value.targets.length >= MAX_CHILD_AGENT_TARGETS;
  const addTarget = () => {
    if (full) return;
    // The per-provider suggestion carries a sensible default model and a
    // description written for the model that has to choose between workers,
    // so a blank name still produces a worker worth spawning.
    const suggestion = SUGGESTED_CHILD_AGENT_TARGETS.find((entry) => entry.provider === draftProvider);
    const id = uniqueChildAgentId(draftId || suggestion?.id || draftProvider, value.targets);
    setTargets([...value.targets, {
      model: draftProvider === "cursor" ? "auto" : "",
      description: "",
      reasoningMode: "inherit",
      reasoningEffort: "medium",
      reasoningMaxEffort: "high",
      ...suggestion,
      id,
      provider: draftProvider,
      label: draftId || suggestion?.label || providerDisplayName(draftProvider),
      enabled: true,
    }]);
    setDraftId("");
    // A new worker still needs a model, so it opens on the fields that matter.
    setExpandedId(id);
  };

  return (
    <div className={`worker-roster ${enabled ? "" : "muted"}`}>
      <div className="worker-roster-head">
        <span>
          <strong>Sub-agents</strong>
          <small>Each one is a named choice the model can delegate to.</small>
        </span>
        <span className="worker-roster-count">{value.targets.length} of {MAX_CHILD_AGENT_TARGETS}</span>
      </div>

      {value.targets.length > 0 ? (
        <ul className="worker-list">
          {value.targets.map((target) => {
            const issue = childAgentTargetIssue(target, readiness);
            const expanded = expandedId === target.id;
            const panelId = `${panelPrefix}-${target.id}`;
            const selectedModel = childAgentModel(target);
            const modelOptions = modelOptionsFor(target.provider, modelCatalogs, selectedModel);
            return (
              <li className={`worker-card ${expanded ? "expanded" : ""} ${target.enabled ? "" : "off"}`} key={target.id}>
                <div className="worker-card-head">
                  <button
                    type="button"
                    className="worker-card-face"
                    aria-expanded={expanded}
                    aria-controls={panelId}
                    aria-label={`Configure ${target.id}`}
                    onClick={() => setExpandedId(expanded ? null : target.id)}
                  >
                    <span className="worker-mark" aria-hidden="true"><ProviderLogo provider={target.provider} size={14} /></span>
                    <span className="worker-copy">
                      <code>{target.id}</code>
                      <small>{providerDisplayName(target.provider)} · {childAgentModel(target) || "provider default"} · {describeChildAgentReasoning(target)}</small>
                    </span>
                    <ChevronDown className="worker-caret" size={14} aria-hidden="true" />
                  </button>
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
                </div>

                {issue && target.enabled && (
                  <p className="worker-issue" role="status"><AlertTriangle size={12} aria-hidden="true" /> {issue}</p>
                )}

                <div
                  id={panelId}
                  className={`worker-config-shell ${expanded ? "open" : ""}`}
                  aria-hidden={!expanded || undefined}
                  inert={!expanded ? true : undefined}
                >
                  <div className="worker-config">
                    <div className="worker-field">
                      <span>Provider</span>
                      <AppSelectMenu
                        ariaLabel={`Provider for ${target.id}`}
                        value={target.provider}
                        options={CHILD_AGENT_PROVIDERS.map((provider) => ({
                          value: provider,
                          label: providerDisplayName(provider),
                          detail: provider === "openai"
                            ? "ChatGPT subscription"
                            : provider === "claude"
                              ? "Claude Code subscription"
                              : provider === "cursor"
                                ? "Cursor subscription"
                                : provider === "lmstudio"
                                  ? "Local LM Studio server"
                                  : "API model routing",
                          icon: <ProviderLogo provider={provider} size={11} />,
                        }))}
                        onChange={(value) => {
                          const provider = value as Provider;
                          updateTarget(target.id, {
                            provider,
                            model: childAgentModel({ provider, model: "" }),
                            label: target.label === providerDisplayName(target.provider) ? providerDisplayName(provider) : target.label,
                          });
                        }}
                      />
                    </div>
                    <div className="worker-field">
                      <span>Model</span>
                      <AppSelectMenu
                        ariaLabel={`Model for ${target.id}`}
                        value={selectedModel}
                        options={modelOptions}
                        favorites={favoriteModels(modelFavorites, target.provider)}
                        {...(onToggleModelFavorite ? { onToggleFavorite: (model: string) => onToggleModelFavorite(target.provider, model) } : {})}
                        {...(target.provider === "openrouter" && onDiscoverOpenRouterModels ? { onSearch: onDiscoverOpenRouterModels } : {})}
                        placeholder={target.provider === "openrouter" ? "Choose an OpenRouter model" : target.provider === "lmstudio" ? "Choose an LM Studio model" : "Choose a model"}
                        searchable={modelOptions.length > 8 || target.provider === "openrouter" || target.provider === "lmstudio"}
                        emptyMessage={target.provider === "openrouter"
                          ? "No OpenRouter models are available. Check the API key and refresh in Settings."
                          : target.provider === "lmstudio"
                            ? "No LM Studio models are available. Start the server and refresh in Settings."
                            : "No models are available for this provider."}
                        onChange={(model) => updateTarget(target.id, { model })}
                      />
                    </div>
                    <div className="worker-field">
                      <span>Reasoning</span>
                      <AppSelectMenu
                        ariaLabel={`Reasoning control for ${target.id}`}
                        value={target.reasoningMode}
                        options={REASONING_MODE_OPTIONS}
                        onChange={(reasoningMode) => updateTarget(target.id, { reasoningMode: reasoningMode as ChildAgentTarget["reasoningMode"] })}
                      />
                    </div>
                    {target.reasoningMode === "fixed" && (
                      <div className="worker-field">
                        <span>Level</span>
                        <AppSelectMenu
                          ariaLabel={`Reasoning level for ${target.id}`}
                          value={target.reasoningEffort}
                          options={REASONING_OPTIONS}
                          onChange={(reasoningEffort) => updateTarget(target.id, { reasoningEffort: reasoningEffort as ChildAgentTarget["reasoningEffort"] })}
                        />
                      </div>
                    )}
                    {target.reasoningMode === "agent" && (
                      <div className="worker-field">
                        <span>Ceiling</span>
                        <AppSelectMenu
                          ariaLabel={`Maximum reasoning for ${target.id}`}
                          value={target.reasoningMaxEffort}
                          options={REASONING_OPTIONS}
                          onChange={(reasoningMaxEffort) => updateTarget(target.id, { reasoningMaxEffort: reasoningMaxEffort as ChildAgentTarget["reasoningMaxEffort"] })}
                        />
                      </div>
                    )}
                    <label className="worker-field wide">
                      <span>When to use</span>
                      <input
                        aria-label={`When to use ${target.id}`}
                        maxLength={400}
                        value={target.description}
                        placeholder="How the model should decide to use this sub-agent"
                        onChange={(event) => updateTarget(target.id, { description: event.target.value })}
                      />
                    </label>
                    <button
                      type="button"
                      className="worker-remove"
                      aria-label={`Remove ${target.id}`}
                      onClick={() => removeTarget(target.id)}
                    >
                      <Trash2 size={12} /> Remove sub-agent
                    </button>
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="worker-empty">No sub-agents yet. Add one below to let the model delegate across providers.</p>
      )}

      <div className="worker-add">
        <input
          aria-label="New destination name"
          maxLength={40}
          value={draftId}
          placeholder="Name, e.g. reviewer"
          onChange={(event) => setDraftId(sanitizeChildAgentIdInput(event.target.value))}
          onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); addTarget(); } }}
        />
        <AppSelectMenu
          ariaLabel="New sub-agent provider"
          value={draftProvider}
          options={CHILD_AGENT_PROVIDERS.map((provider) => ({
            value: provider,
            label: providerDisplayName(provider),
            icon: <ProviderLogo provider={provider} size={11} />,
          }))}
          onChange={(provider) => setDraftProvider(provider as Provider)}
        />
        <button type="button" disabled={full} onClick={addTarget}><Plus size={12} /> Add sub-agent</button>
      </div>
      {full && <p className="worker-empty">This preset has reached its {MAX_CHILD_AGENT_TARGETS}-sub-agent limit.</p>}
    </div>
  );
}
