import { useSyncExternalStore } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { loadStored, storeValue } from "./storage";

/**
 * Optional menu bar / notification area status. A per-device preference
 * that applies immediately; off by default.
 */
const KEY = "kiwi.trayStatus";
let enabled = loadStored<boolean>(KEY, false) === true;
const listeners = new Set<() => void>();

export function setTrayStatusEnabled(value: boolean): void {
  if (value === enabled) return;
  enabled = value;
  storeValue(KEY, value);
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function useTrayStatusEnabled(): boolean {
  return useSyncExternalStore(subscribe, () => enabled, () => enabled);
}

export async function configureTrayStatus(value: boolean): Promise<void> {
  if (!isTauri()) return;
  await invoke("tray_configure", { enabled: value });
}

export async function updateTrayStatus(working: number, approvals: number): Promise<void> {
  if (!isTauri()) return;
  await invoke("tray_status", { working, approvals });
}
