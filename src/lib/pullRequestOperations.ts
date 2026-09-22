import { normalizedProjectPath } from "./paths";

const mutationLocks = new Set<string>();

export function isPullRequestMutationRunning(cwd: string): boolean {
  return mutationLocks.has(normalizedProjectPath(cwd));
}

export function acquirePullRequestMutation(cwd: string): string | null {
  const key = normalizedProjectPath(cwd);
  if (mutationLocks.has(key)) return null;
  mutationLocks.add(key);
  return key;
}

export function releasePullRequestMutation(key: string): void {
  mutationLocks.delete(key);
}
