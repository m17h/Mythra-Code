import { useCallback, useEffect, useRef, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { isTauri } from "@tauri-apps/api/core";
import { relaunch } from "@tauri-apps/plugin-process";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { recordError } from "./errorLog";
import { friendlyError, safeErrorText } from "./errors";

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

// Name resolution and connection count toward the plugin's per-request
// timeout. A cold Windows resolver has been observed taking up to 11.6
// seconds for one name, and the manifest URL redirects across hosts. One
// bounded retry gives a slow or interrupted first attempt a second chance,
// possibly with lookups the first attempt warmed (not guaranteed). Only this
// read-only manifest check retries; downloads and installs never do.
const CHECK_ATTEMPT_TIMEOUT_MS = 15_000;
const CHECK_RETRY_DELAY_MS = 1_500;
// The plugin reports every DNS, connect, TLS and timeout failure before a
// response as reqwest's opaque top-level text, without its cause.
const CHECK_TRANSPORT_FAILURE = /error sending request for url/i;
// Any non-success HTTP status (including rate limits) or a missing manifest.
const CHECK_MANIFEST_FAILURE = /could not fetch a valid release json/i;

export function updateProgress(downloadedBytes: number, totalBytes: number | null): number | null {
  if (!totalBytes || totalBytes <= 0) return null;
  return Math.min(100, Math.max(0, Math.round((downloadedBytes / totalBytes) * 100)));
}

export function appUpdateCheckError(reason: unknown): string {
  const raw = safeErrorText(reason);
  if (CHECK_TRANSPORT_FAILURE.test(raw)) return "Couldn’t reach GitHub Releases to check for updates. Check your connection and try again.";
  if (CHECK_MANIFEST_FAILURE.test(raw)) return "GitHub Releases didn’t return valid update information. Try again later.";
  return friendlyError(reason);
}

async function checkWithRetry(): Promise<Update | null> {
  try {
    return await check({ timeout: CHECK_ATTEMPT_TIMEOUT_MS });
  } catch (reason) {
    if (!CHECK_TRANSPORT_FAILURE.test(safeErrorText(reason))) throw reason;
    await new Promise((resolve) => window.setTimeout(resolve, CHECK_RETRY_DELAY_MS));
    return check({ timeout: CHECK_ATTEMPT_TIMEOUT_MS });
  }
}

export function useAppUpdater(): AppUpdater {
  const [state, setState] = useState<AppUpdateState>(INITIAL_STATE);
  const updateRef = useRef<Update | null>(null);
  const checkingRef = useRef(false);
  const visibleCheckRef = useRef(false);
  const phaseRef = useRef<AppUpdatePhase>(state.phase);
  phaseRef.current = state.phase;

  const performCheck = useCallback(async (silent: boolean) => {
    if (!isTauri()
      || ["downloading", "installing", "restarting"].includes(phaseRef.current)) return;
    if (checkingRef.current) {
      // Opening Updates can join a silent background check. Promote its
      // progress/errors into the page without issuing another network request.
      if (!silent) {
        visibleCheckRef.current = true;
        setState((current) => ({ ...current, phase: "checking", error: null }));
      }
      return;
    }
    checkingRef.current = true;
    visibleCheckRef.current = !silent;
    if (!silent) setState((current) => ({ ...current, phase: "checking", error: null }));
    try {
      const currentVersion = await getVersion();
      const update = await checkWithRetry();
      // Keep the previous handle until a fresh result replaces it, so a failed
      // background recheck cannot leave an "available" card without its update.
      const previous = updateRef.current;
      updateRef.current = update;
      if (previous) void previous.close().catch(() => undefined);
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
      // Keep the underlying text in diagnostics; the card shows a friendly one.
      const raw = safeErrorText(reason);
      if (!visibleCheckRef.current) {
        // The startup check failing silently would otherwise leave no trace
        // anywhere: if the endpoint, key, or manifest breaks, the installed
        // base just stops updating. Keep it out of the UI but in diagnostics.
        recordError(`Automatic update check failed: ${raw}`);
      } else {
        recordError(`Update check failed: ${raw}`);
        setState((current) => ({ ...current, phase: "error", error: appUpdateCheckError(reason) }));
      }
    } finally {
      checkingRef.current = false;
      visibleCheckRef.current = false;
    }
  }, []);

  const checkForUpdates = useCallback(() => {
    // A manual check during the startup delay satisfies this session's check,
    // so the delayed automatic check will not immediately repeat it.
    automaticCheckStarted = true;
    return performCheck(false);
  }, [performCheck]);

  const downloadAndRestart = useCallback(async () => {
    if (checkingRef.current
      || ["downloading", "installing", "restarting"].includes(phaseRef.current)) return;
    const update = updateRef.current;
    if (!update) {
      await performCheck(false);
      return;
    }

    let downloadedBytes = 0;
    let totalBytes: number | null = null;
    phaseRef.current = "downloading";
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
          phaseRef.current = "installing";
          setState((current) => ({ ...current, phase: "installing", downloadedBytes, totalBytes }));
        }
      }, { timeout: 10 * 60_000 });
      phaseRef.current = "restarting";
      setState((current) => ({ ...current, phase: "restarting" }));
      await relaunch();
    } catch (reason) {
      phaseRef.current = "error";
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
