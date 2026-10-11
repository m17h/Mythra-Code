import { isAbsolutePath, normalizedProjectPath } from "./paths";

const GENERATED_PREFIX = "new-draft:";
const DRAFT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A separate namespace and tuple keep arbitrary folder names out of the ID boundary. */
export function createWorkspaceDraftKey(workspacePath: string, id: string = crypto.randomUUID()): string {
  if (!isAbsolutePath(workspacePath) || !DRAFT_ID.test(id)) throw new Error("Invalid workspace draft identity");
  return `${GENERATED_PREFIX}${JSON.stringify([normalizedProjectPath(workspacePath), id])}`;
}

/** Draft keys must never alias a provider ID or another workspace's draft. */
export function isWorkspaceDraftKey(key: unknown, workspacePath: string): key is string {
  if (typeof key !== "string" || !isAbsolutePath(workspacePath)) return false;
  if (key.startsWith("new:")) return normalizedProjectPath(key.slice(4)) === normalizedProjectPath(workspacePath);
  if (!key.startsWith(GENERATED_PREFIX)) return false;
  try {
    const identity: unknown = JSON.parse(key.slice(GENERATED_PREFIX.length));
    return Array.isArray(identity) && identity.length === 2
      && typeof identity[0] === "string" && isAbsolutePath(identity[0])
      && typeof identity[1] === "string" && DRAFT_ID.test(identity[1])
      && normalizedProjectPath(identity[0]) === normalizedProjectPath(workspacePath);
  } catch { return false; }
}

function objectEntries(value: unknown): [string, unknown][] {
  return value && typeof value === "object" && !Array.isArray(value) ? Object.entries(value) : [];
}

export function sanitizeWorkspaceDraftKeys(value: unknown): Record<string, string> {
  return Object.fromEntries(objectEntries(value).filter(([path, key]) => isWorkspaceDraftKey(key, path))
    .map(([path, key]) => [normalizedProjectPath(path), key as string]));
}

export function sanitizeSavedWorkspaceDraftKeys(value: unknown): Record<string, string[]> {
  return Object.fromEntries(objectEntries(value).flatMap(([path, keys]) => {
    if (!Array.isArray(keys) || !isAbsolutePath(path)) return [];
    const valid = [...new Set(keys.filter((key) => isWorkspaceDraftKey(key, path)))];
    return valid.length ? [[normalizedProjectPath(path), valid]] : [];
  }));
}

/** Keep every authored draft and active send; only empty settled keys are stale. */
export function retainSavedWorkspaceDraftKeys(value: unknown, hasDraft: (key: string) => boolean, activeKeys: ReadonlySet<string>, add?: { workspacePath: string; key: string }): Record<string, string[]> {
  const saved = sanitizeSavedWorkspaceDraftKeys(value);
  if (add && isWorkspaceDraftKey(add.key, add.workspacePath)) {
    const path = normalizedProjectPath(add.workspacePath);
    saved[path] = [...new Set([add.key, ...(saved[path] ?? [])])];
  }
  return Object.fromEntries(Object.entries(saved).flatMap(([path, keys]) => {
    const retained = keys.filter((key) => activeKeys.has(key) || hasDraft(key));
    return retained.length ? [[path, retained]] : [];
  }));
}
