import { useId, useState } from "react";
import { AlertTriangle, Plus, Trash2 } from "lucide-react";
import { AppSelectMenu } from "./AppSelectMenu";
import { ProviderLogo } from "./BrandLogos";
import { modelOptionsFor, type ChildAgentModelOption } from "./subAgentModelOptions";
import {
  CHILD_AGENT_PROVIDERS,
  MAX_SUBAGENT_MODEL_GUIDANCE,
  MAX_SUBAGENT_MODEL_GUIDANCE_NOTE,
  childAgentModel,
  providerDisplayName,
  subagentModelGuidanceKey,
} from "../lib/childAgents";
import { favoriteModels, type ModelFavorites } from "../lib/modelFavorites";
import type { Provider, SubagentModelGuidance } from "../types";
import "./SubagentModelGuidance.css";

/**
 * Reusable notes on when a Mythra Code-managed parent should use a model.
 *
 * Deliberately not a crew: a note never approves a destination or enables
 * sub-agents. A parent sees a note only when its own approved crew already
 * includes that provider/model, so this list can describe every model the
 * user cares about without widening any thread's choices.
 */
export function SubagentModelGuidanceEditor({ value, modelCatalogs, modelFavorites = {}, onToggleModelFavorite, onDiscoverOpenRouterModels, onChange }: {
  value: SubagentModelGuidance[];
  modelCatalogs?: Partial<Record<Provider, ChildAgentModelOption[]>>;
  modelFavorites?: ModelFavorites;
  onToggleModelFavorite?: (provider: Provider, model: string) => void;
  onDiscoverOpenRouterModels?: (query: string) => void;
  onChange: (next: SubagentModelGuidance[]) => void;
}) {
  // Focus only the note of an entry this session just added.
  const [addedIndex, setAddedIndex] = useState<number | null>(null);
  const idPrefix = useId();
  const full = value.length >= MAX_SUBAGENT_MODEL_GUIDANCE;
  const update = (index: number, patch: Partial<SubagentModelGuidance>) => {
    onChange(value.map((entry, current) => current === index ? { ...entry, ...patch } : entry));
  };
  const remove = (index: number) => {
    setAddedIndex(null);
    onChange(value.filter((_, current) => current !== index));
  };
  const modelsForNewEntry = (provider: Provider): string[] => {
    const models = modelOptionsFor(provider, modelCatalogs).map((option) => option.value).filter(Boolean);
    if (models.length) return models;
    const fallback = childAgentModel({ provider, model: "" });
    return fallback ? [fallback] : [];
  };
  const add = () => {
    if (full) return;
    // Prefer a current catalog model without a note. Defaults are a fallback
    // only when that provider has no catalog choices.
    const used = new Set(value.map(subagentModelGuidanceKey));
    const candidates = CHILD_AGENT_PROVIDERS.flatMap((provider) => modelsForNewEntry(provider).map((model) => ({ provider, model })));
    const next = candidates.find((candidate) => !used.has(subagentModelGuidanceKey(candidate)))
      ?? candidates[0]
      ?? { provider: "claude" as Provider, model: childAgentModel({ provider: "claude", model: "" }) };
    setAddedIndex(value.length);
    onChange([...value, { ...next, note: "" }]);
  };

  return (
    <div className="model-guidance">
      {value.length > 0 ? (
        <ul className="model-guidance-list" aria-label="Model guidance">
          {value.map((entry, index) => {
            const model = childAgentModel(entry);
            const modelOptions = modelOptionsFor(entry.provider, modelCatalogs, model);
            const key = subagentModelGuidanceKey(entry);
            const duplicate = Boolean(model) && value.slice(0, index).some((earlier) => subagentModelGuidanceKey(earlier) === key);
            const name = model ? `${providerDisplayName(entry.provider)} ${model}` : `${providerDisplayName(entry.provider)} entry ${index + 1}`;
            const issue = !model
              ? "Choose a model. Entries without a model are not saved."
              : duplicate
                ? "Another note already covers this model. Only the first one is saved."
                : !entry.note.trim()
                  ? "Add a note, or remove this model. Empty notes are not saved."
                  : null;
            const issueId = `${idPrefix}-issue-${index}`;
            return (
              <li className="model-guidance-card" key={index}>
                <div className="model-guidance-pickers">
                  <AppSelectMenu
                    ariaLabel={`Provider for ${name}`}
                    portal
                    value={entry.provider}
                    options={CHILD_AGENT_PROVIDERS.map((provider) => ({
                      value: provider,
                      label: providerDisplayName(provider),
                      icon: <ProviderLogo provider={provider} size={11} />,
                    }))}
                    onChange={(next) => {
                      const provider = next as Provider;
                      if (provider !== entry.provider) update(index, { provider, model: modelsForNewEntry(provider)[0] ?? "" });
                    }}
                  />
                  <AppSelectMenu
                    ariaLabel={`Model for ${name}`}
                    portal
                    value={model}
                    options={modelOptions}
                    favorites={favoriteModels(modelFavorites, entry.provider)}
                    {...(onToggleModelFavorite ? { onToggleFavorite: (favorite: string) => onToggleModelFavorite(entry.provider, favorite) } : {})}
                    {...(entry.provider === "openrouter" && onDiscoverOpenRouterModels ? { onSearch: onDiscoverOpenRouterModels } : {})}
                    placeholder={entry.provider === "openrouter" ? "Choose an OpenRouter model" : entry.provider === "lmstudio" ? "Choose an LM Studio model" : "Choose a model"}
                    searchable={modelOptions.length > 8 || entry.provider === "openrouter" || entry.provider === "lmstudio"}
                    emptyMessage={entry.provider === "openrouter"
                      ? "No OpenRouter models are available. Check the API key and refresh in Settings."
                      : entry.provider === "lmstudio"
                        ? "No LM Studio models are available. Start the server and refresh in Settings."
                        : "No models are available for this provider."}
                    onChange={(next) => update(index, { model: next })}
                  />
                  <button
                    type="button"
                    className="model-guidance-remove"
                    aria-label={`Remove guidance for ${name}`}
                    title="Remove"
                    onClick={() => remove(index)}
                  ><Trash2 size={13} aria-hidden="true" /></button>
                </div>
                <label className="model-guidance-note">
                  <span>When and how to use it</span>
                  <textarea
                    aria-label={`Guidance for ${name}`}
                    aria-describedby={issue ? issueId : undefined}
                    aria-invalid={issue ? true : undefined}
                    rows={2}
                    maxLength={MAX_SUBAGENT_MODEL_GUIDANCE_NOTE}
                    value={entry.note}
                    autoFocus={index === addedIndex}
                    placeholder="For example: use for careful code review and test plans; avoid for quick mechanical edits."
                    onChange={(event) => update(index, { note: event.target.value })}
                  />
                </label>
                {issue && <p className="model-guidance-issue" id={issueId} role="status"><AlertTriangle size={12} aria-hidden="true" /> {issue}</p>}
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="worker-empty">No model guidance yet. Parent agents use their own judgment for every model.</p>
      )}
      <button type="button" className="secondary-button model-guidance-add" disabled={full} onClick={add}><Plus size={12} aria-hidden="true" /> Add model</button>
      {full && <p className="worker-empty">You have reached the {MAX_SUBAGENT_MODEL_GUIDANCE}-model limit.</p>}
    </div>
  );
}
