import type { Provider } from "../types";

/** Private, native-owned state. Missing scopes are always disabled. */
export interface PreferenceLearningScopeState {
  scopeKey: string;
  revision: number;
  enabled: boolean;
  provider: Provider;
  /** Empty means latest Luna from the live OpenAI catalog. */
  model: string;
  enabledAt: number | null;
  markdown: string;
  updatedAt: number;
  checkpoints: Record<string, string>;
  historyRequestedAt?: number | null;
  clearedAt?: number | null;
  rejectedInstructions?: string[];
  analysisRequestsAt?: number[];
}

export type PreferenceLearningValue = Omit<PreferenceLearningScopeState, "scopeKey" | "revision">;
export type PreferenceLearningConfigPatch = Partial<Pick<PreferenceLearningValue, "enabled" | "provider" | "model" | "historyRequestedAt">>;

/** Callers must establish human authorship and durable scope membership first. */
export interface PreferenceSourceMessage { id: string; role: "user" | "assistant"; text: string }
export interface LearnedPreference { instruction: string; evidenceIds: string[]; replaces?: string[] }
export interface PreferenceAnalysis { preferences: LearnedPreference[] }
export interface PreferenceLearningJob {
  status: "idle" | "queued" | "running" | "error";
  /** Associates transient status with one explicitly requested history run. */
  historyRunId?: string;
  message?: string;
  startedAt?: number;
}

export const PREFERENCE_LEARNING_LIMITS = Object.freeze({
  documentChars: 8_000, promptChars: 18_000, inputChars: 24_000,
  messageChars: 4_000, messages: 40, preferences: 24, instructionChars: 300,
  evidenceIds: 8, rejectedInstructions: 64,
  checkpointThreads: 1_000, checkpointChars: 2_000,
});
