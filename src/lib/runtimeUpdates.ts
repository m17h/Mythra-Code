import { invoke } from "@tauri-apps/api/core";

export type DeveloperRuntimeTarget = "codex" | "claude";

export interface DeveloperRuntimeTargetStatus {
  installed: boolean;
  currentVersion: string | null;
  latestVersion: string | null;
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
    .then((status) => {
      cachedStatus = status;
      return status;
    })
    .finally(() => {
      pendingCheck = null;
    });
  return pendingCheck;
}

export async function updateDeveloperRuntime(target: DeveloperRuntimeTarget): Promise<DeveloperRuntimeUpdateResult> {
  const result = await invoke<DeveloperRuntimeUpdateResult>("developer_runtime_update", { target });
  cachedStatus = result.status;
  return result;
}
