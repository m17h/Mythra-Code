import { useCallback, useEffect, useRef, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { isTauri } from "@tauri-apps/api/core";
import { relaunch } from "@tauri-apps/plugin-process";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { recordError } from "./errorLog";
import { friendlyError } from "./errors";

export type AppUpdatePhase =
  | "idle"
  | "checking"
  | "current"
  | "available"
  | "downloading"
  | "installing"
  | "restarting"
  | "error";

export interface AppUpdateState {
  phase: AppUpdatePhase;
  currentVersion: string;
  availableVersion: string | null;
  notes: string | null;
  publishedAt: string | null;
  downloadedBytes: number;
  totalBytes: number | null;
  error: string | null;
}

export interface AppUpdater extends AppUpdateState {
  checkForUpdates: () => Promise<void>;
  downloadAndRestart: () => Promise<void>;
}

const INITIAL_STATE: AppUpdateState = {
  phase: "idle",
  currentVersion: "…",
  availableVersion: null,
  notes: null,
  publishedAt: null,
  downloadedBytes: 0,
  totalBytes: null,
  error: null,
};

// Module lifetime matches the current webview/app session. This prevents a
// remount from creating another automatic check while still allowing a fresh
// check the next time Mythra Code is launched.
let automaticCheckStarted = false;

// Long-running sessions should still learn about new releases without a
// relaunch; re-check silently a few times a day.
const AUTOMATIC_RECHECK_INTERVAL_MS = 6 * 60 * 60_000;

export function updateProgress(downloadedBytes: number, totalBytes: number | null): number | null {
  if (!totalBytes || totalBytes <= 0) return null;
  return Math.min(100, Math.max(0, Math.round((downloadedBytes / totalBytes) * 100)));
}

export function useAppUpdater(): AppUpdater {
  const [state, setState] = useState<AppUpdateState>(INITIAL_STATE);
  const updateRef = useRef<Update | null>(null);
  const checkingRef = useRef(false);
  const phaseRef = useRef<AppUpdatePhase>(state.phase);
  phaseRef.current = state.phase;

  const performCheck = useCallback(async (silent: boolean) => {
    if (!isTauri() || checkingRef.current) return;
    checkingRef.current = true;
    if (!silent) setState((current) => ({ ...current, phase: "checking", error: null }));
    try {
      const currentVersion = await getVersion();
      const previous = updateRef.current;
      updateRef.current = null;
      if (previous) await previous.close().catch(() => undefined);

      const update = await check({ timeout: 15_000 });
      if (!update) {
        setState((current) => ({
          ...current,
          phase: "current",
          currentVersion,
          availableVersion: null,
          notes: null,
          publishedAt: null,
          error: null,
        }));
        return;
      }

      updateRef.current = update;
      setState({
        phase: "available",
        currentVersion,
        availableVersion: update.version,
        notes: update.body?.trim() || null,
        publishedAt: update.date ?? null,
        downloadedBytes: 0,
        totalBytes: null,
        error: null,
      });
    } catch (reason) {
      if (silent) {
        // The startup check failing silently would otherwise leave no trace
        // anywhere: if the endpoint, key, or manifest breaks, the installed
        // base just stops updating. Keep it out of the UI but in diagnostics.
        recordError(`Automatic update check failed: ${friendlyError(reason)}`);
      } else {
        setState((current) => ({ ...current, phase: "error", error: friendlyError(reason) }));
      }
    } finally {
      checkingRef.current = false;
    }
  }, []);

  const checkForUpdates = useCallback(() => {
    // A manual check during the startup delay satisfies this session's check,
    // so the delayed automatic check will not immediately repeat it.
    automaticCheckStarted = true;
    return performCheck(false);
  }, [performCheck]);

  const downloadAndRestart = useCallback(async () => {
    const update = updateRef.current;
    if (!update) {
      await performCheck(false);
      return;
    }

    let downloadedBytes = 0;
    let totalBytes: number | null = null;
    setState((current) => ({ ...current, phase: "downloading", downloadedBytes: 0, totalBytes: null, error: null }));
    try {
      await update.downloadAndInstall((event) => {
        if (event.event === "Started") {
          totalBytes = event.data.contentLength ?? null;
          setState((current) => ({ ...current, phase: "downloading", downloadedBytes: 0, totalBytes }));
        } else if (event.event === "Progress") {
          downloadedBytes += event.data.chunkLength;
          setState((current) => ({ ...current, downloadedBytes, totalBytes }));
        } else {
          setState((current) => ({ ...current, phase: "installing", downloadedBytes, totalBytes }));
        }
      }, { timeout: 10 * 60_000 });
      setState((current) => ({ ...current, phase: "restarting" }));
      await relaunch();
    } catch (reason) {
      setState((current) => ({ ...current, phase: "error", error: friendlyError(reason) }));
    }
  }, [performCheck]);

  useEffect(() => {
    if (!isTauri()) {
      setState((current) => ({ ...current, currentVersion: "development" }));
      return;
    }

    void getVersion().then((currentVersion) => {
      setState((current) => ({ ...current, currentVersion }));
    }).catch(() => undefined);

    const timer = window.setTimeout(() => {
      if (automaticCheckStarted) return;
      automaticCheckStarted = true;
      void performCheck(true);
    }, 3_500);
    const recheckTimer = window.setInterval(() => {
      // Never interrupt an in-flight download/install: performCheck closes
      // the Update handle downloadAndInstall is still using.
      if (phaseRef.current === "downloading" || phaseRef.current === "installing" || phaseRef.current === "restarting") return;
      void performCheck(true);
    }, AUTOMATIC_RECHECK_INTERVAL_MS);
    return () => {
      window.clearTimeout(timer);
      window.clearInterval(recheckTimer);
    };
  }, [performCheck]);

  useEffect(() => () => {
    const update = updateRef.current;
    updateRef.current = null;
    if (update) void update.close().catch(() => undefined);
  }, []);

  return { ...state, checkForUpdates, downloadAndRestart };
}
