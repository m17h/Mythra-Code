import { appendLearnedPreferencesToPrompt } from "./preferenceLearning";
import { getPreferenceLearningScope } from "./preferenceLearningStore";

/** Resolve generated preferences only after authored instructions/skills. */
export function appendCurrentLearnedPreferences(prompt: string, projectId: string | null): string {
  const scopes = [getPreferenceLearningScope("app")];
  if (projectId) scopes.push(getPreferenceLearningScope(`project:${projectId}`));
  return appendLearnedPreferencesToPrompt(prompt, scopes);
}
