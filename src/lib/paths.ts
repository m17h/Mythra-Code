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

/**
 * The separator a path is already written with. Display and navigation keep
 * the user's own convention: a Windows project stays `C:\src\app`, and a POSIX
 * project stays `/src/app`, instead of gaining a mixed `C:\src/app` form the
 * moment the file browser descends a level.
 */
export function pathSeparator(path: string): "/" | "\\" {
  return path.includes("\\") && !path.includes("/") ? "\\" : "/";
}

/** Drops trailing separators without emptying a filesystem or drive root. */
export function stripTrailingSeparator(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, "");
  if (trimmed) return /^[a-zA-Z]:$/.test(trimmed) ? `${trimmed}${path.slice(trimmed.length, trimmed.length + 1) || "\\"}` : trimmed;
  return path.slice(0, 1) || path;
}

export function isAbsolutePath(path: string): boolean {
  return path.startsWith("/") || path.startsWith("\\") || /^[a-zA-Z]:[\\/]/.test(path);
}

/** Appends a child segment using the parent's own separator. */
export function joinPath(parent: string, name: string): string {
  const base = stripTrailingSeparator(parent);
  const separator = pathSeparator(parent);
  return base.endsWith(separator) ? `${base}${name}` : `${base}${separator}${name}`;
}

/** Every non-empty segment of a path or relative path, separator-agnostic. */
export function pathSegments(path: string): string[] {
  return path.split(/[\\/]/).filter(Boolean);
}

/**
 * `path` expressed relative to `root`, keeping the original separators. Falls
 * back to the full path when it is not inside the root, so display never
 * silently truncates an unrelated location into a plausible-looking fragment.
 */
export function relativeDisplayPath(root: string, path: string): string {
  const normalizedRoot = normalizedProjectPath(root);
  const normalizedPath = normalizedProjectPath(path);
  if (normalizedPath === normalizedRoot) return "";
  if (!normalizedPath.startsWith(`${normalizedRoot}/`)) return path;
  return path.slice(stripTrailingSeparator(root).length).replace(/^[\\/]+/, "");
}

/**
 * The containing folder, or `null` at a root. Used for "go up" navigation, so
 * it must never step above a POSIX root or a Windows drive root.
 */
export function parentPath(path: string): string | null {
  const trimmed = path.replace(/[\\/]+$/, "");
  const index = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  if (index < 0) return null;
  const parent = trimmed.slice(0, index);
  if (!parent) return trimmed.slice(0, 1);
  if (/^[a-zA-Z]:$/.test(parent)) return `${parent}${trimmed[index]}`;
  return parent;
}
