import { defaultPreferenceLearningScope } from "../lib/preferenceLearning";
import type { PreferenceLearningScopeState, PreferenceLearningValue } from "../lib/preferenceLearningTypes";

/** Native persistence substitute, isolated from real profiles and providers. */
export function preferenceLearningFixture() {
  const states = new Map<string, PreferenceLearningScopeState>();
  const calls: Array<{ command: string; args?: Record<string, unknown> }> = [];
  let epoch = 0;
  let highWaterRevision = 0;
  let pending: (() => Promise<void>) | null = null;
  const reset = (overrides: Partial<PreferenceLearningScopeState> = {}) => {
    epoch += 100;
    states.clear();
    states.set("app", { ...defaultPreferenceLearningScope("app"), revision: epoch, ...overrides });
    highWaterRevision = Math.max(highWaterRevision, epoch);
    calls.length = 0;
    pending = null;
  };
  const invoke = async (command: string, args?: Record<string, unknown>): Promise<unknown> => {
    calls.push({ command, args });
    if (command === "preference_learning_list") return [...states.values()].map((state) => ({ ...state }));
    if (command !== "preference_learning_save" && command !== "preference_learning_forget") throw new Error(`Unexpected fixture command: ${command}`);
    if (pending) await pending();
    const scopeKey = args!.scopeKey as string;
    const current = states.get(scopeKey) ?? defaultPreferenceLearningScope(scopeKey);
    if (current.revision !== args!.expectedRevision) throw new Error("Fixture preference revision conflict");
    if (command === "preference_learning_forget") {
      if (!scopeKey.startsWith("project:") || current.revision === 0) throw new Error("Only saved project preferences can be removed");
      highWaterRevision = Math.max(highWaterRevision, current.revision);
      states.delete(scopeKey);
      return undefined;
    }
    highWaterRevision = Math.max(highWaterRevision, ...[...states.values()].map((state) => state.revision));
    const next = { ...(args!.value as PreferenceLearningValue), scopeKey, revision: current.revision === 0 ? highWaterRevision + 1 : current.revision + 1 };
    highWaterRevision = Math.max(highWaterRevision, next.revision);
    states.set(scopeKey, next);
    return next;
  };
  return { states, calls, reset, invoke, delay: (wait: (() => Promise<void>) | null) => { pending = wait; } };
}
