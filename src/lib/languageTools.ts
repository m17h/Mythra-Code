import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export type LanguageToolState = "installed" | "available" | "missing" | "installing" | "error" | "unavailable";
export type LanguageToolHealth = "unverified" | "verified" | "stale" | "error";

export interface LanguageToolStatus {
  id: string;
  name: string;
  languages: string[];
  state: LanguageToolState;
  detail: string;
  enabled: boolean;
  health: LanguageToolHealth;
}

export interface LanguageToolsSnapshot {
  autoInstall: boolean;
  generation: number;
  tools: LanguageToolStatus[];
}

export function languageToolsSnapshot(): Promise<LanguageToolsSnapshot> {
  return invoke("language_tools_snapshot");
}

/** Explicitly verify servers; ordinary inventory reads never start them. */
export function refreshLanguageTools(): Promise<LanguageToolsSnapshot> {
  return invoke("language_tools_refresh");
}

export function setLanguageToolsAutoInstall(enabled: boolean): Promise<LanguageToolsSnapshot> {
  return invoke("language_tools_set_auto_install", { enabled });
}

export function installLanguageTool(id: string): Promise<LanguageToolsSnapshot> {
  return invoke("language_tools_install", { id });
}

export function setLanguageToolEnabled(id: string, enabled: boolean): Promise<LanguageToolsSnapshot> {
  return invoke("language_tools_set_enabled", { id, enabled });
}

/** Read the authoritative snapshot on change; event payloads are not state. */
export function listenLanguageToolsChanged(onChanged: (generation?: number) => void): Promise<UnlistenFn> {
  return listen<{ generation?: number }>("language-tools-changed", (event) => {
    const generation = event.payload?.generation;
    onChanged(typeof generation === "number" && Number.isSafeInteger(generation) ? generation : undefined);
  });
}
