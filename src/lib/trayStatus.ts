import { useSyncExternalStore } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { loadStored, storeValue } from "./storage";

/**
 * Optional menu bar / notification area status. A per-device preference
 * that applies immediately; off by default.
 */
const KEY = "kiwi.trayStatus";
// This module can be evaluated in the startup shared chunk, before native
// hydration restores the preference. Defer the read until the UI asks for it.
let enabled: boolean | undefined;
const listeners = new Set<() => void>();

function trayStatusEnabled(): boolean {
  return enabled ??= loadStored<boolean>(KEY, false) === true;
}

export function setTrayStatusEnabled(value: boolean): void {
  if (value === trayStatusEnabled()) return;
  enabled = value;
  storeValue(KEY, value);
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function useTrayStatusEnabled(): boolean {
  return useSyncExternalStore(subscribe, trayStatusEnabled, () => false);
}

export async function configureTrayStatus(value: boolean): Promise<void> {
  if (!isTauri()) return;
  await invoke("tray_configure", { enabled: value });
}

export async function updateTrayStatus(working: number, approvals: number): Promise<void> {
  if (!isTauri()) return;
  await invoke("tray_status", { working, approvals });
}
