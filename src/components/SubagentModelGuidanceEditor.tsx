import { useEffect, useId, useMemo, useRef, useState } from "react";
import { AlertTriangle, Pencil, Plus, Trash2 } from "lucide-react";
import { AppSelectMenu } from "./AppSelectMenu";
import { ProviderLogo } from "./BrandLogos";
import { InfoPopover } from "./InfoPopover";
import { modelOptionsFor, type ChildAgentModelOption } from "./subAgentModelOptions";
import {
  CHILD_AGENT_PROVIDERS,
  MAX_SUBAGENT_MODEL_GUIDANCE,
  MAX_SUBAGENT_MODEL_GUIDANCE_NOTE,
  childAgentModel,
  providerDisplayName,
  sanitizeSubagentModelGuidance,
  subagentModelGuidanceKey,
} from "../lib/childAgents";
import { confirmDialog } from "../lib/confirmDialog";
import { favoriteModels, type ModelFavorites } from "../lib/modelFavorites";
import type { Provider, SubagentModelGuidance } from "../types";
import "./SubagentModelGuidance.css";

/**
 * The single entry open for editing. Settings owns it beside its other
 * drafts, so switching panes never drops typed instructions; closing or
 * saving Settings asks first when it differs from {@link initial}.
 */
export interface SubagentModelGuidanceDraft {
  /** The entry being edited, or null for a new one. */
  index: number | null;
  /** The entry when the editor opened: the saved entry, or a new entry's defaults. */
  initial: SubagentModelGuidance;
  entry: SubagentModelGuidance;
}

function sameEntry(first: SubagentModelGuidance, second: SubagentModelGuidance): boolean {
  return first.provider === second.provider && first.model === second.model && first.note === second.note;
}

export function subagentModelGuidanceDraftChanged(draft: SubagentModelGuidanceDraft | null): boolean {
  return Boolean(draft && !sameEntry(draft.entry, draft.initial));
}

/**
 * Where an edit lands in the current list. If the list was replaced under
 * an open editor, the draft follows its entry, or becomes a new entry,
 * rather than overwriting whatever now sits at its old position.
 */
function draftIndex(value: SubagentModelGuidance[], draft: SubagentModelGuidanceDraft): number | null {
  if (draft.index === null) return null;
  const at = value[draft.index];
  if (at && sameEntry(at, draft.initial)) return draft.index;
  const moved = value.findIndex((entry) => sameEntry(entry, draft.initial));
  return moved >= 0 ? moved : null;
}

type EntryStatus = "saved" | "noModel" | "noNote" | "duplicate" | "overLimit";

const STATUS_COPY: Record<Exclude<EntryStatus, "saved">, string> = {
  noModel: "Not saved: choose a model",
  noNote: "Not saved: add instructions",
  duplicate: "Not saved: another entry already covers this model",
  overLimit: `Not saved: over the ${MAX_SUBAGENT_MODEL_GUIDANCE}-model limit`,
};

/**
 * What Save settings will keep, using the sanitizer itself: the first valid
 * entry for each provider/model owns it, and later copies are dropped.
 */
function guidanceStatus(value: SubagentModelGuidance[]) {
  const owners = new Map<string, number>();
  const statuses = value.map((entry, index): EntryStatus => {
    const [clean] = sanitizeSubagentModelGuidance([entry]);
    if (!clean) return childAgentModel(entry) ? "noNote" : "noModel";
    const key = subagentModelGuidanceKey(clean);
    if (owners.has(key)) return "duplicate";
    if (owners.size >= MAX_SUBAGENT_MODEL_GUIDANCE) return "overLimit";
    owners.set(key, index);
    return "saved";
  });
  return { owners, statuses };
}

/**
 * Reusable notes on when a Mythra Code-managed parent should use a model.
 *
 * Deliberately not a crew: a note never approves a destination or enables
 * sub-agents. A parent sees a note only when its own approved crew already
 * includes that provider/model, so this list can describe every model the
 * user cares about without widening any thread's choices.
 *
 * Saved entries show as rows; one entry at a time opens in a form. Its Save
 * writes the Settings draft, which Save settings applies.
 */
export function SubagentModelGuidanceEditor({ value, draft, onDraftChange, modelCatalogs, modelFavorites = {}, onToggleModelFavorite, onDiscoverOpenRouterModels, onChange }: {
  value: SubagentModelGuidance[];
  draft: SubagentModelGuidanceDraft | null;
  onDraftChange: (next: SubagentModelGuidanceDraft | null) => void;
  modelCatalogs?: Partial<Record<Provider, ChildAgentModelOption[]>>;
  modelFavorites?: ModelFavorites;
  onToggleModelFavorite?: (provider: Provider, model: string) => void;
  onDiscoverOpenRouterModels?: (query: string) => void;
  onChange: (next: SubagentModelGuidance[]) => void;
}) {
  const idPrefix = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  // Problems other than a taken model wait for the first Save attempt.
  const [attempted, setAttempted] = useState(false);
  // Selectors to focus after the next render, first match wins.
  const focusNext = useRef<string[]>([]);
  useEffect(() => {
    const selectors = focusNext.current;
    if (!selectors.length) return;
    focusNext.current = [];
    for (const selector of selectors) {
      const target = rootRef.current?.querySelector<HTMLElement>(selector);
      if (target && !target.matches(":disabled")) {
        target.focus();
        return;
      }
    }
  });

  const { owners, statuses } = useMemo(() => guidanceStatus(value), [value]);
  const labels = useMemo(() => new Map(CHILD_AGENT_PROVIDERS.map((provider) => [
    provider,
    new Map(modelOptionsFor(provider, modelCatalogs).map((option) => [option.value, option.label])),
  ])), [modelCatalogs]);
  const modelLabel = (entry: SubagentModelGuidance) => {
    const model = childAgentModel(entry);
    return labels.get(entry.provider)?.get(model) ?? model;
  };
  const entryName = (entry: SubagentModelGuidance) => `${providerDisplayName(entry.provider)} ${modelLabel(entry) || "without a model"}`;
  const editingIndex = draft ? draftIndex(value, draft) : null;
  const full = value.length >= MAX_SUBAGENT_MODEL_GUIDANCE;

  /** Another entry already owns this exact provider/model identity. */
  const taken = (provider: Provider, model: string, index: number | null) => {
    // Match the identity Save settings will actually persist, including its
    // model-ID length limit. Otherwise two long IDs could become duplicates
    // only after Save normalizes them.
    const [normalized] = sanitizeSubagentModelGuidance([{ provider, model, note: "." }]);
    if (!normalized) return false;
    const owner = owners.get(subagentModelGuidanceKey(normalized));
    return owner !== undefined && owner !== index;
  };
  const providerModels = (provider: Provider): string[] => {
    const models = modelOptionsFor(provider, modelCatalogs).map((option) => option.value).filter(Boolean);
    if (models.length) return models;
    const fallback = childAgentModel({ provider, model: "" });
    return fallback ? [fallback] : [];
  };
  const problem = (entry: SubagentModelGuidance, index: number | null): { message: string; live: boolean } | null => {
    const model = childAgentModel(entry);
    if (!model) return { message: "Choose a model.", live: false };
    if (taken(entry.provider, model, index)) {
      return { message: `${entryName(entry)} already has guidance. Choose another model, or edit that entry instead.`, live: true };
    }
    if (index === null && full) return { message: `You have reached the ${MAX_SUBAGENT_MODEL_GUIDANCE}-model limit.`, live: true };
    if (!sanitizeSubagentModelGuidance([entry]).length) return { message: "Describe when and how to use this model.", live: false };
    return null;
  };

  const openEditor = async (next: SubagentModelGuidanceDraft, focus: string) => {
    if (subagentModelGuidanceDraftChanged(draft) && !await confirmDialog("Discard your unsaved model guidance changes?", { confirmLabel: "Discard changes", cancelLabel: "Keep editing" })) return;
    setAttempted(false);
    focusNext.current = [focus];
    onDraftChange(next);
  };
  const add = () => {
    if (full) return;
    // Prefer a current catalog model without a note. Defaults are a fallback
    // only when that provider has no catalog choices.
    const candidates = CHILD_AGENT_PROVIDERS.flatMap((provider) => providerModels(provider).map((model) => ({ provider, model })));
    const next = candidates.find((candidate) => !taken(candidate.provider, candidate.model, null))
      ?? candidates[0]
      ?? { provider: "claude" as Provider, model: childAgentModel({ provider: "claude", model: "" }) };
    const entry = { ...next, note: "" };
    void openEditor({ index: null, initial: entry, entry }, "[data-guidance-form] [data-guidance-field='provider'] .app-select-trigger");
  };
  const edit = (index: number) => {
    const { provider, model, note } = value[index]!;
    const entry = { provider, model, note };
    void openEditor({ index, initial: entry, entry: { ...entry } }, "[data-guidance-form] textarea");
  };
  const remove = (index: number) => {
    if (draft && editingIndex !== null && editingIndex > index) onDraftChange({ ...draft, index: editingIndex - 1 });
    focusNext.current = [`[data-guidance-edit='${index}']`, `[data-guidance-edit='${index - 1}']`, ".model-guidance-add"];
    onChange(value.filter((_, current) => current !== index));
  };
  const updateDraft = (patch: Partial<SubagentModelGuidance>) => {
    if (draft) onDraftChange({ ...draft, entry: { ...draft.entry, ...patch } });
  };
  const cancel = () => {
    setAttempted(false);
    focusNext.current = [editingIndex === null ? ".model-guidance-add" : `[data-guidance-edit='${editingIndex}']`, ".model-guidance-add"];
    onDraftChange(null);
  };
  const save = () => {
    if (!draft) return;
    if (problem(draft.entry, editingIndex)) {
      setAttempted(true);
      return;
    }
    // Store exactly what Save settings keeps: the resolved model and the
    // sanitized note, so the row shows what the parent will read.
    const [entry] = sanitizeSubagentModelGuidance([draft.entry]);
    if (!entry) return;
    setAttempted(false);
    focusNext.current = [`[data-guidance-edit='${editingIndex ?? value.length}']`, ".model-guidance-add"];
    onDraftChange(null);
    if (editingIndex === null) onChange([...value, entry]);
    else if (!sameEntry(value[editingIndex]!, entry)) onChange(value.map((current, index) => index === editingIndex ? entry : current));
  };

  const renderForm = (open: SubagentModelGuidanceDraft, index: number | null) => {
    const entry = open.entry;
    const model = childAgentModel(entry);
    const issue = problem(entry, index);
    const shownIssue = issue && (issue.live || attempted) ? issue.message : null;
    const titleId = `${idPrefix}-form-title`;
    const issueId = `${idPrefix}-form-issue`;
    const hintId = `${idPrefix}-form-hint`;
    const title = index === null ? "New model guidance" : `Edit guidance for ${entryName(open.initial)}`;
    // Models another entry already covers stay visible but cannot be chosen.
    const modelOptions = modelOptionsFor(entry.provider, modelCatalogs, model).map((option) => taken(entry.provider, option.value, index)
      ? { ...option, disabled: true, detail: option.detail ? `Already has guidance · ${option.detail}` : "Already has guidance" }
      : option);
    return (
      <div className="model-guidance-form" role="group" aria-labelledby={titleId} data-guidance-form="">
        <p className="model-guidance-form-title" id={titleId}>{title}</p>
        <div className="model-guidance-pickers">
          <div data-guidance-field="provider">
            <AppSelectMenu
              ariaLabel="Provider"
              portal
              value={entry.provider}
              options={CHILD_AGENT_PROVIDERS.map((provider) => ({
                value: provider,
                label: providerDisplayName(provider),
                icon: <ProviderLogo provider={provider} size={11} />,
              }))}
              onChange={(next) => {
                const provider = next as Provider;
                if (provider === entry.provider) return;
                const models = providerModels(provider);
                updateDraft({ provider, model: models.find((candidate) => !taken(provider, candidate, index)) ?? models[0] ?? "" });
              }}
            />
          </div>
          <div>
            <AppSelectMenu
              ariaLabel="Model"
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
              onChange={(next) => updateDraft({ model: next })}
            />
          </div>
        </div>
        <label className="model-guidance-note">
          <span>When and how to use it</span>
          <textarea
            aria-describedby={shownIssue ? `${issueId} ${hintId}` : hintId}
            aria-invalid={shownIssue ? true : undefined}
            rows={3}
            maxLength={MAX_SUBAGENT_MODEL_GUIDANCE_NOTE}
            value={entry.note}
            placeholder="For example: use for careful code review and test plans; avoid for quick mechanical edits."
            onChange={(event) => updateDraft({ note: event.target.value })}
          />
        </label>
        {shownIssue && <p className="model-guidance-issue" id={issueId} role="alert"><AlertTriangle size={12} aria-hidden="true" /> {shownIssue}</p>}
        <div className="model-guidance-form-actions">
          <small id={hintId}>Save stages this entry. Save settings applies it; closing Settings without saving discards it.</small>
          <button type="button" className="secondary-button" onClick={cancel}>Cancel</button>
          <button type="button" className="primary-button" disabled={Boolean(issue?.live)} onClick={save}>Save</button>
        </div>
      </div>
    );
  };

  const addingNew = Boolean(draft) && editingIndex === null;
  return (
    <div className="model-guidance" ref={rootRef}>
      {value.length > 0 && (
        <ul className="model-guidance-list" aria-label="Model guidance">
          {value.map((entry, index) => {
            if (draft && index === editingIndex) {
              return <li className="model-guidance-editing" key={index}>{renderForm(draft, index)}</li>;
            }
            const model = childAgentModel(entry);
            const label = modelLabel(entry);
            const name = entryName(entry);
            const status = statuses[index]!;
            const note = entry.note.trim();
            return (
              <li className="model-guidance-row" key={index}>
                <div className="model-guidance-model">
                  <ProviderLogo provider={entry.provider} size={13} />
                  <span className="model-guidance-model-copy">
                    <strong>{label || "No model"}</strong>
                    <small>{providerDisplayName(entry.provider)}{model && label !== model ? ` · ${model}` : ""}</small>
                    {status !== "saved" && <small className="model-guidance-row-issue"><AlertTriangle size={11} aria-hidden="true" /> {STATUS_COPY[status]}</small>}
                  </span>
                </div>
                {note ? (
                  <InfoPopover
                    label={`Instructions for ${name}`}
                    className="model-guidance-preview"
                    triggerClassName="model-guidance-preview-trigger"
                    trigger={<span>{note}</span>}
                  >
                    <strong className="model-guidance-full-title">{name}</strong>
                    <p className="model-guidance-full">{entry.note}</p>
                  </InfoPopover>
                ) : <span className="model-guidance-preview-empty">No instructions</span>}
                <div className="model-guidance-actions">
                  <button
                    type="button"
                    className="model-guidance-icon"
                    data-guidance-edit={index}
                    aria-label={`Edit guidance for ${name}`}
                    title="Edit"
                    onClick={() => edit(index)}
                  ><Pencil size={13} aria-hidden="true" /></button>
                  <button
                    type="button"
                    className="model-guidance-icon model-guidance-remove"
                    aria-label={`Remove guidance for ${name}`}
                    title="Remove"
                    onClick={() => remove(index)}
                  ><Trash2 size={13} aria-hidden="true" /></button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {value.length === 0 && !addingNew && <p className="worker-empty">No model guidance yet. Parent agents use their own judgment for every model.</p>}
      {addingNew && draft ? renderForm(draft, null) : (
        <>
          <button type="button" className="secondary-button model-guidance-add" disabled={full} onClick={add}><Plus size={12} aria-hidden="true" /> Add model</button>
          {full && <p className="worker-empty">You have reached the {MAX_SUBAGENT_MODEL_GUIDANCE}-model limit. Edit or remove an entry to make room.</p>}
        </>
      )}
    </div>
  );
}
