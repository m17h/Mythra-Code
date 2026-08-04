/** Last path segment, tolerating both separators and trailing slashes. */
export function basename(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

/**
 * Canonical identity for a workspace path: forward slashes, no trailing
 * slash. Every workspace/thread-binding comparison must go through this so
 * `/a/b/` and `/a/b` never count as different projects.
 */
export function normalizedProjectPath(path: string): string {
  const normalized = path.replace(/\\/g, "/").replace(/\/+$/, "");
  return normalized || "/";
}
