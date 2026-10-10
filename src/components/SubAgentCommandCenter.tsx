import { modelOptionsFor, REASONING_OPTIONS, type ChildAgentModelOption as SubAgentModelOption } from "./subAgentModelOptions";
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, ArrowRightLeft, Info, LoaderCircle, Lock, Minus, Plus, Settings2, Square, SquareArrowOutUpRight, Trash2, UsersRound, X } from "lucide-react";
import { ProviderLogo } from "./BrandLogos";
import { AppSelectMenu, type AppSelectOption } from "./AppSelectMenu";
import type { ReasoningEffort } from "./ModelPowerControl";
import {
  CHILD_AGENT_PROVIDERS,
  MAX_CHILD_AGENT_TARGETS,
  SUGGESTED_CHILD_AGENT_TARGETS,
  MAX_SUBAGENT_CONCURRENCY,
  childAgentAutoCompactIssue,
  childAgentCrewSize,
  childAgentModel,
  childAgentTargetIssue,
  crewSafeConcurrency,
  MAX_CHILD_AGENT_PRESETS,
  describeChildAgentReasoning,
  providerDisplayName,
  providerSignInIssue,
  readyChildAgentTargets,
  sanitizeProjectSubagentSettings,
  uniqueChildAgentId,
  type ChildAgentPolicy,
  type ChildAgentReadiness,
} from "../lib/childAgents";
import {
  describeSubAgentActivity,
  isSubAgentWorkerActive,
  subAgentStatusLabel,
  summarizeSubAgentWorkers,
  type SubAgentWorker,
} from "../lib/subAgentActivity";
import { favoriteModels, type ModelFavorites } from "../lib/modelFavorites";
import { autoCompactTokensError, nativeSubagentVersionAtLeast } from "../lib/threadSubagentSettings";
import { claudeCompactionModelKey, claudeNativeCompactionConflict } from "../lib/claude";
import { frontierPricingSnapshot, type FrontierPricingEntry } from "../lib/frontierPricing";
import { compactionPriceBoundary, compactionPricingEntry, describeCompactionPriceBoundary, modelCompactionWindows } from "../lib/modelCompactionPricing";
import { subscribeUsage } from "../lib/usageLedger";
import { useRosterFlip } from "../hooks/useRosterFlip";
import type { ChildAgentPreset, ChildAgentTarget, NativeSubagentOptions, ProjectSubagentSettings, Provider } from "../types";
import "./SubAgentCommandCenter.css";

/**
 * The composer's sub-agent command center.
 *
 * A single toolbar control that opens a mini window over the composer: crew
 * size, the provider/model destinations a root agent may delegate to, the
 * reasoning authority each destination gets, and the live state of every child
 * currently working for this thread.
 *
 * Three modes, and the differences are security boundaries rather than
 * conveniences — see {@link SubAgentPolicyMode}. What the panel shows is
 * always what the next turn would actually do: a thread that captured a roster
 * shows that roster, and the on/off state shown is the live one, because the
 * runtime re-reads it on every turn.
 *
 * The full Settings → Sub-agents screen remains the durable place to manage
 * destination names, descriptions, and per-project policies; this panel is the
 * daily-use surface and links there.
 */

/**
 * How this conversation's sub-agent policy may be changed right now.
 *
 * - `open` — nothing is frozen yet. A fresh draft, or a started thread that
 *   has never run with cross-provider sub-agents available, edits the policy
 *   the next turn will capture, writing through to the global defaults or to
 *   the active project override.
 * - `captured` — this thread already owns a roster. It may edit that roster
 *   while the parent and all children are idle; the edit is staged atomically
 *   for the next message. While any work is active, the roster is read-only so
 *   a running plan cannot acquire different destinations mid-flight.
 * - `child` — this conversation is itself a sub-agent. It can never delegate,
 *   so nothing here is editable and nothing is offered.
 */
export type SubAgentPolicyMode = "open" | "captured" | "child";

/** The panel is a popover, not a modal: Escape and outside clicks dismiss it. */
export interface SubAgentCommandCenterProps {
  /** Editable draft policy, already resolved for the active scope. */
  policy: ProjectSubagentSettings;
  /** The frozen policy a started thread carries, when it captured one. */
  capturedPolicy: ChildAgentPolicy | null;
  mode: SubAgentPolicyMode;
  readiness: ChildAgentReadiness;
  workers: SubAgentWorker[];
  /** Whether the parent conversation is starting or running. */
  parentActive?: boolean;
  /** "Chats" or the project name — where an edit would be written. */
  scopeLabel: string;
  /** The active project already carries its own sub-agent override. */
  projectOverride: boolean;
  /** User-created complete crew policies, managed in Settings. */
  presets?: ChildAgentPreset[];
  onSavePreset?: (name: string, policy: ProjectSubagentSettings) => void;
  onChange: (next: ProjectSubagentSettings) => void;
  onOpenSettings: () => void;
  onOpenAccounts?: () => void;
  onUnavailable?: (message: string) => void;
  /** Live provider catalogs used by the app's own model pickers. */
  modelCatalogs?: Partial<Record<Provider, SubAgentModelOption[]>>;
  /** Starred models, shared with the composer and Settings pickers. */
  modelFavorites?: ModelFavorites;
  onToggleModelFavorite?: (provider: Provider, model: string) => void;
  /** Open a child's own conversation, live or finished, in the main view. */
  onOpenWorker?: (worker: SubAgentWorker) => Promise<void>;
  /** Stop one live child without stopping its root conversation. */
  onStopWorker?: (worker: SubAgentWorker) => Promise<void>;
  /** Stop one live child and ask the root to restart its task on a frozen destination. */
  onReplaceWorker?: (worker: SubAgentWorker, targetId: string) => Promise<void>;
  /**
   * Which system delegates for this thread. `mythra` is the cross-provider crew
   * configured above; `native` hands delegation to the thread's own provider
   * runtime. Independent of the on/off switch. Defaults to `mythra`.
   */
  engine?: SubAgentEngine;
  /** The thread's own provider, which decides what "native" means. */
  provider?: Provider;
  /** Why native delegation cannot run here (update, sign-in, ...), when known. */
  nativeUnavailableReason?: string | null;
  /**
   * Runtime, provider and sign-in readiness only, without saved native
   * options. When supplied (even as null) it alone decides whether the
   * native system may be chosen, so a thread whose saved options are invalid
   * can still be switched to native and repaired there.
   */
  nativeSelectionUnavailableReason?: string | null;
  /** Native runtime admission limit, independent of the Mythra crew limit. */
  nativeMaxConcurrent?: number;
  /** Omitted while the host has not wired engine selection; the selector then stays hidden. */
  onEngineChange?: (engine: SubAgentEngine) => void;
  onNativeMaxConcurrentChange?: (max: number) => void;
  /**
   * This thread's native child defaults, kept per provider so switching the
   * thread between Codex and Claude Code never loses the other's choices.
   */
  nativeOptions?: NativeSubagentOptions;
  /** Omitted while the host has not wired native options; the fields then stay hidden. */
  onNativeOptionsChange?: (options: NativeSubagentOptions) => void;
  /** Installed Claude Code version, which gates newer child models. */
  claudeVersion?: string | null;
  /** Model ids the native runtimes accept directly; falls back to {@link modelCatalogs}. */
  nativeModelCatalogs?: Partial<Record<Provider, SubAgentModelOption[]>>;
  /** Reasoning levels each Codex model reports; missing or empty means unknown. */
  nativeReasoningEfforts?: Partial<Record<string, ReasoningEffort[]>>;
  /** The parent's model, which Codex children use when no default model is set. */
  nativeDefaultModel?: string;
  /**
   * This conversation's own compaction window, independent of delegation and
   * of either sub-agent system. Omitted means the provider default.
   */
  autoCompactTokens?: number;
  /** Omitted while the host has not wired the conversation window; the control then stays hidden. */
  onAutoCompactTokensChange?: (tokens?: number) => void;
  /** Identity of the conversation this panel edits; a change closes the panel. */
  contextKey?: string;
}

export type SubAgentEngine = "mythra" | "native";

export type { ChildAgentModelOption as SubAgentModelOption } from "./subAgentModelOptions";

/** Stable identity so a locked thread's empty roster never re-triggers memos. */
const NO_TARGETS: ChildAgentTarget[] = [];
const PANEL_EXIT_MS = 180;
/** The roster grid's own key, so `sa-add` can travel with the tiles. */
const ADD_TILE_FLIP_KEY = "__add__";
const DEFAULT_NATIVE_MAX_CONCURRENT = 6;
/** Layout px between the trigger and the panel; matches `calc(100% + 8px)`. */
const PANEL_GAP = 8;
/** Visual px the panel keeps clear of the viewport edge. */
const PANEL_VIEWPORT_MARGIN = 8;
/** Layout px; the panel never grows past this even with room to spare. */
const PANEL_MAX_HEIGHT = 560;
/** Below this much room above the trigger, a roomier space below wins. */
const PANEL_MIN_COMFORTABLE_HEIGHT = 160;

/**
 * Visual pixels per layout pixel. The app shell applies UI scale as CSS zoom,
 * so rectangles are visual while the panel's own lengths are layout pixels.
 */
function effectiveZoom(element: HTMLElement): number {
  const current = (element as HTMLElement & { currentCSSZoom?: number }).currentCSSZoom;
  if (typeof current === "number" && Number.isFinite(current) && current > 0) return current;
  let zoom = 1;
  for (let node: HTMLElement | null = element; node; node = node.parentElement) {
    const value = getComputedStyle(node).zoom;
    const factor = value.endsWith("%") ? Number.parseFloat(value) / 100 : Number.parseFloat(value);
    if (Number.isFinite(factor) && factor > 0) zoom *= factor;
  }
  return zoom;
}

/** Providers whose own runtime can start same-provider sub-agents. */
type NativeProvider = Extract<Provider, "openai" | "claude">;

function nativeProviderFor(provider: Provider | undefined): NativeProvider | null {
  return provider === "openai" || provider === "claude" ? provider : null;
}

function nativeRuntimeName(provider: NativeProvider): string {
  return provider === "openai" ? "Codex" : "Claude Code";
}

function clampNativeLimit(value: number | undefined): number {
  if (!Number.isFinite(value)) return DEFAULT_NATIVE_MAX_CONCURRENT;
  return Math.min(MAX_SUBAGENT_CONCURRENCY, Math.max(1, Math.round(Number(value))));
}

type NativeOptionsKey = keyof NativeSubagentOptions;
type NativeOptionField = "model" | "reasoningEffort" | "autoCompactTokens";

function nativeOptionsKey(provider: NativeProvider): NativeOptionsKey {
  return provider === "openai" ? "codex" : "claude";
}

type NativeOptionPatch = Partial<Record<NativeOptionField, string | number | undefined>>;

/**
 * Sets or clears fields for one provider in a single update. The other
 * provider's entry is carried through untouched, and a cleared field is
 * removed rather than kept as an empty value, so "provider default" really
 * means nothing is sent.
 */
function withNativeOptions(
  options: NativeSubagentOptions | undefined,
  key: NativeOptionsKey,
  patch: NativeOptionPatch,
): NativeSubagentOptions {
  const entry = Object.fromEntries(Object.entries({ ...options?.[key], ...patch })
    .filter(([, current]) => current !== undefined && current !== ""));
  const next: NativeSubagentOptions = { ...options };
  if (Object.keys(entry).length) (next as Record<NativeOptionsKey, unknown>)[key] = entry;
  else delete next[key];
  return next;
}

/** Claude Code first accepts Haiku 5.5 as a child model in this release. */
const HAIKU_5_5 = "claude-haiku-5-5";
const HAIKU_5_5_MIN_CLAUDE = [2, 1, 293] as const;
const HAIKU_5_5_UPDATE = `Haiku 5.5 needs Claude Code ${HAIKU_5_5_MIN_CLAUDE.join(".")} or newer. Update Claude Code to use it for child agents.`;

/** A full Claude model id, rather than "provider chooses" or a family alias. */
/** Dated and context-suffixed ids share the gate, matching the runtime check. */
function isHaiku55(model: string): boolean {
  return model.trim().toLowerCase().startsWith(HAIKU_5_5);
}

/**
 * The thread provider's own catalog, plus the provider-default entry. Haiku
 * 5.5 is always listed for Claude so an outdated fallback catalog cannot hide
 * it, and it is offered only on a runtime that can actually start it.
 */
function nativeModelOptions(
  provider: NativeProvider,
  catalogs: SubAgentCommandCenterProps["modelCatalogs"],
  saved: string,
  haikuSupported: boolean,
): AppSelectOption[] {
  const options = modelOptionsFor(provider, catalogs);
  if (provider === "claude" && !options.some((option) => isHaiku55(option.value))) {
    const olderHaiku = options.findIndex((option) => option.value === "claude-haiku-4-5");
    options.splice(olderHaiku >= 0 ? olderHaiku : options.length, 0, {
      value: HAIKU_5_5,
      label: "Haiku 5.5",
      detail: HAIKU_5_5,
      icon: <ProviderLogo provider="claude" size={11} />,
    });
  }
  if (saved && !options.some((option) => option.value === saved)) {
    options.unshift({
      value: saved,
      label: saved,
      detail: "Previously configured model",
      icon: <ProviderLogo provider={provider} size={11} />,
    });
  }
  if (provider === "claude" && !haikuSupported) {
    options.forEach((option, index) => {
      if (isHaiku55(option.value)) options[index] = { ...option, detail: `Needs Claude Code ${HAIKU_5_5_MIN_CLAUDE.join(".")}+`, disabled: true };
    });
  }
  return [
    { value: "", label: "Provider chooses", detail: `${nativeRuntimeName(provider)} picks the model` },
    ...options,
  ];
}

function describeTokenWindow(tokens: number): string {
  if (tokens % 1_000_000 === 0) return `${tokens / 1_000_000}M tokens`;
  if (tokens % 1_000 === 0) return `${tokens / 1_000}K tokens`;
  return `${tokens.toLocaleString("en-US")} tokens`;
}

/** Select value for a stored window that is present but not a valid choice. */
const INVALID_COMPACTION = "invalid";

/** A stored window as a select value: omitted, a valid choice, or invalid. */
function compactionValue(saved: number | undefined): string {
  if (saved === undefined) return "";
  return autoCompactTokensError(saved) ? INVALID_COMPACTION : String(saved);
}

/**
 * Provider default plus model-specific published price boundaries, manual
 * windows and any valid custom window
 * already saved. An invalid stored value (such as a corrupt zero) is shown as
 * exactly that, never as a working window. When the runtime has no such
 * setting, every window stays visible but unavailable, while Provider default
 * remains selectable so an old value can still be cleared.
 */
function compactionChoices(saved: number | undefined, entry: FrontierPricingEntry | undefined, unavailable?: string): AppSelectOption[] {
  const windows = modelCompactionWindows(entry);
  const priceBoundary = compactionPriceBoundary(entry);
  const options: AppSelectOption[] = [
    { value: "", label: "Provider default", detail: "The runtime's own threshold" },
    ...windows.map((tokens) => ({
      value: String(tokens),
      label: describeTokenWindow(tokens),
      ...(tokens === priceBoundary ? { detail: "Published API price boundary; not a cost cap" }
        : tokens === 1_000_000 ? { detail: "Requested window; model limits still apply" } : {}),
    })),
  ];
  if (saved !== undefined && autoCompactTokensError(saved)) {
    options.splice(1, 0, { value: INVALID_COMPACTION, label: "Invalid saved value", detail: "Choose a window or Provider default", disabled: true });
  } else if (saved !== undefined && !windows.includes(saved)) {
    options.splice(1, 0, { value: String(saved), label: describeTokenWindow(saved), detail: "Previously configured" });
  }
  return unavailable
    ? options.map((option) => (option.value === "" ? option : { ...option, detail: unavailable, disabled: true }))
    : options;
}

/** What is wrong with a stored window, if anything, and how to fix it. */
function compactionIssue(saved: number | undefined, unsupportedBy?: string): string | null {
  if (saved === undefined) return null;
  if (autoCompactTokensError(saved)) return "The saved compaction window is not valid. Choose a window or Provider default.";
  return unsupportedBy ? `${unsupportedBy} has no compaction setting. Choose Provider default to clear the saved window.` : null;
}

/** Providers whose runtime exposes no configurable compaction window. */
function compactionUnsupportedBy(provider: Provider | undefined): string | undefined {
  return provider === "cursor" ? "Cursor" : undefined;
}

function compactionLabel(saved: number | undefined): string {
  if (saved === undefined) return "provider default";
  return autoCompactTokensError(saved) ? "an invalid saved value" : describeTokenWindow(saved);
}

/**
 * Levels a Codex model reports. A present entry is authoritative, and an
 * empty one means the model takes no level at all; a missing entry (or no
 * model) is unknown, which never counts as support.
 */
function reportedEfforts(
  efforts: Partial<Record<string, ReasoningEffort[]>> | undefined,
  model: string,
): ReasoningEffort[] | null {
  if (!model || !efforts || !Object.hasOwn(efforts, model)) return null;
  return efforts[model] ?? [];
}

/**
 * Codex reasoning defaults. Provider default is always available; a level is
 * offered only when the model that would run reports it, and the rest stay
 * visible but unavailable with the reason.
 */
function nativeReasoningOptions(
  supported: ReasoningEffort[] | null,
  modelLabel: string,
  explicitModel: boolean,
): AppSelectOption[] {
  const unavailable = supported
    ? supported.length ? `Not offered by ${modelLabel}` : `${modelLabel} takes no reasoning level`
    : modelLabel ? `Not confirmed for ${modelLabel}` : "Model levels not reported";
  return [
    {
      value: "",
      label: "Provider default",
      detail: explicitModel ? `${modelLabel}'s own default level` : "Parent's level unless Codex config sets one",
    },
    ...REASONING_OPTIONS.map((option) => (supported?.includes(option.value as ReasoningEffort)
      ? option
      : { ...option, detail: unavailable, disabled: true })),
  ];
}

/**
 * Which model a native worker is on, as far as its provider has said. Only an
 * execution report confirms the model; a configured or requested one is
 * labelled as such, and an unlabelled model is never presented as fact.
 */
function nativeWorkerModel(worker: SubAgentWorker): { text: string; confirmed: string | null; requested: string | null } {
  const confirmed = worker.modelSource === "execution" ? worker.model?.trim() || null : null;
  const requested = worker.requestedModel?.trim() || (worker.modelSource === "configured" ? worker.model?.trim() || null : null);
  return {
    text: confirmed ?? (requested ? `${requested} requested, unconfirmed` : "model not reported"),
    confirmed,
    requested,
  };
}

/** Details belong to one activation, so a rerun never opens on an old result. */
function workerDetailsKey(worker: SubAgentWorker): string {
  return `${worker.id}\u0000${worker.activationId ?? ""}`;
}

const REASONING_MODE_OPTIONS: AppSelectOption[] = [
  { value: "inherit", label: "Inherit parent", detail: "Use the main agent's level" },
  { value: "fixed", label: "You set the level", detail: "Always use one chosen level" },
  { value: "agent", label: "Main agent decides", detail: "Let the root choose within a ceiling" },
];

function targetKey(target: ChildAgentTarget): string {
  return target.id;
}

/** A destination named after its provider, deduped against the roster. */
function newTargetFor(provider: Provider, existing: ChildAgentTarget[]): ChildAgentTarget {
  const id = uniqueChildAgentId(provider, existing);
  return {
    id,
    provider,
    model: provider === "cursor" ? "auto" : "",
    label: providerDisplayName(provider),
    description: SUGGESTED_CHILD_AGENT_TARGETS.find((entry) => entry.provider === provider)?.description ?? "",
    enabled: true,
    reasoningMode: "inherit",
    reasoningEffort: "medium",
    reasoningMaxEffort: "high",
  };
}

export function SubAgentCommandCenter(props: SubAgentCommandCenterProps) {
  const { onUnavailable } = props;
  const [open, setOpen] = useState(false);
  const [panelPresent, setPanelPresent] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [selectedPresetId, setSelectedPresetId] = useState("");
  const [replaceWorkerId, setReplaceWorkerId] = useState<string | null>(null);
  const [workerAction, setWorkerAction] = useState<{ workerId: string; kind: "stop" | "replace" | "open" } | null>(null);
  const [presetName, setPresetName] = useState("");
  const [workerActionError, setWorkerActionError] = useState<string | null>(null);
  const [compactInfoOpen, setCompactInfoOpen] = useState(false);
  const [workerDetailsOpen, setWorkerDetailsOpen] = useState<string | null>(null);
  const [compactionPricing, setCompactionPricing] = useState<FrontierPricingEntry[]>([]);
  useEffect(() => {
    if (!open) return;
    const read = () => setCompactionPricing(frontierPricingSnapshot().entries);
    const unsubscribe = subscribeUsage(read);
    read();
    return unsubscribe;
  }, [open]);
  const workerDetailsIdBase = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const closeTimerRef = useRef<number | null>(null);
  const panelId = useId();

  const { policy, capturedPolicy, mode, readiness, workers, onChange } = props;
  const counts = useMemo(() => summarizeSubAgentWorkers(workers), [workers]);
  /** This thread already owns a captured, thread-specific roster. */
  const captured = mode === "captured";
  /** A sub-agent conversation, which may never delegate again. */
  const isChild = mode === "child";
  const statusUnknown = workers.some((worker) => worker.status === "unknown");
  const crewActive = Boolean(props.parentActive) || counts.active > 0 || statusUnknown;
  /** Whether the destination roster and the parallel limit may be edited. */
  const editable = mode === "open" || (captured && !crewActive);
  // The system choice, the main switch and every limit describe how the
  // current run was admitted, so they hold still while any of it is running,
  // including on a thread that has not captured a roster yet.
  const runLocked = crewActive;
  const engine: SubAgentEngine = props.engine ?? "mythra";
  const native = !isChild && engine === "native";
  const nativeProvider = nativeProviderFor(props.provider);
  const nativeName = nativeProvider ? nativeRuntimeName(nativeProvider) : null;
  const unsupportedProviderReason = props.provider && !nativeProvider
    ? `${providerDisplayName(props.provider)} has no native sub-agents. Native mode needs a Codex or Claude Code thread.`
    : null;
  /** Everything that would stop the next native turn, saved options included. */
  const nativeUnavailable = props.nativeUnavailableReason?.trim() || unsupportedProviderReason;
  /** What stops choosing native at all; invalid saved options are fixed inside it. */
  const nativeSelectionBlocked = unsupportedProviderReason
    || (props.nativeSelectionUnavailableReason !== undefined
      ? props.nativeSelectionUnavailableReason?.trim() || null
      : nativeUnavailable);
  const nativeMax = clampNativeLimit(props.nativeMaxConcurrent);
  const showEngineSelector = !isChild && Boolean(props.onEngineChange);
  const engineGroupName = useId();
  const nativeReasonId = useId();
  const lockNoteId = useId();
  const compactInfoId = useId();
  // Native options only exist for a provider that has native agents, and they
  // follow the same locks as the native limit: frozen while anything runs and
  // inert while delegation is off. Editing one never turns delegation on.
  const nativeKey = nativeProvider ? nativeOptionsKey(nativeProvider) : null;
  const nativeOptionsShown = native && Boolean(nativeKey) && Boolean(props.onNativeOptionsChange);
  const nativeOptionsEditable = nativeOptionsShown && !runLocked && policy.enabled;
  const providerOptions = nativeKey ? props.nativeOptions?.[nativeKey] : undefined;
  const savedNativeModel = providerOptions?.model?.trim() ?? "";
  // Claude applies a child window to one exact model; Codex has no separate
  // child window, so a saved Codex value is only ever offered for removal.
  const savedChildCompact = props.nativeOptions?.claude?.autoCompactTokens;
  const savedCodexChildCompact = props.nativeOptions?.codex?.autoCompactTokens;
  const parentCompactShown = !isChild && Boolean(props.onAutoCompactTokensChange);
  const parentCompactUnsupportedBy = compactionUnsupportedBy(props.provider);
  const parentModel = props.nativeDefaultModel?.trim() ?? "";
  const pricingFor = (provider: Provider | undefined, model: string) => compactionPricingEntry(provider, model, compactionPricing,
    provider && props.modelCatalogs?.[provider]?.find((entry) => entry.id === model)?.resolvedModel);
  const parentPricing = pricingFor(props.provider, parentModel);
  const childPricing = pricingFor(nativeProvider ?? undefined, savedNativeModel);
  const parentCompactChoices = useMemo(
    () => compactionChoices(props.autoCompactTokens, parentPricing, parentCompactUnsupportedBy && `Not available for ${parentCompactUnsupportedBy}`),
    [parentCompactUnsupportedBy, parentPricing, props.autoCompactTokens],
  );
  const parentCompactIssue = compactionIssue(props.autoCompactTokens, parentCompactUnsupportedBy);
  const childCompactChoices = useMemo(() => compactionChoices(savedChildCompact, childPricing), [savedChildCompact, childPricing]);
  const childCompactIssue = compactionIssue(savedChildCompact);
  // The same rule the runtime admits native turns by: a child window needs
  // supported explicit models on both sides, and one model has one window.
  const childCompactConflict = savedChildCompact !== undefined && !childCompactIssue
    ? claudeNativeCompactionConflict(parentModel, props.autoCompactTokens, savedNativeModel, savedChildCompact)
    : null;
  const childModelKey = claudeCompactionModelKey(savedNativeModel);
  // Only an equal window is shared without conflict; a different one is blocked above.
  const childSharesParentWindow = savedChildCompact !== undefined && !childCompactIssue && !childCompactConflict
    && childModelKey !== null && childModelKey === claudeCompactionModelKey(parentModel);
  const savedCodexEffort = props.nativeOptions?.codex?.reasoningEffort ?? "";
  const haikuSupported = nativeSubagentVersionAtLeast(props.claudeVersion, HAIKU_5_5_MIN_CLAUDE);
  const nativeCatalogs = props.nativeModelCatalogs ?? props.modelCatalogs;
  const nativeModelChoices = useMemo(
    () => (nativeProvider ? nativeModelOptions(nativeProvider, nativeCatalogs, savedNativeModel, haikuSupported) : []),
    [haikuSupported, nativeCatalogs, nativeProvider, savedNativeModel],
  );
  // Without a default child model, Codex children run on the parent's model,
  // so that model's reported levels decide which defaults are valid.
  const codexEffortModel = savedNativeModel || props.nativeDefaultModel?.trim() || "";
  const modelLabelFor = (model: string) => (model && nativeModelChoices.find((option) => option.value === model)?.label) || model;
  const codexModelLabel = modelLabelFor(codexEffortModel);
  const codexSupportedEfforts = nativeProvider === "openai" ? reportedEfforts(props.nativeReasoningEfforts, codexEffortModel) : null;
  const reasoningChoices = useMemo(
    () => nativeReasoningOptions(codexSupportedEfforts, codexModelLabel, Boolean(savedNativeModel)),
    [codexModelLabel, codexSupportedEfforts, savedNativeModel],
  );
  /** A saved level the model that would run reports it cannot take. */
  const unsupportedCodexEffort = Boolean(savedCodexEffort && codexSupportedEfforts && !codexSupportedEfforts.includes(savedCodexEffort));
  /** A saved level nobody has confirmed; the runtime decides at the next turn. */
  const unconfirmedCodexEffort = Boolean(savedCodexEffort && !codexSupportedEfforts);
  const setNativeOptions = (patch: NativeOptionPatch) => {
    if (!nativeOptionsEditable || !nativeKey) return;
    props.onNativeOptionsChange?.(withNativeOptions(props.nativeOptions, nativeKey, patch));
  };
  // Removing a window Codex cannot use is a repair, not a delegation setting,
  // so it is allowed with delegation off; only active work locks it.
  const clearCodexChildCompact = () => {
    if (runLocked || !props.onNativeOptionsChange) return;
    props.onNativeOptionsChange(withNativeOptions(props.nativeOptions, "codex", { autoCompactTokens: undefined }));
  };
  const setParentCompact = (value: string) => {
    if (runLocked) return;
    props.onAutoCompactTokensChange?.(value ? Number(value) : undefined);
  };
  const setNativeModel = (model: string) => {
    // A saved level the new model reports it cannot take is cleared in the same
    // update, so the thread never holds a pair the next turn would reject.
    const nextModel = model || props.nativeDefaultModel?.trim() || "";
    const nextEfforts = nativeProvider === "openai" ? reportedEfforts(props.nativeReasoningEfforts, nextModel) : null;
    if (savedCodexEffort && nextEfforts && !nextEfforts.includes(savedCodexEffort)) {
      setNativeOptions({ model, reasoningEffort: undefined });
      onUnavailable?.(`${modelLabelFor(nextModel)} does not offer that reasoning level, so child reasoning is back to the provider default.`);
      return;
    }
    setNativeOptions({ model });
  };
  // App resolves a captured thread's policy to its current or staged roster,
  // so every edit operates on the exact draft the next message will promote.
  const targets = useMemo(() => {
    if (isChild) return NO_TARGETS;
    if (captured && crewActive) return capturedPolicy?.targets ?? NO_TARGETS;
    return policy.childAgents.targets;
  }, [captured, capturedPolicy?.targets, crewActive, isChild, policy.childAgents.targets]);
  const maxConcurrent = captured && crewActive
    ? (capturedPolicy?.maxConcurrent ?? policy.maxConcurrent)
    : policy.maxConcurrent;
  // The main switch is read fresh every turn, including captured threads.
  // It re-locks with the
  // rest of the controls while work is active.
  const delegationOn = !isChild && policy.enabled;
  const hasRoster = !isChild && targets.length > 0;
  const readyCount = useMemo(
    () => readyChildAgentTargets({ enabled: true, targets }, readiness).length,
    [readiness, targets],
  );
  const enabledCount = targets.filter((target) => target.enabled).length;
  // The roster is a menu and the limit is a budget. A crew of five destinations
  // with a limit of two is a legitimate configuration: the model picks two of
  // the five to run at a time.
  const crewSize = childAgentCrewSize({ enabled: hasRoster, targets });
  const crewCeiling = Math.max(1, enabledCount);
  const dimmed = !delegationOn;
  const rosterReady = delegationOn && hasRoster && readyCount > 0;

  // Everything that can move a tile: which one is open, who is in the roster,
  // and the fields a destination's own settings add or remove from its editor.
  const crewLayoutSignature = useMemo(() => [
    expandedId ?? "",
    native ? "native" : "mythra",
    editable ? "edit" : "read",
    targets.map((target) => `${target.id}:${target.provider}:${target.reasoningMode}`).join(","),
  ].join("|"), [editable, expandedId, native, targets]);
  const crewFlip = useRosterFlip(crewLayoutSignature);
  // The panel is bottom-anchored, so the roster growing under it would jerk
  // its top edge upward; the transition owns that height too.
  const setPanelNode = useCallback((node: HTMLDivElement | null) => {
    panelRef.current = node;
    crewFlip.surfaceRef(node);
  }, [crewFlip]);

  // The composer is not always at the bottom of the window (an empty thread
  // centres it), so the panel's height comes from the room actually left
  // between the trigger and the viewport edge, never from a fixed share of the
  // window. Content past that height scrolls inside the panel as before.
  const fitPanelToViewport = useCallback(() => {
    const panel = panelRef.current;
    const anchor = rootRef.current;
    if (!panel || !anchor) return;
    const zoom = effectiveZoom(anchor);
    const rect = anchor.getBoundingClientRect();
    const gap = PANEL_GAP * zoom;
    const above = rect.top - gap - PANEL_VIEWPORT_MARGIN;
    const below = window.innerHeight - rect.bottom - gap - PANEL_VIEWPORT_MARGIN;
    const placeBelow = above < PANEL_MIN_COMFORTABLE_HEIGHT * zoom && below > above;
    const room = Math.max(0, placeBelow ? below : above) / zoom;
    panel.style.setProperty("--sa-panel-max-height", `${Math.floor(Math.min(PANEL_MAX_HEIGHT, room))}px`);
    panel.dataset.placement = placeBelow ? "below" : "above";
    // Horizontally the panel keeps its normal width and left alignment, and
    // only narrows to the viewport or slides left as far as needed to keep the
    // same margin from the right edge. Both values depend on the viewport and
    // trigger alone, never on the panel's previous offset.
    const edge = window.innerWidth - PANEL_VIEWPORT_MARGIN;
    const maxWidth = Math.max(0, Math.floor((edge - PANEL_VIEWPORT_MARGIN) / zoom));
    panel.style.setProperty("--sa-panel-max-width", `${maxWidth}px`);
    // offsetWidth is rounded and ignores the opening transform; one extra
    // pixel covers a fractional used width.
    const width = Math.min(panel.offsetWidth + 1, maxWidth);
    const offset = Math.max(
      Math.ceil((PANEL_VIEWPORT_MARGIN - rect.left) / zoom),
      Math.min(0, Math.floor((edge - rect.left) / zoom - width)),
    );
    panel.style.setProperty("--sa-panel-offset-x", `${offset}px`);
  }, []);

  // Measured before paint, so the panel never appears at an overflowing size
  // first. It then follows window resizes and scrolling of anything outside
  // it; scrolling its own content cannot move the trigger.
  //
  // The trigger also moves when the composer around it reflows (a queued
  // prompt appearing or leaving, an error banner) with no window event at all.
  // Any such move resizes one of the trigger's ancestors, so the chain up to
  // the body is observed and re-fitted in the same frame. The panel is
  // absolutely positioned, so its own height never resizes an ancestor and
  // cannot feed back into this observer.
  useLayoutEffect(() => {
    if (!open) return;
    fitPanelToViewport();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(() => fitPanelToViewport());
    for (let node: HTMLElement | null = rootRef.current; observer && node && node !== document.body; node = node.parentElement) {
      observer.observe(node);
    }
    let frame: number | null = null;
    const schedule = (event: Event) => {
      if (event.type === "scroll" && panelRef.current?.contains(event.target as Node)) return;
      if (frame !== null) return;
      frame = window.requestAnimationFrame(() => {
        frame = null;
        fitPanelToViewport();
      });
    };
    window.addEventListener("resize", schedule);
    window.addEventListener("scroll", schedule, true);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", schedule);
      window.removeEventListener("scroll", schedule, true);
      if (frame !== null) window.cancelAnimationFrame(frame);
    };
  }, [fitPanelToViewport, open]);

  const clearCloseTimer = useCallback(() => {
    if (closeTimerRef.current === null) return;
    window.clearTimeout(closeTimerRef.current);
    closeTimerRef.current = null;
  }, []);

  // Expansion is pure state with no exit timer: the roster's own FLIP pass
  // owns the movement, so the DOM is always in its settled layout and a second
  // click never has to wait for a previous one to "finish".
  const toggleExpandedTarget = useCallback((targetId: string) => {
    setExpandedId((current) => (current === targetId ? null : targetId));
  }, []);

  const show = useCallback(() => {
    clearCloseTimer();
    setPanelPresent(true);
    setOpen(true);
  }, [clearCloseTimer]);

  const finishClose = useCallback(() => {
    clearCloseTimer();
    setPanelPresent(false);
  }, [clearCloseTimer]);

  const close = useCallback(() => {
    setOpen(false);
    setExpandedId(null);
    setReplaceWorkerId(null);
    setWorkerActionError(null);
    setCompactInfoOpen(false);
    setWorkerDetailsOpen(null);
    clearCloseTimer();
    // CSS animationend normally removes the panel. This fallback also covers
    // reduced-motion environments and a window losing focus mid-animation.
    closeTimerRef.current = window.setTimeout(finishClose, PANEL_EXIT_MS);
  }, [clearCloseTimer, finishClose]);

  useEffect(() => () => clearCloseTimer(), [clearCloseTimer]);

  useEffect(() => {
    if (!selectedPresetId || props.presets?.some((preset) => preset.id === selectedPresetId)) return;
    setSelectedPresetId("");
  }, [props.presets, selectedPresetId]);

  // A popover opened for one conversation must not remain open after the user
  // switches to another and accidentally stage an edit against the new crew.
  const previousSessionIdRef = useRef(capturedPolicy?.sessionId);
  useEffect(() => {
    const nextSessionId = capturedPolicy?.sessionId;
    if (previousSessionIdRef.current === nextSessionId) return;
    previousSessionIdRef.current = nextSessionId;
    if (open) close();
  }, [capturedPolicy?.sessionId, close, open]);

  // The session id only exists once a roster is captured. The host's own
  // conversation key also covers switching between uncaptured threads.
  const previousContextKeyRef = useRef(props.contextKey);
  useEffect(() => {
    if (previousContextKeyRef.current === props.contextKey) return;
    previousContextKeyRef.current = props.contextKey;
    setWorkerDetailsOpen(null);
    if (open) close();
  }, [close, open, props.contextKey]);

  const openWorker = useCallback(async (worker: SubAgentWorker) => {
    if (!props.onOpenWorker || workerAction) return;
    setWorkerActionError(null);
    setWorkerAction({ workerId: worker.id, kind: "open" });
    try {
      await props.onOpenWorker(worker);
      // The child's conversation is now in front of the user; leaving the
      // command center open over it would cover what they asked to see.
      close();
    } catch (reason) {
      setWorkerActionError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setWorkerAction(null);
    }
  }, [close, props, workerAction]);

  const stopWorker = useCallback(async (worker: SubAgentWorker) => {
    if (!props.onStopWorker || workerAction) return;
    setWorkerActionError(null);
    setWorkerAction({ workerId: worker.id, kind: "stop" });
    try {
      await props.onStopWorker(worker);
      setReplaceWorkerId(null);
    } catch (reason) {
      setWorkerActionError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setWorkerAction(null);
    }
  }, [props, workerAction]);

  const replaceWorker = useCallback(async (worker: SubAgentWorker, targetId: string) => {
    if (!props.onReplaceWorker || workerAction) return;
    setWorkerActionError(null);
    setWorkerAction({ workerId: worker.id, kind: "replace" });
    try {
      await props.onReplaceWorker(worker, targetId);
      setReplaceWorkerId(null);
    } catch (reason) {
      setWorkerActionError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setWorkerAction(null);
    }
  }, [props, workerAction]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) close();
    };
    // Capture phase + stopPropagation: Escape closes this panel and never
    // reaches the app-level handler that stops the running turn.
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      // A nested Mythra Code select gets the first Escape so it can close without
      // dismissing the entire command center around it.
      if (panelRef.current?.querySelector("[data-app-select-open='true']")) return;
      event.stopPropagation();
      close();
      triggerRef.current?.focus();
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown, true);
    };
  }, [close, open]);

  // Move focus into the panel on open so keyboard users land inside it, and
  // keep Tab from escaping into the composer behind it.
  useEffect(() => {
    if (!open) return;
    const panel = panelRef.current;
    if (!panel) return;
    panel.querySelector<HTMLElement>("[data-autofocus]")?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Tab") return;
      const focusable = Array.from(panel.querySelectorAll<HTMLElement>(
        "button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex='-1'])",
      ));
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    panel.addEventListener("keydown", onKeyDown);
    return () => panel.removeEventListener("keydown", onKeyDown);
  }, [open]);

  const setTargets = useCallback((next: ChildAgentTarget[]) => {
    const childAgents = { ...policy.childAgents, enabled: next.length > 0, targets: next };
    onChange({
      ...policy,
      maxConcurrent: crewSafeConcurrency(policy.maxConcurrent, childAgents),
      childAgents,
    });
  }, [onChange, policy]);

  const updateTarget = useCallback((id: string, patch: Partial<ChildAgentTarget>) => {
    setTargets(policy.childAgents.targets.map((target) => (target.id === id ? { ...target, ...patch } : target)));
  }, [policy.childAgents.targets, setTargets]);

  /** A worker's own window; Provider default removes the key rather than storing it empty. */
  const setTargetCompaction = useCallback((id: string, value: string) => {
    setTargets(policy.childAgents.targets.map((target) => {
      if (target.id !== id) return target;
      const { autoCompactTokens: _previous, ...rest } = target;
      return value ? { ...rest, autoCompactTokens: Number(value) } : rest;
    }));
  }, [policy.childAgents.targets, setTargets]);

  const addTarget = useCallback((provider: Provider) => {
    const signInIssue = providerSignInIssue(provider, readiness);
    if (signInIssue) { onUnavailable?.(signInIssue); return; }
    const existing = policy.childAgents.targets;
    if (existing.length >= MAX_CHILD_AGENT_TARGETS) return;
    const target = newTargetFor(provider, existing);
    const nextTargets = [...existing, target];
    const currentEnabledCrew = Math.max(1, existing.filter((entry) => entry.enabled).length);
    const nextChildAgents = { enabled: true, targets: nextTargets };
    // Grow only when the limit was following the crew size. If the user had
    // deliberately chosen a smaller budget, adding another available
    // destination must preserve that choice.
    const requestedMax = policy.maxConcurrent === currentEnabledCrew
      ? currentEnabledCrew + 1
      : policy.maxConcurrent;
    onChange({
      ...policy,
      // Adding a worker is a clear statement of intent; turning the switches on
      // for the user avoids a destination that silently does nothing. The
      // parallel limit is left alone: adding a destination widens the menu, and
      // only a limit already tracking crew size grows with it.
      enabled: true,
      maxConcurrent: crewSafeConcurrency(requestedMax, nextChildAgents),
      childAgents: nextChildAgents,
    });
    setExpandedId(target.id);
  }, [onChange, policy, readiness, onUnavailable]);

  const applyPreset = useCallback(() => {
    const preset = props.presets?.find((entry) => entry.id === selectedPresetId);
    const next = sanitizeProjectSubagentSettings(preset?.policy);
    if (!next) return;
    setExpandedId(null);
    onChange(next);
  }, [onChange, props.presets, selectedPresetId]);

  const triggerLabel = native && delegationOn
    ? counts.active > 0
      ? `Native ${counts.active}/${nativeMax}`
      : nativeUnavailable ? "Native unavailable" : `Native: ${nativeMax}`
    : counts.active > 0
      ? `Sub-agents ${counts.active}/${maxConcurrent}`
      : delegationOn
        ? `Sub-agents: ${maxConcurrent}${rosterReady ? " ↗" : ""}`
        : "Sub-agents off";
  const nativeLimitEditable = native && !runLocked && Boolean(props.onNativeMaxConcurrentChange);
  const setNativeMax = (next: number) => props.onNativeMaxConcurrentChange?.(clampNativeLimit(next));

  return (
    <div className="subagent-control" ref={rootRef}>
      <button
        ref={triggerRef}
        type="button"
        className={`toolbar-button agents-button ${delegationOn ? "enabled" : ""} ${counts.active > 0 ? "live" : ""}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        title={isChild
          ? "This conversation is a sub-agent, so it cannot start sub-agents of its own."
          : captured && crewActive
            ? "This thread's sub-agents are locked while its parent or a sub-agent is working."
            : runLocked
              ? "Sub-agent mode and limits are locked while this thread or a sub-agent is working."
            : captured
              ? "Edit this thread's sub-agents for its next message."
            : "Manage sub-agents for this thread"}
        onClick={() => (open ? close() : show())}
      >
        {/* No viewBox on purpose: the rect is measured in real pixels, so the
            glowing corners stay the button's own radius however wide the label
            makes it. The provider-logo traces inside the panel are separate. */}
        {counts.active > 0 && (
          <svg className="sa-trigger-trace" aria-hidden="true" focusable="false">
            <rect className="sa-trigger-trace-halo" width="100%" height="100%" rx="9" />
            <rect className="sa-trigger-trace-outline" width="100%" height="100%" rx="9" />
          </svg>
        )}
        <span className="sa-trigger-content">
          {native && delegationOn && nativeProvider
            ? <span className="sa-trigger-provider" aria-hidden="true"><ProviderLogo provider={nativeProvider} size={13} /></span>
            : <UsersRound size={14} aria-hidden="true" />}
          {native && delegationOn && <span className="sr-only">Sub-agents: </span>}
          {triggerLabel}
          {(!editable || runLocked) && <Lock size={11} className="sa-trigger-lock" aria-hidden="true" />}
          {props.projectOverride && <em className="project-override-mark">project</em>}
        </span>
      </button>

      {/* Announced while the panel is closed; the open panel has its own
          status region and two would read the same line twice. */}
      {counts.total > 0 && !open && (
        <span className="sr-only" role="status">{describeSubAgentActivity(counts)}</span>
      )}

      {panelPresent && (
        <div
          id={panelId}
          ref={setPanelNode}
          className={`subagent-panel ${open ? "" : "closing"}`}
          role="dialog"
          aria-hidden={!open || undefined}
          aria-label="Sub-agent command center"
          onAnimationEnd={(event) => {
            if (event.target === event.currentTarget && !open) finishClose();
          }}
        >
          <header className="sa-header">
            <span className="sa-header-mark" aria-hidden="true"><UsersRound size={14} /></span>
            <span className="sa-header-copy">
              <strong>Sub-agents</strong>
              <small>
                {isChild
                  ? "Sub-agent conversation"
                  : captured && crewActive
                    ? "Sub-agents locked while work is active"
                    : captured
                      ? "Editing this thread"
                    : `Editing ${props.scopeLabel}`}
              </small>
            </span>
            <button type="button" className="sa-close" onClick={close} aria-label="Close sub-agent command center" data-autofocus>
              <X size={13} />
            </button>
          </header>

          {captured && crewActive && (
            <p className="sa-locked-note" id={lockNoteId}>
              <Lock size={12} aria-hidden="true" />
              <span>
                Finish or stop the parent and every sub-agent before changing this setup.
                {native ? "" : " The current run keeps the sub-agents it started with."}
              </span>
            </p>
          )}

          {mode === "open" && runLocked && (
            <p className="sa-locked-note" id={lockNoteId}>
              <Lock size={12} aria-hidden="true" />
              <span>Mode, on/off and limits unlock once the parent and every sub-agent are idle.</span>
            </p>
          )}

          {captured && !crewActive && (
            <p className="sa-locked-note">
              <ArrowRightLeft size={12} aria-hidden="true" />
              <span>Sub-agent and limit changes stay in this thread and take effect together on its next message.</span>
            </p>
          )}

          {isChild && (
            <p className="sa-locked-note">
              <Lock size={12} aria-hidden="true" />
              <span>
                This conversation is itself a sub-agent. A sub-agent never starts sub-agents of its own,
                so delegation stays off here however it is configured elsewhere.
              </span>
            </p>
          )}

          <div className="sa-policy">
            {showEngineSelector && (
              <fieldset
                className="sa-engine"
                disabled={runLocked}
                aria-describedby={runLocked ? lockNoteId : undefined}
              >
                <legend className="sr-only">Sub-agent system</legend>
                <label className={`sa-engine-option ${engine === "mythra" ? "selected" : ""}`}>
                  <input
                    type="radio"
                    name={engineGroupName}
                    value="mythra"
                    checked={engine === "mythra"}
                    onChange={() => props.onEngineChange?.("mythra")}
                  />
                  <span className="sa-engine-mark" aria-hidden="true"><UsersRound size={13} /></span>
                  <span className="sa-engine-copy">
                    <strong>Mythra Code</strong>
                    <small>Your crew, any provider</small>
                  </span>
                </label>
                <label
                  className={`sa-engine-option ${native ? "selected" : ""} ${nativeSelectionBlocked ? "unavailable" : ""}`}
                  title={nativeSelectionBlocked ?? undefined}
                >
                  <input
                    type="radio"
                    name={engineGroupName}
                    value="native"
                    checked={engine === "native"}
                    disabled={Boolean(nativeSelectionBlocked)}
                    aria-describedby={nativeSelectionBlocked ? nativeReasonId : undefined}
                    onChange={() => { if (!nativeSelectionBlocked) props.onEngineChange?.("native"); }}
                  />
                  <span className="sa-engine-mark" aria-hidden="true">
                    {nativeProvider ? <ProviderLogo provider={nativeProvider} size={13} /> : <UsersRound size={13} />}
                  </span>
                  <span className="sa-engine-copy">
                    <strong>{nativeName ? `Native ${nativeName}` : "Provider native"}</strong>
                    <small>{nativeName ? `${nativeName} picks its agents` : "Codex or Claude Code"}</small>
                  </span>
                </label>
              </fieldset>
            )}

            {(nativeUnavailable || nativeSelectionBlocked) && (showEngineSelector || native) && (
              <p className="sa-engine-reason">
                <AlertTriangle size={11} aria-hidden="true" />
                {nativeSelectionBlocked && <span id={nativeReasonId}>{nativeSelectionBlocked}</span>}
                {nativeUnavailable && nativeUnavailable !== nativeSelectionBlocked && <span>{nativeUnavailable}</span>}
                {native && props.onOpenAccounts && (
                  <button type="button" onClick={() => { close(); props.onOpenAccounts?.(); }}>Models &amp; accounts</button>
                )}
              </p>
            )}

            <div className={`sa-row ${delegationOn ? "on" : ""}`}>
              <span className="sa-row-copy">
                <strong>Sub-agents</strong>
                <small>
                  {!delegationOn
                    ? "Sub-agents are off for this task."
                    : native
                      ? `${nativeName ?? "The provider"} may split work across its own parallel agents.`
                      : "The model may split work across parallel sub-agents."}
                </small>
              </span>
              {isChild ? (
                <span className="sa-readout">Off</span>
              ) : (
                <button
                  type="button"
                  role="switch"
                  aria-checked={policy.enabled}
                  aria-label="Allow sub-agent spawning"
                  aria-describedby={runLocked ? lockNoteId : undefined}
                  disabled={runLocked}
                  className={`toggle-switch ${policy.enabled ? "on" : ""}`}
                  onClick={() => onChange({ ...policy, enabled: !policy.enabled, childAgents: { ...policy.childAgents, enabled: targets.length > 0 } })}
                >
                  <span />
                </button>
              )}
            </div>

            {parentCompactShown && (
              // This conversation's own window: independent of the switch above
              // and of which system delegates, so only running work locks it.
              <fieldset
                className="sa-compaction"
                disabled={runLocked}
                aria-describedby={runLocked ? lockNoteId : undefined}
              >
                <legend className="sr-only">This conversation's compaction</legend>
                <div className="sa-native-field">
                  <span className="sa-row-copy">
                    <strong>Conversation compaction</strong>
                    <small>
                      {parentCompactUnsupportedBy
                        ? `${parentCompactUnsupportedBy} doesn't expose a compaction setting, so it uses its own.`
                        : "This conversation's own context window, from the next turn."}
                    </small>
                  </span>
                  <AppSelectMenu
                    portal
                    ariaLabel="Conversation compaction"
                    value={compactionValue(props.autoCompactTokens)}
                    options={parentCompactChoices}
                    onChange={setParentCompact}
                  />
                </div>
                {parentCompactIssue && (
                  <p className="sa-native-warn sa-compaction-issue">
                    <AlertTriangle size={11} aria-hidden="true" />
                    <span>{parentCompactIssue}</span>
                  </p>
                )}
                <p className="sa-native-note sa-compaction-note">
                  Automatic compaction, not a hard token or spending cap. Model limits still apply.
                </p>
                {!parentCompactUnsupportedBy && <p className="sa-native-note">{describeCompactionPriceBoundary(parentPricing)}</p>}
              </fieldset>
            )}

            {native ? (
              <div className={`sa-native ${dimmed ? "muted" : ""}`}>
                <p className="sa-native-intro">
                  {nativeProvider && (
                    <span className={`sa-native-mark ${nativeProvider}`} aria-hidden="true">
                      <ProviderLogo provider={nativeProvider} size={14} />
                    </span>
                  )}
                  <span>
                    {nativeName && nativeOptionsShown
                      ? `${nativeName} decides when to start agents and which roles they take; the options below set this thread's defaults. They stay on ${nativeName}; your Mythra Code crew is kept for when you switch back.`
                      : nativeName
                        ? `${nativeName} decides when to start agents and which of its models they use. They stay on ${nativeName}; your Mythra Code crew is kept for when you switch back.`
                        : "The thread's provider decides when to start agents and which models they use. Your Mythra Code crew is kept for when you switch back."}
                  </span>
                </p>

                <div className="sa-row">
                  <span className="sa-row-copy">
                    <strong>Max running at once</strong>
                    <small>
                      {runLocked
                        ? "Locked until the parent and every sub-agent are idle."
                        : `How many agents ${nativeName ?? "the provider"} may ${nativeProvider === "claude" ? "admit" : "run"} at once (1–${MAX_SUBAGENT_CONCURRENCY}). It caps parallel agents, not total usage.`}
                    </small>
                  </span>
                  {nativeLimitEditable ? (
                    <div className="number-stepper" aria-label="Maximum concurrent native agents">
                      <button
                        type="button"
                        aria-label="Fewer concurrent native agents"
                        title="Fewer concurrent native agents"
                        disabled={!policy.enabled || nativeMax <= 1}
                        onClick={() => setNativeMax(nativeMax - 1)}
                      ><Minus size={12} /></button>
                      <strong key={nativeMax} className="sa-flash">{nativeMax}</strong>
                      <button
                        type="button"
                        aria-label="More concurrent native agents"
                        title="More concurrent native agents"
                        disabled={!policy.enabled || nativeMax >= MAX_SUBAGENT_CONCURRENCY}
                        onClick={() => setNativeMax(nativeMax + 1)}
                      ><Plus size={12} /></button>
                    </div>
                  ) : (
                    <span className="sa-readout" aria-label={`Native agent limit ${nativeMax}`}>{nativeMax}</span>
                  )}
                </div>

                {nativeOptionsShown && nativeProvider && (
                  <>
                    <fieldset
                      className="sa-native-options"
                      disabled={!nativeOptionsEditable}
                      aria-describedby={runLocked ? lockNoteId : undefined}
                    >
                      <legend className="sr-only">{`${nativeName} options for this thread`}</legend>
                      <div className="sa-native-field">
                        <span className="sa-row-copy">
                          <strong>{nativeProvider === "openai" ? "Default child model" : "Child model"}</strong>
                          <small>
                            {nativeProvider === "openai"
                              ? "Used when the parent starts an agent without naming a model; a model it names wins."
                              : "For ordinary agents, including the built-in Explore, Plan and general-purpose agents. Claude Code's own policy still applies, and the parent keeps its model."}
                          </small>
                        </span>
                        <AppSelectMenu
                          portal
                          ariaLabel={nativeProvider === "openai" ? "Default child model" : "Child model"}
                          value={savedNativeModel}
                          options={nativeModelChoices}
                          searchable={nativeModelChoices.length > 8}
                          emptyMessage="No models are available for this provider."
                          onDisabledSelect={(model) => { if (isHaiku55(model)) onUnavailable?.(HAIKU_5_5_UPDATE); }}
                          onChange={setNativeModel}
                        />
                      </div>

                      {nativeProvider === "openai" && (
                        <div className="sa-native-field">
                          <span className="sa-row-copy">
                            <strong>Default child reasoning</strong>
                            <small>
                              {savedNativeModel
                                ? `Used when the parent names no level; a level it names wins. Provider default uses ${codexModelLabel}'s own default.`
                                : "Used when the parent names no level; a level it names wins. Provider default inherits the parent's level unless your Codex config sets one."}
                            </small>
                          </span>
                          <AppSelectMenu
                            portal
                            ariaLabel="Default child reasoning"
                            value={savedCodexEffort}
                            options={reasoningChoices}
                            onDisabledSelect={() => onUnavailable?.(codexSupportedEfforts
                              ? `${codexModelLabel} does not offer that reasoning level.`
                              : `${codexModelLabel || "This model"} has not reported its reasoning levels, so only the provider default is offered.`)}
                            onChange={(effort) => setNativeOptions({ reasoningEffort: effort as ReasoningEffort | "" })}
                          />
                        </div>
                      )}

                      {nativeProvider === "claude" ? (
                        <div className="sa-native-field">
                          <span className="sa-row-copy">
                            <strong>Child model compaction</strong>
                            <small>
                              Applies to the child model chosen above. A parent on the same model shares one window,
                              so a different window needs a different model.
                            </small>
                          </span>
                          <AppSelectMenu
                            portal
                            ariaLabel="Child model compaction"
                            value={compactionValue(savedChildCompact)}
                            options={childCompactChoices}
                            onChange={(tokens) => setNativeOptions({ autoCompactTokens: tokens ? Number(tokens) : undefined })}
                          />
                        </div>
                      ) : (
                        <div className="sa-native-field">
                          <span className="sa-row-copy">
                            <strong>Child compaction</strong>
                            <small>Codex currently shares the parent compaction setting with native workers. Use Mythra Code for independent worker windows.</small>
                          </span>
                          <span className="sa-readout sa-compaction-readout">
                            {`Parent: ${compactionLabel(props.autoCompactTokens)}`}
                          </span>
                        </div>
                      )}
                    </fieldset>

                    {nativeProvider === "openai" && savedCodexChildCompact !== undefined && (
                      <p className="sa-native-warn">
                        <AlertTriangle size={11} aria-hidden="true" />
                        <span>{`A saved child window (${compactionLabel(savedCodexChildCompact)}) is not used by Codex.`}</span>
                        <button
                          type="button"
                          className="sa-native-reset"
                          disabled={runLocked}
                          onClick={clearCodexChildCompact}
                        >Reset</button>
                      </p>
                    )}

                    {nativeProvider === "openai" && childPricing && <p className="sa-native-note">{describeCompactionPriceBoundary(childPricing)} Native Codex workers still inherit the parent's compaction setting.</p>}

                    {nativeProvider === "claude" && childCompactIssue && (
                      <p className="sa-native-warn">
                        <AlertTriangle size={11} aria-hidden="true" />
                        <span>{childCompactIssue}</span>
                      </p>
                    )}

                    {/* The host's unavailable reason above may already be this conflict. */}
                    {nativeProvider === "claude" && childCompactConflict && childCompactConflict !== nativeUnavailable && (
                      <p className="sa-native-warn">
                        <AlertTriangle size={11} aria-hidden="true" />
                        <span>{childCompactConflict}</span>
                      </p>
                    )}

                    {nativeProvider === "claude" && childSharesParentWindow && (
                      <p className="sa-native-note">
                        {`The parent also runs ${modelLabelFor(savedNativeModel)} with the same window, so they share it.`}
                      </p>
                    )}

                    {/* The host's unavailable reason, shown above, already names
                        the first problem; these only add one it has not reached. */}
                    {!nativeUnavailable && nativeProvider === "claude" && isHaiku55(savedNativeModel) && !haikuSupported && (
                      <p className="sa-native-warn">
                        <AlertTriangle size={11} aria-hidden="true" />
                        <span>{HAIKU_5_5_UPDATE}</span>
                      </p>
                    )}

                    {!nativeUnavailable && unsupportedCodexEffort && (
                      <p className="sa-native-warn">
                        <AlertTriangle size={11} aria-hidden="true" />
                        <span>{`${codexModelLabel} does not offer this reasoning level. Choose another level or the provider default.`}</span>
                      </p>
                    )}

                    {unconfirmedCodexEffort && (
                      <p className="sa-native-note">
                        {`${codexModelLabel || "The model that will run"} has not reported its reasoning levels, so this saved level is unconfirmed. Provider default avoids the guess.`}
                      </p>
                    )}

                    {nativeProvider === "claude" && (
                      <>
                        <p className="sa-native-note sa-native-compact">
                          <span>Claude agents keep the parent's effort or their role's own; there is no separate child effort.</span>
                          <button
                            type="button"
                            className="sa-native-info"
                            aria-expanded={compactInfoOpen}
                            aria-controls={compactInfoId}
                            aria-label="About child compaction and usage"
                            title="About child compaction and usage"
                            onClick={() => setCompactInfoOpen((current) => !current)}
                          ><Info size={11} aria-hidden="true" /></button>
                        </p>
                        <p className="sa-native-note sa-native-detail" id={compactInfoId} hidden={!compactInfoOpen}>
                          A child window applies only while native mode is on. Context size is estimated, so compaction can
                          run late, overshoot or fail; 1M requests a window and does not enlarge the model's context.
                          {` ${describeCompactionPriceBoundary(childPricing)}`}
                        </p>
                      </>
                    )}
                  </>
                )}

                {nativeProvider === "claude" && (
                  <p className="sa-native-note">
                    Agents run inside the current turn. Stopping the parent stops them too.
                  </p>
                )}
              </div>
            ) : (
            <>
            <div className={`sa-row ${dimmed ? "muted" : ""}`}>
              <span className="sa-row-copy">
                <strong>Max running at once</strong>
                <small>
                  {editable && !runLocked
                    ? crewSize > 0
                      ? `How many sub-agents may run at once (1–${MAX_SUBAGENT_CONCURRENCY}), chosen from ${crewSize} configured sub-agent${crewSize === 1 ? "" : "s"}. Adding or removing sub-agents adjusts this limit.`
                      : `How many sub-agents may run at once (1–${MAX_SUBAGENT_CONCURRENCY}).`
                    : isChild
                      ? "A sub-agent works alone."
                      : "Locked until the parent and every sub-agent are idle."}
                </small>
              </span>
              {!editable || runLocked ? (
                <span className="sa-readout">{maxConcurrent}</span>
              ) : (
                <div className="number-stepper" aria-label="Maximum concurrent sub-agents">
                  <button
                    type="button"
                    aria-label="Fewer concurrent sub-agents"
                    title="Fewer concurrent sub-agents"
                    disabled={!policy.enabled || policy.maxConcurrent <= 1}
                    onClick={() => onChange({ ...policy, maxConcurrent: Math.max(1, policy.maxConcurrent - 1) })}
                  ><Minus size={12} /></button>
                  <strong key={policy.maxConcurrent} className="sa-flash">{policy.maxConcurrent}</strong>
                  <button
                    type="button"
                    aria-label="More concurrent sub-agents"
                    disabled={!policy.enabled || policy.maxConcurrent >= crewCeiling}
                    onClick={() => onChange({ ...policy, maxConcurrent: Math.min(crewCeiling, policy.maxConcurrent + 1) })}
                  ><Plus size={12} /></button>
                </div>
              )}
            </div>

            {editable && (
              <div className="sa-preset-row">
                <span>
                  <strong>Sub-agent preset</strong>
                  <small>{props.presets?.length ? "Replace these sub-agents with a saved preset." : "Create reusable presets in Sub-agent settings."}</small>
                </span>
                {props.presets?.length ? (
                  <div className="sa-preset-actions">
                    <AppSelectMenu
                      ariaLabel="Sub-agent preset"
                      value={selectedPresetId}
                      placeholder="Choose preset"
                      options={props.presets.map((preset) => ({
                        value: preset.id,
                        label: preset.name,
                        detail: `${preset.policy.childAgents.targets.length} configured · ${preset.policy.maxConcurrent} at a time`,
                        icon: <UsersRound size={11} />,
                      }))}
                      onChange={setSelectedPresetId}
                    />
                    <button type="button" className="sa-apply-preset" disabled={!selectedPresetId} onClick={applyPreset}>Apply</button>
                  </div>
                ) : (
                  <button type="button" className="sa-manage-presets" onClick={() => { close(); props.onOpenSettings(); }}>Create preset</button>
                )}
              </div>
            )}

            {editable && props.onSavePreset && (
              <div className="sa-preset-row">
                <input aria-label="New sub-agent preset name" placeholder="Preset name" maxLength={60} value={presetName} onChange={(event) => setPresetName(event.target.value)} />
                <button type="button" className="sa-manage-presets" disabled={!presetName.trim() || (props.presets?.length ?? 0) >= MAX_CHILD_AGENT_PRESETS} onClick={() => {
                  props.onSavePreset?.(presetName.trim(), policy);
                  setPresetName("");
                }}>Save as preset</button>
              </div>
            )}

            <div className={`sa-crew ${dimmed ? "muted" : ""}`}>
              {editable && targets.length > 0 && (
                <div className="sa-crew-toolbar">
                  <span>{targets.length} configured · {enabledCount === 0 ? "None switched on" : `${readyCount} ready`}</span>
                  <button
                    type="button"
                    className="sa-clear-all"
                    onClick={() => {
                      setExpandedId(null);
                      setTargets([]);
                    }}
                  ><Trash2 size={11} /> Clear all</button>
                </div>
              )}
              <div className="sa-crew-grid" ref={crewFlip.gridRef} role="list" aria-label="Configured sub-agents">
                {targets.map((target) => {
                  const issue = childAgentTargetIssue(target, readiness);
                  const signInIssue = providerSignInIssue(target.provider, readiness);
                  const expanded = expandedId === target.id && !signInIssue;
                  const busy = workers.some((worker) => worker.targetId === target.id && isSubAgentWorkerActive(worker.status));
                  const selectedModel = childAgentModel(target);
                  const modelOptions = modelOptionsFor(target.provider, props.modelCatalogs, selectedModel);
                  return (
                    <div
                      role="listitem"
                      key={targetKey(target)}
                      data-flip-key={targetKey(target)}
                      className={`sa-tile ${target.provider} ${target.enabled ? "" : "off"} ${signInIssue ? "unavailable" : issue && target.enabled ? "issue" : ""} ${busy ? "busy" : ""} ${expanded ? "expanded" : ""}`}
                    >
                      <div className="sa-tile-head">
                        <button
                          type="button"
                          className="sa-tile-face"
                          aria-expanded={editable ? expanded : undefined}
                          aria-label={editable ? `Configure ${target.label || target.id}` : undefined}
                          disabled={!editable}
                          aria-disabled={Boolean(signInIssue) || undefined}
                          onClick={() => {
                            if (signInIssue) { onUnavailable?.(signInIssue); return; }
                            toggleExpandedTarget(target.id);
                          }}
                        >
                          <span className="sa-avatar" aria-hidden="true">
                            <ProviderLogo provider={target.provider} size={15} />
                            <svg className="sa-avatar-trace" viewBox="0 0 34 34" focusable="false">
                              <rect className="sa-avatar-trace-rail" x="1.5" y="1.5" width="31" height="31" rx="8" pathLength="100" />
                              <rect className="sa-avatar-trace-runner" x="1.5" y="1.5" width="31" height="31" rx="8" pathLength="100" />
                            </svg>
                          </span>
                          <span className="sa-tile-copy">
                            <strong>{target.label || target.id}</strong>
                            <small>{childAgentModel(target) || "provider default"}</small>
                          </span>
                        </button>
                        {editable && (
                          <button
                            type="button"
                            role="switch"
                            aria-checked={target.enabled}
                            aria-label={`Enable ${target.label || target.id}`}
                            className={`sa-tile-switch ${target.enabled ? "on" : ""}`}
                            aria-disabled={Boolean(signInIssue) || undefined}
                            onClick={() => {
                              if (signInIssue) { onUnavailable?.(signInIssue); return; }
                              updateTarget(target.id, { enabled: !target.enabled });
                            }}
                          ><span /></button>
                        )}
                        {editable && signInIssue && (
                          <button type="button" className="icon-button tiny subtle sa-unavailable-remove" aria-label={`Remove ${target.id}`} onClick={() => { setExpandedId(null); setTargets(targets.filter((entry) => entry.id !== target.id)); }}><X size={11} /></button>
                        )}
                      </div>
                      {!editable && <span className="sa-tile-note">{describeChildAgentReasoning(target)}</span>}
                      {issue && !signInIssue && target.enabled && (
                        <p className="sa-tile-issue">
                          <AlertTriangle size={11} aria-hidden="true" /> {issue.replaceAll("`", "")}{" "}
                          {/* A compaction problem is fixed in this tile's own settings, not in accounts. */}
                          {childAgentAutoCompactIssue(target)
                            ? editable && <button type="button" onClick={() => setExpandedId(target.id)}>Compaction</button>
                            : <button type="button" onClick={() => { close(); (props.onOpenAccounts ?? props.onOpenSettings)(); }}>Models &amp; accounts</button>}
                        </p>
                      )}
                      {editable && !signInIssue && (
                        <div className={`sa-tile-config-shell ${expanded ? "open" : ""}`} aria-hidden={!expanded || undefined} inert={!expanded ? true : undefined}>
                          <div className="sa-tile-config">
                          <div className="sa-config-field">
                            <span>Provider</span>
                            <AppSelectMenu
                              portal
                              ariaLabel={`Provider for ${target.id}`}
                              value={target.provider}
                              options={CHILD_AGENT_PROVIDERS.map((provider) => ({
                                value: provider,
                                disabled: Boolean(providerSignInIssue(provider, readiness)),
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
                              onDisabledSelect={(value) => {
                                const issue = providerSignInIssue(value as Provider, readiness);
                                if (issue) onUnavailable?.(issue);
                              }}
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
                          <div className="sa-config-field">
                            <span>Model</span>
                            <AppSelectMenu
                              portal
                              ariaLabel={`Model for ${target.id}`}
                              value={selectedModel}
                              options={modelOptions}
                              favorites={favoriteModels(props.modelFavorites ?? {}, target.provider)}
                              {...(props.onToggleModelFavorite
                                ? { onToggleFavorite: (model: string) => props.onToggleModelFavorite?.(target.provider, model) }
                                : {})}
                              placeholder={target.provider === "openrouter" ? "Choose an OpenRouter model" : target.provider === "lmstudio" ? "Choose an LM Studio model" : "Choose a model"}
                              searchable={modelOptions.length > 8}
                              emptyMessage={target.provider === "openrouter"
                                ? "No OpenRouter models are available. Check the API key and refresh in Settings."
                                : target.provider === "lmstudio"
                                  ? "No LM Studio models are available. Start the server and refresh in Settings."
                                : "No models are available for this provider."}
                              onChange={(model) => updateTarget(target.id, { model })}
                            />
                          </div>
                          <div className="sa-config-field">
                            <span>Reasoning</span>
                            <AppSelectMenu
                              ariaLabel={`Reasoning control for ${target.id}`}
                              value={target.reasoningMode}
                              options={REASONING_MODE_OPTIONS}
                              onChange={(reasoningMode) => updateTarget(target.id, { reasoningMode: reasoningMode as ChildAgentTarget["reasoningMode"] })}
                            />
                          </div>
                          {target.reasoningMode === "fixed" && (
                            <div className="sa-config-field">
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
                            <div className="sa-config-field">
                              <span>Ceiling</span>
                              <AppSelectMenu
                                ariaLabel={`Maximum reasoning for ${target.id}`}
                                value={target.reasoningMaxEffort}
                                options={REASONING_OPTIONS}
                                onChange={(reasoningMaxEffort) => updateTarget(target.id, { reasoningMaxEffort: reasoningMaxEffort as ChildAgentTarget["reasoningMaxEffort"] })}
                              />
                            </div>
                          )}
                          <div className="sa-config-field">
                            <span>Compaction</span>
                            <AppSelectMenu
                              portal
                              ariaLabel={`Compaction for ${target.id}`}
                              value={compactionValue(target.autoCompactTokens)}
                              options={compactionChoices(
                                target.autoCompactTokens,
                                pricingFor(target.provider, childAgentModel(target)),
                                compactionUnsupportedBy(target.provider) && `Not available for ${compactionUnsupportedBy(target.provider)}`,
                              )}
                              onChange={(value) => setTargetCompaction(target.id, value)}
                            />
                          </div>
                          <p className="sa-tile-reasoning">{describeChildAgentReasoning(target)}</p>
                          <p className="sa-tile-reasoning">
                            {compactionIssue(target.autoCompactTokens, compactionUnsupportedBy(target.provider))
                              ?? (target.autoCompactTokens === undefined
                                ? "Compaction: provider default. It does not inherit this conversation's window."
                                : `Compaction: its own ${describeTokenWindow(target.autoCompactTokens)} window.`)}
                          </p>
                          {!compactionUnsupportedBy(target.provider) && <p className="sa-tile-reasoning">{describeCompactionPriceBoundary(pricingFor(target.provider, childAgentModel(target)))}</p>}
                          <button
                            type="button"
                            className="sa-tile-remove"
                            aria-label={`Remove ${target.id}`}
                            onClick={() => {
                              setExpandedId(null);
                              setTargets(policy.childAgents.targets.filter((entry) => entry.id !== target.id));
                            }}
                          ><Trash2 size={12} /> Remove</button>
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}

                {editable && targets.length < MAX_CHILD_AGENT_TARGETS && (
                  <div role="listitem" data-flip-key={ADD_TILE_FLIP_KEY} className="sa-add">
                    <span>Add a sub-agent</span>
                    <div className="sa-add-row">
                      {CHILD_AGENT_PROVIDERS.map((provider) => (
                        <button
                          type="button"
                          key={provider}
                          aria-label={`Add ${providerDisplayName(provider)} sub-agent`}
                          title={`Add ${providerDisplayName(provider)}`}
                          className={providerSignInIssue(provider, readiness) ? "unavailable" : undefined}
                          aria-disabled={Boolean(providerSignInIssue(provider, readiness)) || undefined}
                          onClick={() => addTarget(provider)}
                        >
                          <ProviderLogo provider={provider} size={13} />
                          <Plus size={10} aria-hidden="true" />
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>

              {targets.length === 0 && (
                <p className="sa-empty">
                  {isChild
                    ? "A sub-agent cannot start sub-agents of its own."
                    : captured
                      ? "No sub-agents are configured for this task."
                      : "No sub-agents yet. Add one to let the model delegate across providers."}
                </p>
              )}
            </div>
            </>
            )}
          </div>

          <div className="sa-activity">
            <div className="sa-activity-head">
              <strong>Live sub-agents</strong>
              <span className="sa-counts" role="status">
                <span key={describeSubAgentActivity(counts)} className="sa-flash">{describeSubAgentActivity(counts)}</span>
              </span>
            </div>
            {statusUnknown && <p className="sa-worker-error" role="status">Open the sub-agent conversation to check its status before changing this task’s setup.</p>}
            {workers.length > 0 ? (
              <ul className="sa-worker-list">
                {workers.map((worker, index) => {
                  const active = isSubAgentWorkerActive(worker.status);
                  const replacing = replaceWorkerId === worker.id;
                  const acting = workerAction?.workerId === worker.id;
                  // Native rows say what each agent was asked to do and which
                  // model its provider actually reported, never the parent's.
                  const nativeModel = worker.kind === "native" ? nativeWorkerModel(worker) : null;
                  const assignment = worker.task?.trim() || worker.title;
                  const headline = assignment.split("\n").find((line) => line.trim())?.trim() ?? worker.title;
                  const identity = nativeModel
                    ? `${worker.provider ? providerDisplayName(worker.provider) : nativeName ?? "Same provider as this thread"} · ${nativeModel.text}`
                    : worker.detail;
                  const progress = worker.progress?.trim();
                  const result = worker.result?.trim();
                  const hasDetails = Boolean(worker.task?.trim() || progress || result);
                  const detailsOpen = hasDetails && workerDetailsOpen === workerDetailsKey(worker);
                  const detailsId = `${workerDetailsIdBase}-${index}`;
                  const modelDetail = nativeModel && (nativeModel.confirmed || nativeModel.requested)
                    ? [
                      nativeModel.confirmed ? `${nativeModel.confirmed} · reported by the run` : "",
                      nativeModel.requested && nativeModel.requested !== nativeModel.confirmed ? `${nativeModel.requested} · requested` : "",
                    ].filter(Boolean).join("\n")
                    : "";
                  // Replacement restarts a task on a Mythra Code destination, so
                  // only Mythra-owned children can be replaced. Native workers
                  // say for themselves whether they can be opened or stopped
                  // alone; a Claude Code agent only stops with its parent turn.
                  const replacementTargets = worker.kind === "cross-provider"
                    ? targets.filter((target) => target.enabled && !childAgentTargetIssue(target, readiness))
                    : NO_TARGETS;
                  const canOpen = worker.canOpen !== false;
                  const canStop = worker.canStop !== false;
                  return (
                    <li key={worker.id} className={`sa-worker ${worker.status} ${replacing ? "replacing" : ""}`}>
                      <span className="sa-worker-orb" aria-hidden="true" />
                      <span className="sa-worker-copy">
                        <strong title={headline.length > 240 ? `${headline.slice(0, 240)}…` : headline}>{headline}</strong>
                        <small title={identity}>{subAgentStatusLabel(worker.status)} · {identity}</small>
                      </span>
                      <span className="sa-worker-end">
                        {worker.provider && (
                          <span className="sa-worker-mark" aria-hidden="true"><ProviderLogo provider={worker.provider} size={12} /></span>
                        )}
                        {hasDetails && (
                          <button
                            type="button"
                            className="sa-worker-action"
                            aria-expanded={detailsOpen}
                            aria-controls={detailsOpen ? detailsId : undefined}
                            aria-label={`Details for ${headline.length > 80 ? `${headline.slice(0, 80)}…` : headline}`}
                            onClick={() => setWorkerDetailsOpen(detailsOpen ? null : workerDetailsKey(worker))}
                          >
                            Details
                          </button>
                        )}
                        {props.onOpenWorker && canOpen && (
                          <button
                            type="button"
                            className="sa-worker-action"
                            aria-label={`Open ${worker.title}`}
                            title="Open this sub-agent's own conversation"
                            disabled={Boolean(workerAction)}
                            onClick={() => void openWorker(worker)}
                          >
                            {acting && workerAction?.kind === "open"
                              ? <LoaderCircle className="spin" size={10} />
                              : <SquareArrowOutUpRight size={10} />}
                            Open
                          </button>
                        )}
                        {active && props.onReplaceWorker && replacementTargets.length > 0 && (
                          <button
                            type="button"
                            className="sa-worker-action"
                            aria-expanded={replacing}
                            aria-label={`Replace ${worker.title}`}
                            disabled={Boolean(workerAction)}
                            onClick={() => {
                              setWorkerActionError(null);
                              setReplaceWorkerId(replacing ? null : worker.id);
                            }}
                          >
                            <ArrowRightLeft size={10} /> Replace
                          </button>
                        )}
                        {active && props.onStopWorker && canStop && (
                          <button
                            type="button"
                            className="sa-worker-action stop"
                            aria-label={`Stop ${worker.title}`}
                            disabled={Boolean(workerAction)}
                            onClick={() => void stopWorker(worker)}
                          >
                            {acting && workerAction?.kind === "stop" ? <LoaderCircle className="spin" size={10} /> : <Square size={9} />}
                            Stop
                          </button>
                        )}
                      </span>

                      {replacing && (
                        <div className="sa-replace-picker" role="group" aria-label={`Replacement sub-agent for ${worker.title}`}>
                          <span>
                            <strong>Replace with</strong>
                            <small>The root agent will restart the same task.</small>
                          </span>
                          <div>
                            {replacementTargets.map((target) => (
                              <button
                                type="button"
                                key={target.id}
                                disabled={Boolean(workerAction)}
                                aria-label={`Replace ${worker.title} with ${target.label || target.id}`}
                                onClick={() => void replaceWorker(worker, target.id)}
                              >
                                {acting && workerAction?.kind === "replace"
                                  ? <LoaderCircle className="spin" size={11} />
                                  : <ProviderLogo provider={target.provider} size={11} />}
                                <span><strong>{target.label || target.id}</strong><small>{childAgentModel(target) || "provider default"}{target.id === worker.targetId ? " · restart" : ""}</small></span>
                              </button>
                            ))}
                            <button type="button" className="cancel" disabled={Boolean(workerAction)} onClick={() => setReplaceWorkerId(null)} aria-label="Cancel replacement">
                              <X size={11} />
                            </button>
                          </div>
                        </div>
                      )}

                      {detailsOpen && (
                        <div className="sa-worker-details" id={detailsId}>
                          {/* Provider-reported text only, already bounded upstream;
                              each block scrolls on its own instead of growing the panel. */}
                          <dl>
                            <div><dt>Assignment</dt><dd tabIndex={0}>{assignment}</dd></div>
                            {modelDetail && <div><dt>Model</dt><dd>{modelDetail}</dd></div>}
                            {progress && <div><dt>Latest progress</dt><dd tabIndex={0}>{progress}</dd></div>}
                            {result && <div><dt>Result</dt><dd tabIndex={0}>{result}</dd></div>}
                          </dl>
                          {!progress && !result && <p>The provider has reported no progress or result yet.</p>}
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            ) : (
              <p className="sa-empty">
                {native
                  ? `Agents appear here when ${nativeName ?? "the provider"} starts them.`
                  : editable ? "Sub-agents appear here the moment the model delegates." : "No sub-agents have run in this thread yet."}
              </p>
            )}
            {workerActionError && <p className="sa-worker-error" role="alert"><AlertTriangle size={11} /> {workerActionError}</p>}
          </div>

          <footer className="sa-footer">
            <button type="button" className="sa-advanced" onClick={() => { close(); props.onOpenSettings(); }}>
              <Settings2 size={12} /> Advanced sub-agent settings
            </button>
          </footer>
        </div>
      )}
    </div>
  );
}
