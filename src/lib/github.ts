import { invoke } from "@tauri-apps/api/core";
import type { PermissionMode } from "../types";

export interface GitHubCloneTarget {
  name: string;
  url: string;
}

function parseGitHubRemoteTarget(input: string): GitHubCloneTarget | null {
  const trimmed = input.trim();
  if (/[\x00-\x1f\x7f]/.test(trimmed)) return null;
  const value = trimmed.split(/[?#]/, 1)[0];
  const prefixes = ["https://github.com/", "http://github.com/", "git@github.com:", "ssh://git@github.com/", "ssh://git@ssh.github.com:443/"];
  const prefix = prefixes.find((item) => value.startsWith(item));
  if (!prefix) return null;
  const parts = value.slice(prefix.length).replace(/\/+$/, "").split("/");
  if (parts.length !== 2) return null;
  const [owner, repository] = parts;
  const name = repository.endsWith(".git") ? repository.slice(0, -4) : repository;
  if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/.test(owner) || !/^[A-Za-z0-9._-]{1,100}$/.test(name)) return null;
  if (name === "." || name === "..") return null;
  if (prefix === "ssh://git@ssh.github.com:443/") return { name, url: `${prefix}${owner}/${name}.git` };
  const ssh = prefix.startsWith("git@") || prefix.startsWith("ssh:");
  return { name, url: ssh ? `git@github.com:${owner}/${name}.git` : `https://github.com/${owner}/${name}.git` };
}

/** Canonicalize a repository address without imposing local-folder restrictions. */
export function normalizeGitHubRemoteUrl(input: string): string | null {
  return parseGitHubRemoteTarget(input)?.url ?? null;
}

/** Derive a cross-platform folder name and canonical GitHub URL, never a path from URL text. */
export function parseGitHubCloneTarget(input: string): GitHubCloneTarget | null {
  const target = parseGitHubRemoteTarget(input);
  if (!target) return null;
  const { name } = target;
  // Windows trims trailing dots and treats device names (even with extensions) as special files.
  if (name.endsWith(".") || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(name)) return null;
  return target;
}

export type GitWorkspaceAction =
  | "status"
  | "diff"
  | "stage"
  | "revert"
  | "commit"
  | "commitPush"
  | "commitStaged"
  | "commitStagedPush"
  | "unstage"
  | "fetch"
  | "pull"
  | "push"
  | "attach"
  | "create"
  | "comments"
  | "ci"
  | "pr";

export interface GitHubAccountStatus {
  available: boolean;
  authenticated: boolean;
  path?: string | null;
  version?: string | null;
  login?: string | null;
  name?: string | null;
  email?: string | null;
  avatarUrl?: string | null;
  profileUrl?: string | null;
  error?: string | null;
}

export interface GitHubRepoStatus {
  isRepo: boolean;
  remoteUrl?: string | null;
  repository?: string | null;
  branch?: string | null;
  upstream?: string | null;
  ahead: number;
  behind: number;
}

export function getGitHubStatus(): Promise<GitHubAccountStatus> {
  return invoke<GitHubAccountStatus>("github_status");
}

export function startGitHubLogin(): Promise<void> {
  return invoke("github_login");
}

export function getGitHubRepoStatus(cwd: string): Promise<GitHubRepoStatus> {
  return invoke<GitHubRepoStatus>("github_repo_status", { cwd });
}

export async function attachGitHubRemote(cwd: string, url: string): Promise<GitHubRepoStatus> {
  const normalized = normalizeGitHubRemoteUrl(url);
  if (!normalized) throw new Error("Enter a GitHub repository URL such as https://github.com/owner/repository.git");
  return invoke<GitHubRepoStatus>("github_attach_remote", { cwd, url: normalized });
}

export function createGitHubRepository(
  cwd: string,
  name: string,
  visibility: "private" | "public",
): Promise<GitHubRepoStatus> {
  return invoke<GitHubRepoStatus>("github_create_repository", { cwd, name, visibility });
}

export function cloneGitHubRepository(url: string, destination: string): Promise<void> {
  return invoke("github_clone_repository", { url, destination });
}

export function gitActionUnavailableReason(
  action: GitWorkspaceAction,
  permission: PermissionMode,
): string | null {
  if (permission !== "read-only" || action === "status" || action === "diff") return null;
  return "Switch this thread from Read only to Ask or Full access before changing Git or contacting GitHub.";
}

export function gitPushCommand(status: GitHubRepoStatus | null): string[] | null {
  if (!status?.repository || !status.branch) return null;
  return status.upstream
    ? ["git", "push"]
    : ["git", "push", "--set-upstream", "origin", status.branch];
}

export function gitPushCompletionNote(statusPorcelain: string): string {
  const remaining = statusPorcelain.split(/\r?\n/).filter((line) => line.trim()).length;
  if (!remaining) return "Push succeeded. This branch's committed changes are on GitHub.";
  return `Push succeeded, but ${remaining} uncommitted entr${remaining === 1 ? "y remains" : "ies remain"} local. Stage and commit before pushing again.`;
}

export function githubCliCommand(
  binary: string,
  action: Extract<GitWorkspaceAction, "comments" | "ci" | "pr">,
  attached?: { repository: string; number: number },
  repositoryContext?: string | null,
): string[] {
  // An explicit full host also protects the generic terminal fallback from
  // enterprise GH_HOST/GH_REPO defaults inherited by the desktop process.
  const repository = action === "pr" ? repositoryContext : attached?.repository ?? repositoryContext;
  if (!repository) throw new Error("Connect this project to a GitHub repository before using pull request actions.");
  if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/.test(repository)
    || [".", ".."].includes(repository.split("/")[1])) {
    throw new Error("Choose a valid GitHub repository in owner/repository form before using pull request actions.");
  }
  if (attached && action !== "pr" && (!Number.isSafeInteger(attached.number) || attached.number <= 0)) {
    throw new Error("Choose a valid pull request number before using pull request actions.");
  }
  const target = `github.com/${repository}`;
  if (action === "comments") return attached
    ? [binary, "pr", "view", String(attached.number), "--repo", target, "--comments"]
    : [binary, "pr", "view", "--repo", target, "--comments"];
  if (action === "ci") return attached
    ? [binary, "pr", "checks", String(attached.number), "--repo", target]
    : [binary, "pr", "checks", "--repo", target];
  return [binary, "pr", "create", "--repo", target, "--draft", "--fill"];
}
