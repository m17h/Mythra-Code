import { invoke } from "@tauri-apps/api/core";
import type { PermissionMode } from "../types";

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

export function githubCliCommand(
  binary: string,
  action: Extract<GitWorkspaceAction, "comments" | "ci" | "pr">,
): string[] {
  if (action === "comments") return [binary, "pr", "view", "--comments"];
  if (action === "ci") return [binary, "pr", "checks"];
  return [binary, "pr", "create", "--draft", "--fill"];
}
