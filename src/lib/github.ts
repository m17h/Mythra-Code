import { invoke } from "@tauri-apps/api/core";
import type { PermissionMode } from "../types";

export interface GitHubCloneTarget {
  name: string;
  url: string;
}

/** Derive a cross-platform folder name and canonical GitHub URL, never a path from URL text. */
export function parseGitHubCloneTarget(input: string): GitHubCloneTarget | null {
  const value = input.trim().split(/[?#]/, 1)[0];
  const prefixes = ["https://github.com/", "http://github.com/", "git@github.com:", "ssh://git@github.com/"];
  const prefix = prefixes.find((item) => value.startsWith(item));
  if (!prefix) return null;
  const parts = value.slice(prefix.length).replace(/\/+$/, "").split("/");
  if (parts.length !== 2) return null;
  const [owner, repository] = parts;
  const name = repository.endsWith(".git") ? repository.slice(0, -4) : repository;
  if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/.test(owner) || !/^[A-Za-z0-9._-]{1,100}$/.test(name)) return null;
  // Windows trims trailing dots and treats device names (even with extensions) as special files.
  if (name === "." || name === ".." || name.endsWith(".") || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(name)) return null;
  const ssh = prefix.startsWith("git@") || prefix.startsWith("ssh:");
  return { name, url: ssh ? `git@github.com:${owner}/${name}.git` : `https://github.com/${owner}/${name}.git` };
}

export type GitWorkspaceAction =
  | "status"
  | "diff"
  | "stage"
  | "revert"
  | "commit"
  | "commitPush"
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

export function attachGitHubRemote(cwd: string, url: string): Promise<GitHubRepoStatus> {
  return invoke<GitHubRepoStatus>("github_attach_remote", { cwd, url });
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
): string[] {
  if (action === "comments") return [binary, "pr", "view", "--comments"];
  if (action === "ci") return [binary, "pr", "checks"];
  return [binary, "pr", "create", "--draft", "--fill"];
}
