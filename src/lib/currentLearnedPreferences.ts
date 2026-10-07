import { appendLearnedPreferencesToPrompt } from "./preferenceLearning";
import { getPreferenceLearningHydrated, getPreferenceLearningScope, loadPreferenceLearning } from "./preferenceLearningStore";

/** Resolve generated preferences only after authored instructions/skills. */
export async function appendCurrentLearnedPreferences(prompt: string, projectId: string | null): Promise<string> {
  // An unhydrated default is not proof that persisted learning is disabled.
  // Share the startup read and propagate failures so this turn cannot silently
  // omit enabled instructions; a later preparation can retry the failed read.
  if (!getPreferenceLearningHydrated()) await loadPreferenceLearning();
  const scopes = [getPreferenceLearningScope("app")];
  if (projectId) scopes.push(getPreferenceLearningScope(`project:${projectId}`));
  return appendLearnedPreferencesToPrompt(prompt, scopes);
}
