import { invoke } from "@tauri-apps/api/core";

export type DeveloperRuntimeTarget = "codex" | "claude";

export interface DeveloperRuntimeTargetStatus {
  installed: boolean;
  currentVersion: string | null;
  latestVersion: string | null;
  /** Previous successful metadata retained after a failed refresh, never current evidence. */
  latestVersionStale?: boolean;
  latestVersionCheckedAt?: number | null;
  installedVersionStale?: boolean;
  updateAvailable: boolean;
  canUpdate: boolean;
  source: string | null;
  error: string | null;
}

export interface DeveloperRuntimeUpdateStatus {
  checkedAt: number;
  codex: DeveloperRuntimeTargetStatus;
  claude: DeveloperRuntimeTargetStatus;
}

export interface DeveloperRuntimeUpdateResult {
  status: DeveloperRuntimeUpdateStatus;
  message: string;
  restartRequired: boolean;
}

export interface DeveloperRuntimeUpdater {
  status: DeveloperRuntimeUpdateStatus | null;
  checking: boolean;
  updating: DeveloperRuntimeTarget | null;
  error: string | null;
  message: string | null;
  checkForUpdates: () => Promise<void>;
  updateRuntime: (target: DeveloperRuntimeTarget) => Promise<void>;
}

let cachedStatus: DeveloperRuntimeUpdateStatus | null = null;
let pendingCheck: Promise<DeveloperRuntimeUpdateStatus> | null = null;

function rememberStatus(next: DeveloperRuntimeUpdateStatus): DeveloperRuntimeUpdateStatus {
  const previous = cachedStatus;
  const merge = (target: DeveloperRuntimeTarget): DeveloperRuntimeTargetStatus => {
    const value = next[target];
    const old = previous?.[target];
    if (value.latestVersion) return { ...value, latestVersionStale: false, latestVersionCheckedAt: next.checkedAt, installedVersionStale: false };
    if (old?.latestVersion) return {
      ...value,
      latestVersion: old.latestVersion,
      latestVersionCheckedAt: old.latestVersionCheckedAt ?? previous!.checkedAt,
      latestVersionStale: true,
      installedVersionStale: false,
      updateAvailable: false,
    };
    return { ...value, latestVersionStale: false, latestVersionCheckedAt: null, installedVersionStale: false };
  };
  cachedStatus = { ...next, codex: merge("codex"), claude: merge("claude") };
  return cachedStatus;
}

export function cachedDeveloperRuntimeUpdates(): DeveloperRuntimeUpdateStatus | null {
  return cachedStatus;
}

/** Reuse the launch check when Settings opens before or after it completes. */
export function ensureDeveloperRuntimeUpdates(): Promise<DeveloperRuntimeUpdateStatus> {
  return cachedStatus ? Promise.resolve(cachedStatus) : checkDeveloperRuntimeUpdates();
}

export async function checkDeveloperRuntimeUpdates(): Promise<DeveloperRuntimeUpdateStatus> {
  if (pendingCheck) return pendingCheck;
  pendingCheck = invoke<DeveloperRuntimeUpdateStatus>("developer_runtime_updates")
    .then(rememberStatus)
    .catch(() => {
      const message = "Couldn’t check runtime updates. Try again.";
      if (!cachedStatus) throw new Error(message);
      const markUnknown = (value: DeveloperRuntimeTargetStatus): DeveloperRuntimeTargetStatus => ({
        ...value, latestVersionStale: Boolean(value.latestVersion), installedVersionStale: true,
        updateAvailable: false, error: message,
      });
      cachedStatus = { ...cachedStatus, checkedAt: Date.now(), codex: markUnknown(cachedStatus.codex), claude: markUnknown(cachedStatus.claude) };
      return cachedStatus;
    })
    .finally(() => {
      pendingCheck = null;
    });
  return pendingCheck;
}

export async function updateDeveloperRuntime(target: DeveloperRuntimeTarget): Promise<DeveloperRuntimeUpdateResult> {
  try {
    const result = await invoke<DeveloperRuntimeUpdateResult>("developer_runtime_update", { target });
    return { ...result, status: rememberStatus(result.status) };
  } catch (reason) {
    // The installer may have changed disk before its process/IPC failed. Keep
    // history, but do not certify the previously installed executable as current.
    if (cachedStatus) cachedStatus = {
      ...cachedStatus,
      [target]: { ...cachedStatus[target], installedVersionStale: true, updateAvailable: false,
        error: "The update did not finish normally. Check again to confirm the installed version." },
    };
    throw reason;
  }
}
