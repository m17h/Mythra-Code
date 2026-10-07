import { invoke } from "@tauri-apps/api/core";
import { useSyncExternalStore } from "react";
import { defaultPreferenceLearningScope, mergeLearnedPreferences, preferenceDocumentInstructions } from "./preferenceLearning";
import { PREFERENCE_LEARNING_LIMITS as LIMITS, type LearnedPreference, type PreferenceLearningConfigPatch, type PreferenceLearningJob, type PreferenceLearningScopeState, type PreferenceLearningValue } from "./preferenceLearningTypes";

export interface PreferenceLearningTransport {
  list: () => Promise<PreferenceLearningScopeState[]>;
  save: (scopeKey: string, expectedRevision: number, value: PreferenceLearningValue) => Promise<PreferenceLearningScopeState>;
  forget?: (scopeKey: string, expectedRevision: number) => Promise<void>;
}
export interface PreferenceAnalysisCommit {
  /** A validated native write receipt, independent of subsequent settings changes. */
  saved: boolean;
  committed: boolean; changed: boolean; state: PreferenceLearningScopeState;
}
const IDLE_JOB: PreferenceLearningJob = Object.freeze({ status: "idle" });

function validateScopeKey(scopeKey: string): void {
  if (scopeKey === "app") return;
  const id = typeof scopeKey === "string" && scopeKey.startsWith("project:") ? scopeKey.slice(8) : "";
  if (!id || id.length > 200 || id !== id.trim() || id === "." || id === ".." || /[\u0000-\u001f\u007f/\\]/.test(id)) throw new Error("Invalid preference scope");
}
function validTime(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0; }
function nullableTime(value: unknown): boolean { return value === null || validTime(value); }
function boundedText(value: unknown, limit: number): value is string { return typeof value === "string" && value.length <= limit && !value.includes("\0"); }
function validateNativeScope(value: unknown): PreferenceLearningScopeState {
  const fail = (): never => { throw new Error("Invalid preference settings returned by the app"); };
  if (!value || typeof value !== "object" || Array.isArray(value)) return fail();
  const state = value as Record<string, unknown>;
  const fields = new Set(["scopeKey", "revision", "enabled", "provider", "model", "enabledAt", "markdown", "updatedAt", "checkpoints", "historyRequestedAt", "clearedAt", "rejectedInstructions", "analysisRequestsAt"]);
  if (Object.keys(state).some((key) => !fields.has(key)) || typeof state.scopeKey !== "string") return fail();
  validateScopeKey(state.scopeKey);
  if (!validTime(state.revision) || typeof state.enabled !== "boolean"
    || typeof state.provider !== "string" || !["openai", "openrouter", "lmstudio", "claude", "cursor"].includes(state.provider)
    || !boundedText(state.model, 160) || /[\u0000-\u001f\u007f]/.test(state.model)
    || !nullableTime(state.enabledAt) || (state.enabled && state.enabledAt === null)
    || !boundedText(state.markdown, LIMITS.documentChars) || !validTime(state.updatedAt)
    || !state.checkpoints || typeof state.checkpoints !== "object" || Array.isArray(state.checkpoints)) return fail();
  const checkpoints = Object.entries(state.checkpoints);
  if (checkpoints.length > LIMITS.checkpointThreads || checkpoints.some(([key, checkpoint]) => !key || !boundedText(key, 300) || !boundedText(checkpoint, LIMITS.checkpointChars))) return fail();
  if ((state.historyRequestedAt !== undefined && !nullableTime(state.historyRequestedAt))
    || (state.clearedAt !== undefined && !nullableTime(state.clearedAt))
    || (state.rejectedInstructions !== undefined && state.rejectedInstructions !== null && (!Array.isArray(state.rejectedInstructions) || state.rejectedInstructions.length > LIMITS.rejectedInstructions || state.rejectedInstructions.some((instruction) => !boundedText(instruction, 400))))
    || (state.analysisRequestsAt !== undefined && state.analysisRequestsAt !== null && (!Array.isArray(state.analysisRequestsAt) || state.analysisRequestsAt.length > 12 || state.analysisRequestsAt.some((time) => !validTime(time))))) return fail();
  // Own the snapshots so a transport/mock cannot mutate validated state later.
  return { ...state, checkpoints: Object.fromEntries(checkpoints),
    ...(Array.isArray(state.rejectedInstructions) ? { rejectedInstructions: [...state.rejectedInstructions] } : { rejectedInstructions: undefined }),
    ...(Array.isArray(state.analysisRequestsAt) ? { analysisRequestsAt: [...state.analysisRequestsAt] } : { analysisRequestsAt: undefined }),
  } as unknown as PreferenceLearningScopeState;
}
function valueOf(state: PreferenceLearningScopeState): PreferenceLearningValue {
  const { scopeKey: _scopeKey, revision: _revision, ...value } = state;
  return value;
}
function mergeCheckpoints(current: Record<string, string>, incoming: Record<string, string>): Record<string, string> {
  const additions = Object.entries(incoming);
  if (additions.length > LIMITS.checkpointThreads || additions.some(([key, checkpoint]) => !key || !boundedText(key, 300) || !boundedText(checkpoint, LIMITS.checkpointChars))) throw new Error("Invalid preference checkpoints");
  const addedKeys = new Set(additions.map(([key]) => key));
  const retained = Object.entries(current).filter(([key]) => !addedKeys.has(key)).slice(-(LIMITS.checkpointThreads - additions.length));
  // slice(-0) means the entire array, so a full incoming batch retains none.
  return Object.fromEntries([...(additions.length === LIMITS.checkpointThreads ? [] : retained), ...additions]);
}

/** One queued writer per scope; only successful native CAS results become visible. */
export function createPreferenceLearningStore(transport: PreferenceLearningTransport) {
  const scopes = new Map<string, PreferenceLearningScopeState>();
  const defaults = new Map<string, PreferenceLearningScopeState>();
  const jobs = new Map<string, PreferenceLearningJob>();
  const queues = new Map<string, Promise<unknown>>();
  const generations = new Map<string, number>();
  const forgetGenerations = new Map<string, number>();
  const deletedAt = new Map<string, number>();
  const deletedRevisions = new Map<string, number>();
  const pendingMutations = new Map<string, number>();
  const suppressed = new Map<string, PreferenceLearningScopeState>();
  const listeners = new Set<() => void>();
  let hydrated = false;
  let loading: Promise<void> | null = null;
  let error: string | null = null;
  let deletionEpoch = 0;
  let savedScopeKeys: readonly string[] = Object.freeze([]);
  const emit = () => {
    const keys = [...scopes.keys()].sort();
    if (keys.length !== savedScopeKeys.length || keys.some((key, index) => key !== savedScopeKeys[index])) savedScopeKeys = Object.freeze(keys);
    listeners.forEach((listener) => listener());
  };
  const getNative = (scopeKey: string): PreferenceLearningScopeState => {
    validateScopeKey(scopeKey);
    const scope = scopes.get(scopeKey);
    if (scope) return scope;
    let initial = defaults.get(scopeKey);
    if (!initial) { initial = Object.freeze(defaultPreferenceLearningScope(scopeKey)); defaults.set(scopeKey, initial); }
    return initial;
  };
  const get = (scopeKey: string): PreferenceLearningScopeState => {
    const current = getNative(scopeKey);
    if (!pendingMutations.get(scopeKey) || !current.enabled) return current;
    let snapshot = suppressed.get(scopeKey);
    if (!snapshot || snapshot.revision !== current.revision) {
      snapshot = { ...current, enabled: false };
      suppressed.set(scopeKey, snapshot);
    }
    return snapshot;
  };
  const load = (): Promise<void> => {
    if (loading) return loading;
    const startedAt = deletionEpoch;
    const startingScopes = new Map(scopes);
    loading = Promise.resolve().then(() => transport.list()).then((payload: unknown) => {
      if (!Array.isArray(payload) || payload.length > 128) throw new Error("Invalid preference settings returned by the app");
      // Validate the whole response before publishing any enabled scope.
      const states = payload.map(validateNativeScope);
      if (new Set(states.map((state) => state.scopeKey)).size !== states.length) throw new Error("Duplicate preference scopes returned by the app");
      // Keep a newer successful local CAS when an older list arrives late.
      for (const state of states) {
        validateScopeKey(state.scopeKey);
        if ((deletedAt.get(state.scopeKey) ?? 0) > startedAt || state.revision <= (deletedRevisions.get(state.scopeKey) ?? -1)) continue;
        if (state.revision >= (scopes.get(state.scopeKey)?.revision ?? -1)) scopes.set(state.scopeKey, state);
      }
      // Another instance may have forgotten a scope. An absent row removes only
      // the exact snapshot present at request start, never a later local save.
      const present = new Set(states.map((state) => state.scopeKey));
      for (const [key, state] of startingScopes) {
        if (!present.has(key) && scopes.get(key) === state) {
          scopes.delete(key);
          deletedAt.set(key, ++deletionEpoch);
          deletedRevisions.set(key, Math.max(deletedRevisions.get(key) ?? 0, state.revision));
          generations.set(key, (generations.get(key) ?? 0) + 1);
          forgetGenerations.set(key, (forgetGenerations.get(key) ?? 0) + 1);
          jobs.delete(key);
        }
      }
      hydrated = true;
      error = null;
      emit();
    }).catch((reason: unknown) => {
      error = reason instanceof Error ? reason.message : String(reason);
      // Failure never manufactures an enabled state or erases a known document.
      emit();
      throw reason;
    }).finally(() => { loading = null; });
    return loading;
  };
  const enqueue = <T,>(scopeKey: string, action: () => Promise<T>): Promise<T> => {
    validateScopeKey(scopeKey);
    const operation = (queues.get(scopeKey) ?? Promise.resolve()).catch(() => undefined).then(action);
    queues.set(scopeKey, operation);
    void operation.finally(() => { if (queues.get(scopeKey) === operation) queues.delete(scopeKey); }).catch(() => undefined);
    return operation;
  };
  const save = async (state: PreferenceLearningScopeState, value: PreferenceLearningValue,
    onNativeSaved?: (state: PreferenceLearningScopeState) => void): Promise<PreferenceLearningScopeState> => {
    const startingDeletion = deletedAt.get(state.scopeKey) ?? 0;
    try {
      const next = validateNativeScope(await transport.save(state.scopeKey, state.revision, value));
      // New scopes receive a native high-water revision, including after a
      // previous incarnation was forgotten. Existing scopes still advance one.
      if (next.scopeKey !== state.scopeKey || (state.revision === 0 ? next.revision <= 0 : next.revision !== state.revision + 1)) throw new Error("Invalid preference revision returned by the app");
      onNativeSaved?.(next);
      if ((deletedAt.get(state.scopeKey) ?? 0) !== startingDeletion) throw new Error("These saved project preferences were removed while this update was running.");
      if (next.revision <= (deletedRevisions.get(next.scopeKey) ?? -1)) throw new Error("Invalid recreated preference revision returned by the app");
      // The native write can finish before its bridge response arrives. A list
      // may already have observed a subsequent external edit or disable.
      if (next.revision < (scopes.get(next.scopeKey)?.revision ?? 0)) throw new Error("Preference settings changed while this update was running.");
      scopes.set(next.scopeKey, next);
      emit();
      return next;
    } catch (reason) {
      // Refresh conflicts rather than replacing native data with stale UI state.
      await load().catch(() => undefined);
      throw reason;
    }
  };
  const invalidate = (scopeKey: string) => {
    generations.set(scopeKey, (generations.get(scopeKey) ?? 0) + 1);
    jobs.delete(scopeKey);
    emit();
  };
  const mutate = (scopeKey: string, action: (current: PreferenceLearningScopeState) => PreferenceLearningValue) => {
    validateScopeKey(scopeKey);
    const forgetGeneration = forgetGenerations.get(scopeKey) ?? 0;
    pendingMutations.set(scopeKey, (pendingMutations.get(scopeKey) ?? 0) + 1);
    invalidate(scopeKey);
    return enqueue(scopeKey, async () => {
      if (!hydrated) await load();
      if (forgetGeneration !== (forgetGenerations.get(scopeKey) ?? 0)) throw new Error("These saved project preferences were removed. Review the latest settings before saving.");
      const current = getNative(scopeKey);
      return save(current, action(current));
    }).finally(() => {
      const count = (pendingMutations.get(scopeKey) ?? 1) - 1;
      if (count) pendingMutations.set(scopeKey, count); else pendingMutations.delete(scopeKey);
      suppressed.delete(scopeKey);
      emit();
    });
  };
  return {
    get, load,
    getSavedScopeKeys: () => savedScopeKeys,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    isHydrated: () => hydrated,
    getError: () => error,
    getJob: (scopeKey: string) => jobs.get(scopeKey) ?? IDLE_JOB,
    setJob: (scopeKey: string, job: PreferenceLearningJob) => { jobs.set(scopeKey, job); emit(); },
    configure: (scopeKey: string, patch: PreferenceLearningConfigPatch) => mutate(scopeKey, (current) => ({
      ...valueOf(current), ...patch, updatedAt: Date.now(),
      enabledAt: patch.enabled === true && !current.enabled ? Date.now() : current.enabledAt,
    })),
    edit: (scopeKey: string, markdown: string, expectedRevision?: number) => {
      if (markdown.length > LIMITS.documentChars || /[\u0000]/.test(markdown)) return Promise.reject(new Error("Preference document is too large or contains invalid text"));
      return mutate(scopeKey, (current) => {
        if (expectedRevision !== undefined && expectedRevision !== current.revision) throw new Error("The learned preferences changed. Review the latest document before saving.");
        const retained = new Set(preferenceDocumentInstructions(markdown));
        const removed = preferenceDocumentInstructions(current.markdown).filter((entry) => !retained.has(entry));
        return { ...valueOf(current), markdown, updatedAt: Date.now(), rejectedInstructions: [...new Set([...current.rejectedInstructions ?? [], ...removed])].filter((instruction) => instruction.length <= LIMITS.instructionChars).slice(-LIMITS.rejectedInstructions) };
      });
    },
    clear: (scopeKey: string, expectedRevision?: number) => mutate(scopeKey, (current) => {
      if (expectedRevision !== undefined && expectedRevision !== current.revision) throw new Error("The learned preferences changed. Review the latest document before clearing.");
      const now = Date.now();
      return { ...valueOf(current), markdown: "", updatedAt: now, clearedAt: now,
        enabledAt: current.enabled ? now : current.enabledAt, historyRequestedAt: null,
        rejectedInstructions: [...new Set([...current.rejectedInstructions ?? [], ...preferenceDocumentInstructions(current.markdown)])].filter((instruction) => instruction.length <= LIMITS.instructionChars).slice(-LIMITS.rejectedInstructions),
      };
    }),
    forget: (scopeKey: string, expectedRevision: number): Promise<void> => {
      validateScopeKey(scopeKey);
      if (scopeKey === "app" || !validTime(expectedRevision) || expectedRevision === 0) return Promise.reject(new Error("Only saved project preferences can be removed."));
      const remove = transport.forget;
      if (!remove) return Promise.reject(new Error("Removing saved project preferences is unavailable."));
      forgetGenerations.set(scopeKey, (forgetGenerations.get(scopeKey) ?? 0) + 1);
      pendingMutations.set(scopeKey, (pendingMutations.get(scopeKey) ?? 0) + 1);
      invalidate(scopeKey);
      return enqueue(scopeKey, async () => {
        if (!hydrated) await load();
        const current = getNative(scopeKey);
        if (current.revision !== expectedRevision) throw new Error("The learned preferences changed. Review the latest document before removing it.");
        try {
          await remove(scopeKey, expectedRevision);
          deletedAt.set(scopeKey, ++deletionEpoch);
          deletedRevisions.set(scopeKey, Math.max(deletedRevisions.get(scopeKey) ?? 0, expectedRevision));
          // A newer recreated scope may already have arrived through a list.
          if ((scopes.get(scopeKey)?.revision ?? 0) <= expectedRevision) scopes.delete(scopeKey);
          jobs.delete(scopeKey);
          emit();
        } catch (reason) {
          await load().catch(() => undefined);
          throw reason;
        }
      }).finally(() => {
        const count = (pendingMutations.get(scopeKey) ?? 1) - 1;
        if (count) pendingMutations.set(scopeKey, count); else pendingMutations.delete(scopeKey);
        suppressed.delete(scopeKey);
        emit();
      });
    },
    reserve: (scopeKey: string, expectedRevision: number, now = Date.now()): Promise<PreferenceLearningScopeState | null> => {
      const generation = generations.get(scopeKey) ?? 0;
      return enqueue(scopeKey, async () => {
        const current = get(scopeKey);
        if (!hydrated || !current.enabled || current.revision !== expectedRevision || generation !== (generations.get(scopeKey) ?? 0)) return null;
        const analysisRequestsAt = (current.analysisRequestsAt ?? []).filter((timestamp) => timestamp > now - 86_400_000);
        if (analysisRequestsAt.length >= 12) return null;
        const reserved = await save(current, { ...valueOf(current), analysisRequestsAt: [...analysisRequestsAt, now], updatedAt: now });
        return generation === (generations.get(scopeKey) ?? 0) ? reserved : null;
      });
    },
    commit: (scopeKey: string, expectedRevision: number, preferences: LearnedPreference[], checkpoints: Record<string, string>): Promise<PreferenceAnalysisCommit> => {
      const generation = generations.get(scopeKey) ?? 0;
      return enqueue(scopeKey, async () => {
        const current = get(scopeKey);
        if (!hydrated || !current.enabled || current.revision !== expectedRevision || generation !== (generations.get(scopeKey) ?? 0)) return { saved: false, committed: false, changed: false, state: current };
        const markdown = mergeLearnedPreferences(current.markdown, preferences, current.rejectedInstructions);
        let savedState: PreferenceLearningScopeState | undefined;
        try {
          const state = await save(current, { ...valueOf(current), markdown, checkpoints: mergeCheckpoints(current.checkpoints, checkpoints), updatedAt: Date.now() }, (receipt) => { savedState = receipt; });
          if (generation !== (generations.get(scopeKey) ?? 0)) return { saved: true, committed: false, changed: markdown !== current.markdown, state: get(scopeKey) };
          return { saved: true, committed: true, changed: markdown !== current.markdown, state };
        } catch {
          return { saved: Boolean(savedState), committed: false, changed: Boolean(savedState && savedState.markdown !== current.markdown), state: get(scopeKey) };
        }
      });
    },
  };
}

const store = createPreferenceLearningStore({
  list: () => invoke("preference_learning_list"),
  save: (scopeKey, expectedRevision, value) => invoke("preference_learning_save", { scopeKey, expectedRevision, value }),
  forget: (scopeKey, expectedRevision) => invoke("preference_learning_forget", { scopeKey, expectedRevision }),
});
export const loadPreferenceLearning = store.load;
export const getPreferenceLearningScope = store.get;
export const getPreferenceLearningSavedScopeKeys = store.getSavedScopeKeys;
export const getPreferenceLearningHydrated = store.isHydrated;
export const getPreferenceLearningError = store.getError;
export const subscribePreferenceLearning = store.subscribe;
export const getPreferenceLearningJob = store.getJob;
export const setPreferenceLearningJob = store.setJob;
export const configurePreferenceLearning = store.configure;
export const editPreferenceLearning = store.edit;
export const clearPreferenceLearning = store.clear;
export const forgetPreferenceLearning = store.forget;
export const reservePreferenceLearningAnalysis = store.reserve;
export const commitPreferenceAnalysis = store.commit;
export function usePreferenceLearningScope(scopeKey: string): PreferenceLearningScopeState {
  return useSyncExternalStore(store.subscribe, () => store.get(scopeKey), () => store.get(scopeKey));
}
export function usePreferenceLearningJob(scopeKey: string): PreferenceLearningJob {
  return useSyncExternalStore(store.subscribe, () => store.getJob(scopeKey), () => store.getJob(scopeKey));
}
export function usePreferenceLearningHydrated(): boolean {
  return useSyncExternalStore(store.subscribe, store.isHydrated, store.isHydrated);
}
export function usePreferenceLearningSavedScopeKeys(): readonly string[] {
  return useSyncExternalStore(store.subscribe, store.getSavedScopeKeys, store.getSavedScopeKeys);
}
