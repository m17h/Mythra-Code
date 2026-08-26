import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { AlertTriangle, ArrowRightLeft, LoaderCircle, Lock, Minus, Plus, Settings2, Square, SquareArrowOutUpRight, Trash2, UsersRound, X } from "lucide-react";
import { ProviderLogo } from "./BrandLogos";
import { AppSelectMenu, type AppSelectOption } from "./AppSelectMenu";
import {
  CHILD_AGENT_PROVIDERS,
  CHILD_AGENT_REASONING_EFFORTS,
  MAX_CHILD_AGENT_TARGETS,
  MAX_SUBAGENT_CONCURRENCY,
  childAgentCrewSize,
  childAgentModel,
  childAgentTargetIssue,
  crewSafeConcurrency,
  describeChildAgentReasoning,
  providerDisplayName,
  readyChildAgentTargets,
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
import type { ChildAgentTarget, ProjectSubagentSettings, Provider } from "../types";

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
  onChange: (next: ProjectSubagentSettings) => void;
  onOpenSettings: () => void;
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
}

export interface SubAgentModelOption {
  id: string;
  label: string;
  detail?: string;
  keywords?: string;
}

/** Stable identity so a locked thread's empty roster never re-triggers memos. */
const NO_TARGETS: ChildAgentTarget[] = [];
const PANEL_EXIT_MS = 180;

const BUILTIN_MODEL_CATALOGS: Record<Provider, SubAgentModelOption[]> = {
  openai: [
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
  { value: "agent", label: "Main agent decides", detail: "Let the root choose within a ceiling" },
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
  catalogs: SubAgentCommandCenterProps["modelCatalogs"],
  selectedModel?: string,
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
    description: "",
    enabled: true,
    reasoningMode: "inherit",
    reasoningEffort: "medium",
    reasoningMaxEffort: "high",
  };
}

export function SubAgentCommandCenter(props: SubAgentCommandCenterProps) {
  const [open, setOpen] = useState(false);
  const [panelPresent, setPanelPresent] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [replaceWorkerId, setReplaceWorkerId] = useState<string | null>(null);
  const [workerAction, setWorkerAction] = useState<{ workerId: string; kind: "stop" | "replace" | "open" } | null>(null);
  const [workerActionError, setWorkerActionError] = useState<string | null>(null);
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
  const crewActive = Boolean(props.parentActive) || counts.active > 0;
  /** Whether the destination roster and the parallel limit may be edited. */
  const editable = mode === "open" || (captured && !crewActive);
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
  // The switches are read fresh by every turn, so the panel reports the live
  // ones even for a thread whose roster is captured. They re-lock with the
  // rest of the controls while work is active.
  const delegationOn = !isChild && policy.enabled;
  const crossProviderOn = !isChild && policy.childAgents.enabled;
  const readyCount = useMemo(
    () => readyChildAgentTargets({ enabled: true, targets }, readiness).length,
    [readiness, targets],
  );
  const enabledCount = targets.filter((target) => target.enabled).length;
  // The roster is a menu and the limit is a budget. A crew of five destinations
  // with a limit of two is a legitimate configuration: the model picks two of
  // the five to run at a time.
  const crewSize = childAgentCrewSize({ enabled: crossProviderOn, targets });
  const crewCeiling = Math.max(1, enabledCount);
  const dimmed = !delegationOn;
  const crossProviderReady = delegationOn && crossProviderOn && readyCount > 0;

  const clearCloseTimer = useCallback(() => {
    if (closeTimerRef.current === null) return;
    window.clearTimeout(closeTimerRef.current);
    closeTimerRef.current = null;
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
    clearCloseTimer();
    // CSS animationend normally removes the panel. This fallback also covers
    // reduced-motion environments and a window losing focus mid-animation.
    closeTimerRef.current = window.setTimeout(finishClose, PANEL_EXIT_MS);
  }, [clearCloseTimer, finishClose]);

  useEffect(() => () => clearCloseTimer(), [clearCloseTimer]);

  // A popover opened for one conversation must not remain open after the user
  // switches to another and accidentally stage an edit against the new crew.
  const previousSessionIdRef = useRef(capturedPolicy?.sessionId);
  useEffect(() => {
    const nextSessionId = capturedPolicy?.sessionId;
    if (previousSessionIdRef.current === nextSessionId) return;
    previousSessionIdRef.current = nextSessionId;
    if (open) close();
  }, [capturedPolicy?.sessionId, close, open]);

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
    const childAgents = { ...policy.childAgents, targets: next };
    onChange({
      ...policy,
      maxConcurrent: crewSafeConcurrency(policy.maxConcurrent, childAgents),
      childAgents,
    });
  }, [onChange, policy]);

  const updateTarget = useCallback((id: string, patch: Partial<ChildAgentTarget>) => {
    setTargets(policy.childAgents.targets.map((target) => (target.id === id ? { ...target, ...patch } : target)));
  }, [policy.childAgents.targets, setTargets]);

  const addTarget = useCallback((provider: Provider) => {
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
  }, [onChange, policy]);

  const triggerLabel = counts.active > 0
    ? `Agents ${counts.active}/${maxConcurrent}`
    : delegationOn
      ? `Agents: ${maxConcurrent}${crossProviderReady ? " ↗" : ""}`
      : "Agents off";

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
            ? "This thread's crew is locked while its parent or a sub-agent is working."
            : captured
              ? "Edit this thread's sub-agent crew for its next message."
            : "Manage the sub-agent crew for this thread"}
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
          <UsersRound size={14} aria-hidden="true" />
          {triggerLabel}
          {!editable && <Lock size={11} className="sa-trigger-lock" aria-hidden="true" />}
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
          ref={panelRef}
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
              <strong>Sub-agent crew</strong>
              <small>
                {isChild
                  ? "Sub-agent conversation"
                  : captured && crewActive
                    ? "Crew locked while work is active"
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
            <p className="sa-locked-note">
              <Lock size={12} aria-hidden="true" />
              <span>
                Finish or stop the parent and every sub-agent before changing this crew.
                The current run keeps the destinations it started with.
              </span>
            </p>
          )}

          {captured && !crewActive && (
            <p className="sa-locked-note">
              <ArrowRightLeft size={12} aria-hidden="true" />
              <span>Destination and limit changes stay in this thread and take effect together on its next message.</span>
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
            <div className={`sa-row ${delegationOn ? "on" : ""}`}>
              <span className="sa-row-copy">
                <strong>Sub-agents</strong>
                <small>{delegationOn ? "The model may split work across parallel agents." : "No sub-agent tools are exposed."}</small>
              </span>
              {isChild ? (
                <span className="sa-readout">Off</span>
              ) : (
                <button
                  type="button"
                  role="switch"
                  aria-checked={policy.enabled}
                  aria-label="Allow sub-agent spawning"
                  disabled={captured && crewActive}
                  className={`toggle-switch ${policy.enabled ? "on" : ""}`}
                  onClick={() => onChange({ ...policy, enabled: !policy.enabled })}
                >
                  <span />
                </button>
              )}
            </div>

            <div className={`sa-row ${dimmed ? "muted" : ""}`}>
              <span className="sa-row-copy">
                <strong>Parallel limit</strong>
                <small>
                  {editable
                    ? crewSize > 0
                      ? `How many children may run at once (1–${MAX_SUBAGENT_CONCURRENCY}), chosen from ${crewSize} destination${crewSize === 1 ? "" : "s"}.`
                      : `How many children may run at once (1–${MAX_SUBAGENT_CONCURRENCY}).`
                    : captured
                      ? "Locked until the parent and every child are idle."
                      : "A sub-agent works alone."}
                </small>
              </span>
              {!editable ? (
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

            <div className={`sa-row ${dimmed ? "muted" : ""}`}>
              <span className="sa-row-copy">
                <strong>Cross-provider</strong>
                <small>
                  {!crossProviderOn
                    ? "Children stay inside this thread's own provider."
                    : enabledCount === 0
                      ? "No destinations switched on."
                      : `${readyCount} of ${enabledCount} destination${enabledCount === 1 ? "" : "s"} ready`}
                </small>
              </span>
              {isChild ? (
                <span className="sa-readout">Off</span>
              ) : (
                <button
                  type="button"
                  role="switch"
                  aria-checked={policy.childAgents.enabled}
                  aria-label="Allow cross-provider sub-agents"
                  disabled={!policy.enabled || (captured && crewActive)}
                  className={`toggle-switch ${policy.childAgents.enabled && policy.enabled ? "on" : ""}`}
                  onClick={() => onChange({ ...policy, childAgents: { ...policy.childAgents, enabled: !policy.childAgents.enabled } })}
                >
                  <span />
                </button>
              )}
            </div>

            <div className={`sa-crew ${crossProviderOn && !dimmed ? "" : "muted"}`}>
              <div className="sa-crew-grid" role="list" aria-label="Cross-provider destinations">
                {targets.map((target) => {
                  const issue = childAgentTargetIssue(target, readiness);
                  const expanded = expandedId === target.id;
                  const busy = workers.some((worker) => worker.targetId === target.id && isSubAgentWorkerActive(worker.status));
                  const selectedModel = childAgentModel(target);
                  const modelOptions = modelOptionsFor(target.provider, props.modelCatalogs, selectedModel);
                  return (
                    <div
                      role="listitem"
                      key={targetKey(target)}
                      className={`sa-tile ${target.provider} ${target.enabled ? "" : "off"} ${issue && target.enabled ? "issue" : ""} ${busy ? "busy" : ""} ${expanded ? "expanded" : ""}`}
                    >
                      <div className="sa-tile-head">
                        <button
                          type="button"
                          className="sa-tile-face"
                          aria-expanded={editable ? expanded : undefined}
                          aria-label={editable ? `Configure ${target.label || target.id}` : undefined}
                          disabled={!editable}
                          onClick={() => setExpandedId(expanded ? null : target.id)}
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
                            onClick={() => updateTarget(target.id, { enabled: !target.enabled })}
                          ><span /></button>
                        )}
                      </div>
                      {!editable && <span className="sa-tile-note">{describeChildAgentReasoning(target)}</span>}
                      {issue && target.enabled && (
                        <p className="sa-tile-issue"><AlertTriangle size={11} aria-hidden="true" /> {issue}</p>
                      )}
                      {expanded && editable && (
                        <div className="sa-tile-config">
                          <div className="sa-config-field">
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
                          <div className="sa-config-field">
                            <span>Model</span>
                            <AppSelectMenu
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
                          <p className="sa-tile-reasoning">{describeChildAgentReasoning(target)}</p>
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
                      )}
                    </div>
                  );
                })}

                {editable && targets.length < MAX_CHILD_AGENT_TARGETS && (
                  <div role="listitem" className="sa-add">
                    <span>Add a worker</span>
                    <div className="sa-add-row">
                      {CHILD_AGENT_PROVIDERS.map((provider) => (
                        <button
                          type="button"
                          key={provider}
                          aria-label={`Add ${providerDisplayName(provider)} destination`}
                          title={`Add ${providerDisplayName(provider)}`}
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
                    ? "A sub-agent has no destinations of its own."
                    : captured
                      ? "This thread captured no cross-provider destinations."
                      : "No destinations yet. Add a worker to let the root agent delegate across providers."}
                </p>
              )}
            </div>
          </div>

          <div className="sa-activity">
            <div className="sa-activity-head">
              <strong>Live agents</strong>
              <span className="sa-counts" role="status">
                <span key={describeSubAgentActivity(counts)} className="sa-flash">{describeSubAgentActivity(counts)}</span>
              </span>
            </div>
            {workers.length > 0 ? (
              <ul className="sa-worker-list">
                {workers.map((worker) => {
                  const active = isSubAgentWorkerActive(worker.status);
                  const replacing = replaceWorkerId === worker.id;
                  const acting = workerAction?.workerId === worker.id;
                  const replacementTargets = targets.filter((target) => target.enabled && !childAgentTargetIssue(target, readiness));
                  return (
                    <li key={worker.id} className={`sa-worker ${worker.status} ${replacing ? "replacing" : ""}`}>
                      <span className="sa-worker-orb" aria-hidden="true" />
                      <span className="sa-worker-copy">
                        <strong title={worker.title}>{worker.title}</strong>
                        <small title={worker.detail}>{subAgentStatusLabel(worker.status)} · {worker.detail}</small>
                      </span>
                      <span className="sa-worker-end">
                        {worker.provider && (
                          <span className="sa-worker-mark" aria-hidden="true"><ProviderLogo provider={worker.provider} size={12} /></span>
                        )}
                        {props.onOpenWorker && (
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
                        {active && props.onStopWorker && (
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
                        <div className="sa-replace-picker" role="group" aria-label={`Replacement destination for ${worker.title}`}>
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
                    </li>
                  );
                })}
              </ul>
            ) : (
              <p className="sa-empty">
                {editable ? "Sub-agents appear here the moment the model delegates." : "No sub-agents have run in this thread yet."}
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
